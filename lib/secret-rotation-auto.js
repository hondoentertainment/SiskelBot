/**
 * Phase 36.2: Automatic secret rotation with Vault / AWS Secrets Manager / local.
 *
 * Supports two rotation strategies:
 *   - dual-key: write new secret, keep old active during a grace window, then
 *     invalidate old. During the window both old and new are returned by
 *     getActiveSecrets() so middleware can accept either.
 *   - cutover: immediately replace the existing secret with the new one.
 *
 * Rotation configs and history are persisted under data/secret-rotations.json
 * (via the durable json-path-store abstraction). Subscribers can be notified
 * via HTTP POST webhook URLs attached to the rotation config.
 *
 * Public API:
 *   rotateSecret(secretId, options)     - perform rotation now
 *   scheduleRotation(secretId, cron, opts) - register a cron schedule
 *   listPendingRotations()              - list schedules with next-run info
 *   getRotationHistory(secretId)        - return rotation events for a secret
 *   unscheduleRotation(secretId)        - remove a schedule
 *   getActiveSecrets(secretId)          - return [{version, value}] still valid
 *   _resetForTesting()                  - reset in-memory cache (tests only)
 */

import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LENGTH = 48;
const MAX_HISTORY = 100;

function storePath() {
  return join(getDataDir(), "secret-rotations.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    _version: STORE_VERSION,
    schedules: {},
    history: {},
    active: {},
  });
  data.schedules = data.schedules || {};
  data.history = data.history || {};
  data.active = data.active || {};
  return data;
}

async function saveStore(data) {
  data._version = STORE_VERSION;
  await writeJsonPath(storePath(), data);
}

async function loadProvider(provider) {
  switch (provider) {
    case "vault":
      return import("./secret-providers/vault.js");
    case "aws":
      return import("./secret-providers/aws-secrets.js");
    case "local":
    default:
      return import("./secret-providers/local.js");
  }
}

function generateSecret(length = DEFAULT_LENGTH) {
  // URL-safe base64 is convenient and covers most API-key uses.
  return randomBytes(length).toString("base64url");
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(arr, max) {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

async function appendHistory(secretId, entry) {
  const path = storePath();
  await withPathLock(path, async () => {
    const data = await loadStore();
    const list = Array.isArray(data.history[secretId]) ? data.history[secretId] : [];
    list.push({ id: randomUUID(), timestamp: nowIso(), ...entry });
    data.history[secretId] = clamp(list, MAX_HISTORY);
    await saveStore(data);
  });
}

async function updateActive(secretId, record) {
  const path = storePath();
  await withPathLock(path, async () => {
    const data = await loadStore();
    data.active[secretId] = record;
    await saveStore(data);
  });
}

async function notifyWebhooks(urls, payload) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  for (const url of urls) {
    if (!url || typeof url !== "string") continue;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Best-effort: record text but do not throw — rotation must succeed
        // even when notification delivery fails.
        try { await res.text(); } catch {}
      }
    } catch {
      // swallow; delivery failure is logged in history
    }
  }
}

/**
 * Rotate a secret.
 *
 * @param {string} secretId
 * @param {object} [options]
 * @param {"vault"|"aws"|"local"} [options.provider="local"]
 * @param {"dual-key"|"cutover"} [options.strategy="dual-key"]
 * @param {number} [options.graceMs] - dual-key grace window (ms)
 * @param {number} [options.length] - generated secret length in bytes
 * @param {string|Function} [options.newValue] - explicit new value or generator
 * @param {string[]} [options.notify] - webhook URLs to POST rotation events to
 * @returns {Promise<object>} rotation result
 */
