import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduledAgent, runScheduledAgent, getScheduledAgentRuns } from "../lib/scheduled-agents.js";

test("failed scheduled runs alert only when SCHEDULED_RUN_ALERTS=1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-alert-"));
  const prevStore = process.env.STORAGE_PATH;
  const prevFlag = process.env.SCHEDULED_RUN_ALERTS;
  process.env.STORAGE_PATH = dir;
  delete process.env.SCHEDULED_RUN_ALERTS;
  try {
    const agent = await createScheduledAgent({
      workspaceId: "ws",
      name: "Nightly digest",
      cron: "0 9 * * *",
      prompt: "Summarize the inbox",
    });
    let alerts = 0;
    const failedFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const config = () => ({ baseUrl: "http://backend", path: "/chat", headers: {} });
    await runScheduledAgent("ws", agent.id, {
      backendFetch: failedFetch,
      buildProxyConfig: config,
      alertFailedRun: async () => { alerts += 1; },
    });
    assert.equal(alerts, 0);
    process.env.SCHEDULED_RUN_ALERTS = "1";
    await runScheduledAgent("ws", agent.id, {
      backendFetch: failedFetch,
      buildProxyConfig: config,
      alertFailedRun: async (info) => {
        alerts += 1;
        assert.equal(info.agent.name, "Nightly digest");
        assert.match(info.error, /500/);
      },
    });
    assert.equal(alerts, 1);
    const runs = await getScheduledAgentRuns("ws", agent.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, "failed");
  } finally {
    if (prevStore === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStore;
    if (prevFlag === undefined) delete process.env.SCHEDULED_RUN_ALERTS;
    else process.env.SCHEDULED_RUN_ALERTS = prevFlag;
    rmSync(dir, { recursive: true, force: true });
  }
});
