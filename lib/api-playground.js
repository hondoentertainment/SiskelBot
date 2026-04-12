/**
 * Phase 61.1: API playground — interactive console with code generation.
 *
 * Code generators for curl, JavaScript (fetch), Python (requests),
 * Go (net/http), Rust (reqwest), and Ruby (net/http).
 *
 * Storage layout (via json-path-store):
 *   data/playground/history/{userId}.json        — request history
 *   data/playground/collections/_index.json      — collection ids index
 *   data/playground/collections/{id}.json        — collection record
 *   data/playground/environments/{userId}.json   — envs per user
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function historyPath(userId) {
  return join(getDataDir(), "playground", "history", `${sanitize(userId)}.json`);
}

function collectionPath(id) {
  return join(getDataDir(), "playground", "collections", `${sanitize(id)}.json`);
}

function collectionsIndexPath() {
  return join(getDataDir(), "playground", "collections", "_index.json");
}

function environmentsPath(userId) {
  return join(getDataDir(), "playground", "environments", `${sanitize(userId)}.json`);
}

function genId(prefix) {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

// ─── Code generators ────────────────────────────────────────────────────────

/**
 * Shell-escape a string for POSIX single-quoted context: ' -> '\'' .
 */
function shellSingleQuote(s) {
  if (s == null) return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function ensureBodyString(body) {
  if (body == null || body === "") return null;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function methodUpper(method) {
  return String(method || "GET").toUpperCase();
}

export function generateCurl(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const lines = [`curl -X ${m} ${shellSingleQuote(endpoint)}`];
  for (const [k, v] of Object.entries(headers || {})) {
    lines.push(`  -H ${shellSingleQuote(`${k}: ${v}`)}`);
  }
  const bodyStr = ensureBodyString(body);
  if (bodyStr && m !== "GET" && m !== "DELETE") {
    lines.push(`  --data ${shellSingleQuote(bodyStr)}`);
  }
  return lines.join(" \\\n");
}

export function generateJavaScript(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const bodyStr = ensureBodyString(body);
  const opts = { method: m };
  if (Object.keys(headers || {}).length) {
    opts.headers = headers;
  }
  let optsJson = JSON.stringify(opts, null, 2);
  if (bodyStr && m !== "GET" && m !== "DELETE") {
    // Inject body as template string literal so nested JSON isn't double-escaped.
    const escaped = bodyStr.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    optsJson = optsJson.replace(/\n}$/, `,\n  "body": \`${escaped}\`\n}`);
  }
  return [
    `const response = await fetch(${JSON.stringify(endpoint)}, ${optsJson});`,
    `const data = await response.json();`,
    `console.log(data);`,
  ].join("\n");
}

export function generatePython(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const lines = [`import requests`, ``];
  lines.push(`url = ${JSON.stringify(endpoint)}`);
  if (Object.keys(headers || {}).length) {
    lines.push(`headers = ${JSON.stringify(headers, null, 4).replace(/"/g, '"')}`);
  } else {
    lines.push(`headers = {}`);
  }
  const bodyStr = ensureBodyString(body);
  if (bodyStr && m !== "GET" && m !== "DELETE") {
    // Use a triple-quoted raw-ish string so embedded quotes survive.
    lines.push(`data = """${bodyStr.replace(/"""/g, '\\"\\"\\"')}"""`);
    lines.push(`response = requests.request(${JSON.stringify(m.toLowerCase())}, url, headers=headers, data=data)`);
  } else {
    lines.push(`response = requests.request(${JSON.stringify(m.toLowerCase())}, url, headers=headers)`);
  }
  lines.push(`print(response.status_code)`);
  lines.push(`print(response.text)`);
  return lines.join("\n");
}

export function generateGo(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const bodyStr = ensureBodyString(body);
  const hasBody = bodyStr && m !== "GET" && m !== "DELETE";
  const lines = [
    `package main`,
    ``,
    `import (`,
    `\t"fmt"`,
    `\t"io"`,
    `\t"net/http"`,
  ];
  if (hasBody) lines.push(`\t"strings"`);
  lines.push(`)`);
  lines.push(``);
  lines.push(`func main() {`);
  if (hasBody) {
    lines.push(`\tbody := strings.NewReader(${JSON.stringify(bodyStr)})`);
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(m)}, ${JSON.stringify(endpoint)}, body)`);
  } else {
    lines.push(`\treq, err := http.NewRequest(${JSON.stringify(m)}, ${JSON.stringify(endpoint)}, nil)`);
  }
  lines.push(`\tif err != nil { panic(err) }`);
  for (const [k, v] of Object.entries(headers || {})) {
    lines.push(`\treq.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(String(v))})`);
  }
  lines.push(`\tresp, err := http.DefaultClient.Do(req)`);
  lines.push(`\tif err != nil { panic(err) }`);
  lines.push(`\tdefer resp.Body.Close()`);
  lines.push(`\tb, _ := io.ReadAll(resp.Body)`);
  lines.push(`\tfmt.Println(resp.StatusCode)`);
  lines.push(`\tfmt.Println(string(b))`);
  lines.push(`}`);
  return lines.join("\n");
}

export function generateRust(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const bodyStr = ensureBodyString(body);
  const methodCall = {
    GET: "get",
    POST: "post",
    PUT: "put",
    PATCH: "patch",
    DELETE: "delete",
    HEAD: "head",
  }[m] || "request";

  const lines = [
    `use reqwest::blocking::Client;`,
    ``,
    `fn main() -> Result<(), Box<dyn std::error::Error>> {`,
    `    let client = Client::new();`,
  ];
  let builder;
  if (methodCall === "request") {
    builder = `client.request(reqwest::Method::from_bytes(b${JSON.stringify(m)})?, ${JSON.stringify(endpoint)})`;
  } else {
    builder = `client.${methodCall}(${JSON.stringify(endpoint)})`;
  }
  lines.push(`    let mut req = ${builder};`);
  for (const [k, v] of Object.entries(headers || {})) {
    lines.push(`    req = req.header(${JSON.stringify(k)}, ${JSON.stringify(String(v))});`);
  }
  if (bodyStr && m !== "GET" && m !== "DELETE") {
    lines.push(`    req = req.body(${JSON.stringify(bodyStr)});`);
  }
  lines.push(`    let resp = req.send()?;`);
  lines.push(`    println!("{}", resp.status());`);
  lines.push(`    println!("{}", resp.text()?);`);
  lines.push(`    Ok(())`);
  lines.push(`}`);
  return lines.join("\n");
}

export function generateRuby(endpoint, method, body, headers = {}) {
  const m = methodUpper(method);
  const bodyStr = ensureBodyString(body);
  const klass = {
    GET: "Net::HTTP::Get",
    POST: "Net::HTTP::Post",
    PUT: "Net::HTTP::Put",
    PATCH: "Net::HTTP::Patch",
    DELETE: "Net::HTTP::Delete",
    HEAD: "Net::HTTP::Head",
  }[m] || "Net::HTTP::Get";
  const lines = [
    `require "net/http"`,
    `require "uri"`,
    ``,
    `uri = URI(${JSON.stringify(endpoint)})`,
    `http = Net::HTTP.new(uri.host, uri.port)`,
    `http.use_ssl = (uri.scheme == "https")`,
    `request = ${klass}.new(uri.request_uri)`,
  ];
  for (const [k, v] of Object.entries(headers || {})) {
    lines.push(`request[${JSON.stringify(k)}] = ${JSON.stringify(String(v))}`);
  }
  if (bodyStr && m !== "GET" && m !== "DELETE") {
    lines.push(`request.body = ${JSON.stringify(bodyStr)}`);
  }
  lines.push(`response = http.request(request)`);
  lines.push(`puts response.code`);
  lines.push(`puts response.body`);
  return lines.join("\n");
}

export const CODE_GENERATORS = {
  curl: generateCurl,
  javascript: generateJavaScript,
  python: generatePython,
  go: generateGo,
  rust: generateRust,
  ruby: generateRuby,
};

/**
 * Dispatch to a code generator by language.
 * @param {string} lang
 * @param {{ endpoint: string, method: string, body?: any, headers?: object }} request
 */
export function generateCode(lang, request) {
  const key = String(lang || "").toLowerCase();
  const fn = CODE_GENERATORS[key];
  if (!fn) throw new Error(`Unsupported language: ${lang}`);
  const { endpoint, method, body, headers } = request || {};
  return fn(endpoint, method, body, headers || {});
}

export function listSupportedLanguages() {
  return Object.keys(CODE_GENERATORS);
}

// ─── Request history ────────────────────────────────────────────────────────

const MAX_HISTORY = 500;

export async function saveRequest(userId, request) {
  if (!request || typeof request !== "object") throw new Error("request is required");
  const id = request.id || genId("req");
  const entry = {
    id,
    createdAt: new Date().toISOString(),
    endpoint: request.endpoint || "",
    method: methodUpper(request.method),
    body: request.body ?? null,
    headers: request.headers || {},
    status: request.status ?? null,
    elapsedMs: request.elapsedMs ?? null,
    name: request.name || null,
  };
  await withPathLock(historyPath(userId), async () => {
    const data = await readJsonPath(historyPath(userId), { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    items.unshift(entry);
    if (items.length > MAX_HISTORY) items.length = MAX_HISTORY;
    await writeJsonPath(historyPath(userId), { items });
  });
  return entry;
}

export async function getHistory(userId, limit = 50) {
  const data = await readJsonPath(historyPath(userId), { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  const n = Math.max(0, Math.min(items.length, Number(limit) || 50));
  return items.slice(0, n);
}

export async function clearHistory(userId) {
  await writeJsonPath(historyPath(userId), { items: [] });
  return { ok: true };
}

export async function getSavedRequest(requestId) {
  // Scans all user histories — used rarely (e.g. deep-link lookup).
  // Since history is per-user and we don't know userId here, iterate via
  // the index we keep in memory? Without an index we just return null unless
  // caller passes userId. To support the API contract, we try a few known
  // user ids from the "index". Implementation: walk all files we can find
  // by reading the index of playground users if available, otherwise return null.
  // For simplicity and determinism in tests, we attempt lookup using a
  // per-request index file:
  const idxPath = join(getDataDir(), "playground", "history", "_request_index.json");
  const idx = await readJsonPath(idxPath, { map: {} });
  const userId = idx.map ? idx.map[requestId] : null;
  if (!userId) return null;
  const data = await readJsonPath(historyPath(userId), { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  return items.find((it) => it.id === requestId) || null;
}

async function recordRequestIndex(userId, requestId) {
  const idxPath = join(getDataDir(), "playground", "history", "_request_index.json");
  await withPathLock(idxPath, async () => {
    const idx = await readJsonPath(idxPath, { map: {} });
    if (!idx.map) idx.map = {};
    idx.map[requestId] = userId;
    await writeJsonPath(idxPath, idx);
  });
}

// Patch saveRequest to also record the id->user mapping.
const _origSaveRequest = saveRequest;
export async function saveRequestAndIndex(userId, request) {
  const entry = await _origSaveRequest(userId, request);
  await recordRequestIndex(userId, entry.id);
  return entry;
}

// ─── Collections ────────────────────────────────────────────────────────────

async function updateCollectionsIndex(id, ownerId, name, remove = false) {
  await withPathLock(collectionsIndexPath(), async () => {
    const idx = await readJsonPath(collectionsIndexPath(), { items: [] });
    const items = Array.isArray(idx.items) ? idx.items : [];
    const filtered = items.filter((it) => it.id !== id);
    if (!remove) filtered.push({ id, ownerId, name });
    await writeJsonPath(collectionsIndexPath(), { items: filtered });
  });
}

export async function createCollection(userId, name, requests = []) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  const id = genId("col");
  const now = new Date().toISOString();
  const record = {
    id,
    ownerId: userId,
    name,
    createdAt: now,
    updatedAt: now,
    requests: Array.isArray(requests) ? requests.map((r) => ({
      id: r.id || genId("req"),
      endpoint: r.endpoint || "",
      method: methodUpper(r.method),
      body: r.body ?? null,
      headers: r.headers || {},
      name: r.name || null,
    })) : [],
  };
  await writeJsonPath(collectionPath(id), record);
  await updateCollectionsIndex(id, userId, name, false);
  return record;
}

export async function getCollection(collectionId) {
  const rec = await readJsonPath(collectionPath(collectionId), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listCollections(userId) {
  const idx = await readJsonPath(collectionsIndexPath(), { items: [] });
  const items = Array.isArray(idx.items) ? idx.items : [];
  const filtered = userId ? items.filter((it) => it.ownerId === userId) : items;
  const records = [];
  for (const it of filtered) {
    const rec = await getCollection(it.id);
    if (rec) records.push(rec);
  }
  return records;
}

export async function addRequestToCollection(collectionId, request) {
  return withPathLock(collectionPath(collectionId), async () => {
    const rec = await readJsonPath(collectionPath(collectionId), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`collection ${collectionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const entry = {
      id: request?.id || genId("req"),
      endpoint: request?.endpoint || "",
      method: methodUpper(request?.method),
      body: request?.body ?? null,
      headers: request?.headers || {},
      name: request?.name || null,
    };
    rec.requests = Array.isArray(rec.requests) ? rec.requests : [];
    rec.requests.push(entry);
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(collectionPath(collectionId), rec);
    return entry;
  });
}

