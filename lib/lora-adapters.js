/**
 * Phase 38.5: LoRA (Low-Rank Adaptation) adapter management.
 *
 * Supports loading, unloading, and switching between fine-tuned adapters
 * at runtime. Works with three classes of adapters:
 *
 *   - OpenAI fine-tunes  → resolved by passing the fine-tuned model ID
 *                          directly in the OpenAI chat completion request.
 *   - vLLM LoRA adapters → loaded via --enable-lora, selected per-request
 *                          via the `adapter_name` extra body parameter.
 *   - Local adapters     → referenced via an "adapter:<id>" pseudo-model
 *                          name, useful for custom Ollama/vLLM integrations.
 *
 * Metadata-only support for HuggingFace PEFT adapters (card fetch).
 *
 * Storage: JSON at data/lora-adapters.json via json-path-store so it honors
 * the global STORAGE_BACKEND (json, sqlite, postgres).
 *
 * @module lora-adapters
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DATA_FILE = () => join(getDataDir(), "lora-adapters.json");

const VALID_SOURCES = new Set(["openai", "huggingface", "local", "url"]);
const VALID_TYPES = new Set(["lora", "qlora", "full"]);
const VALID_SCOPES = new Set(["workspace", "global"]);

/**
 * Shape of the store:
 * {
 *   adapters: { [adapterId]: AdapterRecord },
 *   activeByWorkspace: { [workspaceId]: adapterId },
 *   metrics: { [adapterId]: MetricsRecord },
 * }
 */
function defaultStore() {
  return { adapters: {}, activeByWorkspace: {}, metrics: {} };
}

async function loadStore() {
  const data = await readJsonPath(DATA_FILE(), defaultStore());
  if (!data || typeof data !== "object") return defaultStore();
  return {
    adapters: data.adapters || {},
    activeByWorkspace: data.activeByWorkspace || {},
    metrics: data.metrics || {},
  };
}

async function saveStore(store) {
  await writeJsonPath(DATA_FILE(), store);
}

function requireAdapterConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("adapter config is required");
  }
  if (!config.name || typeof config.name !== "string") {
    throw new Error("adapter name is required");
  }
  if (!config.baseModel || typeof config.baseModel !== "string") {
    throw new Error("baseModel is required");
  }
  const adapterType = config.adapterType || "lora";
  if (!VALID_TYPES.has(adapterType)) {
    throw new Error(`adapterType must be one of: ${[...VALID_TYPES].join(", ")}`);
  }
  const source = config.source;
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`source must be one of: ${[...VALID_SOURCES].join(", ")}`);
  }
  const scope = config.scope || "workspace";
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`scope must be one of: ${[...VALID_SCOPES].join(", ")}`);
  }
  if (scope === "workspace" && !config.workspaceId) {
    throw new Error("workspaceId is required when scope=workspace");
  }
  return { adapterType, source, scope };
}

/**
 * Register a new adapter. Does not load it into the backend; call loadAdapter
 * separately to mark it as active.
 *
 * @param {object} config
 * @param {string} [config.id]           Optional explicit ID (else generated).
 * @param {string}  config.name          Human-friendly name.
 * @param {string}  config.baseModel     Model this adapter was trained from.
 * @param {'lora'|'qlora'|'full'} [config.adapterType]
 * @param {'openai'|'huggingface'|'local'|'url'} config.source
 * @param {object}  [config.sourceConfig]  e.g. { modelId: 'myorg/myadapter' }
 * @param {'workspace'|'global'} [config.scope]
 * @param {string}  [config.workspaceId]  required when scope=workspace
 * @returns {Promise<{id:string,registeredAt:string,loaded:false}>}
 */
export async function registerAdapter(config) {
  const { adapterType, source, scope } = requireAdapterConfig(config);
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const id = config.id || `adp_${randomUUID()}`;
    if (store.adapters[id]) {
      throw new Error(`adapter with id ${id} already exists`);
    }
    const record = {
      id,
      name: config.name,
      baseModel: config.baseModel,
      adapterType,
      source,
      sourceConfig: config.sourceConfig || {},
      scope,
      workspaceId: scope === "workspace" ? config.workspaceId : null,
      description: config.description || "",
      tags: Array.isArray(config.tags) ? config.tags.slice() : [],
      registeredAt: new Date().toISOString(),
      loaded: false,
      loadedAt: null,
    };
    store.adapters[id] = record;
    store.metrics[id] = store.metrics[id] || {
      usage: 0,
      totalLatencyMs: 0,
      errors: 0,
      lastUsed: null,
    };
    await saveStore(store);
    return { id, registeredAt: record.registeredAt, loaded: false };
  });
}

