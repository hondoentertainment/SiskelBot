/**
 * Phase 36.2: secret rotation automation tests.
 *
 * Covers dual-key vs cutover strategies, local provider round-trip,
 * mocked vault and aws providers, scheduled rotation triggers, and
 * history tracking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate file storage per-test-run.
const TMP = mkdtempSync(join(tmpdir(), "secret-rotation-"));
process.env.STORAGE_PATH = TMP;
process.env.SECRET_STORE_KEY = Buffer.alloc(32, 7).toString("base64");

// Import AFTER env is set so modules resolve paths correctly.
const rotationMod = await import("../lib/secret-rotation-auto.js");
const localMod = await import("../lib/secret-providers/local.js");

const {
  rotateSecret,
  scheduleRotation,
  unscheduleRotation,
  listPendingRotations,
  getRotationHistory,
  getActiveSecrets,
  invalidateGraceWindow,
  runDueRotations,
  _resetForTesting,
} = rotationMod;

async function reset() {
  await _resetForTesting();
  // Also clear the local provider store by deleting any known test ids.
  try {
    const items = await localMod.listSecrets();
    for (const it of items) {
      await localMod.deleteSecret(it.id).catch(() => {});
    }
  } catch {}
}

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Local provider round-trip
// ---------------------------------------------------------------------------

test("local provider: set / get / list / delete round-trip", async () => {
  await reset();
  const set = await localMod.setSecret("api/token", "hello-world");
  assert.equal(set.id, "api/token");
  assert.equal(set.version, 1);

  const fetched = await localMod.getSecret("api/token");
  assert.equal(fetched.value, "hello-world");
  assert.equal(fetched.version, 1);

  const list = await localMod.listSecrets();
  assert.ok(list.find((x) => x.id === "api/token"));

  await localMod.setSecret("api/token", "updated");
  const v2 = await localMod.getSecret("api/token");
  assert.equal(v2.value, "updated");
  assert.equal(v2.version, 2);

  const removed = await localMod.deleteSecret("api/token");
  assert.equal(removed, true);
  const missing = await localMod.getSecret("api/token");
  assert.equal(missing, null);
});

// ---------------------------------------------------------------------------
// Dual-key rotation with grace window
// ---------------------------------------------------------------------------

test("dual-key rotation: keeps old secret active during grace window", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD-SECRET");

  const result = await rotateSecret("svc/key", {
    provider: "local",
    strategy: "dual-key",
    graceMs: 5000,
    skipTimer: true,
  });

  assert.equal(result.strategy, "dual-key");
  assert.ok(result.newValue);
  assert.notEqual(result.newValue, "OLD-SECRET");
  assert.ok(result.graceUntil, "graceUntil should be set");

  const active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 2, "both old and new should be active during grace");
  const values = active.map((a) => a.value).sort();
  assert.deepEqual(values.sort(), [result.newValue, "OLD-SECRET"].sort());

  // The provider already holds the new value
  const stored = await localMod.getSecret("svc/key");
  assert.equal(stored.value, result.newValue);
});

test("dual-key rotation: invalidateGraceWindow drops old secret", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD");
  await rotateSecret("svc/key", {
    provider: "local",
    strategy: "dual-key",
    graceMs: 60_000,
    skipTimer: true,
  });

  let active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 2);

  await invalidateGraceWindow("svc/key");
  active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 1);
  assert.equal(active[0].current, true);
});

test("dual-key rotation: zero graceMs means no dual window", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD");
  const result = await rotateSecret("svc/key", {
    provider: "local",
    strategy: "dual-key",
    graceMs: 0,
    skipTimer: true,
  });
  // graceUntil should still be set when there's an old value but expire immediately.
  assert.ok(result.graceUntil);
  // Wait a tick to cross the zero window.
  await new Promise((r) => setTimeout(r, 5));
  const active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 1);
});

test("dual-key rotation: waitForGrace option awaits cleanup", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD");
  const start = Date.now();
  await rotateSecret("svc/key", {
    provider: "local",
    strategy: "dual-key",
    graceMs: 50,
    waitForGrace: true,
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 45, "should have waited for grace window");
  const active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 1, "old secret should be cleared after grace");
});

// ---------------------------------------------------------------------------
// Cutover rotation
// ---------------------------------------------------------------------------

test("cutover rotation: replaces old secret immediately", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD");
  const result = await rotateSecret("svc/key", {
    provider: "local",
    strategy: "cutover",
  });

  assert.equal(result.strategy, "cutover");
  assert.equal(result.graceUntil, null);

  const active = await getActiveSecrets("svc/key");
  assert.equal(active.length, 1, "only new secret should be active");
  assert.equal(active[0].current, true);
  assert.equal(active[0].value, result.newValue);
});

test("rotateSecret: accepts explicit newValue", async () => {
  await reset();
  await localMod.setSecret("svc/key", "OLD");
  const result = await rotateSecret("svc/key", {
    provider: "local",
    strategy: "cutover",
    newValue: "EXPLICIT-NEW",
  });
  assert.equal(result.newValue, "EXPLICIT-NEW");
  const fresh = await localMod.getSecret("svc/key");
  assert.equal(fresh.value, "EXPLICIT-NEW");
});

test("rotateSecret: rejects invalid strategy", async () => {
  await reset();
  await assert.rejects(
    () => rotateSecret("svc/key", { provider: "local", strategy: "bogus" }),
    /invalid strategy/
  );
});

// ---------------------------------------------------------------------------
// History tracking
// ---------------------------------------------------------------------------

test("getRotationHistory: records rotation events", async () => {
  await reset();
  await localMod.setSecret("svc/hist", "V1");
  await rotateSecret("svc/hist", {
    provider: "local",
    strategy: "cutover",
  });
  await rotateSecret("svc/hist", {
    provider: "local",
    strategy: "cutover",
  });

  const history = await getRotationHistory("svc/hist");
  const rotated = history.filter((h) => h.event === "rotated");
  assert.equal(rotated.length, 2);
  assert.ok(rotated.every((h) => h.provider === "local"));
  assert.ok(rotated.every((h) => h.timestamp));
});

test("getRotationHistory: records grace_ended", async () => {
  await reset();
  await localMod.setSecret("svc/grace", "V1");
  await rotateSecret("svc/grace", {
    provider: "local",
    strategy: "dual-key",
    graceMs: 10,
    waitForGrace: true,
  });
  const history = await getRotationHistory("svc/grace");
  const ended = history.filter((h) => h.event === "grace_ended");
  assert.ok(ended.length >= 1, "should record grace_ended event");
});

// ---------------------------------------------------------------------------
// Notification webhooks
// ---------------------------------------------------------------------------

test("rotateSecret: notifies subscribers via HTTP POST", async () => {
  await reset();
  await localMod.setSecret("svc/notify", "V1");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => "" };
  };
  try {
    await rotateSecret("svc/notify", {
      provider: "local",
      strategy: "cutover",
      notify: ["https://example.com/hook1", "https://example.com/hook2"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.event, "secret_rotated");
  assert.equal(calls[0].body.secretId, "svc/notify");
  assert.equal(calls[0].body.strategy, "cutover");
});

test("rotateSecret: webhook failures don't fail rotation", async () => {
  await reset();
  await localMod.setSecret("svc/notify", "V1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const result = await rotateSecret("svc/notify", {
      provider: "local",
      strategy: "cutover",
      notify: ["https://example.com/hook"],
    });
    assert.ok(result.newValue);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test("scheduleRotation: persists config with defaults", async () => {
  await reset();
  const entry = await scheduleRotation("svc/sched", "0 3 * * 0", {
    provider: "local",
    strategy: "dual-key",
    notify: ["https://example.com/hook"],
  });
  assert.equal(entry.secretId, "svc/sched");
  assert.equal(entry.cron, "0 3 * * 0");
  assert.equal(entry.provider, "local");
  assert.equal(entry.enabled, true);

  const pending = await listPendingRotations();
  assert.ok(pending.find((p) => p.secretId === "svc/sched"));
});

test("listPendingRotations: returns nextRunAt when cron-parser available", async () => {
  await reset();
  await scheduleRotation("svc/sched", "*/5 * * * *", { provider: "local" });
  const pending = await listPendingRotations();
  const entry = pending.find((p) => p.secretId === "svc/sched");
  assert.ok(entry);
  // nextRunAt may be null if cron-parser isn't installed; accept either.
  if (entry.nextRunAt) {
    assert.ok(new Date(entry.nextRunAt).getTime() > Date.now() - 1000);
  }
});