export async function removeRequestFromCollection(collectionId, requestId) {
  return withPathLock(collectionPath(collectionId), async () => {
    const rec = await readJsonPath(collectionPath(collectionId), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`collection ${collectionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const before = Array.isArray(rec.requests) ? rec.requests.length : 0;
    rec.requests = (rec.requests || []).filter((r) => r.id !== requestId);
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(collectionPath(collectionId), rec);
    return { ok: rec.requests.length < before };
  });
}

export async function deleteCollection(collectionId) {
  const rec = await readJsonPath(collectionPath(collectionId), null);
  if (!rec || !rec.id) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(collectionPath(collectionId), { _deleted: true });
  await updateCollectionsIndex(collectionId, rec.ownerId, rec.name, true);
  return { ok: true };
}

// ─── Environments ───────────────────────────────────────────────────────────

export async function saveEnvironment(userId, envName, vars) {
  if (!envName || typeof envName !== "string") throw new Error("envName is required");
  const safe = sanitize(envName);
  return withPathLock(environmentsPath(userId), async () => {
    const data = await readJsonPath(environmentsPath(userId), { envs: {} });
    if (!data.envs) data.envs = {};
    data.envs[safe] = {
      name: envName,
      vars: vars && typeof vars === "object" ? { ...vars } : {},
      updatedAt: new Date().toISOString(),
    };
    await writeJsonPath(environmentsPath(userId), data);
    return data.envs[safe];
  });
}

export async function getEnvironment(userId, envName) {
  const data = await readJsonPath(environmentsPath(userId), { envs: {} });
  const safe = sanitize(envName);
  return (data.envs && data.envs[safe]) || null;
}

export async function listEnvironments(userId) {
  const data = await readJsonPath(environmentsPath(userId), { envs: {} });
  return Object.values(data.envs || {});
}

// ─── Variable substitution ──────────────────────────────────────────────────

/**
 * Replace {{name}} tokens in a template with values from the `variables` map.
 * Works on strings, objects, and arrays. Unknown tokens are left intact.
 */
export function substituteVariables(template, variables) {
  const vars = variables && typeof variables === "object" ? variables : {};
  if (template == null) return template;
  if (typeof template === "string") {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(vars, key)) {
        const v = vars[key];
        return v == null ? "" : String(v);
      }
      return match;
    });
  }
  if (Array.isArray(template)) {
    return template.map((item) => substituteVariables(item, vars));
  }
  if (typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      out[substituteVariables(k, vars)] = substituteVariables(v, vars);
    }
    return out;
  }
  return template;
}

// ─── Import / export ────────────────────────────────────────────────────────

export function exportCollection(collection, format = "json") {
  if (!collection || typeof collection !== "object") {
    throw new Error("collection is required");
  }
  const fmt = String(format || "json").toLowerCase();
  const payload = {
    schema: "siskelbot.playground.collection/v1",
    name: collection.name || "",
    requests: Array.isArray(collection.requests) ? collection.requests : [],
    exportedAt: new Date().toISOString(),
  };
  if (fmt === "json") {
    return JSON.stringify(payload, null, 2);
  }
  if (fmt === "postman") {
    return JSON.stringify(toPostmanCollection(payload), null, 2);
  }
  throw new Error(`Unsupported export format: ${format}`);
}

export function importCollection(data, format = "json") {
  const fmt = String(format || "json").toLowerCase();
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  if (fmt === "json") {
    return {
      name: parsed?.name || "Imported collection",
      requests: Array.isArray(parsed?.requests) ? parsed.requests.map(normalizeRequest) : [],
    };
  }
  if (fmt === "postman") {
    return importPostmanCollection(parsed);
  }
  throw new Error(`Unsupported import format: ${format}`);
}

function normalizeRequest(r) {
  return {
    id: r?.id || genId("req"),
    endpoint: r?.endpoint || r?.url || "",
    method: methodUpper(r?.method),
    body: r?.body ?? null,
    headers: r?.headers || {},
    name: r?.name || null,
  };
}

/**
 * Transform a Postman v2.1 collection JSON into our native shape.
 */
export function importPostmanCollection(postmanJson) {
  const json = typeof postmanJson === "string" ? JSON.parse(postmanJson) : postmanJson;
  const info = json?.info || {};
  const items = Array.isArray(json?.item) ? json.item : [];
  const requests = [];
  function walk(nodes) {
    for (const node of nodes) {
      if (Array.isArray(node?.item)) {
        walk(node.item);
        continue;
      }
      const req = node?.request;
      if (!req) continue;
      const url = typeof req.url === "string" ? req.url : (req.url?.raw || "");
      const headers = {};
      if (Array.isArray(req.header)) {
        for (const h of req.header) {
          if (h?.key) headers[h.key] = h.value ?? "";
        }
      }
      let body = null;
      if (req.body) {
        if (req.body.mode === "raw") body = req.body.raw ?? "";
        else if (req.body.mode === "urlencoded" && Array.isArray(req.body.urlencoded)) {
          body = req.body.urlencoded.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? "")}`).join("&");
        }
      }
      requests.push({
        id: genId("req"),
        endpoint: url,
        method: methodUpper(req.method),
        body,
        headers,
        name: node?.name || null,
      });
    }
  }
  walk(items);
  return {
    name: info?.name || "Imported from Postman",
    requests,
  };
}

