import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a listed tool waits for approval and a timeout denies it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approve-"));
  const prev = {
    STORAGE_PATH: process.env.STORAGE_PATH,
    APPROVAL_QUEUE: process.env.APPROVAL_QUEUE,
    APPROVAL_TIMEOUT_MS: process.env.APPROVAL_TIMEOUT_MS,
    APPROVAL_NOTIFY: process.env.APPROVAL_NOTIFY,
  };
  process.env.STORAGE_PATH = dir;
  process.env.APPROVAL_QUEUE = "1";
  process.env.APPROVAL_TIMEOUT_MS = "4000";
  delete process.env.APPROVAL_NOTIFY;
  try {
    const { runTool } = await import("../lib/agent-tools.js");
    const { saveWorkspaceAgentSettings } = await import("../lib/workspace-agent-settings.js");
    const { listApprovals, decideApproval } = await import("../lib/approval-queue.js");
    await saveWorkspaceAgentSettings("ada", "default", {
      agentPolicy: { approvalTools: ["send_notification"] },
    });

    const approved = runTool("send_notification", { message: "ship it" }, {
      workspace: "default",
      workspaceUserId: "ada",
    });
    let pending = [];
    for (let i = 0; i < 20 && !pending.length; i++) {
      pending = await listApprovals("default", { status: "pending" });
      if (!pending.length) await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, "send_notification");
    const decided = await decideApproval("default", pending[0].id, { status: "approved", by: "ada" });
    assert.equal(decided.status, "approved");
    const ok = JSON.parse((await approved).content);
    assert.equal(ok.ok, true);

    process.env.APPROVAL_TIMEOUT_MS = "80";
    const timed = JSON.parse((await runTool("send_notification", { message: "too late" }, {
      workspace: "default",
      workspaceUserId: "ada",
    })).content);
    assert.equal(timed.code, "APPROVAL_TIMEOUT");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
