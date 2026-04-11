// @ts-check
/**
 * Phase 61.1: API playground.
 *
 * Saves request "snippets" (method, url, headers, body) and generates
 * runnable code in curl, JavaScript (fetch), and Python (requests).
 * Persisted via `lib/json-path-store.js`.
 *
 * Export surface:
 *   - saveRequest(request)
 *   - loadRequest(id)
 *   - generateCode(request, language)
 *   - listLanguages()
 *   - listSavedRequests()
 *
 * @module api-playground
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const SUPPORTED_LANGUAGES = ["curl", "js", "python"];
const MAX_SAVED = 500;

function storePath() {
  return join(getDataDir(), "api-playground.json");
}

let _counter = 0;
function genId() {
  _counter += 1;
  return `req_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, requests: [] });
  if (!Array.isArray(data.requests)) data.requests = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    requests: Array.isArray(data.requests) ? data.requests.slice(-MAX_SAVED) : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Request normalization                                                      */
/* -------------------------------------------------------------------------- */

const VALID_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Normalize a request object; throws on invalid input.
 *
 * @param {any} request
 */
export function normalizeRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("request must be an object");
  }
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (!VALID_METHODS.has(method)) {
    throw new Error(`unsupported method: ${method}`);
  }
  const url = typeof request.url === "string" ? request.url.trim() : "";
  if (!url) throw new Error("url is required");
  const headers = {};
  if (request.headers && typeof request.headers === "object") {
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v === "string" || typeof v === "number") {
        headers[String(k)] = String(v);
      }
    }
  }
  let body = null;
  if (request.body !== undefined && request.body !== null) {
    body = request.body;
  }
  const name = typeof request.name === "string" && request.name.trim()
    ? request.name.trim()
    : `${method} ${url}`;
  return { name, method, url, headers, body };
}

/* -------------------------------------------------------------------------- */
/* Code generators                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Shell-quote a string for single-quoted bash.
 * @param {string} s
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Serialize a body for embedding in curl/js/python. Returns
 * { stringified, isJson }.
 */
function serializeBody(body) {
  if (body === null || body === undefined) return { stringified: null, isJson: false };
  if (typeof body === "string") return { stringified: body, isJson: false };
  try {
    return { stringified: JSON.stringify(body), isJson: true };
  } catch {
    return { stringified: String(body), isJson: false };
  }
}

/**
 * Generate curl code.
 *
 * @param {ReturnType<typeof normalizeRequest>} req
 */
export function generateCurl(req) {
  const parts = [`curl -X ${req.method}`];
  parts.push(shellQuote(req.url));
  const headers = { ...req.headers };
  const { stringified, isJson } = serializeBody(req.body);
  if (stringified !== null && !("Content-Type" in headers) && !("content-type" in headers)) {
    if (isJson) headers["Content-Type"] = "application/json";
  }
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (stringified !== null) {
    parts.push(`--data-raw ${shellQuote(stringified)}`);
  }
  return parts.join(" \\\n  ");
}

/**
 * Generate JavaScript (fetch) code.
 *
 * @param {ReturnType<typeof normalizeRequest>} req
 */
export function generateJs(req) {
  const headers = { ...req.headers };
  const { stringified, isJson } = serializeBody(req.body);
  if (stringified !== null && isJson && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const lines = [];
  lines.push(`const response = await fetch(${JSON.stringify(req.url)}, {`);
  lines.push(`  method: ${JSON.stringify(req.method)},`);
  if (Object.keys(headers).length > 0) {
    lines.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, "\n  ")},`);
  }
  if (stringified !== null) {
    lines.push(`  body: ${JSON.stringify(stringified)},`);
  }
  lines.push(`});`);
  lines.push(`const data = await response.json();`);
  lines.push(`console.log(data);`);
  return lines.join("\n");
}

/**
 * Generate Python (requests) code.
 *
 * @param {ReturnType<typeof normalizeRequest>} req
 */
export function generatePython(req) {
  const headers = { ...req.headers };
  const { stringified, isJson } = serializeBody(req.body);
  const lines = [`import requests`, ``];
  lines.push(`url = ${JSON.stringify(req.url)}`);
  if (Object.keys(headers).length > 0) {
    lines.push(`headers = ${pyDict(headers)}`);
  } else {
    lines.push(`headers = {}`);
  }
  if (stringified !== null) {
    if (isJson) {
      lines.push(`payload = ${pyDict(req.body)}`);
      lines.push(``);
      lines.push(`response = requests.request(${JSON.stringify(req.method.toLowerCase())}, url, headers=headers, json=payload)`);
    } else {
      lines.push(`data = ${JSON.stringify(stringified)}`);
      lines.push(``);
      lines.push(`response = requests.request(${JSON.stringify(req.method.toLowerCase())}, url, headers=headers, data=data)`);
    }
  } else {
    lines.push(``);
    lines.push(`response = requests.request(${JSON.stringify(req.method.toLowerCase())}, url, headers=headers)`);
  }
  lines.push(`print(response.json())`);
  return lines.join("\n");
}

/**
 * Render a python-ish dict literal from a JSON-serializable value.
 */
function pyDict(value) {
  const json = JSON.stringify(value, null, 2);
  return json
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate runnable code in the target language.
 *
 * @param {any} request
 * @param {string} language
 */
export function generateCode(request, language) {
  const req = normalizeRequest(request);
  const lang = String(language || "").toLowerCase();
  if (lang === "curl") return generateCurl(req);
  if (lang === "js" || lang === "javascript" || lang === "node") return generateJs(req);
  if (lang === "python" || lang === "py") return generatePython(req);
  throw new Error(`unsupported language: ${language}`);
}

/**
 * List supported code-gen languages.
 */
export function listLanguages() {
  return SUPPORTED_LANGUAGES.slice();
}

/**
 * Save a request for later reuse.
 *
 * @param {any} request
 */
export async function saveRequest(request) {
  const normalized = normalizeRequest(request);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: genId(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    data.requests.push(record);
    if (data.requests.length > MAX_SAVED) {
      data.requests = data.requests.slice(-MAX_SAVED);
    }
    await saveStore(data);
    return record;
  });
}

/**
 * Load a saved request by id.
 *
 * @param {string} id
 */
export async function loadRequest(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.requests.find((r) => r.id === id) || null;
}

/**
 * List all saved requests.
 */
export async function listSavedRequests() {
  const data = await loadStore();
  return data.requests.slice().sort((a, b) => {
    return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
  });
}

/**
 * Remove a saved request.
 *
 * @param {string} id
 */
export async function deleteRequest(id) {
  if (!id || typeof id !== "string") return { deleted: 0 };
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const before = data.requests.length;
    data.requests = data.requests.filter((r) => r.id !== id);
    await saveStore(data);
    return { deleted: before - data.requests.length };
  });
}
