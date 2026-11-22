import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { captureThought, enableAdviceMode } from "../lib/advice-companion.js";
import { buildMorningBrief, ensureMorningBriefSchedule, MORNING_BRIEF_AGENT_NAME } from "../lib/advice-brief.js";
import { createScheduledAgent, listScheduledAgents, runDueScheduledAgents } from "../lib/scheduled-agents.js";
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
    assert.match(brief.text, /not connected/);
    assert.equal(brief.sources.googleConnected, false);
    assert.equal(brief.sources.journal, true);
    assert.ok(brief.dueCount >= 1);
    assert.match(brief.promptForAgent, /honest advice companion/i);
    assert.match(brief.promptForAgent, /Do not invent meetings/);
  });

  it("includes today's calendar and unread mail when Google loaders are provided", async () => {
    const brief = await buildMorningBrief(user, ws, {
      calendarListEvents: async () => ({
        ok: true,
        events: [{ id: "e1", summary: "Standup", start: "2026-11-22T09:00:00-08:00", end: "2026-11-22T09:30:00-08:00" }],
      }),
      gmailListMessages: async () => ({
        ok: true,
        messages: [{ id: "m1", from: "Ada <ada@example.com>", subject: "Ship the operator brief", snippet: "secret body" }],
      }),
    });
    assert.match(brief.text, /09:00 Standup/);
    assert.match(brief.text, /Ada <ada@example.com> — Ship the operator brief/);
    assert.equal(brief.text.includes("secret body"), false);
    assert.equal(brief.sources.calendar, true);
    assert.equal(brief.sources.inbox, true);
    assert.equal(brief.calendar.length, 1);
    assert.equal(brief.inbox.length, 1);
  });

  it("ensures a daily scheduled agent once", async () => {
    const first = await ensureMorningBriefSchedule(ws, { userId: user });
    assert.equal(first.created, true);
    assert.equal(first.agent.name, MORNING_BRIEF_AGENT_NAME);
    assert.equal(first.agent.ownerUserId, user);
    const second = await ensureMorningBriefSchedule(ws, { userId: user });
    assert.equal(second.created, false);
    const agents = await listScheduledAgents(ws);
    assert.equal(agents.filter((a) => a.name === MORNING_BRIEF_AGENT_NAME).length, 1);
  });

  it("backfills the owner and refreshes that user's journal when the brief is due", async () => {
    const ownerWs = "brief-owner";
    await enableAdviceMode(user, ownerWs, { challenge: false });
    await captureThought(user, ownerWs, {
      content: "Call the design partner before noon",
      kind: "reminder",
      resurfaceAt: new Date(Date.now() - 1000).toISOString(),
    });
    await captureThought("anonymous", ownerWs, {
      content: "ANON-ONLY-MARKER should not be in the owner brief",
      kind: "note",
      resurfaceAt: new Date(Date.now() - 1000).toISOString(),
    });
    await createScheduledAgent({
      workspaceId: ownerWs,
      name: MORNING_BRIEF_AGENT_NAME,
      cron: "0 8 * * *",
      prompt: "stale prompt from schedule creation",
    });
    const ensured = await ensureMorningBriefSchedule(ownerWs, { userId: user });
    assert.equal(ensured.created, false);
    assert.equal(ensured.agent.ownerUserId, user);

    const file = join(dir, "scheduled-agents", `${ownerWs}.json`);
    const store = JSON.parse(readFileSync(file, "utf8"));
    store.agents[0].nextRun = new Date(Date.now() - 60_000).toISOString();
    store.agents[0].prompt = "stale prompt from schedule creation";
    writeFileSync(file, JSON.stringify(store));

    const ran = await runDueScheduledAgents({ workspaceId: ownerWs });
    assert.equal(ran.total, 1);
    assert.equal(ran.ran, 1);
    const agents = await listScheduledAgents(ownerWs);
    const agent = agents.find((a) => a.name === MORNING_BRIEF_AGENT_NAME);
    assert.match(agent.prompt, /Call the design partner before noon/);
    assert.equal(agent.prompt.includes("ANON-ONLY-MARKER"), false);
    assert.equal(agent.prompt.includes("stale prompt from schedule creation"), false);
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
