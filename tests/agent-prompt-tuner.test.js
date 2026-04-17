/**
 * Tests for the offline auto prompt-tuner.
 * Uses an isolated STORAGE_PATH so tests don't touch the real data dir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-prompt-tuner-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  synthesizePatch,
  savePatch,
  listPatches,
  getActivePatch,
  setPatchStatus,
  autoTuneAndApply,
  getActivePatchContent,
  MAX_PATCH_CHARS_EXPORTED,
} = await import("../lib/agent-prompt-tuner.js");

const { recordRunFailures } = await import("../lib/agent-failure-store.js");
const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
const { recordConflict, clearConflicts } = await import("../lib/swarm-conflict-store.js");

function uniqueWs(tag) {
  return `t-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("synthesizePatch: returns null for empty workspace (no signal)", async () => {
  const ws = uniqueWs("empty");
  const p = await synthesizePatch(ws);
  assert.equal(p, null);
});

test("synthesizePatch: returns null for tiny signal below thresholds", async () => {
  const ws = uniqueWs("tiny");
  // 1 failure, 2 genealogy samples, 0 conflicts → below thresholds.
  await recordRunFailures(ws, [{ tool: "web_search", category: "timeout" }]);
  await recordToolOutcomes(ws, [
    { tool: "web_search", ok: true },
    { tool: "web_search", ok: false },
  ]);
  const p = await synthesizePatch(ws);
  assert.equal(p, null);
});

test("synthesizePatch: populated workspace produces Known-bad + Reliable sections", async () => {
  const ws = uniqueWs("populated");

  // Reliable tool: search_context, 10/10 successes → ~92% smoothed rate.
  await recordToolOutcomes(ws, Array.from({ length: 10 }, () => ({ tool: "search_context", ok: true })));
  // Unreliable tool: flaky_api, 1/9 failures → low success rate.
  await recordToolOutcomes(ws, [
    { tool: "flaky_api", ok: true },
    ...Array.from({ length: 9 }, () => ({ tool: "flaky_api", ok: false })),
  ]);

  // Chronic failures for flaky_api to push score above threshold.
  await recordRunFailures(ws, [
    { tool: "flaky_api", category: "permission" },
    { tool: "flaky_api", category: "permission" },
    { tool: "flaky_api", category: "not_allowed" },
    { tool: "flaky_api", category: "permission" },
  ]);

  const p = await synthesizePatch(ws);
  assert.ok(p, "expected a patch");
  assert.equal(p.workspace, ws);
  assert.match(p.version, /^v1-\d{8}-[0-9a-f]{8}$/);
  assert.ok(p.content.includes("Known-bad"), "expected Known-bad section");
  assert.ok(p.content.includes("flaky_api"), "flaky_api should be flagged");
  assert.ok(p.content.includes("Reliable"), "expected Reliable section");
  assert.ok(p.content.includes("search_context"), "search_context should be preferred");
  assert.ok(p.basis.toolsFlagged.includes("flaky_api"));
  assert.ok(p.basis.toolsPreferred.includes("search_context"));
  assert.equal(p.status, "pending");
  assert.ok(p.content.length <= MAX_PATCH_CHARS_EXPORTED);
});

test("synthesizePatch: deterministic — same state yields same version hash", async () => {
  const ws = uniqueWs("determ");
  await recordToolOutcomes(ws, Array.from({ length: 10 }, () => ({ tool: "good", ok: true })));
  await recordRunFailures(ws, [
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
  ]);
  const a = await synthesizePatch(ws);
  const b = await synthesizePatch(ws);
  assert.ok(a && b);
  assert.equal(a.version, b.version);
  assert.equal(a.content, b.content);
});

test("synthesizePatch: includes conflict topic when similarity median < 0.3", async () => {
  const ws = uniqueWs("conflicts");
  for (let i = 0; i < 4; i++) {
    await recordConflict(ws, {
      type: "disagreement",
      similarity: 0.15 + i * 0.01,
      summary: "researcher and planner disagree on deployment strategy for kubernetes",
      specialists: ["researcher", "planner"],
      responses: [],
    });
  }
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.ok(p.content.toLowerCase().includes("specialist disagreements"));
  await clearConflicts(ws);
});

test("savePatch + listPatches roundtrip", async () => {
  const ws = uniqueWs("roundtrip");
  const patch = {
    workspace: ws,
    generatedAt: Date.now(),
    version: "v1-20260417-aaaaaaaa",
    content: "hello",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "pending",
  };
  await savePatch(patch);
  const list = await listPatches(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].version, "v1-20260417-aaaaaaaa");
  assert.equal(list[0].content, "hello");
});

test("ring buffer: save 55 patches, only 50 remain (newest kept)", async () => {
  const ws = uniqueWs("ring");
  const base = Date.now();
  for (let i = 0; i < 55; i++) {
    await savePatch({
      workspace: ws,
      generatedAt: base + i * 1000,
      version: `v1-20260417-${String(i).padStart(8, "0")}`,
      content: `patch ${i}`,
      basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
      status: "pending",
    });
  }
  const all = await listPatches(ws, { limit: 100 });
  assert.equal(all.length, 50);
  // Newest first, so index 0 is patch #54, index 49 is patch #5.
  assert.equal(all[0].content, "patch 54");
  assert.equal(all[49].content, "patch 5");
});

test("getActivePatch: returns most recent applied, skipping pending/rejected", async () => {
  const ws = uniqueWs("active");
  const base = Date.now();
  // Oldest: applied (should not win — there's a newer applied).
  await savePatch({
    workspace: ws,
    generatedAt: base,
    version: "v1-20260417-oldapply",
    content: "old-applied",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "applied",
    appliedAt: base,
    appliedBy: "admin1",
  });
  // Middle: applied — should win.
  await savePatch({
    workspace: ws,
    generatedAt: base + 1000,
    version: "v1-20260417-newapply",
    content: "new-applied",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "applied",
    appliedAt: base + 1000,
    appliedBy: "admin2",
  });
  // Newest: pending — should be skipped.
  await savePatch({
    workspace: ws,
    generatedAt: base + 2000,
    version: "v1-20260417-pending1",
    content: "pending",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "pending",
  });
  // Also newer: rejected — should be skipped.
  await savePatch({
    workspace: ws,
    generatedAt: base + 3000,
    version: "v1-20260417-rejecta",
    content: "rejected",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "rejected",
  });

  const active = await getActivePatch(ws);
  assert.ok(active);
  assert.equal(active.version, "v1-20260417-newapply");
  assert.equal(active.content, "new-applied");
});

test("setPatchStatus: changes status + records appliedAt/appliedBy", async () => {
  const ws = uniqueWs("setstatus");
  await savePatch({
    workspace: ws,
    generatedAt: Date.now(),
    version: "v1-20260417-statusxx",
    content: "x",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "pending",
  });
  const updated = await setPatchStatus(ws, "v1-20260417-statusxx", "applied", "admin-42");
  assert.equal(updated.status, "applied");
  assert.equal(updated.appliedBy, "admin-42");
  assert.ok(typeof updated.appliedAt === "number" && updated.appliedAt > 0);

  const rejected = await setPatchStatus(ws, "v1-20260417-statusxx", "rejected", "admin-7");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.appliedBy, "admin-7");
});

test("setPatchStatus: throws for unknown version", async () => {
  const ws = uniqueWs("statusnope");
  await assert.rejects(
    () => setPatchStatus(ws, "v1-nonexistent", "applied", "admin"),
    /unknown patch version/,
  );
});

test("autoTuneAndApply: autoApply=false stores as pending", async () => {
  const ws = uniqueWs("autopending");
  await recordToolOutcomes(ws, Array.from({ length: 10 }, () => ({ tool: "good", ok: true })));
  await recordRunFailures(ws, [
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
  ]);
  const p = await autoTuneAndApply(ws, { autoApply: false });
  assert.ok(p);
  assert.equal(p.status, "pending");
  const active = await getActivePatch(ws);
  assert.equal(active, null);
});

test("autoTuneAndApply: autoApply=true stores as applied", async () => {
  const ws = uniqueWs("autoapply");
  await recordToolOutcomes(ws, Array.from({ length: 10 }, () => ({ tool: "good", ok: true })));
  await recordRunFailures(ws, [
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
    { tool: "bad", category: "permission" },
  ]);
  const p = await autoTuneAndApply(ws, { autoApply: true, adminId: "auto-job" });
  assert.ok(p);
  assert.equal(p.status, "applied");
  assert.equal(p.appliedBy, "auto-job");
  const active = await getActivePatch(ws);
  assert.ok(active);
  assert.equal(active.version, p.version);
});

test("autoTuneAndApply: returns null when insufficient signal", async () => {
  const ws = uniqueWs("autoempty");
  const p = await autoTuneAndApply(ws, { autoApply: true });
  assert.equal(p, null);
});

test("getActivePatchContent: returns '' when no applied patch", async () => {
  const ws = uniqueWs("noactive");
  const c = await getActivePatchContent(ws);
  assert.equal(c, "");

  // Also '' when only pending patch exists.
  await savePatch({
    workspace: ws,
    generatedAt: Date.now(),
    version: "v1-20260417-pendxxxx",
    content: "pending content",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "pending",
  });
  assert.equal(await getActivePatchContent(ws), "");
});

test("getActivePatchContent: returns content of applied patch", async () => {
  const ws = uniqueWs("activecontent");
  await savePatch({
    workspace: ws,
    generatedAt: Date.now(),
    version: "v1-20260417-applyabc",
    content: "the applied patch text",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "applied",
    appliedAt: Date.now(),
    appliedBy: "admin",
  });
  const c = await getActivePatchContent(ws);
  assert.equal(c, "the applied patch text");
});

test("workspace isolation: patches in ws1 do not leak into ws2", async () => {
  const ws1 = uniqueWs("iso1");
  const ws2 = uniqueWs("iso2");
  await savePatch({
    workspace: ws1,
    generatedAt: Date.now(),
    version: "v1-20260417-iso11111",
    content: "ws1 only",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "applied",
    appliedAt: Date.now(),
    appliedBy: "admin",
  });
  const a1 = await listPatches(ws1);
  const a2 = await listPatches(ws2);
  assert.equal(a1.length, 1);
  assert.equal(a2.length, 0);
  assert.equal(await getActivePatchContent(ws2), "");
});

test("patch content stays under 1500 chars", async () => {
  const ws = uniqueWs("lenbound");
  // Push a lot of data in.
  const outcomes = [];
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 10; j++) outcomes.push({ tool: `good_${i}`, ok: true });
  }
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 10; j++) outcomes.push({ tool: `bad_${i}`, ok: j < 2 });
  }
  await recordToolOutcomes(ws, outcomes);
  const fails = [];
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 4; j++) fails.push({ tool: `bad_${i}`, category: "permission" });
  }
  await recordRunFailures(ws, fails);
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.ok(p.content.length <= MAX_PATCH_CHARS_EXPORTED, `content was ${p.content.length} chars`);
});

test("listPatches: filters by status", async () => {
  const ws = uniqueWs("filter");
  const base = Date.now();
  await savePatch({
    workspace: ws,
    generatedAt: base,
    version: "v1-20260417-filt1111",
    content: "a",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "pending",
  });
  await savePatch({
    workspace: ws,
    generatedAt: base + 1,
    version: "v1-20260417-filt2222",
    content: "b",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
    status: "applied",
    appliedAt: base,
    appliedBy: "admin",
  });
  const pending = await listPatches(ws, { status: "pending" });
  const applied = await listPatches(ws, { status: "applied" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].version, "v1-20260417-filt1111");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].version, "v1-20260417-filt2222");
});
