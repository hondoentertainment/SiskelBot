import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCodeInSandbox } from "../lib/agent-sandbox.js";
import { runTool } from "../lib/agent-tools.js";

describe("sandbox code execution", () => {
  it("runCodeInSandbox evaluates JS in mock sandbox", async () => {
    const out = await runCodeInSandbox("console.log('hi'); 1+2", { timeoutMs: 2000, runtime: "mock" });
    assert.equal(out.ok, true);
    assert.match(out.output || "", /hi/);
    assert.equal(out.result, 3);
    assert.equal(out.runtime, "mock");
  });

  it("code_execute uses sandbox when AGENT_CODE_SANDBOX=1", async () => {
    const prevExec = process.env.AGENT_CODE_EXECUTE;
    const prevSand = process.env.AGENT_CODE_SANDBOX;
    process.env.AGENT_CODE_EXECUTE = "1";
    process.env.AGENT_CODE_SANDBOX = "1";
    try {
      const r = await runTool(
        "code_execute",
        { code: "2*21" },
        { workspace: "default", workspaceUserId: "anonymous", allowExecution: false },
      );
      const parsed = JSON.parse(r.content);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.result, 42);
      assert.ok(parsed.sandbox?.runtime);
    } finally {
      if (prevExec === undefined) delete process.env.AGENT_CODE_EXECUTE;
      else process.env.AGENT_CODE_EXECUTE = prevExec;
      if (prevSand === undefined) delete process.env.AGENT_CODE_SANDBOX;
      else process.env.AGENT_CODE_SANDBOX = prevSand;
    }
  });
});
