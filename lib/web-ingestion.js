// @ts-check
/**
 * Phase 68.1: Real-time web ingestion.
 *
 * Tracks registered web sources, runs scheduled crawls with an injectable
 * fetch implementation, records each crawl result, and exposes lookup
 * helpers. No external dependencies: the crawl loop is deterministic
 * and unit-testable with a stub fetch.
 *
 * Exports:
 *   - registerSource
 *   - crawlSource
 *   - listSources
 *   - getLastCrawl
 *   - scheduleCrawl
 *
 * Storage is JSON-backed via json-path-store.js.
 *
 * @module web-ingestion
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function sourcesPath() {
  return join(getDataDir(), "web-ingestion-sources.json");
}

function crawlsPath() {
  return join(getDataDir(), "web-ingestion-crawls.json");
}

function schedulesPath() {
  return join(getDataDir(), "web-ingestion-schedules.json");
}

async function loadSources() {
  const data = await readJsonPath(sourcesPath(), { version: STORE_VERSION, sources: {} });
  if (!data.sources || typeof data.sources !== "object") data.sources = {};
  return data;
}

async function saveSources(data) {
  await writeJsonPath(sourcesPath(), {
    version: STORE_VERSION,
    sources: data.sources || {},
  });
}

async function loadCrawls() {
  const data = await readJsonPath(crawlsPath(), { version: STORE_VERSION, crawls: {} });
  if (!data.crawls || typeof data.crawls !== "object") data.crawls = {};
  return data;
}

async function saveCrawls(data) {
  await writeJsonPath(crawlsPath(), {
    version: STORE_VERSION,
    crawls: data.crawls || {},
  });
}

async function loadSchedules() {
  const data = await readJsonPath(schedulesPath(), { version: STORE_VERSION, schedules: {} });
  if (!data.schedules || typeof data.schedules !== "object") data.schedules = {};
  return data;
}

async function saveSchedules(data) {
  await writeJsonPath(schedulesPath(), {
    version: STORE_VERSION,
    schedules: data.schedules || {},
  });
}

/**
 * Normalize a URL into a stable identifier. Lowercases the host and
 * strips a trailing slash. Throws on invalid URLs.
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("url is required");
  }
  const trimmed = url.trim();
  if (!trimmed) throw new Error("url is required");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("url must start with http:// or https://");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    throw new Error("url is not valid");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  let out = parsed.toString();
  if (out.endsWith("/") && parsed.pathname === "/") {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Derive a deterministic source id from a URL.
 * @param {string} url
 * @returns {string}
 */
export function sourceIdFromUrl(url) {
  const norm = normalizeUrl(url);
  const base = norm.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  return base.replace(/^_+|_+$/g, "").slice(0, 120) || "src";
}

/**
 * Register a new web source for ingestion. If a source with the same
 * id already exists it is updated rather than duplicated.
 *
 * @param {{ url: string, title?: string, tags?: string[], intervalMs?: number }} spec
 * @returns {Promise<object>}
 */
export async function registerSource(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("spec is required");
  }
  const url = normalizeUrl(spec.url);
  const id = sourceIdFromUrl(url);
  const path = sourcesPath();
  return withPathLock(path, async () => {
    const data = await loadSources();
    const now = new Date().toISOString();
    const existing = data.sources[id] || { createdAt: now, crawlCount: 0 };
    const record = {
      ...existing,
      id,
      url,
      title: typeof spec.title === "string" ? spec.title : existing.title || "",
      tags: Array.isArray(spec.tags) ? spec.tags.slice() : existing.tags || [],
      intervalMs: Number.isFinite(spec.intervalMs) && spec.intervalMs > 0
        ? Math.floor(spec.intervalMs)
        : existing.intervalMs || 3600000,
      updatedAt: now,
    };
    data.sources[id] = record;
    await saveSources(data);
    return record;
  });
}

/**
 * Execute a single crawl against a registered source. Accepts an
 * injectable fetch implementation for testability.
 *
 * @param {string} sourceId
 * @param {{ fetchImpl?: (url: string) => Promise<{ ok: boolean, status: number, text?: () => Promise<string>, body?: string }> }} [options]
 * @returns {Promise<object>}
 */
