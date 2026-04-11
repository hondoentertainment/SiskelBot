// @ts-check
/**
 * Phase 57.3: Schema evolution.
 *
 * Versioned record schemas with forward-compatible migrations. A
 * schema registry holds every version of every schema; records stamped
 * with their origin version are auto-migrated to the latest version
 * through a chain of caller-provided migration functions.
 *
 * Exports:
 *   - registerSchema(name, version, schema, migrateFromPrev?)
 *   - getSchemaVersion(name, version?)
 *   - migrateRecord(name, record)
 *   - listSchemas()
 *   - diffSchemas(name, v1, v2)
 *   - latestVersion(name)
 *
 * @module schema-evolution
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "schema-evolution.json");
}

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* In-memory migrations                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Migration functions cannot be persisted to JSON, so they live in a
 * process-wide map keyed by `${name}:${version}`. Default migration
 * (if none is supplied) is a shallow no-op.
 *
 * @type {Record<string, (rec: any) => any>}
 */
const _migrations = {};

function migrationKey(name, version) {
  return `${name}:${version}`;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    schemas: {},
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, schemas: {} };
  }
  if (!raw.schemas || typeof raw.schemas !== "object") raw.schemas = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    schemas: store.schemas || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

function isValidSchema(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (!schema.fields || typeof schema.fields !== "object") return false;
  return true;
}

function defaultFor(type) {
  switch (type) {
    case "string": return "";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Register a schema version. A migration function can be supplied that
 * transforms a record from version N-1 to version N.
 *
 * @param {string} name
 * @param {number} version
 * @param {{fields: Record<string, {type: string, required?: boolean, default?: any}>, description?: string}} schema
 * @param {((rec: any) => any) | null} [migrateFromPrev]
 */
export async function registerSchema(name, version, schema, migrateFromPrev = null) {
  if (!name || typeof name !== "string") throw new Error("schema name required");
  if (!Number.isFinite(version) || version < 1) throw new Error("version must be >= 1");
  if (!isValidSchema(schema)) throw new Error("schema.fields required");

  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (!store.schemas[name]) store.schemas[name] = { versions: {} };
    if (store.schemas[name].versions[version]) {
      throw new Error(`schema "${name}" already has version ${version}`);
    }
    // v1 must have no prior; vN>1 must have v(N-1) registered.
    if (version > 1 && !store.schemas[name].versions[version - 1]) {
      throw new Error(`cannot register version ${version} before version ${version - 1}`);
    }
    store.schemas[name].versions[version] = {
      version,
      fields: schema.fields,
      description: schema.description || "",
      registeredAt: now(),
    };
    await saveStore(store);
    // Cache migration fn in memory; fall back to shallow no-op.
    if (typeof migrateFromPrev === "function") {
      _migrations[migrationKey(name, version)] = migrateFromPrev;
    } else if (version > 1 && !_migrations[migrationKey(name, version)]) {
      _migrations[migrationKey(name, version)] = (rec) => {
        const out = { ...rec };
        for (const [fname, fdef] of Object.entries(schema.fields)) {
          if (out[fname] === undefined) {
            out[fname] = fdef.default !== undefined ? fdef.default : defaultFor(fdef.type);
          }
        }
        return out;
      };
    }
    return store.schemas[name].versions[version];
  });
}

/**
 * Fetch a schema version (latest if `version` omitted).
 * @param {string} name
 * @param {number} [version]
 */
export async function getSchemaVersion(name, version) {
  if (!name) throw new Error("name required");
  const store = await loadStore();
  const s = store.schemas[name];
  if (!s) return null;
  if (version != null) return s.versions[version] || null;
  const versions = Object.keys(s.versions).map(Number).sort((a, b) => b - a);
  if (versions.length === 0) return null;
  return s.versions[versions[0]];
}

/** Latest version number for a schema. */
export async function latestVersion(name) {
  const store = await loadStore();
  const s = store.schemas[name];
  if (!s) return 0;
  const versions = Object.keys(s.versions).map(Number).sort((a, b) => b - a);
  return versions[0] || 0;
}

/** List every schema with its highest registered version. */
export async function listSchemas() {
  const store = await loadStore();
  const out = [];
  for (const [name, s] of Object.entries(store.schemas || {})) {
    const versions = Object.keys(s.versions || {}).map(Number).sort((a, b) => b - a);
    out.push({
      name,
      latest: versions[0] || 0,
      versionCount: versions.length,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Migrate a record from its stamped version to the latest version by
 * chaining registered migrations. Records without a `_schemaVersion`
 * field are treated as v1.
 * @param {string} name
 * @param {object} record
 */
export async function migrateRecord(name, record) {
  if (!name) throw new Error("name required");
  if (!record || typeof record !== "object") throw new Error("record required");
  const store = await loadStore();
  const s = store.schemas[name];
  if (!s) throw new Error(`no schema "${name}"`);
  const versions = Object.keys(s.versions).map(Number).sort((a, b) => a - b);
  const target = versions[versions.length - 1];
  const startV = Number.isFinite(record._schemaVersion) ? record._schemaVersion : 1;
  if (!s.versions[startV]) throw new Error(`unknown source version ${startV}`);
  let cur = { ...record };
  for (let v = startV + 1; v <= target; v++) {
    const fn = _migrations[migrationKey(name, v)];
    if (fn) {
      cur = fn(cur);
    } else {
      // Default: backfill missing fields with defaults from target version.
      const schema = s.versions[v];
      const out = { ...cur };
      for (const [fname, fdef] of Object.entries(schema.fields)) {
        if (out[fname] === undefined) {
          out[fname] = fdef.default !== undefined ? fdef.default : defaultFor(fdef.type);
        }
      }
      cur = out;
    }
  }
  cur._schemaVersion = target;
  return cur;
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compare two schema versions and return added/removed/changed fields.
 * @param {string} name
 * @param {number} v1
 * @param {number} v2
 */
export async function diffSchemas(name, v1, v2) {
  if (!name) throw new Error("name required");
  const store = await loadStore();
  const s = store.schemas[name];
  if (!s) throw new Error(`no schema "${name}"`);
  const a = s.versions[v1];
  const b = s.versions[v2];
  if (!a) throw new Error(`no version ${v1}`);
  if (!b) throw new Error(`no version ${v2}`);
  const added = [];
  const removed = [];
  const changed = [];
  const aNames = new Set(Object.keys(a.fields || {}));
  const bNames = new Set(Object.keys(b.fields || {}));
  for (const f of bNames) if (!aNames.has(f)) added.push(f);
  for (const f of aNames) if (!bNames.has(f)) removed.push(f);
  for (const f of aNames) {
    if (!bNames.has(f)) continue;
    const af = a.fields[f];
    const bf = b.fields[f];
    if (af.type !== bf.type || !!af.required !== !!bf.required) {
      changed.push({
        field: f,
        from: { type: af.type, required: !!af.required },
        to: { type: bf.type, required: !!bf.required },
      });
    }
  }
  return { name, v1, v2, added, removed, changed };
}

/** Internal: register a custom migration after the fact (tests). */
export function _registerMigration(name, version, fn) {
  _migrations[migrationKey(name, version)] = fn;
}