/**
 * Remove an adapter record. Also unloads it and clears it as the active
 * adapter for any workspace that had it selected.
 */
export async function unregisterAdapter(adapterId) {
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    if (!store.adapters[adapterId]) {
      return { ok: false, error: "adapter not found" };
    }
    delete store.adapters[adapterId];
    delete store.metrics[adapterId];
    for (const [ws, active] of Object.entries(store.activeByWorkspace)) {
      if (active === adapterId) delete store.activeByWorkspace[ws];
    }
    await saveStore(store);
    return { ok: true };
  });
}

/**
 * Mark an adapter as loaded. Backends that support hot-loading (e.g. vLLM
 * with --enable-lora) should already be serving the adapter weights; this
 * function flips the in-store flag and timestamps the event.
 */
export async function loadAdapter(adapterId) {
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const adapter = store.adapters[adapterId];
    if (!adapter) throw new Error("adapter not found");
    adapter.loaded = true;
    adapter.loadedAt = new Date().toISOString();
    await saveStore(store);
    return { loaded: true, loadedAt: adapter.loadedAt };
  });
}

/** Mark an adapter as unloaded. */
export async function unloadAdapter(adapterId) {
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const adapter = store.adapters[adapterId];
    if (!adapter) throw new Error("adapter not found");
    adapter.loaded = false;
    adapter.loadedAt = null;
    await saveStore(store);
    return { loaded: false };
  });
}

/**
 * List adapters visible to a workspace. When `workspaceId` is omitted, all
 * adapters are returned (admin view).
 */
export async function listAdapters(workspaceId) {
  const store = await loadStore();
  const all = Object.values(store.adapters);
  if (!workspaceId) return all;
  return all.filter((a) => a.scope === "global" || a.workspaceId === workspaceId);
}

/** Fetch a single adapter record by id. */
export async function getAdapter(adapterId) {
  const store = await loadStore();
  return store.adapters[adapterId] || null;
}

/**
 * Set the active adapter for a workspace. Passing `null` clears the
 * selection, restoring the default (no-adapter) model behavior.
 */
export async function switchActiveAdapter(workspaceId, adapterId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    if (adapterId == null) {
      delete store.activeByWorkspace[workspaceId];
      await saveStore(store);
      return { workspaceId, adapterId: null };
    }
    const adapter = store.adapters[adapterId];
    if (!adapter) throw new Error("adapter not found");
    if (adapter.scope === "workspace" && adapter.workspaceId !== workspaceId) {
      throw new Error("adapter is not accessible from this workspace");
    }
    store.activeByWorkspace[workspaceId] = adapterId;
    await saveStore(store);
    return { workspaceId, adapterId };
  });
}

/**
 * Return the active adapter record for a workspace, or `null` if none.
 * Safe to call from hot paths — reads only, no locks.
 */
export async function getActiveAdapter(workspaceId) {
  if (!workspaceId) return null;
  const store = await loadStore();
  const id = store.activeByWorkspace[workspaceId];
  if (!id) return null;
  return store.adapters[id] || null;
}

/**
 * Record usage of an adapter (called from chat hot-path). Updates usage
 * counter, latency aggregate, error count, and last-used timestamp.
 */
export async function recordAdapterUsage(adapterId, { latencyMs = 0, error = false } = {}) {
  if (!adapterId) return;
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const m = store.metrics[adapterId] || {
      usage: 0,
      totalLatencyMs: 0,
      errors: 0,
      lastUsed: null,
    };
    m.usage += 1;
    m.totalLatencyMs += Number(latencyMs) || 0;
    if (error) m.errors += 1;
    m.lastUsed = new Date().toISOString();
    store.metrics[adapterId] = m;
    await saveStore(store);
  });
}

/**
 * @returns {Promise<{usage:number, avgLatency:number, errorRate:number, lastUsed:string|null}>}
 */
export async function getAdapterMetrics(adapterId) {
  const store = await loadStore();
  const m = store.metrics[adapterId];
  if (!m) return { usage: 0, avgLatency: 0, errorRate: 0, lastUsed: null };
  const avgLatency = m.usage > 0 ? m.totalLatencyMs / m.usage : 0;
  const errorRate = m.usage > 0 ? m.errors / m.usage : 0;
  return {
    usage: m.usage,
    avgLatency: Math.round(avgLatency * 100) / 100,
    errorRate: Math.round(errorRate * 10000) / 10000,
    lastUsed: m.lastUsed,
  };
}

