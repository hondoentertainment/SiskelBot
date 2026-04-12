/**
 * Phase 57.3: Schema evolution.
 *
 * A versioned schema registry with compatibility checks. Schemas are
 * registered under a subject; each registration bumps the version. At
 * registration time we verify compatibility against the previous version
 * under the configured compatibility mode:
 *
 *   backward  — consumers of the new schema can read old data
 *   forward   — old consumers can read new data
 *   full      — both of the above
 *   none      — any change is accepted
 *
 * Storage:
 *   data/schema-evolution/{subject}.json  — { versions: [{ version, schema, ... }], compatibility }
 *   data/schema-evolution/_index.json     — known subjects
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const COMPATIBILITY_MODES = Object.freeze(["backward", "forward", "full", "none"]);

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function subjectPath(subject) {
  return join(getDataDir(), "schema-evolution", `${sanitize(subject)}.json`);
}

function indexPath() {
  return join(getDataDir(), "schema-evolution", "_index.json");
}

async function touchIndex(subject) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { subjects: [] });
    const list = Array.isArray(idx.subjects) ? idx.subjects : [];
    if (!list.includes(subject)) {
      list.push(subject);
      await writeJsonPath(indexPath(), { subjects: list });
    }
  });
}

/**
 * Register a new schema version for a subject. Performs compatibility check
 * against the most recent version unless mode is "none" or there is no
 * previous version.
 *
 * @param {string} subject
 * @param {object} schema — JSON-like schema. We interpret {type: "object", properties, required} in the style of JSON Schema subset.
 * @param {{ compatibility?: string }} [options]
 * @returns {Promise<{ subject, version, schema, compatibility, registeredAt }>}
 */
export async function registerSchema(subject, schema, options = {}) {
  if (!subject) throw new Error("subject is required");
  if (!schema || typeof schema !== "object") {
    throw new Error("schema must be an object");
  }
  const compatibility = options.compatibility && COMPATIBILITY_MODES.includes(options.compatibility)
    ? options.compatibility
    : "backward";

  const file = subjectPath(subject);
  let result;
  await withPathLock(file, async () => {
    const existing = await readJsonPath(file, null);
    const versions = existing && Array.isArray(existing.versions) ? existing.versions : [];
    const latest = versions[versions.length - 1] || null;
    const mode = existing?.compatibility || compatibility;
    if (latest) {
      const check = checkCompatibility(latest.schema, schema, mode);
      if (!check.compatible) {
        const err = new Error(`incompatible schema: ${check.issues.join("; ")}`);
        err.code = "INCOMPATIBLE";
        throw err;
      }
    }
    const nextVersion = latest ? latest.version + 1 : 1;
    const entry = {
      version: nextVersion,
      schema,
      registeredAt: new Date().toISOString(),
    };
    const record = {
      subject: sanitize(subject),
      compatibility: mode,
      versions: [...versions, entry],
      updatedAt: new Date().toISOString(),
    };
    await writeJsonPath(file, record);
    result = { subject: record.subject, ...entry, compatibility: mode };
  });
  await touchIndex(sanitize(subject));
  return result;
}

/**
 * Fetch a specific version (default latest).
 */
export async function getSchema(subject, version = null) {
  const rec = await readJsonPath(subjectPath(subject), null);
  if (!rec || !Array.isArray(rec.versions) || rec.versions.length === 0) return null;
  if (version == null) return { ...rec.versions[rec.versions.length - 1], subject: rec.subject, compatibility: rec.compatibility };
  const v = rec.versions.find((x) => x.version === Number(version));
  return v ? { ...v, subject: rec.subject, compatibility: rec.compatibility } : null;
}

export async function listVersions(subject) {
  const rec = await readJsonPath(subjectPath(subject), null);
  if (!rec) return [];
  return (rec.versions || []).map((v) => ({ version: v.version, registeredAt: v.registeredAt }));
}

export async function listSubjects() {
  const idx = await readJsonPath(indexPath(), { subjects: [] });
  return Array.isArray(idx.subjects) ? idx.subjects.slice() : [];
}

