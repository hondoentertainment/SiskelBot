/**
 * Phase 54.2: Image generation proxy.
 *
 * Backend-agnostic image generation with:
 *   - Pluggable providers (dalle, stable diffusion, flux, mock, custom)
 *   - Prompt templating (photo_realistic, anime, watercolor, pixel_art, etc.)
 *   - Prompt safety sanitization
 *   - Generation history with filtering
 *   - Style presets
 *   - Batch generation
 *   - Variation/upscale stubs
 *
 * Storage (via lib/json-path-store.js):
 *   data/image-generation/history.json    — generation history index
 *   data/image-generation/presets.json    — named style presets
 */
import crypto from "node:crypto";
import { join } from "node:path";
import {
  getDataDir,
  readJsonPath,
  writeJsonPath,
  withPathLock,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const SUBDIR = "image-generation";
const HISTORY_FILE = "history.json";
const PRESETS_FILE = "presets.json";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Built-in image generation provider definitions. Each provider has an
 * optional HTTP endpoint. The `mock` provider has no endpoint and returns a
 * deterministic stub image — used by tests and as a safe default when no
 * external provider is configured.
 */
export const IMAGE_PROVIDERS = {
  dalle: { endpoint: "https://api.openai.com/v1/images/generations" },
  stable_diffusion: { endpoint: "http://localhost:7860/sdapi/v1/txt2img" },
  flux: {
    endpoint:
      "https://api.replicate.com/v1/models/black-forest-labs/flux/predictions",
  },
  mock: {},
};

// Registry of providers — built-ins plus any user-registered provider.
// Each entry is { config, generator }. Populated lazily after the built-in
// generators below are defined to avoid temporal-dead-zone issues.
const providerRegistry = new Map();

function initProviderRegistry() {
  providerRegistry.clear();
  providerRegistry.set("dalle", {
    config: IMAGE_PROVIDERS.dalle,
    generator: httpGenerator,
  });
  providerRegistry.set("stable_diffusion", {
    config: IMAGE_PROVIDERS.stable_diffusion,
    generator: httpGenerator,
  });
  providerRegistry.set("flux", {
    config: IMAGE_PROVIDERS.flux,
    generator: httpGenerator,
  });
  providerRegistry.set("mock", {
    config: IMAGE_PROVIDERS.mock,
    generator: mockGenerator,
  });
}

/**
 * Register a custom image generation provider. Generators receive
 * (prompt, options, config) and must return an object of shape:
 *   { images: [{ url?, data?, id }], metadata? }
 * @param {string} name
 * @param {object} config
 * @param {(prompt: string, options: object, config: object) => Promise<object>} generator
 */
export function registerImageProvider(name, config, generator) {
  if (!name || typeof name !== "string") {
    throw new Error("provider name is required");
  }
  if (typeof generator !== "function") {
    throw new Error("generator function is required");
  }
  providerRegistry.set(name, { config: config || {}, generator });
}

/**
 * Fetch a registered provider by name, or null if unknown.
 * @param {string} name
 */
export function getImageProvider(name) {
  if (!providerRegistry.has(name)) return null;
  return providerRegistry.get(name);
}

/**
 * Reset the provider registry back to built-ins (test helper).
 */
export function _resetImageProviders() {
  initProviderRegistry();
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Deterministic mock generator. Returns a 1x1 transparent PNG as base64 so
 * tests can assert on shape without any network calls.
 * @param {string} prompt
 * @param {object} [options]
 */
export const mockGenerator = async (prompt, options = {}) => {
  const count = Math.max(1, Math.min(8, options.count || 1));
  const seed = options.seed ?? hashPromptToSeed(prompt);
  // 1x1 transparent PNG, base64. Stable across all calls.
  const transparentPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
  const images = Array.from({ length: count }, (_, i) => ({
    id: `mock_${seed}_${i}`,
    url: `data:image/png;base64,${transparentPng}`,
    data: transparentPng,
    seed: seed + i,
  }));
  return {
    images,
    metadata: {
      provider: "mock",
      prompt,
      count,
      size: options.size || "1x1",
      style: options.style || null,
      createdAt: new Date().toISOString(),
    },
  };
};

/**
 * Generic HTTP generator. Calls the provider's endpoint with a JSON payload
 * built from prompt+options. Used by dalle/stable_diffusion/flux by default.
 * @param {string} prompt
 * @param {object} options
 * @param {object} config
 */
export const httpGenerator = async (prompt, options = {}, config = {}) => {
  const endpoint = config.endpoint;
  if (!endpoint) {
    throw new Error("provider is missing endpoint");
  }
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  const payload = {
    prompt,
    size: options.size || "1024x1024",
    n: options.count || 1,
    negative_prompt: options.negativePrompt || undefined,
    seed: options.seed,
    style: options.style,
  };
  const headers = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`http generator failed: ${res.status} ${text.slice(0, 120)}`);
  }
  const body = await res.json().catch(() => ({}));
  const rawImages = body.data || body.images || body.output || [];
  const images = (Array.isArray(rawImages) ? rawImages : [rawImages]).map(
    (img, i) => {
      if (typeof img === "string") {
        return { id: `http_${i}`, url: img };
      }
      return {
        id: img?.id || `http_${i}`,
        url: img?.url || img?.image_url || null,
        data: img?.b64_json || img?.data || null,
      };
    },
  );
  return {
    images,
    metadata: {
      provider: "http",
      prompt,
      endpoint,
      createdAt: new Date().toISOString(),
    },
  };
};

