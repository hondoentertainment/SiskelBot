import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-sess-plan-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  validateAgentSessionPlanInput,
  createAgentSession,
  updateAgentSessionPlan,
  getAgentSession,
} = await import("../lib/agent-session.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("validateAgentSessionPlanInput rejects empty body", () => {
  const r = validateAgentSessionPlanInput({});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "EMPTY_PLAN");
});

test("validateAgentSessionPlanInput accepts planSummary only", () => {
  const r = validateAgentSessionPlanInput({ planSummary: "Step A then B" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.planSummary, "Step A then B");
});

test("validateAgentSessionPlanInput accepts planDag only", () => {
  const r = validateAgentSessionPlanInput({ planDag: { nodes: [{ id: "1" }], edges: [] } });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.planDag && typeof r.planDag === "object");
});

test("validateAgentSessionPlanInput rejects array planDag", () => {
  const r = validateAgentSessionPlanInput({ planDag: [] });
  assert.equal(r.ok, false);
});

test("validateAgentSessionPlanInput rejects too-deep planDag", () => {
  let o = { x: 1 };
  for (let i = 0; i < 30; i++) o = { nest: o };
  const r = validateAgentSessionPlanInput({ planDag: o });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "PLAN_DAG_TOO_DEEP");
});

test("createAgentSession and updateAgentSessionPlan persist plan fields", async () => {
  const s = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "t",
    planSummary: "v1",
    planDag: { version: 1, steps: ["a"] },
  });
  assert.equal(s.planSummary, "v1");
  assert.deepEqual(s.planDag, { version: 1, steps: ["a"] });

  const up = await updateAgentSessionPlan(s.id, { planSummary: "v2" });
  assert.equal(up.ok, true);
  if (up.ok) {
    assert.equal(up.session.planSummary, "v2");
    assert.deepEqual(up.session.planDag, { version: 1, steps: ["a"] });
  }

  const row = await getAgentSession(s.id);
  assert.equal(row?.planSummary, "v2");
});
