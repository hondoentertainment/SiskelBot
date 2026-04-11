// @ts-check
/**
 * Phase 61.5: Schema registry.
 *
 * Versioned schema storage for OpenAPI documents and event schemas with
 * backwards-compatibility checks. Each registered schema is keyed by
 * (name, version) and persisted via `lib/json-path-store.js`.
 *
 * Compatibility rules (approximation of Avro / JSON Schema semantics):
 *   - Adding an optional field is backwards compatible.
 *   - Adding a required field is NOT.
 *   - Removing a required field is NOT.
 *   - Changing a field's type is NOT.
 *   - Removing an optional field is breaking for FORWARD compat but not BACKWARD.
 *
 * Export surface:
 *   - registerSchema(schema)
 *   - getSchema(name, version?)
 *   - listVersions(name)
 *   - isCompatible(name, newSchema, mode?)
 *   - diffSchemas(nameOrSchema, fromVersion, toVersion)
 *
 * @module schema-registry
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VALID_KINDS = new Set(["openapi", "event", "json-schema"]);

function storePath() {
  return join(getDataDir(), "schema-registry.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, schemas: {} });
  if (!data.schemas || typeof data.schemas !== "object") data.schemas = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    schemas: data.schemas || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a semver-ish string into [major, minor, patch].
 *
 * @param {string} v
 */