function hashPromptToSeed(prompt) {
  const hex = crypto
    .createHash("sha256")
    .update(String(prompt || ""))
    .digest("hex")
    .slice(0, 8);
  return parseInt(hex, 16);
}

// Populate provider registry now that the built-in generators are defined.
initProviderRegistry();

// ---------------------------------------------------------------------------
// Prompt templating
// ---------------------------------------------------------------------------

/**
 * Built-in prompt templates. Each template uses {prompt} as the placeholder
 * that gets substituted with the user's raw prompt.
 */
export const PROMPT_TEMPLATES = {
  photo_realistic: "photorealistic, 8k, detailed, {prompt}",
  anime: "anime style, studio quality, {prompt}",
  watercolor: "watercolor painting, soft edges, {prompt}",
  pixel_art: "16-bit pixel art, retro, {prompt}",
  schematic: "technical schematic, blueprint, {prompt}",
  logo: "minimalist logo design, flat, {prompt}",
};

// Runtime registry — built-ins plus user-registered templates.
const templateRegistry = new Map(Object.entries(PROMPT_TEMPLATES));

/**
 * Apply a named template to a prompt. If the template is unknown the prompt
 * is returned unchanged so callers that pass null/undefined still work.
 * @param {string} prompt
 * @param {string|null} [templateName]
 * @returns {string}
 */
export function applyTemplate(prompt, templateName) {
  if (!templateName) return prompt;
  const template = templateRegistry.get(templateName);
  if (!template) return prompt;
  return template.replace(/\{prompt\}/g, prompt);
}

/**
 * Register a new prompt template.
 * @param {string} name
 * @param {string} template — must include {prompt} placeholder
 */
export function registerTemplate(name, template) {
  if (!name || typeof name !== "string") {
    throw new Error("template name is required");
  }
  if (!template || typeof template !== "string") {
    throw new Error("template body is required");
  }
  if (!template.includes("{prompt}")) {
    throw new Error("template must contain {prompt} placeholder");
  }
  templateRegistry.set(name, template);
}

/**
 * List all known template names and their bodies.
 */
export function listTemplates() {
  return Array.from(templateRegistry.entries()).map(([name, template]) => ({
    name,
    template,
  }));
}

/**
 * Reset templates back to built-ins (test helper).
 */