test("unscheduleRotation: removes schedule", async () => {
  await reset();
  await scheduleRotation("svc/sched", "0 0 * * *", { provider: "local" });
  const removed = await unscheduleRotation("svc/sched");
  assert.equal(removed, true);
  const pending = await listPendingRotations();
  assert.ok(!pending.find((p) => p.secretId === "svc/sched"));

  const removedAgain = await unscheduleRotation("svc/sched");
  assert.equal(removedAgain, false);
});

test("runDueRotations: runs rotations for schedules whose cron matched recently", async () => {
  // Skip if cron-parser is not installed.
  try {
    await import("cron-parser");
  } catch {
    return;
  }
  await reset();
  await localMod.setSecret("svc/due", "V1");
  // "* * * * *" matches every minute, so the previous run is within 120s.
  await scheduleRotation("svc/due", "* * * * *", {
    provider: "local",
    strategy: "cutover",
  });

  const result = await runDueRotations();
  assert.ok(result.ran >= 1, "at least one rotation should have run");
  const history = await getRotationHistory("svc/due");
  assert.ok(history.some((h) => h.event === "rotated"));
});

test("runDueRotations: skips disabled schedules", async () => {
  try {
    await import("cron-parser");
  } catch {
    return;
  }
  await reset();
  await localMod.setSecret("svc/disabled", "V1");
  await scheduleRotation("svc/disabled", "* * * * *", {
    provider: "local",
    strategy: "cutover",
    enabled: false,
  });
  const result = await runDueRotations();
  assert.equal(result.ran, 0);
});