function toPostmanCollection(nativeCollection) {
  return {
    info: {
      name: nativeCollection.name || "SiskelBot export",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: (nativeCollection.requests || []).map((r) => ({
      name: r.name || `${methodUpper(r.method)} ${r.endpoint}`,
      request: {
        method: methodUpper(r.method),
        header: Object.entries(r.headers || {}).map(([key, value]) => ({ key, value: String(value) })),
        body: r.body == null ? undefined : { mode: "raw", raw: typeof r.body === "string" ? r.body : JSON.stringify(r.body) },
        url: { raw: r.endpoint || "" },
      },
    })),
  };
}

// ─── OpenAPI integration ────────────────────────────────────────────────────

/**
 * Parse an OpenAPI 3.x spec and return a flat list of endpoints usable by the
 * playground UI: { method, path, operationId, summary, parameters, requestBody }.
 */
export async function getEndpointsFromSpec(openapiSpec) {
  const spec = typeof openapiSpec === "string" ? JSON.parse(openapiSpec) : openapiSpec;
  const out = [];
  const paths = spec?.paths || {};
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of methods) {
      const op = pathItem[method];
      if (!op || typeof op !== "object") continue;
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId || null,
        summary: op.summary || "",
        description: op.description || "",
        parameters: Array.isArray(op.parameters) ? op.parameters : [],
        requestBody: op.requestBody || null,
        tags: Array.isArray(op.tags) ? op.tags : [],
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return out;
}

/**
 * Build a concrete request (endpoint, method, headers, body) from an OpenAPI
 * operation and a params map. `params` supplies path/query/header/body values.
 */
export async function generateRequestFromOperation(operation, params = {}) {
  if (!operation || typeof operation !== "object") {
    throw new Error("operation is required");
  }
  let path = operation.path || "";
  const query = [];
  const headers = {};
  let body = null;

  for (const p of operation.parameters || []) {
    const name = p?.name;
    if (!name) continue;
    const val = params[name];
    if (val === undefined) continue;
    if (p.in === "path") {
      path = path.replace(new RegExp(`\\{${name}\\}`, "g"), encodeURIComponent(String(val)));
    } else if (p.in === "query") {
      query.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(val))}`);
    } else if (p.in === "header") {
      headers[name] = String(val);
    }
  }

  if (operation.requestBody && params.body !== undefined) {
    body = params.body;
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const endpoint = query.length ? `${path}?${query.join("&")}` : path;
  return {
    method: methodUpper(operation.method),
    endpoint,
    headers,
    body,
  };
}
