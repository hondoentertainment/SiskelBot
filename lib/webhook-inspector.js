// @ts-check
/**
 * Phase 61.2: Webhook inspector.
 *
 * Captures webhook deliveries (incoming or outgoing) and lets operators
 * replay them through an injectable transport. Persists recent captures
 * via `lib/json-path-store.js` with bounded retention.
 *
 * Export surface:
 *   - captureDelivery(delivery)
 *   - listDeliveries()
 *   - replayDelivery(id, opts?)
 *   - filterDeliveries(query)
 *   - clearCapture(id?)
 *
 * @module webhook-inspector
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_CAPTURES = 500;

function storePath() {
  return join(getDataDir(), "webhook-inspector.json");
}

let _counter = 0;
function genId(prefix) {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    deliveries: [],
    replays: [],
  });
  if (!Array.isArray(data.deliveries)) data.deliveries = [];
  if (!Array.isArray(data.replays)) data.replays = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    deliveries: Array.isArray(data.deliveries) ? data.deliveries.slice(-MAX_CAPTURES) : [],
    replays: Array.isArray(data.replays) ? data.replays.slice(-MAX_CAPTURES * 2) : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an incoming / outgoing webhook delivery.
 *
 * @param {any} delivery
 */
export function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") {
    throw new Error("delivery must be an object");
  }
  const direction = delivery.direction === "outgoing" ? "outgoing" : "incoming";
  const method = typeof delivery.method === "string" ? delivery.method.toUpperCase() : "POST";
  const url = typeof delivery.url === "string" ? delivery.url : "";
  if (!url) throw new Error("url is required");
  const event = typeof delivery.event === "string" ? delivery.event : "unknown";
  const headers = {};
  if (delivery.headers && typeof delivery.headers === "object") {
    for (const [k, v] of Object.entries(delivery.headers)) {
      if (typeof v === "string" || typeof v === "number") {
        headers[String(k)] = String(v);
      }
    }
  }
  const body = delivery.body !== undefined ? delivery.body : null;
  const status = Number.isFinite(delivery.status) ? Number(delivery.status) : null;
  const source = typeof delivery.source === "string" ? delivery.source : "unknown";
  return { direction, method, url, event, headers, body, status, source };
}

/**
 * Store a delivery capture.
 *
 * @param {any} delivery
 */
export async function captureDelivery(delivery) {
  const normalized = normalizeDelivery(delivery);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: genId("dlv"),
      ...normalized,
      capturedAt: now,
    };
    data.deliveries.push(record);
    if (data.deliveries.length > MAX_CAPTURES) {
      data.deliveries = data.deliveries.slice(-MAX_CAPTURES);
    }
    await saveStore(data);
    return record;
  });
}

/**
 * List every captured delivery (most recent first).
 */
export async function listDeliveries() {
  const data = await loadStore();
  return data.deliveries
    .slice()
    .sort((a, b) => (Date.parse(b.capturedAt) || 0) - (Date.parse(a.capturedAt) || 0));
}

/**
 * Filter deliveries. Supported filters:
 *   - event
 *   - direction
 *   - source
 *   - status
 *   - urlContains
 *   - sinceMs (relative cutoff)
 *
 * @param {object} query
 */
export async function filterDeliveries(query = {}) {
  const data = await loadStore();
  let out = data.deliveries.slice();
  if (query && typeof query === "object") {
    if (query.event) out = out.filter((d) => d.event === query.event);
    if (query.direction) out = out.filter((d) => d.direction === query.direction);
    if (query.source) out = out.filter((d) => d.source === query.source);
    if (query.status != null) out = out.filter((d) => d.status === Number(query.status));
    if (typeof query.urlContains === "string" && query.urlContains) {
      const needle = query.urlContains.toLowerCase();
      out = out.filter((d) => d.url && d.url.toLowerCase().includes(needle));
    }
    if (Number.isFinite(query.sinceMs) && query.sinceMs > 0) {
      const cutoff = Date.now() - query.sinceMs;
      out = out.filter((d) => (Date.parse(d.capturedAt) || 0) >= cutoff);
    }
  }
  return out.sort((a, b) => (Date.parse(b.capturedAt) || 0) - (Date.parse(a.capturedAt) || 0));
}

/**
 * Replay a captured delivery. Uses an injectable transport so tests can
 * assert on the payload without hitting the network.
 *
 * @param {string} id
 * @param {{ transport?: (req: any) => Promise<{ status: number, body?: any }>, overrideUrl?: string }} [opts]
 */
export async function replayDelivery(id, opts = {}) {
  if (!id || typeof id !== "string") {
    throw new Error("delivery id is required");
  }
  const data = await loadStore();
  const delivery = data.deliveries.find((d) => d.id === id);
  if (!delivery) throw new Error(`delivery ${id} not found`);
  const transport = typeof opts.transport === "function" ? opts.transport : defaultTransport;
  const url = typeof opts.overrideUrl === "string" && opts.overrideUrl ? opts.overrideUrl : delivery.url;
  const requestPayload = {
    method: delivery.method,
    url,
    headers: { ...delivery.headers },
    body: delivery.body,
  };
  let resultStatus = 0;
  let resultBody = null;
  let error = null;
  try {
    const result = await transport(requestPayload);
    resultStatus = Number(result?.status) || 0;
    resultBody = result?.body !== undefined ? result.body : null;
  } catch (err) {
    error = err?.message || String(err);
  }
  const replay = {
    id: genId("rpl"),
    deliveryId: delivery.id,
    replayedAt: new Date().toISOString(),
    requestPayload,
    responseStatus: resultStatus,
    responseBody: resultBody,
    error,
  };
  const path = storePath();
  await withPathLock(path, async () => {
    const store = await loadStore();
    store.replays.push(replay);
    if (store.replays.length > MAX_CAPTURES * 2) {
      store.replays = store.replays.slice(-MAX_CAPTURES * 2);
    }
    await saveStore(store);
  });
  return replay;
}

/**
 * Default transport used when no injector is supplied. Returns a 0
 * status so callers must provide a transport in production.
 */
async function defaultTransport(_req) {
  return { status: 0, body: { note: "no transport configured" } };
}

/**
 * Remove a captured delivery (or every capture + replay when id omitted).
 *
 * @param {string} [id]
 */
export async function clearCapture(id) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!id) {
      const cleared = data.deliveries.length + data.replays.length;
      data.deliveries = [];
      data.replays = [];
      await saveStore(data);
      return { cleared };
    }
    const before = data.deliveries.length;
    data.deliveries = data.deliveries.filter((d) => d.id !== id);
    data.replays = data.replays.filter((r) => r.deliveryId !== id);
    await saveStore(data);
    return { cleared: before - data.deliveries.length };
  });
}

/**
 * List recorded replays for a delivery (or all replays when id omitted).
 *
 * @param {string} [deliveryId]
 */
export async function listReplays(deliveryId) {
  const data = await loadStore();
  let out = data.replays.slice();
  if (deliveryId) out = out.filter((r) => r.deliveryId === deliveryId);
  return out.sort((a, b) => (Date.parse(b.replayedAt) || 0) - (Date.parse(a.replayedAt) || 0));
}
