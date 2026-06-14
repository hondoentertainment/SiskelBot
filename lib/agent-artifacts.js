/**
 * Agent-run artifact store.
 *
 * Each artifact is a named output produced during an agent run (a file, a
 * chart, a table, etc.). Small payloads are stored inline in the metadata
 * record; larger payloads spill to disk under
 * `<STORAGE_PATH>/artifacts/<sessionId>/<id>.bin`, leaving only the path on
 * the record. Metadata is persisted via json-path-store so it flows through
 * the same JSON / SQLite / Postgres backends as the rest of the codebase.
 *
 * Record shape:
 *   {
 *     id, sessionId, runId?, name, mime, sizeBytes, createdAt, createdBy?,
 *     storage: "inline" | "disk",
 *     inline?: string (base64-encoded when binary, raw utf-8 otherwise),
 *     inlineEncoding?: "utf8" | "base64",
 *     diskPath?: string,
 *     meta?: object
 *   }
 *
 * Guards (overridable via env):
 *   - ARTIFACT_MAX_BYTES               (default 10 MiB per artifact)
 *   - ARTIFACT_SESSION_MAX_BYTES       (default 100 MiB per session)
 *   - ARTIFACT_INLINE_BYTES            (default 64 KiB; larger → disk spill)
 *   - name length <= 256 chars
 *   - mime must match /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i
 *
 * Errors are thrown as plain Error objects with a .code property:
 *   INVALID_NAME, INVALID_MIME, ARTIFACT_TOO_LARGE, ARTIFACT_QUOTA_EXCEEDED,
 *   INVALID_CONTENT
 *
 * Emits `artifact.new` on publishAgentRunEvent so the Agent Run SSE stream
 * can fan it out to the hero-view Artifacts pane.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync, statSync } from "fs";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";

const STORE_VERSION = 1;

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_SESSION_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_INLINE_THRESHOLD = 64 * 1024; // 64 KiB
const MAX_NAME_CHARS = 256;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;

function resolvePositiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function getArtifactLimits() {
  return {
    perArtifact: resolvePositiveEnv("ARTIFACT_MAX_BYTES", DEFAULT_MAX_BYTES),
    perSession: resolvePositiveEnv("ARTIFACT_SESSION_MAX_BYTES", DEFAULT_SESSION_MAX_BYTES),
    inlineThreshold: resolvePositiveEnv("ARTIFACT_INLINE_BYTES", DEFAULT_INLINE_THRESHOLD),
  };
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function storePath() {
  return join(getDataDir(), "agent-artifacts.json");
}

function artifactDir(sessionId) {
  return join(getDataDir(), "artifacts", String(sessionId));
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : null;
  const artifacts =
    base && base.artifacts && typeof base.artifacts === "object" && !Array.isArray(base.artifacts)
      ? base.artifacts
      : {};
  const bySession =
    base && base.bySession && typeof base.bySession === "object" && !Array.isArray(base.bySession)
      ? base.bySession
      : {};
  return { _version: STORE_VERSION, artifacts, bySession };
}

/**
 * @param {unknown} name
 * @returns {string}
 */