/**
 * Compute the model name (and any extras) the backend should use when an
 * adapter is selected. Pure/synchronous helper so it can be used inside
 * hot-path chat routing without awaits.
 *
 * Returns:
 *   {
 *     model: string,          // model name to put in the request body
 *     extras?: object,        // additional fields to merge into request body
 *   }
 *
 * @param {string} baseModel - fallback model name (request-supplied)
 * @param {object|string|null} adapterOrId - adapter record or id
 */
export function buildModelNameWithAdapter(baseModel, adapterOrId) {
  if (!adapterOrId) return { model: baseModel };
  // If caller passed an id rather than a record, we can't resolve it here;
  // return base and let caller look it up first.
  if (typeof adapterOrId === "string") return { model: baseModel };
  const adapter = adapterOrId;
  switch (adapter.source) {
    case "openai": {
      // OpenAI fine-tunes: the fine-tuned model ID replaces the base model.
      const ftId = adapter.sourceConfig?.fineTunedModelId || adapter.sourceConfig?.modelId;
      if (ftId) return { model: ftId };
      return { model: baseModel };
    }
    case "huggingface":
    case "url": {
      // vLLM with --enable-lora receives the adapter_name extra body arg.
      const adapterName = adapter.sourceConfig?.adapterName || adapter.name || adapter.id;
      return { model: baseModel, extras: { adapter_name: adapterName } };
    }
    case "local": {
      // Local adapter pseudo-model name.
      return { model: `adapter:${adapter.id}` };
    }
    default:
      return { model: baseModel };
  }
}

// ───────────────────────── OpenAI fine-tuned model support ───────────────

/**
 * List succeeded OpenAI fine-tuning jobs. Thin wrapper around the REST API;
 * returns a normalized array. Network/auth errors are surfaced to caller.
 *
 * @param {string} apiKey
 * @returns {Promise<Array<{id:string, fineTunedModel:string|null, baseModel:string, status:string, createdAt:number}>>}
 */
export async function listOpenAIFineTunes(apiKey) {
  if (!apiKey) throw new Error("apiKey is required");
  const res = await fetch("https://api.openai.com/v1/fine_tuning/jobs?limit=50", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const items = Array.isArray(body?.data) ? body.data : [];
  return items.map((j) => ({
    id: j.id,
    fineTunedModel: j.fine_tuned_model || null,
    baseModel: j.model,
    status: j.status,
    createdAt: j.created_at,
  }));
}

/**
 * Import an OpenAI fine-tuned model as an adapter record. Fetches the job
 * details and registers it.
 *
 * @param {string} jobId
 * @param {string} apiKey
 * @param {object} [opts] extra options — { workspaceId, scope, name }
 */
export async function importOpenAIFineTune(jobId, apiKey, opts = {}) {
  if (!jobId) throw new Error("jobId is required");
  if (!apiKey) throw new Error("apiKey is required");
  const res = await fetch(`https://api.openai.com/v1/fine_tuning/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const job = await res.json();
  if (!job?.fine_tuned_model) {
    throw new Error(`fine-tuning job ${jobId} has no fine_tuned_model (status=${job?.status})`);
  }
  return registerAdapter({
    name: opts.name || job.fine_tuned_model,
    baseModel: job.model,
    adapterType: "lora",
    source: "openai",
    sourceConfig: {
      jobId,
      fineTunedModelId: job.fine_tuned_model,
    },
    scope: opts.scope || (opts.workspaceId ? "workspace" : "global"),
    workspaceId: opts.workspaceId || null,
    description: `Imported OpenAI fine-tune ${jobId}`,
    tags: ["openai", "fine-tune"],
  });
}

// ───────────────────────── HuggingFace PEFT metadata ─────────────────────

/**
 * Fetch a HuggingFace model card for a PEFT/LoRA adapter. Metadata only —
 * does not download weights.
 *
 * @param {string} modelId e.g. "myorg/my-lora-adapter"
 */
export async function fetchHuggingFaceAdapterInfo(modelId) {
  if (!modelId) throw new Error("modelId is required");
  const url = `https://huggingface.co/api/models/${encodeURIComponent(modelId)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HuggingFace API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  return {
    modelId,
    author: body.author || null,
    sha: body.sha || null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    pipeline: body.pipeline_tag || null,
    downloads: Number(body.downloads) || 0,
    likes: Number(body.likes) || 0,
    lastModified: body.lastModified || null,
    baseModel: body?.cardData?.base_model || body?.config?.base_model_name_or_path || null,
    library: body.library_name || null,
  };
}

/** Test-only: wipe all adapter state. */
export async function _resetAdapterStoreForTest() {
  return withPathLock(DATA_FILE(), async () => {
    await saveStore(defaultStore());
  });
}
