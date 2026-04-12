/**
 * Phase 61.2: Webhook inspector — testing + replay tool.
 *
 * Lists recent webhook deliveries from the DLQ plus a live probe log so
 * operators can inspect payloads and replay them against the same URL or a
 * different URL with the same or modified payload.
 *
 * Storage layout (via json-path-store):
 *   data/webhook-inspector/live.json   — ring buffer of recent probes
 *   data/webhook-inspector/replays.json — history of replays
 *
 * DLQ entries are read straight from `lib/webhook-delivery.js`.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import {
  getDLQ,
  retryDLQEntry,
  deliverWebhook,
} from "./webhook-delivery.js";

// ─── Storage paths ─────────────────────────────────────────────────────────

const MAX_LIVE = 200;
const MAX_REPLAYS = 200;

function livePath() {
  return join(getDataDir(), "webhook-inspector", "live.json");
}

function replaysPath() {
  return join(getDataDir(), "webhook-inspector", "replays.json");
}

// ─── Probe log ─────────────────────────────────────────────────────────────

/**
 * Record a probe — a synthetic or real webhook delivery that the operator
 * wants to inspect. Called by manual probe endpoints.
 *
 * @param {{url: string, payload?: any, result?: object, source?: string}} entry
 */
export async function recordProbe(entry = {}) {
  if (!entry || typeof entry !== "object") {
    throw new Error("entry is required");
  }
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!url) throw new Error("url is required");
  const probe = {
    id: randomUUID(),
    url,
    payload: entry.payload ?? null,
    result: entry.result ?? null,
    source: entry.source || "probe",
    recordedAt: new Date().toISOString(),
  };
  await withPathLock(livePath(), async () => {
    const data = await readJsonPath(livePath(), { probes: [] });
    const probes = Array.isArray(data.probes) ? data.probes : [];
    probes.unshift(probe);
    if (probes.length > MAX_LIVE) probes.length = MAX_LIVE;
    await writeJsonPath(livePath(), { probes });
  });
  return probe;
}

export async function listProbes(limit = 50) {
  const data = await readJsonPath(livePath(), { probes: [] });
  const probes = Array.isArray(data.probes) ? data.probes : [];
  const n = Math.max(1, Math.min(MAX_LIVE, Number(limit) || 50));
  return probes.slice(0, n);
}

export async function clearProbes() {
  await writeJsonPath(livePath(), { probes: [] });
  return { ok: true };
}

// ─── Combined listing ──────────────────────────────────────────────────────

/**
 * List recent deliveries — merges DLQ entries and probe log.
 * @param {{limit?: number, source?: "dlq"|"probe"|"all", url?: string}} [opts]
 */
export async function listDeliveries(opts = {}) {
  const source = opts.source || "all";
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
  const urlFilter = typeof opts.url === "string" ? opts.url : null;

  const entries = [];
  if (source === "all" || source === "dlq") {
    const dlq = await getDLQ();
    for (const e of dlq) {
      entries.push({
        kind: "dlq",
        id: e.id,
        url: e.url,
        payload: e.payload,
        error: e.error,
        retryCount: e.retryCount || 0,
        recordedAt: e.failedAt,
      });
    }
  }
  if (source === "all" || source === "probe") {
    const probes = await listProbes(limit);
    for (const p of probes) {
      entries.push({
        kind: "probe",
        id: p.id,
        url: p.url,
        payload: p.payload,
        result: p.result,
        source: p.source,
        recordedAt: p.recordedAt,
      });
    }
  }
  const filtered = urlFilter ? entries.filter((e) => e.url === urlFilter) : entries;
  filtered.sort((a, b) => {
    const ta = Date.parse(a.recordedAt || 0) || 0;
    const tb = Date.parse(b.recordedAt || 0) || 0;
    return tb - ta;
  });
  return filtered.slice(0, limit);
}

// ─── Replay ────────────────────────────────────────────────────────────────

/**
 * Replay a delivery. Accepts either a DLQ id (uses `retryDLQEntry`) or
 * explicit `url`/`payload` overrides.
 *
 * @param {{id?: string, url?: string, payload?: any, secret?: string, retries?: number}} opts
 */
export async function replayDelivery(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const started = Date.now();
  let result;
  let target;
  let payloadUsed;

  if (opts.id && !opts.url && !opts.payload) {
    // Replay a DLQ entry as-is.
    const dlq = await getDLQ();
    const entry = dlq.find((e) => e.id === opts.id);
    if (!entry) {
      const err = new Error("delivery not found");
      err.code = "NOT_FOUND";
      throw err;
    }
    target = entry.url;
    payloadUsed = entry.payload;
    result = await retryDLQEntry(opts.id);
  } else {
    // Free-form replay. Use the provided url/payload, or fetch an existing
    // delivery's payload when only id is given.
    let baseUrl = opts.url;
    let basePayload = opts.payload;
    if (opts.id) {
      const dlq = await getDLQ();
      const entry = dlq.find((e) => e.id === opts.id);
      if (entry) {
        baseUrl = baseUrl || entry.url;
        basePayload = basePayload !== undefined ? basePayload : entry.payload;
      } else {
        const probes = await listProbes(MAX_LIVE);
        const probe = probes.find((p) => p.id === opts.id);
        if (probe) {
          baseUrl = baseUrl || probe.url;
          basePayload = basePayload !== undefined ? basePayload : probe.payload;
        }
      }
    }
    if (!baseUrl) throw new Error("url is required");
    target = baseUrl;
    payloadUsed = basePayload ?? {};
    result = await deliverWebhook(baseUrl, basePayload ?? {}, {
      secret: opts.secret,
      retries: opts.retries,
    });
  }

  const entry = {
    id: randomUUID(),
    originalId: opts.id || null,
    url: target,
    payload: payloadUsed,
    result,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  await withPathLock(replaysPath(), async () => {
    const data = await readJsonPath(replaysPath(), { replays: [] });
    const replays = Array.isArray(data.replays) ? data.replays : [];
    replays.unshift(entry);
    if (replays.length > MAX_REPLAYS) replays.length = MAX_REPLAYS;
    await writeJsonPath(replaysPath(), { replays });
  });
  return entry;
}

export async function listReplays(limit = 50) {
  const data = await readJsonPath(replaysPath(), { replays: [] });
  const replays = Array.isArray(data.replays) ? data.replays : [];
  const n = Math.max(1, Math.min(MAX_REPLAYS, Number(limit) || 50));
  return replays.slice(0, n);
}

// ─── Internal test helpers ────────────────────────────────────────────────

export const _internals = {
  livePath,
  replaysPath,
  MAX_LIVE,
  MAX_REPLAYS,
};