// ---------------------------------------------------------------------------
// Mocked Vault provider
// ---------------------------------------------------------------------------

test("vault provider: getSecret / setSecret via mocked fetch", async () => {
  await reset();
  process.env.VAULT_ADDR = "https://vault.test";
  process.env.VAULT_TOKEN = "test-token";
  process.env.VAULT_KV_MOUNT = "secret";
  process.env.VAULT_SECRET_PREFIX = "siskelbot";

  // Ensure node-vault dynamic import fails so we fall through to fetch branch.
  // (We don't need to stub it — just ensure fetch path is exercised by mocking it.)
  const originalFetch = globalThis.fetch;
  const state = new Map();
  globalThis.fetch = async (url, opts) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (opts?.method === "POST" && path.includes("/v1/secret/data/")) {
      const body = JSON.parse(opts.body);
      state.set(path, { data: body.data, version: 1 });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { version: 1, created_time: "2026-04-11T00:00:00Z" } }),
      };
    }
    if ((!opts || opts.method === "GET") && path.includes("/v1/secret/data/")) {
      const entry = state.get(path);
      if (!entry) return { ok: false, status: 404, text: async () => "" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { data: entry.data, metadata: { version: entry.version, created_time: "2026-04-11T00:00:00Z" } },
        }),
      };
    }
    if (opts?.method === "DELETE" && path.includes("/v1/secret/metadata/")) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  try {
    // Re-import with cache-bust in case a previous test loaded the module.
    const vaultMod = await import(`../lib/secret-providers/vault.js?t=${Date.now()}`);
    await vaultMod.setSecret("my-key", "shh");
    const got = await vaultMod.getSecret("my-key");
    assert.ok(got);
    assert.equal(got.value, "shh");
    const missing = await vaultMod.getSecret("does-not-exist");
    assert.equal(missing, null);
    const removed = await vaultMod.deleteSecret("my-key");
    assert.equal(removed, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_KV_MOUNT;
    delete process.env.VAULT_SECRET_PREFIX;
  }
});

test("vault provider: getSecret errors when VAULT_ADDR missing", async () => {
  const saved = { addr: process.env.VAULT_ADDR, token: process.env.VAULT_TOKEN };
  delete process.env.VAULT_ADDR;
  delete process.env.VAULT_TOKEN;
  try {
    const vaultMod = await import(`../lib/secret-providers/vault.js?t=${Date.now()}`);
    await assert.rejects(() => vaultMod.getSecret("anything"), /VAULT_ADDR/);
  } finally {
    if (saved.addr) process.env.VAULT_ADDR = saved.addr;
    if (saved.token) process.env.VAULT_TOKEN = saved.token;
  }
});

// ---------------------------------------------------------------------------
// Mocked AWS provider
// ---------------------------------------------------------------------------

test("aws provider: throws clear error when SDK missing", async () => {
  // @aws-sdk/client-secrets-manager is likely not installed; verify the error
  // path is clean.
  const awsMod = await import(`../lib/secret-providers/aws-secrets.js?t=${Date.now()}`);
  try {
    await awsMod.getSecret("anything");
    // If the SDK IS installed for some reason, this is still an acceptable path.
  } catch (e) {
    assert.match(e.message, /AWS Secrets Manager SDK not available|credential|region/i);
  }
});

// ---------------------------------------------------------------------------
// End-to-end via rotateSecret with provider dispatch
// ---------------------------------------------------------------------------

test("rotateSecret dispatches to local provider by default", async () => {
  await reset();
  const result = await rotateSecret("svc/default", {});
  // No existing secret — should still create one.
  assert.ok(result.newValue);
  assert.equal(result.strategy, "dual-key");
  // No old value, so graceUntil should be null.
  assert.equal(result.graceUntil, null);

  const stored = await localMod.getSecret("svc/default");
  assert.equal(stored.value, result.newValue);
});
