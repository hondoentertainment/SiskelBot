import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureThought, enableAdviceMode } from "../lib/advice-companion.js";
import { buildMorningBrief, ensureMorningBriefSchedule, MORNING_BRIEF_AGENT_NAME } from "../lib/advice-brief.js";
import { listScheduledAgents } from "../lib/scheduled-agents.js";
import {
  googleWorkspaceConfigured,
  googleToolNeedsHitl,
  gmailListMessages,
} from "../lib/google-workspace-tools.js";

describe("advice morning brief", () => {
  let dir;
  const prev = process.env.STORAGE_PATH;
  const user = "brief-user";
  const ws = "brief-ws";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "siskel-brief-"));
    process.env.STORAGE_PATH = dir;
  });

  after(() => {
    if (prev === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("builds a morning brief from due thoughts", async () => {
    await enableAdviceMode(user, ws, { challenge: false });
    await captureThought(user, ws, {
      content: "Ship the advice brief feature",
      kind: "reminder",
      resurfaceAt: new Date(Date.now() - 1000).toISOString(),
    });
    const brief = await buildMorningBrief(user, ws);
    assert.match(brief.text, /Morning brief/);
    assert.match(brief.text, /Ship the advice brief/);
    assert.ok(brief.dueCount >= 1);
    assert.match(brief.promptForAgent, /honest advice companion/i);
  });

  it("ensures a daily scheduled agent once", async () => {
    const first = await ensureMorningBriefSchedule(ws, { userId: user });
    assert.equal(first.created, true);
    assert.equal(first.agent.name, MORNING_BRIEF_AGENT_NAME);
    const second = await ensureMorningBriefSchedule(ws, { userId: user });
    assert.equal(second.created, false);
    const agents = await listScheduledAgents(ws);
    assert.equal(agents.filter((a) => a.name === MORNING_BRIEF_AGENT_NAME).length, 1);
  });
});

describe("google workspace tools", () => {
  it("reports not configured without token", () => {
    const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    assert.equal(googleWorkspaceConfigured(), false);
    assert.equal(googleToolNeedsHitl("gmail_send_message"), true);
    assert.equal(googleToolNeedsHitl("gmail_list_messages"), false);
    if (prev !== undefined) process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  });

  it("gmail_list_messages returns GOOGLE_NOT_CONFIGURED without token", async () => {
    const prev = process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    delete process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN;
    const r = await gmailListMessages({ query: "is:unread" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "GOOGLE_NOT_CONFIGURED");
    if (prev !== undefined) process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN = prev;
  });
});