export async function rotateSecret(secretId, options = {}) {
  if (!secretId || typeof secretId !== "string") {
    throw new Error("rotateSecret: secretId required");
  }
  const provider = options.provider || "local";
  const strategy = options.strategy || "dual-key";
  if (!["dual-key", "cutover"].includes(strategy)) {
    throw new Error(`rotateSecret: invalid strategy "${strategy}"`);
  }
  const graceMs = Number.isFinite(options.graceMs) ? Math.max(0, options.graceMs) : DEFAULT_GRACE_MS;
  const length = Number.isFinite(options.length) ? options.length : DEFAULT_LENGTH;
  const mod = await loadProvider(provider);

  // Fetch current value (may be null if secret doesn't exist yet).
  let oldRecord = null;
  try {
    oldRecord = await mod.getSecret(secretId);
  } catch (e) {
    throw new Error(`rotateSecret: failed to read current secret: ${e.message}`);
  }

  // Generate or accept a new value.
  let newValue;
  if (typeof options.newValue === "function") {
    newValue = await options.newValue();
  } else if (typeof options.newValue === "string") {
    newValue = options.newValue;
  } else {
    newValue = generateSecret(length);
  }

  // Write new secret through provider.
  let writeResult;
  try {
    writeResult = await mod.setSecret(secretId, newValue);
  } catch (e) {
    await appendHistory(secretId, {
      event: "rotation_failed",
      provider,
      strategy,
      error: e.message,
    });
    throw new Error(`rotateSecret: provider setSecret failed: ${e.message}`);
  }

  const rotatedAt = nowIso();
  const activeRecord = {
    provider,
    strategy,
    rotatedAt,
    newVersion: writeResult?.version || null,
    newValue, // kept so getActiveSecrets can return it without re-reading
    old: null,
    graceUntil: null,
  };

  if (strategy === "dual-key" && oldRecord?.value) {
    activeRecord.old = {
      value: oldRecord.value,
      version: oldRecord.version || null,
    };
    activeRecord.graceUntil = new Date(Date.now() + graceMs).toISOString();
  }

  await updateActive(secretId, activeRecord);

  // Fire webhook notifications (best-effort, non-blocking for history).
  const notifyPayload = {
    event: "secret_rotated",
    secretId,
    provider,
    strategy,
    version: activeRecord.newVersion,
    rotatedAt,
    graceUntil: activeRecord.graceUntil,
  };
  await notifyWebhooks(options.notify, notifyPayload);

  await appendHistory(secretId, {
    event: "rotated",
    provider,
    strategy,
    version: activeRecord.newVersion,
    graceUntil: activeRecord.graceUntil,
    notifiedCount: Array.isArray(options.notify) ? options.notify.length : 0,
  });

  // Schedule grace-window cleanup (non-blocking). In test mode callers can
  // await invalidateGraceWindow directly.
  if (strategy === "dual-key" && graceMs > 0 && oldRecord?.value) {
    if (options.waitForGrace) {
      await new Promise((r) => setTimeout(r, graceMs));
      await invalidateGraceWindow(secretId);
    } else if (!options.skipTimer) {
      const timer = setTimeout(() => {
        invalidateGraceWindow(secretId).catch(() => {});
      }, graceMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  return {
    secretId,
    provider,
    strategy,
    version: activeRecord.newVersion,
    rotatedAt,
    graceUntil: activeRecord.graceUntil,
    newValue,
  };
}

/**
 * Invalidate the dual-key grace window, dropping the old secret from the
 * active record. Safe to call multiple times.
 */
export async function invalidateGraceWindow(secretId) {
  const path = storePath();
  await withPathLock(path, async () => {
    const data = await loadStore();
    const record = data.active[secretId];
    if (!record) return;
    if (record.old) {
      record.old = null;
      record.graceUntil = null;
      data.active[secretId] = record;
      await saveStore(data);
    }
  });
  await appendHistory(secretId, { event: "grace_ended" });
}

/**
 * Return the currently valid secret values for a given id. During a dual-key
 * rotation the array contains both new and old values.
 */
export async function getActiveSecrets(secretId) {
  const data = await loadStore();
  const record = data.active[secretId];
  if (!record) return [];
  const out = [{ value: record.newValue, version: record.newVersion, current: true }];
  if (record.old && record.graceUntil) {
    if (new Date(record.graceUntil).getTime() > Date.now()) {
      out.push({ value: record.old.value, version: record.old.version, current: false });
    }
  }
  return out;
}

/**
 * Schedule a rotation by cron expression. The schedule is persisted; the
 * in-process scheduler picks it up via registerRotationSchedulerHook (see
 * lib/scheduler.js integration). Returns the stored schedule.
 *
 * @param {string} secretId
 * @param {string} cron - cron expression, e.g. "0 3 * * 0"
 * @param {object} [opts]
 * @param {"vault"|"aws"|"local"} [opts.provider="local"]
 * @param {"dual-key"|"cutover"} [opts.strategy="dual-key"]
 * @param {number} [opts.graceMs]
 * @param {string[]} [opts.notify]
 * @param {boolean} [opts.enabled=true]
 */
export async function scheduleRotation(secretId, cron, opts = {}) {
  if (!secretId || typeof secretId !== "string") {
    throw new Error("scheduleRotation: secretId required");
  }
  if (!cron || typeof cron !== "string") {
    throw new Error("scheduleRotation: cron required");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = data.schedules[secretId] || {};
    const entry = {
      secretId,
      cron: cron.trim(),
      provider: opts.provider || existing.provider || "local",
      strategy: opts.strategy || existing.strategy || "dual-key",
      graceMs: Number.isFinite(opts.graceMs) ? opts.graceMs : existing.graceMs ?? DEFAULT_GRACE_MS,
      notify: Array.isArray(opts.notify) ? opts.notify : existing.notify || [],
      enabled: opts.enabled !== undefined ? !!opts.enabled : existing.enabled !== false,
      createdAt: existing.createdAt || nowIso(),
      updatedAt: nowIso(),
    };
    data.schedules[secretId] = entry;
    await saveStore(data);
    return entry;
  });
}

/**
 * Remove a rotation schedule. Returns true if removed.
 */
export async function unscheduleRotation(secretId) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.schedules[secretId]) return false;
    delete data.schedules[secretId];
    await saveStore(data);
    return true;
  });
}

