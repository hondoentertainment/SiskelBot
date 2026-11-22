/**
 * Import an OpenAPI 3 document as agent tools.
 * Bearer auth comes from the workspace secrets store.
 * Calls are off unless OPENAPI_TOOLS_ENABLED=1 and the import is enabled.
 * Non-GET methods also require OPENAPI_TOOLS_WRITE=1.
 * Each host has a per-minute cap. Redirects are not followed.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { sanitizeWorkspace, sanitizeUserId } from "./storage.js";
import { getSecretValue } from "./secrets-store.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import {
  checkPolicyBeforeTool,
  createPolicyState,
  resolveEffectivePolicy,
  recordPolicyToolCompletion,
} from "./agent-policy.js";

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254.169.254"]);
const METHODS = ["get", "post", "put", "patch", "delete"];
const buckets = new Map();

export function openApiToolsEnabled() {
  return process.env.OPENAPI_TOOLS_ENABLED === "1";
}

export function openApiWriteEnabled() {
  return process.env.OPENAPI_TOOLS_WRITE === "1";
}

export function resetOpenApiHostBudgets() {
  buckets.clear();
}

export function consumeHostBudget(host, limit, now = Date.now()) {
  const cap = Math.min(60, Math.max(1, Number(limit) || 10));
  const key = String(host || "").toLowerCase();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= 60_000) {
    bucket = { start: now, count: 0 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= cap) return { ok: false, limit: cap };
  bucket.count += 1;
  return { ok: true, limit: cap, remaining: cap - bucket.count };
}

export function validateOpenApiServerUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return { ok: false, error: "servers[0].url is invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "only https OpenAPI servers are allowed" };
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { ok: false, error: "host is blocked" };
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) {
    return { ok: false, error: "private hosts are blocked" };
  }
  return { ok: true, host, origin: parsed.origin, base: parsed.href.replace(/\/$/, "") };
}

function resolveSchema(schema, components, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 4) return null;
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop();
    const target = components?.schemas?.[name];
    if (!target || target === schema) return null;
    return resolveSchema(target, components, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const resolved = resolveSchema(part, components, depth + 1);
      if (!resolved || typeof resolved !== "object") continue;
      Object.assign(merged.properties, resolved.properties || {});
      if (Array.isArray(resolved.required)) merged.required.push(...resolved.required);
    }
    return merged;
  }
  return schema;
}

function jsonType(schema) {
  const type = schema?.type;
  if (type === "number" || type === "integer" || type === "boolean" || type === "object" || type === "array") return type;
  return "string";
}

/**
 * Pull application/json requestBody fields, following local $ref and allOf.
 * @param {object} operation
 * @param {object} [components]
 */
export function extractRequestBodyFields(operation, components) {
  const content = operation?.requestBody?.content || {};
  const media = content["application/json"] || content["application/*+json"] || null;
  const schema = resolveSchema(media?.schema, components);
  if (!schema || typeof schema !== "object") return [];
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).slice(0, 20).map(([name, def]) => {
    const resolved = resolveSchema(def, components) || {};
    return {
      name: String(name).slice(0, 60),
      type: jsonType(resolved),
      required: required.has(name),
      description: typeof resolved.description === "string" ? resolved.description.slice(0, 160) : "",
    };
  }).filter((field) => field.name);
}

function coerceBodyValue(value, type) {
  if (value == null) return undefined;
  if (type === "number" || type === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (type === "object" || type === "array") {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return undefined; }
    }
    return value;
  }
  if (typeof value === "string") return value.slice(0, 4000);
  return value;
}

/**
 * Build a JSON body from tool args using the stored requestBody fields.
 * Query-parameter names are left out of the body.
 */
