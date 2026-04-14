/**
 * Phase 63.5: Migration assistant tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-migration-"));
process.env.STORAGE_PATH = TMP;

const {
  registerPlaybook,
  listPlaybooks,
  getPlaybook,
  startMigration,
  getMigrationStatus,
  advanceMigration,
  listMigrations,
  _reset,
} = await import("../lib/migration-assistant.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const PLAYBOOK = {
  name: "node-18-to-20",
  description: "Upgrade from Node 18 to Node 20.",
  steps: [
    { id: "update-engines", title: "Update engines in package.json", command: "npm pkg set engines.node=^20" },
    { id: "run-tests", title: "Run test suite", command: "npm test", check: "exit 0" },
    { id: "update-ci", title: "Update CI to Node 20" },
  ],
};

test("registerPlaybook validates structure and persists", async () => {
  await _reset("ws-reg");
  const clean = await registerPlaybook(PLAYBOOK);
  assert.equal(clean.name, "node-18-to-20");
  assert.equal(clean.steps.length, 3);
  const fetched = await getPlaybook("node-18-to-20");
  assert.equal(fetched.name, "node-18-to-20");
});

test("registerPlaybook rejects bad input", async () => {
  await _reset("ws-bad");
  await assert.rejects(() => registerPlaybook({ name: "", steps: [] }));
  await assert.rejects(() => registerPlaybook({ name: "n", steps: [] }));
  await assert.rejects(() => registerPlaybook({ name: "n", steps: [{ title: "no id" }] }));
});

test("listPlaybooks returns registered playbooks", async () => {
  await _reset("ws-ls");
  await registerPlaybook(PLAYBOOK);
  await registerPlaybook({ ...PLAYBOOK, name: "other", steps: [{ id: "a", title: "A" }] });
  const { playbooks } = await listPlaybooks();
  assert.ok(playbooks.length >= 2);
  const names = playbooks.map((p) => p.name);
  assert.ok(names.includes("node-18-to-20"));
  assert.ok(names.includes("other"));
});

test("startMigration errors on unknown playbook", async () => {
  await _reset("ws-start");
  await assert.rejects(() =>
    startMigration({ workspaceId: "ws-start", playbookName: "does-not-exist" }),
  );
});

test("startMigration seeds steps from the playbook", async () => {
  await _reset("ws-seed");
  await registerPlaybook(PLAYBOOK);
  const m = await startMigration({ workspaceId: "ws-seed", playbookName: PLAYBOOK.name });
  assert.equal(m.steps.length, 3);
  assert.equal(m.currentStep, 0);
  assert.equal(m.status, "in-progress");
  assert.ok(m.steps.every((s) => s.status === "pending"));
});

test("advanceMigration with pass walks through steps to completed", async () => {
  await _reset("ws-walk");
  await registerPlaybook(PLAYBOOK);
  const m = await startMigration({ workspaceId: "ws-walk", playbookName: PLAYBOOK.name });
  let cur = m;
  for (let i = 0; i < 3; i += 1) {
    cur = await advanceMigration({ migrationId: m.migrationId, stepOutcome: "pass", workspaceId: "ws-walk" });
  }
  assert.equal(cur.status, "completed");
  assert.equal(cur.currentStep, 3);
  assert.ok(cur.steps.every((s) => s.status === "completed"));
});

test("advanceMigration with fail terminates migration", async () => {
  await _reset("ws-fail");
  await registerPlaybook(PLAYBOOK);
  const m = await startMigration({ workspaceId: "ws-fail", playbookName: PLAYBOOK.name });
  const after = await advanceMigration({
    migrationId: m.migrationId,
    stepOutcome: "fail",
    workspaceId: "ws-fail",
  });
  assert.equal(after.status, "failed");
  assert.equal(after.steps[0].status, "failed");
  // Subsequent advances don't change terminal status.
  const again = await advanceMigration({
    migrationId: m.migrationId,
    stepOutcome: "pass",
    workspaceId: "ws-fail",
  });
  assert.equal(again.status, "failed");
});

test("advanceMigration skip advances without marking completed", async () => {
  await _reset("ws-skip");
  await registerPlaybook(PLAYBOOK);
  const m = await startMigration({ workspaceId: "ws-skip", playbookName: PLAYBOOK.name });
  const after = await advanceMigration({
    migrationId: m.migrationId,
    stepOutcome: "skip",
    workspaceId: "ws-skip",
  });
  assert.equal(after.steps[0].status, "skipped");
  assert.equal(after.currentStep, 1);
  assert.equal(after.status, "in-progress");
});

test("advanceMigration validates outcome", async () => {
  await _reset("ws-bad-outcome");
  await registerPlaybook(PLAYBOOK);
  const m = await startMigration({ workspaceId: "ws-bad-outcome", playbookName: PLAYBOOK.name });
  await assert.rejects(() =>
    advanceMigration({ migrationId: m.migrationId, stepOutcome: "bogus", workspaceId: "ws-bad-outcome" }),
  );
});

test("getMigrationStatus and listMigrations round-trip", async () => {
  await _reset("ws-rt");
  await registerPlaybook(PLAYBOOK);
  const a = await startMigration({ workspaceId: "ws-rt", playbookName: PLAYBOOK.name });
  const b = await startMigration({ workspaceId: "ws-rt", playbookName: PLAYBOOK.name });
  const fetched = await getMigrationStatus(a.migrationId, "ws-rt");
  assert.equal(fetched.migrationId, a.migrationId);
  const { migrations } = await listMigrations("ws-rt");
  assert.equal(migrations.length, 2);
  const ids = migrations.map((m) => m.migrationId);
  assert.ok(ids.includes(a.migrationId));
  assert.ok(ids.includes(b.migrationId));
});