export async function crawlSource(sourceId, options = {}) {
  if (!sourceId || typeof sourceId !== "string") {
    throw new Error("sourceId is required");
  }
  const { fetchImpl } = options;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl is required");
  }
  const sourcesData = await loadSources();
  const source = sourcesData.sources[sourceId];
  if (!source) {
    throw new Error(`unknown source: ${sourceId}`);
  }
  const startedAt = new Date().toISOString();
  let body = "";
  let status = 0;
  let ok = false;
  let error = null;
  try {
    const resp = await fetchImpl(source.url);
    if (resp && typeof resp === "object") {
      status = Number(resp.status) || 0;
      ok = Boolean(resp.ok);
      if (typeof resp.text === "function") {
        body = String(await resp.text());
      } else if (typeof resp.body === "string") {
        body = resp.body;
      }
    }
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  const finishedAt = new Date().toISOString();
  const record = {
    id: `${sourceId}-${Date.now()}`,
    sourceId,
    url: source.url,
    startedAt,
    finishedAt,
    status,
    ok,
    bytes: body.length,
    error,
    bodyPreview: body.slice(0, 512),
  };

  await withPathLock(crawlsPath(), async () => {
    const data = await loadCrawls();
    if (!Array.isArray(data.crawls[sourceId])) data.crawls[sourceId] = [];
    data.crawls[sourceId].push(record);
    if (data.crawls[sourceId].length > 200) {
      data.crawls[sourceId] = data.crawls[sourceId].slice(-200);
    }
    await saveCrawls(data);
  });

  await withPathLock(sourcesPath(), async () => {
    const data = await loadSources();
    const cur = data.sources[sourceId];
    if (cur) {
      cur.lastCrawlAt = finishedAt;
      cur.lastCrawlStatus = status;
      cur.lastCrawlOk = ok;
      cur.crawlCount = (cur.crawlCount || 0) + 1;
      data.sources[sourceId] = cur;
      await saveSources(data);
    }
  });

  return record;
}

/**
 * List every registered source, optionally filtered by tag.
 * @param {{ tag?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listSources(opts = {}) {
  const data = await loadSources();
  let out = Object.values(data.sources || {});
  if (opts && typeof opts.tag === "string" && opts.tag) {
    const tag = opts.tag.toLowerCase();
    out = out.filter((s) => Array.isArray(s.tags) && s.tags.some((t) => String(t).toLowerCase() === tag));
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

/**
 * Get the most recent crawl result for a source.
 * @param {string} sourceId
 * @returns {Promise<object | null>}
 */
export async function getLastCrawl(sourceId) {
  if (!sourceId || typeof sourceId !== "string") return null;
  const data = await loadCrawls();
  const list = data.crawls[sourceId];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[list.length - 1];
}

/**
 * Record a crawl schedule. Returns the schedule record. Does not
 * spawn timers; a background worker can call crawlSource() at the
 * scheduled time.
 *
 * @param {{ sourceId: string, intervalMs: number, nextRunAt?: string }} spec
 * @returns {Promise<object>}
 */
export async function scheduleCrawl(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("spec is required");
  }
  if (!spec.sourceId || typeof spec.sourceId !== "string") {
    throw new Error("sourceId is required");
  }
  if (!Number.isFinite(spec.intervalMs) || spec.intervalMs <= 0) {
    throw new Error("intervalMs must be a positive number");
  }
  const sources = await loadSources();
  if (!sources.sources[spec.sourceId]) {
    throw new Error(`unknown source: ${spec.sourceId}`);
  }
  const path = schedulesPath();
  return withPathLock(path, async () => {
    const data = await loadSchedules();
    const now = new Date().toISOString();
    const nextRunAt = typeof spec.nextRunAt === "string"
      ? spec.nextRunAt
      : new Date(Date.now() + Math.floor(spec.intervalMs)).toISOString();
    const record = {
      sourceId: spec.sourceId,
      intervalMs: Math.floor(spec.intervalMs),
      createdAt: data.schedules[spec.sourceId]?.createdAt || now,
      updatedAt: now,
      nextRunAt,
    };
    data.schedules[spec.sourceId] = record;
    await saveSchedules(data);
    return record;
  });
}

/**
 * Return the list of scheduled crawls.
 * @returns {Promise<object[]>}
 */
export async function listSchedules() {
  const data = await loadSchedules();
  return Object.values(data.schedules || {});
}