export async function setCompatibility(subject, mode) {
  if (!COMPATIBILITY_MODES.includes(mode)) {
    throw new Error(`compatibility must be one of ${COMPATIBILITY_MODES.join(", ")}`);
  }
  const file = subjectPath(subject);
  return withPathLock(file, async () => {
    const rec = await readJsonPath(file, null);
    if (!rec) throw new Error(`subject ${subject} not found`);
    rec.compatibility = mode;
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(file, rec);
    return { subject: rec.subject, compatibility: mode };
  });
}

// ─── Compatibility checks ────────────────────────────────────────────────

function getProps(schema) {
  return (schema && typeof schema.properties === "object") ? schema.properties : {};
}

function getRequired(schema) {
  return Array.isArray(schema?.required) ? schema.required : [];
}

/**
 * Backward compatible: new schema can read data written by old schema. This
 * means new schema must accept everything the old one did — any new required
 * field is a break, a removed optional field is OK, a type change is a break.
 */
function checkBackward(oldSchema, newSchema) {
  const issues = [];
  const oldProps = getProps(oldSchema);
  const newProps = getProps(newSchema);
  const oldReq = new Set(getRequired(oldSchema));
  const newReq = new Set(getRequired(newSchema));
  for (const [name, prop] of Object.entries(newProps)) {
    if (newReq.has(name) && !(name in oldProps) && !("default" in prop)) {
      issues.push(`new required field without default: ${name}`);
    }
  }
  for (const [name, oldProp] of Object.entries(oldProps)) {
    if (name in newProps) {
      const newProp = newProps[name];
      if (oldProp.type && newProp.type && oldProp.type !== newProp.type) {
        issues.push(`type change for ${name}: ${oldProp.type} -> ${newProp.type}`);
      }
    } else if (oldReq.has(name)) {
      // required field removed is still backward-compatible for readers of old data
      // (new reader doesn't need it). OK.
    }
  }
  return issues;
}

/**
 * Forward compatible: old consumers can read new data. Removing a required
 * field breaks; renaming breaks; adding an optional field is OK; type changes
 * break.
 */
function checkForward(oldSchema, newSchema) {
  const issues = [];
  const oldProps = getProps(oldSchema);
  const newProps = getProps(newSchema);
  const oldReq = new Set(getRequired(oldSchema));
  for (const [name, oldProp] of Object.entries(oldProps)) {
    if (!(name in newProps)) {
      if (oldReq.has(name)) issues.push(`required field removed: ${name}`);
    } else {
      const newProp = newProps[name];
      if (oldProp.type && newProp.type && oldProp.type !== newProp.type) {
        issues.push(`type change for ${name}: ${oldProp.type} -> ${newProp.type}`);
      }
    }
  }
  return issues;
}

/**
 * Compare two schemas under a compatibility mode.
 *
 * @returns {{ compatible: boolean, issues: string[] }}
 */
export function checkCompatibility(oldSchema, newSchema, mode = "backward") {
  if (mode === "none") return { compatible: true, issues: [] };
  const issues = [];
  if (mode === "backward" || mode === "full") {
    issues.push(...checkBackward(oldSchema, newSchema).map((i) => `backward: ${i}`));
  }
  if (mode === "forward" || mode === "full") {
    issues.push(...checkForward(oldSchema, newSchema).map((i) => `forward: ${i}`));
  }
  return { compatible: issues.length === 0, issues };
}

/**
 * Test helper.
 */
export async function _reset(subject) {
  if (subject) {
    await writeJsonPath(subjectPath(subject), { subject, versions: [], _deleted: true });
    return;
  }
  const idx = await readJsonPath(indexPath(), { subjects: [] });
  for (const s of (idx.subjects || [])) {
    await writeJsonPath(subjectPath(s), { subject: s, versions: [], _deleted: true });
  }
  await writeJsonPath(indexPath(), { subjects: [] });
}

export const _internals = { checkBackward, checkForward, getProps, getRequired };