export function buildJsonRequestBody(args, bodyFields, queryNames = []) {
  const source = args && typeof args === "object" ? args : {};
  const skip = new Set(queryNames);
  const fields = Array.isArray(bodyFields) ? bodyFields : [];
  const body = {};
  const missing = [];
  if (fields.length) {
    for (const field of fields) {
      if (skip.has(field.name)) continue;
      const value = coerceBodyValue(source[field.name], field.type);
      if (value === undefined) {
        if (field.required) missing.push(field.name);
        continue;
      }
      body[field.name] = value;
    }
  } else if (source.body && typeof source.body === "object" && !Array.isArray(source.body)) {
    for (const [key, value] of Object.entries(source.body).slice(0, 20)) {
      if (!skip.has(key)) body[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(source).slice(0, 20)) {
      if (skip.has(key) || key === "body") continue;
      body[key] = value;
    }
  }
  return { body, missing };
}

function safeOperationId(method, path, operationId) {
  const raw = String(operationId || `${method}_${path}`).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
  return raw || `${method}_op`;
}

export function parseOpenApiSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    const err = new Error("OpenAPI spec must be a JSON object");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (!String(spec.openapi || "").startsWith("3.")) {
    const err = new Error("Only OpenAPI 3.x documents can be imported");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const server = validateOpenApiServerUrl(spec.servers?.[0]?.url);
  if (!server.ok) {
    const err = new Error(server.error);
    err.code = "INVALID_INPUT";
    throw err;
  }
  const operations = [];
  const paths = spec.paths && typeof spec.paths === "object" ? spec.paths : {};
  const components = spec.components && typeof spec.components === "object" ? spec.components : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object" || !path.startsWith("/")) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const parameters = Array.isArray(op.parameters)
        ? op.parameters
            .filter((p) => p && p.in === "query" && typeof p.name === "string")
            .slice(0, 12)
            .map((p) => ({ name: p.name.slice(0, 60), required: p.required === true }))
        : [];
      operations.push({
        method,
        path: path.slice(0, 180),
        operationId: safeOperationId(method, path, op.operationId),
        summary: String(op.summary || op.operationId || `${method} ${path}`).slice(0, 200),
        parameters,
        bodyFields: method === "get" ? [] : extractRequestBodyFields(op, components),
      });
      if (operations.length >= 40) break;
    }
    if (operations.length >= 40) break;
  }
  if (!operations.length) {
    const err = new Error("Spec has no operations");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return { host: server.host, baseUrl: server.base, operations };
}

function storePath(workspaceId) {
  return join(getDataDir(), "openapi-tools", `${sanitizeWorkspace(workspaceId)}.json`);
}

function toPublic(doc) {
  return {
    id: doc.id,
    name: doc.name,
    host: doc.host,
    baseUrl: doc.baseUrl,
    enabled: doc.enabled === true,
    authConfigured: Boolean(doc.authSecretName),
    maxPerMinute: doc.maxPerMinute,
    operations: (doc.operations || []).map((op) => ({
      name: op.exposedName,
      method: op.method,
      path: op.path,
      summary: op.summary,
    })),
    createdAt: doc.createdAt,
  };
}

export async function listOpenApiImports(workspaceId) {
  const store = await readJsonPath(storePath(workspaceId), { imports: [] });
  return (store.imports || []).map(toPublic);
}

export async function importOpenApiSpec(workspaceId, input = {}) {
  const raw = input.spec;
  const parsed = parseOpenApiSpec(raw);
  const maxPerMinute = Math.min(60, Math.max(1, Number(input.maxPerMinute) || 10));
  const id = randomUUID();
  const bare = id.replace(/-/g, "");
  const doc = {
    id,
    name: String(input.name || parsed.host).trim().slice(0, 120) || parsed.host,
    host: parsed.host,
    baseUrl: parsed.baseUrl,
    enabled: input.enabled === true,
    authSecretName: typeof input.authSecretName === "string" ? input.authSecretName.trim().slice(0, 80) : "",
    maxPerMinute,
    operations: parsed.operations.map((op, index) => ({
      ...op,
      exposedName: `oapi_${bare}_${index}`,
    })),
    createdAt: new Date().toISOString(),
  };
  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { imports: [] });
    if (!Array.isArray(store.imports)) store.imports = [];
    if (store.imports.length >= 10) {
      const err = new Error("Maximum number of OpenAPI imports reached");
      err.code = "LIMIT_EXCEEDED";
      throw err;
    }
    store.imports.push(doc);
    await writeJsonPath(path, store);
  });
  return toPublic(doc);
}

export async function deleteOpenApiImport(workspaceId, id) {
  const path = storePath(workspaceId);
  let removed = false;
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { imports: [] });
    const before = (store.imports || []).length;
    store.imports = (store.imports || []).filter((doc) => doc.id !== id);
    removed = store.imports.length < before;
    if (removed) await writeJsonPath(path, store);
  });
  return removed;
}

export async function openApiToolDefs(workspaceId) {
  if (!openApiToolsEnabled()) return [];
  const store = await readJsonPath(storePath(workspaceId), { imports: [] });
  const defs = [];
  for (const doc of store.imports || []) {
    if (doc.enabled !== true) continue;
    for (const op of doc.operations || []) {
      if (op.method !== "get" && !openApiWriteEnabled()) continue;
      const properties = {};
      const required = [];
      for (const param of op.parameters || []) {
        properties[param.name] = { type: "string" };
        if (param.required) required.push(param.name);
      }
      for (const field of op.bodyFields || []) {
        if (properties[field.name]) continue;
        properties[field.name] = {
          type: field.type === "integer" ? "number" : (field.type || "string"),
          ...(field.description ? { description: field.description } : {}),
        };
        if (field.required) required.push(field.name);
      }
      defs.push({
        type: "function",
        function: {
          name: op.exposedName,
          description: `[OpenAPI ${doc.name}] ${op.method.toUpperCase()} ${op.path} — ${op.summary}`,
          parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
        },
      });
    }
  }
  return defs;
}

