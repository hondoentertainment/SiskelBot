/**
 * Phase 66.5: Tenant migration tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tenant-mig-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  planMigration,
  executeMigration,
  rollbackMigration,
  getMigrationStatus,
  listMigrations,
  PHASES,
} = await import("../lib/tenant-migration.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("planMigration creates a planned record", async () => {
  const m = await planMigration({
    tenantId: "tenant-1",
    fromRegion: "us-east-1",
    toRegion: "us-west-2",
    owner: "ops",
  });
  assert.ok(m.id);
  assert.equal(m.tenantId, "tenant-1");
  assert.equal(m.status, "planned");
  assert.equal(m.currentPhase, "plan");
  assert.deepEqual(m.completedPhases, ["plan"]);
});

test("planMigration validates inputs", async () => {
  await assert.rejects(() => planMigration(null));
  await assert.rejects(() => planMigration({ tenantId: "t" }));
  await assert.rejects(() => planMigration({ tenantId: "t", fromRegion: "a" }));
  await assert.rejects(() => planMigration({ tenantId: "t", fromRegion: "a", toRegion: "a" }));
});

test("planMigration rejects concurrent active migrations per tenant", async () => {
  await planMigration({ tenantId: "tenant-conc", fromRegion: "a", toRegion: "b" });
  await assert.rejects(() =>
    planMigration({ tenantId: "tenant-conc", fromRegion: "a", toRegion: "c" }),
  );
});

test("executeMigration walks through all phases to verify", async () => {
  const m = await planMigration({ tenantId: "tenant-walk", fromRegion: "r1", toRegion: "r2" });
  const done = await executeMigration(m.id);
  assert.equal(done.status, "completed");
  assert.equal(done.currentPhase, "verify");
  assert.deepEqual(done.completedPhases, PHASES);
});

test("executeMigration stops at untilPhase", async () => {
  const m = await planMigration({ tenantId: "tenant-partial", fromRegion: "r1", toRegion: "r2" });
  const result = await executeMigration(m.id, { untilPhase: "replicate" });
  assert.equal(result.currentPhase, "replicate");
  assert.equal(result.status, "in_progress");
});

test("executeMigration marks failed when a hook throws", async () => {
  const m = await planMigration({ tenantId: "tenant-fail", fromRegion: "r1", toRegion: "r2" });
  await assert.rejects(
    () =>
      executeMigration(m.id, {
        hooks: {
          replicate: async () => {
            throw new Error("replication failed");
          },
        },
      }),
    /replication failed/,
  );
  const status = await getMigrationStatus(m.id);
  assert.equal(status.status, "failed");
});

test("executeMigration rejects unknown ids and phases", async () => {
  await assert.rejects(() => executeMigration("missing"));
  const m = await planMigration({ tenantId: "tenant-badphase", fromRegion: "r1", toRegion: "r2" });
  await assert.rejects(() => executeMigration(m.id, { untilPhase: "not-a-phase" }));
});

test("rollbackMigration reverts to plan and marks rolled_back", async () => {
  const m = await planMigration({ tenantId: "tenant-rb", fromRegion: "r1", toRegion: "r2" });
  await executeMigration(m.id, { untilPhase: "cutover" });
  const rb = await rollbackMigration(m.id, { reason: "test-rb" });
  assert.equal(rb.status, "rolled_back");
  assert.equal(rb.currentPhase, "plan");
  assert.deepEqual(rb.completedPhases, ["plan"]);
  assert.ok(rb.history.some((h) => h.phase === "rollback"));
});

test("rollbackMigration is idempotent", async () => {
  const m = await planMigration({ tenantId: "tenant-idem", fromRegion: "r1", toRegion: "r2" });
  await rollbackMigration(m.id);
  const again = await rollbackMigration(m.id);
  assert.equal(again.status, "rolled_back");
});

test("getMigrationStatus returns record or null", async () => {
  const m = await planMigration({ tenantId: "tenant-get", fromRegion: "r1", toRegion: "r2" });
  const fetched = await getMigrationStatus(m.id);
  assert.ok(fetched);
  assert.equal(fetched.id, m.id);
  assert.equal(await getMigrationStatus("missing"), null);
});

test("listMigrations filters by tenant and status", async () => {
  await planMigration({ tenantId: "tenant-list", fromRegion: "a", toRegion: "b" });
  const all = await listMigrations({ tenantId: "tenant-list" });
  assert.ok(all.length >= 1);
  for (const r of all) assert.equal(r.tenantId, "tenant-list");
  const planned = await listMigrations({ status: "planned" });
  for (const r of planned) assert.equal(r.status, "planned");
});