function validateName(name) {
  if (typeof name !== "string") throw codedError("INVALID_NAME", "name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw codedError("INVALID_NAME", "name required");
  if (trimmed.length > MAX_NAME_CHARS) {
    throw codedError("INVALID_NAME", `name exceeds ${MAX_NAME_CHARS} chars`);
  }
  return trimmed;
}

/**
 * @param {unknown} mime
 * @returns {string}
 */
function validateMime(mime) {
  if (typeof mime !== "string") throw codedError("INVALID_MIME", "mime must be a string");
  const trimmed = mime.trim();
  if (!trimmed || !MIME_PATTERN.test(trimmed)) {
    throw codedError("INVALID_MIME", "mime must match type/subtype");
  }
  return trimmed.toLowerCase();
}

/**
 * @param {Buffer | string | undefined | null} content
 * @returns {Buffer}
 */
function coerceBuffer(content) {
  if (content == null) throw codedError("INVALID_CONTENT", "content required");
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  throw codedError("INVALID_CONTENT", "content must be a Buffer or string");
}

function isTextMime(mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase();
  if (m.startsWith("text/")) return true;
  if (m.endsWith("+json") || m.endsWith("+xml")) return true;
  return m === "application/json" || m === "application/xml" || m === "application/javascript";
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function currentSessionBytes(store, sessionId) {
  const ids = Array.isArray(store.bySession[sessionId]) ? store.bySession[sessionId] : [];
  let total = 0;
  for (const id of ids) {
    const row = store.artifacts[id];
    if (row && Number.isFinite(row.sizeBytes)) total += Number(row.sizeBytes);
  }
  return total;
}

function stripInline(record) {
  if (!record || typeof record !== "object") return record;
  const { inline, inlineEncoding, diskPath, ...rest } = record;
  void inline; void inlineEncoding; void diskPath;
  return rest;
}

/**
 * Create an artifact and register it against the given agent session.
 *
 * @param {{
 *   sessionId: string,
 *   runId?: string,
 *   name: string,
 *   mime: string,
 *   content: Buffer | string,
 *   createdBy?: string,
 *   meta?: object,
 *   urlBuilder?: (id: string) => string,
 * }} opts
 * @returns {Promise<object>} metadata record (without inline content)
 */
export async function createArtifact(opts) {
  const sessionId = String(opts?.sessionId || "").trim();
  if (!sessionId) throw codedError("INVALID", "sessionId required");
  const runId = opts?.runId ? String(opts.runId).trim() : null;
  const name = validateName(opts?.name);
  const mime = validateMime(opts?.mime);
  const buffer = coerceBuffer(opts?.content);

  const limits = getArtifactLimits();
  if (buffer.length > limits.perArtifact) {
    throw codedError(
      "ARTIFACT_TOO_LARGE",
      `artifact exceeds per-artifact cap of ${limits.perArtifact} bytes`,
    );
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const useInline = buffer.length <= limits.inlineThreshold;

  /** @type {Record<string, unknown>} */
  const record = {
    id,
    sessionId,
    runId: runId || null,
    name,
    mime,
    sizeBytes: buffer.length,
    createdAt,
    createdBy: opts?.createdBy ? String(opts.createdBy) : null,
    storage: useInline ? "inline" : "disk",
  };
  if (opts?.meta && typeof opts.meta === "object" && !Array.isArray(opts.meta)) {
    record.meta = opts.meta;
  }

  if (useInline) {
    if (isTextMime(mime)) {
      record.inlineEncoding = "utf8";
      record.inline = buffer.toString("utf8");
    } else {
      record.inlineEncoding = "base64";
      record.inline = buffer.toString("base64");
    }
  } else {
    const dir = artifactDir(sessionId);
    ensureDir(dir);
    const diskPath = join(dir, `${id}.bin`);
    writeFileSync(diskPath, buffer);
    record.diskPath = diskPath;
  }

  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const sessionTotal = currentSessionBytes(data, sessionId) + buffer.length;
    if (sessionTotal > limits.perSession) {
      // Rollback disk file if we spilled.
      if (!useInline && record.diskPath) {
        try { rmSync(record.diskPath, { force: true }); } catch (_) { /* best-effort */ }
      }
      throw codedError(
        "ARTIFACT_QUOTA_EXCEEDED",
        `session ${sessionId} would exceed per-session cap of ${limits.perSession} bytes`,
      );
    }
    data.artifacts[id] = record;
    const idx = Array.isArray(data.bySession[sessionId]) ? [...data.bySession[sessionId]] : [];
    idx.unshift(id);
    data.bySession[sessionId] = idx;
    await writeJsonPath(path, data);
  });

  const summary = stripInline(record);
  // Publish to the Agent Run SSE stream. Include the HTTP URL so the hero-view
  // Artifacts pane can preview / link directly.
  try {
    const url =
      typeof opts?.urlBuilder === "function"
        ? opts.urlBuilder(id)
        : `/api/v1/agent/artifacts/${encodeURIComponent(id)}`;
    publishAgentRunEvent(sessionId, "artifact.new", {
      id,
      name,
      mime,
      sizeBytes: buffer.length,
      url,
    });
  } catch (_) { /* publish failures must not break creation */ }

  return summary;
}

/**
 * List artifact metadata records for a session. Inline content is stripped
 * from the returned records — callers should fetch content via
 * getArtifactContent().
 *
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function listArtifactsForSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const data = normalizeStore(await readJsonPath(storePath(), null));
  const ids = Array.isArray(data.bySession[id]) ? data.bySession[id] : [];
  const out = [];
  for (const artifactId of ids) {
    const row = data.artifacts[artifactId];
    if (!row) continue;
    out.push(stripInline(row));
  }
  return out;
}

/**
 * Get the full metadata record (including inline/diskPath) for a single
 * artifact by id. Returns null when the artifact is unknown.
 *
 * @param {string} artifactId
 * @returns {Promise<object | null>}
 */
export async function getArtifactRecord(artifactId) {
  const id = String(artifactId || "").trim();
  if (!id) return null;
  const data = normalizeStore(await readJsonPath(storePath(), null));
  return data.artifacts[id] || null;
}

/**
 * Load the artifact bytes from inline storage or from disk.
 *
 * @param {string} artifactId
 * @returns {Promise<Buffer | null>}
 */
export async function getArtifactContent(artifactId) {
  const rec = await getArtifactRecord(artifactId);
  if (!rec) return null;
  if (rec.storage === "inline") {
    const enc = rec.inlineEncoding === "utf8" ? "utf8" : "base64";
    return Buffer.from(String(rec.inline || ""), enc);
  }
  if (rec.storage === "disk" && rec.diskPath) {
    try {
      return readFileSync(rec.diskPath);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Delete a single artifact by id. Returns true if a record was removed.
 *
 * @param {string} artifactId
 * @returns {Promise<boolean>}
 */
export async function deleteArtifact(artifactId) {
  const id = String(artifactId || "").trim();
  if (!id) return false;
  let removed = false;
  let diskPath = null;
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const rec = data.artifacts[id];
    if (!rec) return;
    removed = true;
    diskPath = rec.storage === "disk" ? rec.diskPath : null;
    delete data.artifacts[id];
    const sessionId = rec.sessionId;
    if (sessionId && Array.isArray(data.bySession[sessionId])) {
      data.bySession[sessionId] = data.bySession[sessionId].filter((x) => x !== id);
      if (!data.bySession[sessionId].length) delete data.bySession[sessionId];
    }
    await writeJsonPath(path, data);
  });
  if (removed && diskPath) {
    try { rmSync(diskPath, { force: true }); } catch (_) { /* best-effort */ }
  }
  return removed;
}

/**
 * Delete every artifact associated with a session (metadata + any disk
 * spill files). Intended to be called on session deletion / purge. Disk
 * cleanup is best-effort — stale files left behind by a crash are GC'd on
 * next call because the per-session directory is rm-rf'd after metadata is
 * erased.
 *
 * @param {string} sessionId
 * @returns {Promise<number>} count removed
 */
export async function deleteArtifactsForSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return 0;
  const pathsToUnlink = [];
  let removed = 0;
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const ids = Array.isArray(data.bySession[sid]) ? [...data.bySession[sid]] : [];
    for (const id of ids) {
      const rec = data.artifacts[id];
      if (!rec) continue;
      if (rec.storage === "disk" && rec.diskPath) pathsToUnlink.push(rec.diskPath);
      delete data.artifacts[id];
      removed += 1;
    }
    delete data.bySession[sid];
    await writeJsonPath(path, data);
  });
  for (const p of pathsToUnlink) {
    try { rmSync(p, { force: true }); } catch (_) { /* best-effort */ }
  }
  // Best-effort: clear per-session directory so crash-leftovers are GC'd.
  try {
    const dir = artifactDir(sid);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
  return removed;
}

/**
 * Total bytes stored for a session (metadata-driven; disk sizes are trusted
 * from the record, not re-stat'd).
 *
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
export async function getSessionArtifactBytes(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return 0;
  const data = normalizeStore(await readJsonPath(storePath(), null));
  return currentSessionBytes(data, sid);
}

// Test helper — used in test teardown to avoid cross-test contamination
// on shared storage paths.
export async function __resetArtifactsForTests() {
  const path = storePath();
  await writeJsonPath(path, { _version: STORE_VERSION, artifacts: {}, bySession: {} });
  // Sweep the on-disk artifacts dir as well.
  try {
    const dir = join(getDataDir(), "artifacts");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

// Internal: re-stat disk-backed records (used by tests / diagnostics). Not
// exported as a public API surface.
export function __statDiskArtifact(rec) {
  if (!rec || rec.storage !== "disk" || !rec.diskPath) return null;
  try { return statSync(rec.diskPath); } catch { return null; }
}