function findOperation(store, name) {
  for (const doc of store.imports || []) {
    const op = (doc.operations || []).find((item) => item.exposedName === name);
    if (op) return { doc, op };
  }
  return null;
}

export async function invokeOpenApiTool(name, args, ctx = {}, deps = {}) {
  if (!String(name).startsWith("oapi_")) {
    return { content: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }), ok: false };
  }
  if (!openApiToolsEnabled()) {
    return {
      content: JSON.stringify({ ok: false, code: "OPENAPI_DISABLED", error: "Set OPENAPI_TOOLS_ENABLED=1 to call imported tools" }),
      ok: false,
    };
  }
  const workspace = ctx.workspace || "default";
  const store = await readJsonPath(storePath(workspace), { imports: [] });
  const found = findOperation(store, name);
  if (!found || found.doc.enabled !== true) {
    return { content: JSON.stringify({ ok: false, code: "NOT_FOUND", error: "OpenAPI tool is not enabled" }), ok: false };
  }
  if (found.op.method !== "get" && !openApiWriteEnabled()) {
    return {
      content: JSON.stringify({ ok: false, code: "OPENAPI_WRITE_DISABLED", error: "Non-GET OpenAPI tools require OPENAPI_TOOLS_WRITE=1" }),
      ok: false,
    };
  }
  const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
  const settings = await loadWorkspaceAgentSettings(uid, workspace);
  const state = createPolicyState(resolveEffectivePolicy(settings.agentPolicy || {}), {
    deniedTools: settings.agentPolicy?.deniedTools || [],
  });
  const verdict = checkPolicyBeforeTool(state, name, args);
  if (!verdict.ok) {
    return { content: JSON.stringify({ ok: false, code: verdict.code, error: verdict.reason }), ok: false };
  }
  const query = args && typeof args === "object" ? args : {};
  const queryNames = (found.op.parameters || []).map((param) => param.name);
  const built = buildJsonRequestBody(query, found.op.bodyFields, queryNames);
  if (found.op.method !== "get" && built.missing.length) {
    return {
      content: JSON.stringify({
        ok: false,
        code: "INVALID_INPUT",
        error: `Missing request body fields: ${built.missing.join(", ")}`,
      }),
      ok: false,
    };
  }
  const budget = consumeHostBudget(found.doc.host, found.doc.maxPerMinute, deps.now);
  if (!budget.ok) {
    return {
      content: JSON.stringify({ ok: false, code: "HOST_RATE_LIMIT", error: `Host cap ${budget.limit}/min reached for ${found.doc.host}` }),
      ok: false,
    };
  }
  const root = found.doc.baseUrl.endsWith("/") ? found.doc.baseUrl.slice(0, -1) : found.doc.baseUrl;
  const suffix = found.op.path.startsWith("/") ? found.op.path : `/${found.op.path}`;
  const url = new URL(`${root}${suffix}`);
  for (const param of found.op.parameters || []) {
    if (query[param.name] != null) url.searchParams.set(param.name, String(query[param.name]).slice(0, 500));
  }
  const headers = { Accept: "application/json" };
  let requestBody;
  if (found.op.method !== "get") {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(built.body);
  }
  if (found.doc.authSecretName) {
    const secret = await getSecretValue("workspace", sanitizeWorkspace(workspace), found.doc.authSecretName);
    if (!secret) {
      return { content: JSON.stringify({ ok: false, code: "AUTH_SECRET_MISSING", error: "Workspace auth secret is not set" }), ok: false };
    }
    headers.Authorization = `Bearer ${secret}`;
  }
  const fetcher = deps.fetchImpl || globalThis.fetch;
  const started = Date.now();
  try {
    const res = await fetcher(url.toString(), {
      method: found.op.method.toUpperCase(),
      headers,
      redirect: "manual",
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      return { content: JSON.stringify({ ok: false, code: "REDIRECT_BLOCKED", error: "Redirects are not followed" }), ok: false };
    }
    const text = typeof res.text === "function" ? await res.text() : "";
    recordPolicyToolCompletion(state, name, Date.now() - started);
    return {
      content: JSON.stringify({ ok: res.ok !== false && res.status < 400, status: res.status, body: String(text).slice(0, 4000) }),
      ok: res.ok !== false && res.status < 400,
    };
  } catch (err) {
    return { content: JSON.stringify({ ok: false, code: "OPENAPI_CALL_FAILED", error: err.message }), ok: false };
  }
}
