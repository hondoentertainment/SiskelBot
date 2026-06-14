/**
 * Phase 68.1: Real-time web ingestion — scheduled crawl + source tracking.
 *
 * A source registers a URL (or list of URLs) on a cron-like schedule. On each
 * ingestion run, content is fetched via lib/knowledge-url-fetch.js (SSRF-safe,
 * allowlist-enforced) and recorded. Freshness is tracked per source so callers
 * can detect stale data.
 *
 * Storage:
 *   data/web-ingestion/sources/{id}.json  — source record
 *   data/web-ingestion/runs/{runId}.json  — ingestion run record
 *   data/web-ingestion/_index.json        — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { fetchTextFromAllowedUrl } from "./knowledge-url-fetch.js";

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function sourcePath(id) {
  return join(getDataDir(), "web-ingestion", "sources", `${sanitize(id)}.json`);
}

function runPath(id) {
  return join(getDataDir(), "web-ingestion", "runs", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "web-ingestion", "_index.json");
}

async function updateIndex(updater) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { sources: [], runs: [] });
    idx.sources = Array.isArray(idx.sources) ? idx.sources : [];
    idx.runs = Array.isArray(idx.runs) ? idx.runs : [];
    await updater(idx);
    await writeJsonPath(indexPath(), idx);
  });
}

// ─── Sources ───────────────────────────────────────────────────────────────

/**
 * Register a web source.
 * urls: array of URL strings (at least one).
 * schedule: optional cron-like string (scheduler is external).
 * freshnessTargetMs: operator's SLA — ingestion older than this is "stale".
 */
export async function registerSource({
  name,
  urls,
  schedule,
  freshnessTargetMs,
  description,
  tags,
} = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("urls array is required");
  }
  const clean = urls
    .filter((u) => typeof u === "string" && u.trim())
    .map((u) => u.trim());
  if (clean.length === 0) {
    throw new Error("at least one URL is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name,
    urls: clean,
    schedule: schedule || null,
    freshnessTargetMs: Number.isFinite(Number(freshnessTargetMs))
      ? Math.max(0, Number(freshnessTargetMs))
      : null,
    description: description || "",
    tags: Array.isArray(tags) ? tags.map(String) : [],
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastSuccessAt: null,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    lastErrors: [],
  };
  await writeJsonPath(sourcePath(id), record);
  await updateIndex((idx) => {
    idx.sources.push({ id, name, schedule: record.schedule, createdAt: now });
  });
  return record;
}

export async function getSource(id) {
  if (!id) return null;
  const rec = await readJsonPath(sourcePath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listSources(filter = {}) {
  const idx = await readJsonPath(indexPath(), { sources: [] });
  const entries = Array.isArray(idx.sources) ? idx.sources : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getSource(entry.id);
    if (!rec) continue;
    if (filter.name && rec.name !== filter.name) continue;
    if (filter.tag && !rec.tags.includes(filter.tag)) continue;
    records.push(rec);
  }
  return records;
}

export async function deleteSource(id) {
  const rec = await getSource(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(sourcePath(id), { _deleted: true });
  await updateIndex((idx) => {
    idx.sources = (idx.sources || []).filter((e) => e.id !== id);
  });
  return { ok: true };
}

async function mutateSource(id, mutator) {
  return withPathLock(sourcePath(id), async () => {
    const rec = await readJsonPath(sourcePath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`source ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(sourcePath(id), updated);
      return updated;
    }
    return rec;
  });
}

// ─── Runs ──────────────────────────────────────────────────────────────────

/**
 * Run ingestion for a source. Accepts an optional `fetcher(url)=>{text,...}`
 * override (test hook); defaults to lib/knowledge-url-fetch.js.
 */
export async function runIngestion(id, { fetcher } = {}) {
  const source = await getSource(id);
  if (!source) {
    const err = new Error(`source ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const fetchFn = typeof fetcher === "function"
    ? fetcher
    : async (u) => fetchTextFromAllowedUrl(u);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const results = [];
  let successCount = 0;
  let failureCount = 0;
  const errors = [];
  for (const url of source.urls) {
    let result;
    try {
      result = await fetchFn(url);
    } catch (e) {
      result = { error: e.message, code: "FETCH_FAILED" };
    }
    if (result && result.error) {
      failureCount += 1;
      errors.push({ url, error: result.error, code: result.code || "FETCH_FAILED" });
      results.push({ url, ok: false, error: result.error, code: result.code });
    } else {
      successCount += 1;
      results.push({
        url,
        ok: true,
        finalUrl: result.finalUrl || url,
        byteLength: typeof result.text === "string" ? Buffer.byteLength(result.text) : 0,
        textPreview: typeof result.text === "string" ? result.text.slice(0, 500) : "",
      });
    }
  }
  const completedAt = new Date().toISOString();
  const run = {
    id: runId,
    sourceId: id,
    sourceName: source.name,
    startedAt,
    completedAt,
    urls: source.urls,
    results,
    successCount,
    failureCount,
    status: failureCount === 0 ? "success" : (successCount === 0 ? "failed" : "partial"),
  };
  await writeJsonPath(runPath(runId), run);
  await updateIndex((idx) => {
    idx.runs.push({ id: runId, sourceId: id, startedAt, status: run.status });
  });
  await mutateSource(id, (rec) => {
    rec.lastRunAt = completedAt;
    rec.runCount += 1;
    if (successCount > 0) {
      rec.successCount += 1;
      rec.lastSuccessAt = completedAt;
    }
    if (failureCount > 0) {
      rec.failureCount += 1;
      rec.lastErrors = errors.slice(-5);
    }
    return rec;
  });
  return run;
}

export async function getRun(runId) {
  if (!runId) return null;
  const rec = await readJsonPath(runPath(runId), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

/**
 * Freshness status for a source.
 */
export async function getIngestionStatus(id) {
  const source = await getSource(id);
  if (!source) {
    const err = new Error(`source ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const now = Date.now();
  const lastSuccessMs = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : null;
  const ageMs = lastSuccessMs != null ? now - lastSuccessMs : null;
  const target = source.freshnessTargetMs;
  let freshness = "unknown";
  if (target == null) {
    freshness = lastSuccessMs != null ? "ok" : "never_ingested";
  } else if (lastSuccessMs == null) {
    freshness = "never_ingested";
  } else if (ageMs <= target) {
    freshness = "fresh";
  } else {
    freshness = "stale";
  }
  return {
    sourceId: source.id,
    name: source.name,
    runCount: source.runCount,
    successCount: source.successCount,
    failureCount: source.failureCount,
    lastRunAt: source.lastRunAt,
    lastSuccessAt: source.lastSuccessAt,
    lastErrors: source.lastErrors || [],
    freshnessTargetMs: target,
    ageMs,
    freshness,
  };
}

export const _internals = { sourcePath, runPath, indexPath };