export function _resetTemplates() {
  templateRegistry.clear();
  for (const [k, v] of Object.entries(PROMPT_TEMPLATES)) {
    templateRegistry.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Prompt safety
// ---------------------------------------------------------------------------

/**
 * Disallowed content patterns. We strip matches rather than throwing so the
 * generator still gets a usable prompt. Callers that want hard rejection can
 * compare the input to the output and error on mismatch.
 */
const DISALLOWED_PATTERNS = [
  /\b(nude|nudity|naked|explicit\s+sex|porn|pornographic)\b/gi,
  /\b(child\s+porn|csam|minors?\s+nude)\b/gi,
  /\b(gore|dismember|beheading|decapitat\w*)\b/gi,
  /\b(bioweapon|nerve\s+agent|anthrax)\b/gi,
  /\b(make|build|assemble)\s+a?\s*(bomb|explosive|ied)\b/gi,
];

/**
 * Sanitize a prompt by removing disallowed phrases. Collapses repeated
 * whitespace after substitution. Returns null if the resulting prompt is
 * empty after sanitization.
 * @param {string} prompt
 * @returns {{ sanitized: string, removed: string[], modified: boolean }}
 */
export function sanitizePrompt(prompt) {
  if (typeof prompt !== "string") {
    return { sanitized: "", removed: [], modified: false };
  }
  let sanitized = prompt;
  const removed = [];
  for (const pattern of DISALLOWED_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      removed.push(...matches);
      sanitized = sanitized.replace(pattern, "");
    }
  }
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  return {
    sanitized,
    removed,
    modified: removed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Core: generate
// ---------------------------------------------------------------------------

/**
 * Generate one or more images via the selected provider.
 *
 * @param {string} prompt — raw user prompt
 * @param {object} [options]
 * @param {string} [options.provider] — default: "mock"
 * @param {string} [options.size] — e.g. "1024x1024"
 * @param {string} [options.style] — optional style tag
 * @param {number} [options.count] — number of images to generate
 * @param {string} [options.negativePrompt]
 * @param {number} [options.seed]
 * @param {string} [options.template] — named prompt template
 * @param {boolean} [options.skipHistory] — don't persist the result
 * @param {string} [options.userId]
 * @param {string} [options.workspaceId]
 * @returns {Promise<{ id: string, images: object[], metadata: object, providerId: string }>}
 */
export async function generateImage(prompt, options = {}) {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("prompt is required");
  }
  const providerName = options.provider || "mock";
  const provider = getImageProvider(providerName);
  if (!provider) {
    throw new Error(`unknown provider: ${providerName}`);
  }

  const safety = sanitizePrompt(prompt);
  if (!safety.sanitized) {
    throw new Error("prompt is empty after sanitization");
  }
  const templated = applyTemplate(safety.sanitized, options.template);

  const raw = await provider.generator(templated, options, provider.config);
  const result = {
    id: `img_${crypto.randomUUID()}`,
    prompt,
    sanitizedPrompt: safety.sanitized,
    templatedPrompt: templated,
    images: raw.images || [],
    metadata: {
      ...(raw.metadata || {}),
      provider: providerName,
      template: options.template || null,
      size: options.size || raw.metadata?.size || null,
      style: options.style || raw.metadata?.style || null,
      count: options.count || (raw.images || []).length || 1,
      seed: options.seed ?? null,
      negativePrompt: options.negativePrompt || null,
      userId: options.userId || "anonymous",
      workspaceId: options.workspaceId || "default",
      createdAt: raw.metadata?.createdAt || new Date().toISOString(),
      safety: {
        modified: safety.modified,
        removed: safety.removed,
      },
    },
    providerId: providerName,
  };
  if (!options.skipHistory) {
    await recordGeneration(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generation history
// ---------------------------------------------------------------------------

function historyPath() {
  return join(getDataDir(), SUBDIR, HISTORY_FILE);
}

function presetsPath() {
  return join(getDataDir(), SUBDIR, PRESETS_FILE);
}

async function readHistory() {
  return readJsonPath(historyPath(), {
    _version: STORE_VERSION,
    byId: {},
    order: [],
  });
}

async function writeHistory(state) {
  await writeJsonPath(historyPath(), state);
}

/**
 * Persist a generation result into the history store.
 * @param {object} result — shape from generateImage
 */
export async function recordGeneration(result) {
  if (!result || !result.id) {
    throw new Error("result.id is required");
  }
  const path = historyPath();
  return withPathLock(path, async () => {
    const state = await readHistory();
    state.byId[result.id] = result;
    if (!state.order.includes(result.id)) {
      state.order.unshift(result.id);
    }
    // Bound the history to the 1000 most recent entries.
    if (state.order.length > 1000) {
      const dropped = state.order.splice(1000);
      for (const id of dropped) delete state.byId[id];
    }
    await writeHistory(state);
    return result;
  });
}

/**
 * List historical generations with optional filter.
 * @param {object} [filter]
 * @param {string} [filter.provider]
 * @param {string} [filter.userId]
 * @param {string} [filter.workspaceId]
 * @param {string} [filter.template]
 * @param {number} [filter.limit] — default 50
 * @param {number} [filter.offset] — default 0
 */
export async function getGenerationHistory(filter = {}) {
  const state = await readHistory();
  const limit = Math.max(1, Math.min(500, filter.limit || 50));
  const offset = Math.max(0, filter.offset || 0);
  let entries = state.order
    .map((id) => state.byId[id])
    .filter((x) => x != null);

  if (filter.provider) {
    entries = entries.filter((e) => e.providerId === filter.provider);
  }
  if (filter.userId) {
    entries = entries.filter((e) => e.metadata?.userId === filter.userId);
  }
  if (filter.workspaceId) {
    entries = entries.filter(
      (e) => e.metadata?.workspaceId === filter.workspaceId,
    );
  }
  if (filter.template) {
    entries = entries.filter((e) => e.metadata?.template === filter.template);
  }

  return {
    total: entries.length,
    entries: entries.slice(offset, offset + limit),
    limit,
    offset,
  };
}

/**
 * Load a single generation by id, or null.
 * @param {string} id
 */
export async function getGeneration(id) {
  const state = await readHistory();
  return state.byId[id] || null;
}

/**
 * Delete a generation by id. Returns true if it existed.
 * @param {string} id
 */
export async function deleteGeneration(id) {
  const path = historyPath();
  return withPathLock(path, async () => {
    const state = await readHistory();
    if (!state.byId[id]) return false;
    delete state.byId[id];
    state.order = state.order.filter((x) => x !== id);
    await writeHistory(state);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Style presets
// ---------------------------------------------------------------------------

async function readPresets() {
  return readJsonPath(presetsPath(), {
    _version: STORE_VERSION,
    byName: {},
  });
}

async function writePresets(state) {
  await writeJsonPath(presetsPath(), state);
}

/**
 * Save (or overwrite) a named style preset.
 * @param {string} name
 * @param {object} preset — arbitrary style options (template, size, style, negativePrompt, ...)
 */
export async function saveStylePreset(name, preset) {
  if (!name || typeof name !== "string") {
    throw new Error("preset name is required");
  }
  if (!preset || typeof preset !== "object") {
    throw new Error("preset body is required");
  }
  const path = presetsPath();
  return withPathLock(path, async () => {
    const state = await readPresets();
    const stored = {
      name,
      preset,
      createdAt: state.byName[name]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.byName[name] = stored;
    await writePresets(state);
    return stored;
  });
}

/**
 * Fetch a named style preset or null.
 * @param {string} name
 */
export async function getStylePreset(name) {
  const state = await readPresets();
  return state.byName[name] || null;
}

/**
 * List all saved presets.
 */
export async function listStylePresets() {
  const state = await readPresets();
  return Object.values(state.byName);
}

// ---------------------------------------------------------------------------
// Batch + variation
// ---------------------------------------------------------------------------

/**
 * Generate a batch of images in sequence. Individual failures don't abort
 * the batch — each slot gets either a result or an error entry.
 * @param {string[]} prompts
 * @param {object} [options]
 */
export async function generateBatch(prompts, options = {}) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("prompts must be a non-empty array");
  }
  const results = [];
  for (const prompt of prompts) {
    try {
      const r = await generateImage(prompt, options);
      results.push({ ok: true, prompt, result: r });
    } catch (err) {
      results.push({ ok: false, prompt, error: err?.message || String(err) });
    }
  }
  const successes = results.filter((r) => r.ok).length;
  return {
    total: prompts.length,
    successes,
    failures: prompts.length - successes,
    results,
  };
}

/**
 * Generate a variation of an existing image. Looks up the original in history
 * and re-runs the generator with a perturbed seed. Minimal stub: the real
 * provider would accept an init image, but for portability we just re-generate
 * using the stored prompt with a new seed.
 * @param {string} imageId
 * @param {object} [options]
 */
export async function generateVariation(imageId, options = {}) {
  const original = await getGeneration(imageId);
  if (!original) {
    throw new Error(`image ${imageId} not found`);
  }
  const variationSeed =
    options.seed ?? (original.metadata?.seed || 0) + Math.floor(Math.random() * 1000) + 1;
  const mergedOptions = {
    ...options,
    provider: options.provider || original.providerId,
    size: options.size || original.metadata?.size,
    style: options.style || original.metadata?.style,
    seed: variationSeed,
  };
  const variation = await generateImage(original.prompt, mergedOptions);
  variation.metadata.variationOf = imageId;
  await recordGeneration(variation);
  return variation;
}
