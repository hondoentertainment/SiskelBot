// @ts-check
/**
 * Phase 62.3: Response drafting.
 *
 * Tone-controlled reply generation: template + optional LLM callback.
 *
 *   - `createTemplate(name, body, opts)` — register a Mustache-like template
 *   - `listTemplates()` — list registered templates
 *   - `setTone(name, tone)` — assign a tone to a template
 *   - `preview(templateName, vars)` — render without persisting
 *   - `draftResponse(opts)` — template render + optional LLM polish
 *
 * Templates use `{{var}}` placeholders. Tones map to phrase substitutions.
 *
 * @module response-drafting
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const TONE_MODIFIERS = {
  formal: {
    greeting: "Dear",
    closing: "Sincerely",
    apologyPrefix: "We sincerely regret",
    thankPrefix: "We appreciate",
  },
  friendly: {
    greeting: "Hi",
    closing: "Thanks",
    apologyPrefix: "I'm so sorry",
    thankPrefix: "Thanks so much",
  },
  empathetic: {
    greeting: "Hi",
    closing: "Take care",
    apologyPrefix: "I completely understand, and I'm sorry",
    thankPrefix: "Thank you for",
  },
  concise: {
    greeting: "Hello",
    closing: "Thanks",
    apologyPrefix: "Sorry",
    thankPrefix: "Thanks for",
  },
};

function templatesPath() {
  return join(getDataDir(), "response-drafting-templates.json");
}

async function loadTemplates() {
  const data = await readJsonPath(templatesPath(), { version: STORE_VERSION, templates: {} });
  if (!data.templates || typeof data.templates !== "object") data.templates = {};
  return data;
}

async function saveTemplates(data) {
  await writeJsonPath(templatesPath(), { version: STORE_VERSION, templates: data.templates || {} });
}

/* -------------------------------------------------------------------------- */
/* Template CRUD                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Create or replace a named template.
 *
 * @param {string} name
 * @param {string} body
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function createTemplate(name, body, opts = {}) {
  if (!name || typeof name !== "string") throw new Error("template name is required");
  if (typeof body !== "string") throw new Error("template body must be a string");
  const path = templatesPath();
  return withPathLock(path, async () => {
    const data = await loadTemplates();
    const now = new Date().toISOString();
    const existing = data.templates[name] || { createdAt: now };
    data.templates[name] = {
      ...existing,
      name,
      body,
      tone: opts.tone || existing.tone || "friendly",
      description: opts.description || existing.description || "",
      variables: Array.isArray(opts.variables) ? opts.variables : extractVariables(body),
      updatedAt: now,
    };
    await saveTemplates(data);
    return data.templates[name];
  });
}

/** Return every registered template. */
export async function listTemplates() {
  const data = await loadTemplates();
  return Object.values(data.templates || {});
}

/**
 * Change a template's tone.
 *
 * @param {string} name
 * @param {string} tone
 * @returns {Promise<object>}
 */
export async function setTone(name, tone) {
  if (!name || typeof name !== "string") throw new Error("template name is required");
  if (!TONE_MODIFIERS[tone]) throw new Error(`unknown tone "${tone}"`);
  const path = templatesPath();
  return withPathLock(path, async () => {
    const data = await loadTemplates();
    const tmpl = data.templates[name];
    if (!tmpl) throw new Error(`template "${name}" not found`);
    tmpl.tone = tone;
    tmpl.updatedAt = new Date().toISOString();
    await saveTemplates(data);
    return tmpl;
  });
}

/**
 * Extract `{{var}}` names from a template body.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function extractVariables(body) {
  if (typeof body !== "string") return [];
  const out = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

/**
 * Render a template with variables.
 *
 * @param {string} body
 * @param {Record<string, any>} vars
 * @returns {string}
 */
export function renderTemplate(body, vars) {
  if (typeof body !== "string") return "";
  const safeVars = vars && typeof vars === "object" ? vars : {};
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    if (Object.prototype.hasOwnProperty.call(safeVars, key)) {
      const v = safeVars[key];
      return v == null ? "" : String(v);
    }
    return `{{${key}}}`;
  });
}

/**
 * Apply tone substitutions to rendered text. This replaces `{{greeting}}`
 * etc. already, but then also substitutes the `__TONE_*__` markers if
 * authors prefer explicit tone slots.
 *
 * @param {string} text
 * @param {string} tone
 * @returns {string}
 */
export function applyTone(text, tone) {
  const mods = TONE_MODIFIERS[tone] || TONE_MODIFIERS.friendly;
  return text
    .replace(/__GREETING__/g, mods.greeting)
    .replace(/__CLOSING__/g, mods.closing)
    .replace(/__APOLOGY__/g, mods.apologyPrefix)
    .replace(/__THANK__/g, mods.thankPrefix);
}

/**
 * Preview a render of a template without side effects.
 *
 * @param {string} templateName
 * @param {Record<string, any>} vars
 * @returns {Promise<{ name: string, text: string, tone: string, missingVars: string[] }>}
 */
export async function preview(templateName, vars = {}) {
  const data = await loadTemplates();
  const tmpl = data.templates[templateName];
  if (!tmpl) throw new Error(`template "${templateName}" not found`);
  const needed = extractVariables(tmpl.body);
  const missing = needed.filter((v) => !(v in (vars || {})));
  const rendered = renderTemplate(tmpl.body, vars);
  const toned = applyTone(rendered, tmpl.tone);
  return { name: tmpl.name, text: toned, tone: tmpl.tone, missingVars: missing };
}

/* -------------------------------------------------------------------------- */
/* Response drafting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} DraftOptions
 * @property {string} [templateName] Named template to use.
 * @property {string} [body]         Inline template body (overrides template lookup).
 * @property {string} [tone]         Override tone.
 * @property {Record<string, any>} [vars] Variables to interpolate.
 * @property {(input: string) => Promise<string>} [llm] Optional LLM polish callback.
 */

/**
 * Draft a reply. If `templateName` is given we fetch it; otherwise `body`
 * is treated as the template. Returns rendered + optional polished text.
 *
 * @param {DraftOptions} opts
 * @returns {Promise<{ text: string, rendered: string, tone: string, polished: boolean }>}
 */
export async function draftResponse(opts = {}) {
  let body = typeof opts.body === "string" ? opts.body : "";
  let tone = opts.tone;
  if (opts.templateName) {
    const data = await loadTemplates();
    const tmpl = data.templates[opts.templateName];
    if (!tmpl) throw new Error(`template "${opts.templateName}" not found`);
    body = tmpl.body;
    tone = tone || tmpl.tone;
  }
  if (!body) throw new Error("templateName or body is required");
  tone = tone || "friendly";
  if (!TONE_MODIFIERS[tone]) throw new Error(`unknown tone "${tone}"`);
  const rendered = renderTemplate(body, opts.vars || {});
  const toned = applyTone(rendered, tone);
  let text = toned;
  let polished = false;
  if (typeof opts.llm === "function") {
    try {
      const out = await opts.llm(toned);
      if (out && typeof out === "string") {
        text = out;
        polished = true;
      }
    } catch (_err) {
      // LLM polish is best-effort — fall back to rendered text.
    }
  }
  return { text, rendered: toned, tone, polished };
}

/** List every supported tone. */
export function listTones() {
  return Object.keys(TONE_MODIFIERS);
}