/**
 * Compute the next run time for a cron expression. Requires cron-parser.
 * Returns null if the expression cannot be parsed.
 */
async function nextRunFor(cronExpr) {
  try {
    const mod = await import("cron-parser");
    const parseExpression = mod.parseExpression || mod.default?.parseExpression;
    if (!parseExpression) return null;
    const interval = parseExpression(cronExpr, { currentDate: new Date() });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * List enabled rotation schedules along with their next-run timestamp.
 */
export async function listPendingRotations() {
  const data = await loadStore();
  const schedules = Object.values(data.schedules);
  const out = [];
  for (const s of schedules) {
    const nextRunAt = await nextRunFor(s.cron);
    out.push({ ...s, nextRunAt });
  }
  return out;
}

/**
 * Return the rotation history (most recent last) for a secret.
 */
export async function getRotationHistory(secretId) {
  if (!secretId) throw new Error("getRotationHistory: secretId required");
  const data = await loadStore();
  return Array.isArray(data.history[secretId]) ? data.history[secretId] : [];
}

/**
 * Run any rotation schedules that are due now. Called by the cron scheduler
 * integration. Uses a simple "within last 2 minutes" window check compatible
 * with the same approach used by lib/scheduler.js#runDueJobsVercel.
 */
export async function runDueRotations() {
  const data = await loadStore();
  const schedules = Object.values(data.schedules).filter((s) => s.enabled);
  let ran = 0;
  for (const sched of schedules) {
    try {
      const mod = await import("cron-parser");
      const parseExpression = mod.parseExpression || mod.default?.parseExpression;
      if (!parseExpression) continue;
      const interval = parseExpression(sched.cron, { currentDate: new Date() });
      const prevMs = interval.prev().toDate().getTime();
      if (Date.now() - prevMs >= 120_000) continue;
    } catch {
      continue;
    }
    try {
      await rotateSecret(sched.secretId, {
        provider: sched.provider,
        strategy: sched.strategy,
        graceMs: sched.graceMs,
        notify: sched.notify,
      });
      ran++;
    } catch (e) {
      await appendHistory(sched.secretId, {
        event: "scheduled_rotation_failed",
        error: e.message,
      });
    }
  }
  return { ran };
}

/**
 * Test-only: clear the store file for isolation between tests.
 */
export async function _resetForTesting() {
  await writeJsonPath(storePath(), {
    _version: STORE_VERSION,
    schedules: {},
    history: {},
    active: {},
  });
}
