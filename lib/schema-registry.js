/**
 * Phase 61.5: Schema registry — versioned OpenAPI + event schemas.
 *
 * Stores immutable schema revisions keyed by (namespace, id, version) and
 * exposes a diff helper suitable for PR-time breaking-change detection.
 *
 * Storage layout (via json-path-store):
 *   data/schema-registry/{namespace}/{id}/_index.json     — version list
 *   data/schema-registry/{namespace}/{id}/{version}.json  — schema revision
 */
import { join } from "path";
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "default";
}

function schemaDir(namespace, id) {
  return join(getDataDir(), "schema-registry", sanitize(namespace), sanitize(id));
}

function indexPath(namespace, id) {
  return join(schemaDir(namespace, id), "_index.json");
}

function versionPath(namespace, id, version) {
  return join(schemaDir(namespace, id), `${sanitize(version)}.json`);
}

function hashSchema(schema) {
  return createHash("sha256").update(JSON.stringify(schema || {})).digest("hex");
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Register a new schema version. Fails with ALREADY_EXISTS if the same
 * version already exists and the hash doesn't match. If the hash matches,
 * the call is idempotent.
 *
 * @param {{namespace: string, id: string, version: string, schema: object, description?: string}} opts
 */
export async function registerSchema(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const namespace = opts.namespace;
  const id = opts.id;
  const version = opts.version;
  const schema = opts.schema;
  if (!namespace) throw new Error("namespace is required");
  if (!id) throw new Error("id is required");
  if (!version) throw new Error("version is required");
  if (!schema || typeof schema !== "object") throw new Error("schema must be an object");

  const hash = hashSchema(schema);
  const now = new Date().toISOString();
  const record = {
    namespace: sanitize(namespace),
    id: sanitize(id),
    version: String(version),
    hash,
    description: opts.description || "",
    schema,
    registeredAt: now,
  };

  const vPath = versionPath(namespace, id, version);
  return withPathLock(indexPath(namespace, id), async () => {
    const existing = await readJsonPath(vPath, null);
    if (existing && existing.hash) {
      if (existing.hash === hash) return existing; // idempotent
      const err = new Error(`version ${version} already registered with different content`);
      err.code = "ALREADY_EXISTS";
      throw err;
    }
    await writeJsonPath(vPath, record);
    const idx = await readJsonPath(indexPath(namespace, id), { versions: [] });
    const list = Array.isArray(idx.versions) ? idx.versions.filter((v) => v.version !== version) : [];
    list.push({ version: record.version, hash, registeredAt: now });
    list.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
    await writeJsonPath(indexPath(namespace, id), { versions: list });
    return record;
  });
}

export async function getSchema(namespace, id, version) {
  if (!namespace || !id) return null;
  if (!version) {
    // return latest by registeredAt
    const versions = await listVersions(namespace, id);
    if (versions.length === 0) return null;
    version = versions[versions.length - 1].version;
  }
  const rec = await readJsonPath(versionPath(namespace, id, version), null);
  if (!rec || !rec.hash) return null;
  return rec;
}

export async function listVersions(namespace, id) {
  if (!namespace || !id) return [];
  const idx = await readJsonPath(indexPath(namespace, id), { versions: [] });
  return Array.isArray(idx.versions) ? idx.versions.slice() : [];
}

// ─── Diff engine ───────────────────────────────────────────────────────────

/**
 * Compute a structural diff between two schemas. Returns a list of change
 * records with a `severity` of "breaking", "additive", or "info". The
 * traversal recognises OpenAPI-style shapes (paths, properties, required)
 * plus generic object/array differences.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{changes: Array<object>, breaking: boolean, breakingCount: number}}
 */
export function diffSchemas(before, after) {
  const changes = [];
  walk("", before ?? {}, after ?? {}, changes);
  const breaking = changes.some((c) => c.severity === "breaking");
  const breakingCount = changes.filter((c) => c.severity === "breaking").length;
  return { changes, breaking, breakingCount };
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function walk(path, a, b, changes) {
  if (a === undefined && b === undefined) return;
  if (a === undefined) {
    changes.push({ path, type: "added", severity: isBreakingAdd(path) ? "breaking" : "additive", after: b });
    return;
  }
  if (b === undefined) {
    changes.push({ path, type: "removed", severity: "breaking", before: a });
    return;
  }
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    changes.push({ path, type: "type_changed", severity: "breaking", before: a, after: b });
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    // Handle `required` arrays specially — additions are breaking.
    if (path.endsWith("/required") && Array.isArray(a) && Array.isArray(b)) {
      diffRequiredArrays(path, a, b, changes);
      return;
    }
    for (const key of keys) {
      const childPath = path ? `${path}/${key}` : `/${key}`;
      walk(childPath, a[key], b[key], changes);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // Handle the required-array case wherever it appears.
    if (path.endsWith("/required")) {
      diffRequiredArrays(path, a, b, changes);
      return;
    }
    if (a.length !== b.length) {
      changes.push({
        path,
        type: "array_length_changed",
        severity: b.length < a.length ? "breaking" : "additive",
        before: a.length,
        after: b.length,
      });
    }
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      walk(`${path}/${i}`, a[i], b[i], changes);
    }
    return;
  }
  if (a !== b) {
    changes.push({ path, type: "value_changed", severity: valueChangeSeverity(path), before: a, after: b });
  }
}

function diffRequiredArrays(path, a, b, changes) {
  const beforeSet = new Set(a.map((x) => String(x)));
  const afterSet = new Set(b.map((x) => String(x)));
  for (const k of afterSet) {
    if (!beforeSet.has(k)) {
      changes.push({ path, type: "required_added", severity: "breaking", added: k });
    }
  }
  for (const k of beforeSet) {
    if (!afterSet.has(k)) {
      changes.push({ path, type: "required_removed", severity: "additive", removed: k });
    }
  }
}

function isBreakingAdd(path) {
  return /\/required\//.test(path) || /\/parameters\/.+\/required$/.test(path);
}

function valueChangeSeverity(path) {
  if (/\/type$/.test(path)) return "breaking";
  if (/\/required$/.test(path)) return "breaking";
  if (/\/minLength$/.test(path) || /\/maxLength$/.test(path)) return "breaking";
  if (/\/minimum$/.test(path) || /\/maximum$/.test(path)) return "breaking";
  return "info";
}

export const _internals = {
  hashSchema,
  schemaDir,
  indexPath,
  versionPath,
};
