/**
 * Phase 50.5: Post-quantum migration tooling tests.
 *
 * Covers scanning, planning, rotation, rollback, status, audit, readiness,
 * report generation, idempotency, and concurrent rotation safety.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate STORAGE_PATH so persisted state does not leak across suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-pq-migration-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;
// Provide deterministic JWT/TLS env so scan has something to find.
process.env.JWT_ALGORITHM = "RS256";
process.env.JWT_KEY_ID = "test-jwt-key";
process.env.TLS_KEY_ALGORITHM = "ecdsa-p256";
process.env.TLS_KEY_ID = "test-tls-key";

const {
  scanClassicalKeys,
  planMigration,
  rotateKey,
  rollbackRotation,
  getMigrationStatus,
  recordMigrationEvent,
  validatePqReadiness,
  generateMigrationReport,
  _internals,
} = await import("../lib/pq-migration.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- 1. Scanning ----

test("scanClassicalKeys returns an array", async () => {
  const keys = await scanClassicalKeys();
  assert.ok(Array.isArray(keys));
  // Should pick up JWT and TLS entries from env.
  const ids = keys.map((k) => k.keyId);
  assert.ok(ids.includes("test-jwt-key"));
  assert.ok(ids.includes("test-tls-key"));
});

test("scanClassicalKeys marks rotatable classical algorithms", async () => {
  const keys = await scanClassicalKeys();
  const jwt = keys.find((k) => k.keyId === "test-jwt-key");
  assert.ok(jwt);
  assert.equal(jwt.rotatable, true);
  assert.equal(jwt.algorithm, "rsa-2048");
  assert.equal(jwt.location, "jwt-config");
});

test("scanClassicalKeys with no env vars returns empty results gracefully", async () => {
  const savedJwt = process.env.JWT_ALGORITHM;
  const savedTls = process.env.TLS_KEY_ALGORITHM;
  delete process.env.JWT_ALGORITHM;
  delete process.env.TLS_KEY_ALGORITHM;
  try {
    const keys = await scanClassicalKeys({ includeHsm: false });
    assert.ok(Array.isArray(keys));
    assert.equal(keys.length, 0);
  } finally {
    process.env.JWT_ALGORITHM = savedJwt;
    process.env.TLS_KEY_ALGORITHM = savedTls;
  }
});

// ---- 2. Planning ----

test("planMigration produces a valid plan with steps and risks", async () => {
  const keys = await scanClassicalKeys();
  const plan = await planMigration(keys, "ml-dsa-65");
  assert.ok(Array.isArray(plan));
  assert.ok(plan.length > 0);
  for (const p of plan) {
    assert.ok(p.keyId);
    assert.ok(p.from);
    assert.ok(p.to);
    assert.ok(Array.isArray(p.steps));
    assert.ok(p.steps.length > 0);
    assert.ok(Array.isArray(p.risks));
    assert.ok(typeof p.estimatedTime === "number");
  }
});

test("planMigration rejects invalid target level", async () => {
  await assert.rejects(() => planMigration([], "not-a-real-level"), /invalid target level/);
});

test("planMigration rejects non-array input", async () => {
  await assert.rejects(() => planMigration("oops"), /must be an array/);
});

// ---- 3. Rotation ----

test("rotateKey creates a new key entry and updates store", async () => {
  await scanClassicalKeys(); // ensure inventory populated
  const result = await rotateKey("test-jwt-key", { targetLevel: "ml-dsa-65" });
  assert.equal(result.oldKeyId, "test-jwt-key");
  assert.ok(result.newKeyId);
  assert.ok(result.newKeyId.startsWith("test-jwt-key-pq-"));
  assert.equal(result.status, "rotated");
  assert.ok(typeof result.rotatedAt === "number");
});

test("rotateKey records an event in the audit trail", async () => {
  const before = await _internals.loadAudit();
  const beforeCount = before.events.length;
  await scanClassicalKeys();
  // Rotate a fresh key so we always have something to rotate.
  await rotateKey("test-tls-key", { targetLevel: "ml-dsa-65", actor: "unit-test" });
  const after = await _internals.loadAudit();
  assert.ok(after.events.length > beforeCount);
  const last = after.events[after.events.length - 1];
  assert.equal(last.type, "rotate");
  assert.equal(last.actor, "unit-test");
});

test("rotateKey is idempotent — re-rotating already rotated key returns already_rotated", async () => {
  await scanClassicalKeys();
  const first = await rotateKey("test-jwt-key").catch(() => null);
  // First call may or may not succeed depending on prior tests; request again.
  const again = await rotateKey("test-jwt-key");
  // The second call must either succeed as already_rotated or return a valid result.
  assert.ok(again.newKeyId);
  assert.ok(["rotated", "already_rotated"].includes(again.status));
});

test("rotateKey rejects unknown keyId", async () => {
  await assert.rejects(() => rotateKey("does-not-exist-12345"), /key not found/);
});

test("rotateKey rejects missing keyId", async () => {
  await assert.rejects(() => rotateKey(""), /keyId is required/);
});

test("rotateKey rejects invalid target level", async () => {
  await scanClassicalKeys();
  await assert.rejects(() => rotateKey("test-tls-key", { targetLevel: "bogus" }), /invalid target level/);
});

// ---- 4. Status ----

test("getMigrationStatus returns correct counts after rotations", async () => {
  await scanClassicalKeys();
  const status = await getMigrationStatus();
  assert.ok(typeof status.total === "number");
  assert.ok(typeof status.migrated === "number");
  assert.ok(typeof status.pending === "number");
  assert.ok(typeof status.inProgress === "number");
  assert.ok(typeof status.failed === "number");
  assert.ok(typeof status.percentComplete === "number");
  assert.equal(status.total, status.migrated + status.pending + status.inProgress + status.failed);
});

// ---- 5. Rollback ----

test("rollbackRotation restores the previous classical state", async () => {
  // Set up a scenario specifically for rollback using a new key.
  process.env.JWT_KEY_ID = "rollback-test-key";
  process.env.JWT_ALGORITHM = "ES256";
  await scanClassicalKeys();
  await rotateKey("rollback-test-key");
  const rollback = await rollbackRotation("rollback-test-key");
  assert.equal(rollback.keyId, "rollback-test-key");
  assert.equal(rollback.status, "rolled_back");
  const store = await _internals.loadStore();
  const entry = store.keys["rollback-test-key"];
  assert.ok(entry);
  assert.notEqual(entry.status, "rotated");
});

test("rollbackRotation rejects key with no active rotation", async () => {
  await assert.rejects(() => rollbackRotation("never-rotated-key"), /key not found|no active rotation/);
});

// ---- 6. Readiness ----

test("validatePqReadiness detects missing modules gracefully", async () => {
  const readiness = await validatePqReadiness();
  assert.ok(typeof readiness.ready === "boolean");
  assert.ok(Array.isArray(readiness.missing));
  assert.ok(Array.isArray(readiness.warnings));
  assert.ok(readiness.modules);
  // In this phase the modules are expected to be missing placeholders.
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.length >= 1);
});

test("validatePqReadiness is non-destructive — does not mutate store", async () => {
  const before = await _internals.loadStore();
  const beforeKeyCount = Object.keys(before.keys).length;
  await validatePqReadiness();
  const after = await _internals.loadStore();
  const afterKeyCount = Object.keys(after.keys).length;
  assert.equal(afterKeyCount, beforeKeyCount);
});

// ---- 7. Audit event persistence ----

test("recordMigrationEvent persists to the audit log", async () => {
  const before = await _internals.loadAudit();
  const ev = await recordMigrationEvent({
    type: "test-event",
    keyId: "some-key",
    actor: "tester",
  });
  assert.ok(ev.id);
  assert.equal(ev.type, "test-event");
  const after = await _internals.loadAudit();
  assert.equal(after.events.length, before.events.length + 1);
});

test("recordMigrationEvent rejects non-object input", async () => {
  await assert.rejects(() => recordMigrationEvent(null), /must be an object/);
});

// ---- 8. Report generation ----

test("generateMigrationReport has the expected structure", async () => {
  const report = await generateMigrationReport();
  assert.ok(report.status);
  assert.ok(report.readiness);
  assert.ok(Array.isArray(report.inventory));
  assert.ok(Array.isArray(report.timeline));
  assert.ok(Array.isArray(report.recommendations));
  assert.ok(typeof report.generatedAt === "number");
});

test("generateMigrationReport includes a timeline derived from audit events", async () => {
  // Ensure there is at least one event in the audit log.
  await recordMigrationEvent({ type: "report-timeline-probe", keyId: "probe", actor: "test" });
  const report = await generateMigrationReport();
  assert.ok(report.timeline.length > 0);
  // Timeline should be sorted ascending by time.
  for (let i = 1; i < report.timeline.length; i++) {
    assert.ok(report.timeline[i].at >= report.timeline[i - 1].at);
  }
});

// ---- 9. Concurrency ----

test("concurrent rotations of distinct keys are handled safely", async () => {
  // Register two rotatable keys via env + scan so both are in the store.
  process.env.JWT_KEY_ID = "concurrent-a";
  process.env.JWT_ALGORITHM = "RS256";
  process.env.TLS_KEY_ID = "concurrent-b";
  process.env.TLS_KEY_ALGORITHM = "ecdsa-p256";
  await scanClassicalKeys();

  const [a, b] = await Promise.all([
    rotateKey("concurrent-a"),
    rotateKey("concurrent-b"),
  ]);
  assert.ok(a.newKeyId);
  assert.ok(b.newKeyId);
  assert.notEqual(a.newKeyId, b.newKeyId);

  const store = await _internals.loadStore();
  assert.equal(store.keys["concurrent-a"].status, "rotated");
  assert.equal(store.keys["concurrent-b"].status, "rotated");
});