export function parseVersion(v) {
  if (!v || typeof v !== "string") return null;
  const m = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/**
 * Compare two semver-ish strings. Returns -1, 0, or 1.
 *
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a) || [0, 0, 0];
  const pb = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Bump a version automatically when the caller didn't supply one. Uses
 * patch if no schemas exist yet, otherwise increments the latest patch.
 *
 * @param {string|null} latest
 */
function autoNextVersion(latest) {
  if (!latest) return "1.0.0";
  const parsed = parseVersion(latest);
  if (!parsed) return "1.0.0";
  return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`;
}

/* -------------------------------------------------------------------------- */
/* Schema registration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Register a new schema version.
 *
 * @param {{ name: string, kind?: string, version?: string, schema: object, description?: string }} entry
 */
export async function registerSchema(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("schema entry is required");
  }
  if (!entry.name || typeof entry.name !== "string") {
    throw new Error("name is required");
  }
  if (!entry.schema || typeof entry.schema !== "object") {
    throw new Error("schema is required");
  }
  const kind = entry.kind || "json-schema";
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`invalid kind: ${kind}`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = data.schemas[entry.name] || { name: entry.name, kind, versions: [] };
    if (existing.kind !== kind) {
      throw new Error(`kind mismatch: existing ${existing.kind}, new ${kind}`);
    }
    const versions = existing.versions || [];
    const latest = versions.length > 0 ? versions[versions.length - 1].version : null;
    let version = entry.version;
    if (!version) {
      version = autoNextVersion(latest);
    } else if (!parseVersion(version)) {
      throw new Error(`invalid version: ${version}`);
    } else if (latest && compareVersions(version, latest) <= 0) {
      throw new Error(`version ${version} must be greater than latest ${latest}`);
    }
    const now = new Date().toISOString();
    const record = {
      version,
      schema: entry.schema,
      description: typeof entry.description === "string" ? entry.description : "",
      registeredAt: now,
    };
    versions.push(record);
    existing.kind = kind;
    existing.versions = versions;
    existing.updatedAt = now;
    data.schemas[entry.name] = existing;
    await saveStore(data);
    return { name: entry.name, kind, ...record };
  });
}

/**
 * Fetch a specific version, or the latest if version is omitted.
 *
 * @param {string} name
 * @param {string} [version]
 */
export async function getSchema(name, version) {
  if (!name || typeof name !== "string") return null;
  const data = await loadStore();
  const entry = data.schemas[name];
  if (!entry) return null;
  const versions = entry.versions || [];
  if (versions.length === 0) return null;
  if (!version) {
    const latest = versions[versions.length - 1];
    return { name, kind: entry.kind, ...latest };
  }
  const match = versions.find((v) => v.version === version);
  return match ? { name, kind: entry.kind, ...match } : null;
}

/**
 * List all registered versions for a schema.
 *
 * @param {string} name
 */
export async function listVersions(name) {
  if (!name || typeof name !== "string") return [];
  const data = await loadStore();
  const entry = data.schemas[name];
  if (!entry) return [];
  return (entry.versions || []).map((v) => ({
    version: v.version,
    description: v.description,
    registeredAt: v.registeredAt,
  }));
}

/* -------------------------------------------------------------------------- */
/* Compatibility & diffing                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Extract a simplified field map from a JSON-schema-like object:
 *   { fieldName: { type, required } }
 *
 * @param {any} schema
 */
export function extractFields(schema) {
  /** @type {Record<string, { type: string, required: boolean }>} */
  const out = {};
  if (!schema || typeof schema !== "object") return out;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [name, def] of Object.entries(props)) {
    const d = /** @type {any} */ (def);
    const type = typeof d?.type === "string" ? d.type : "unknown";
    out[name] = { type, required: required.has(name) };
  }
  return out;
}

/**
 * Compute a structural diff between two schemas.
 *
 * @param {any} before
 * @param {any} after
 */
export function computeSchemaDiff(before, after) {
  const beforeFields = extractFields(before);
  const afterFields = extractFields(after);
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {Array<{ name: string, from: any, to: any }>} */
  const changed = [];
  for (const [name, def] of Object.entries(afterFields)) {
    if (!beforeFields[name]) {
      added.push(name);
    } else if (
      beforeFields[name].type !== def.type ||
      beforeFields[name].required !== def.required
    ) {
      changed.push({ name, from: beforeFields[name], to: def });
    }
  }
  for (const name of Object.keys(beforeFields)) {
    if (!afterFields[name]) removed.push(name);
  }
  return { added, removed, changed, beforeFields, afterFields };
}

/**
 * Check backwards compatibility. Modes:
 *   - "backward" (default): new schema can read old data
 *   - "forward": old schema can read new data
 *   - "full": both directions
 *
 * @param {string} name
 * @param {any} newSchema
 * @param {string} [mode]
 */
export async function isCompatible(name, newSchema, mode = "backward") {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!newSchema || typeof newSchema !== "object") {
    throw new Error("newSchema is required");
  }
  const latest = await getSchema(name);
  if (!latest) {
    return { compatible: true, reason: "no previous schema", breaking: [] };
  }
  const diff = computeSchemaDiff(latest.schema, newSchema);
  /** @type {string[]} */
  const breaking = [];

  // Backward: new schema reads old data -> can't add required fields or change types.
  if (mode === "backward" || mode === "full") {
    for (const field of diff.added) {
      if (diff.afterFields[field]?.required) {
        breaking.push(`added required field "${field}"`);
      }
    }
    for (const change of diff.changed) {
      if (change.from.type !== change.to.type) {
        breaking.push(`changed type of "${change.name}" from ${change.from.type} to ${change.to.type}`);
      }
      if (!change.from.required && change.to.required) {
        breaking.push(`field "${change.name}" became required`);
      }
    }
    for (const field of diff.removed) {
      if (diff.beforeFields[field]?.required) {
        breaking.push(`removed required field "${field}"`);
      }
    }
  }
  // Forward: old schema reads new data -> can't remove optional fields or change types.
  if (mode === "forward" || mode === "full") {
    for (const field of diff.removed) {
      breaking.push(`removed field "${field}"`);
    }
    for (const change of diff.changed) {
      if (change.from.type !== change.to.type) {
        breaking.push(`changed type of "${change.name}"`);
      }
    }
  }
  // Dedupe
  const uniq = [...new Set(breaking)];
  return {
    compatible: uniq.length === 0,
    mode,
    previousVersion: latest.version,
    breaking: uniq,
    diff,
  };
}

/**
 * Diff two versions of a registered schema, or diff ad-hoc schemas
 * when both `fromVersion` and `toVersion` are schema objects.
 *
 * @param {string|object} nameOrSchema
 * @param {string|object} fromVersion
 * @param {string|object} [toVersion]
 */
export async function diffSchemas(nameOrSchema, fromVersion, toVersion) {
  // Variant 1: two raw schemas.
  if (typeof nameOrSchema === "object" && typeof fromVersion === "object") {
    return computeSchemaDiff(nameOrSchema, fromVersion);
  }
  // Variant 2: (name, fromVersion, toVersion)
  if (typeof nameOrSchema === "string") {
    const from = await getSchema(nameOrSchema, typeof fromVersion === "string" ? fromVersion : undefined);
    const to = typeof toVersion === "string"
      ? await getSchema(nameOrSchema, toVersion)
      : await getSchema(nameOrSchema);
    if (!from) throw new Error(`schema ${nameOrSchema}@${fromVersion} not found`);
    if (!to) throw new Error(`schema ${nameOrSchema}@${toVersion || "latest"} not found`);
    return {
      fromVersion: from.version,
      toVersion: to.version,
      ...computeSchemaDiff(from.schema, to.schema),
    };
  }
  throw new Error("diffSchemas: invalid arguments");
}
