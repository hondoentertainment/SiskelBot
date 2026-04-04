import test from "node:test";
import assert from "node:assert/strict";
import { checkPolicyBeforeTool, createPolicyState, resolveEffectivePolicy } from "../lib/agent-policy.js";
import { runTool } from "../lib/agent-tools.js";

test("checkPolicyBeforeTool blocks denied tool", () => {
  const state = createPolicyState(resolveEffectivePolicy({}), { deniedTools: new Set(["execute_step"]) });
  const r = checkPolicyBeforeTool(state, "execute_step");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "POLICY_TOOL_DENIED");
});

test("runTool returns POLICY_TOOL_DENIED when workspace denies tool", async () => {
  const out = await runTool(
    "list_context",
    {},
    {
      workspace: "default",
      workspaceDeniedTools: new Set(["list_context"]),
      allowExecution: false,
      projectDir: process.cwd(),
      workspaceUserId: "anonymous",
    }
  );
  const p = JSON.parse(out.content);
  assert.equal(p.code, "POLICY_TOOL_DENIED");
});
