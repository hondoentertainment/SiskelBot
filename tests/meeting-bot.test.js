/**
 * Tests for lib/meeting-bot.js — meeting lifecycle (join/leave/list/get/delete),
 * transcript storage, summarization with an LLM mock, action item extraction,
 * and adapter interface compliance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  joinMeeting,
  leaveMeeting,
  listMeetings,
  getMeeting,
  deleteMeeting,
  summarizeMeeting,
  extractActionItems,
  extractActionItemsForMeeting,
  appendTranscriptSegment,
  recordMeeting,
  setLLMClient,
  setAdapter,
  validateAdapter,
  _resetForTests,
  _internals,
} from "../lib/meeting-bot.js";

import * as zoomAdapter from "../lib/meeting-adapters/zoom.js";
import * as meetAdapter from "../lib/meeting-adapters/google-meet.js";
import * as teamsAdapter from "../lib/meeting-adapters/teams.js";
import * as webexAdapter from "../lib/meeting-adapters/webex.js";

const TEST_WS = "test-meeting-ws-" + Date.now();

function uniqueWs(suffix) {
  return `test-meeting-ws-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── joinMeeting / leaveMeeting / lifecycle ────────────────────────────────

test("joinMeeting requires a config object", async () => {
  await assert.rejects(() => joinMeeting(null), /config is required/);
});

test("joinMeeting requires a meetingUrl", async () => {
  await assert.rejects(
    () => joinMeeting({ platform: "zoom" }),
    /meetingUrl is required/
  );
});

test("joinMeeting rejects an unknown platform", async () => {
  await assert.rejects(
    () => joinMeeting({ platform: "skype", meetingUrl: "https://x" }),
    /platform must be one of/
  );
});

test("joinMeeting returns sessionId, joinedAt, meetingId", async () => {
  const ws = uniqueWs("join");
  const result = await joinMeeting({
    platform: "zoom",
    meetingUrl: "https://us02web.zoom.us/j/1234567890",
    workspaceId: ws,
  });
  assert.ok(result.sessionId);
  assert.ok(result.joinedAt);
  assert.ok(result.meetingId);
});

test("joinMeeting persists a meeting record", async () => {
  const ws = uniqueWs("persist");
  await joinMeeting({
    platform: "meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    workspaceId: ws,
  });
  const meetings = await listMeetings(ws);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].platform, "meet");
  assert.equal(meetings[0].status, "joined");
});

test("leaveMeeting marks the meeting as ended", async () => {
  const ws = uniqueWs("leave");
  const join = await joinMeeting({
    platform: "teams",
    meetingUrl: "https://teams.microsoft.com/l/meetup-join/19:meeting_xyz@thread.v2/0",
    workspaceId: ws,
  });
  const result = await leaveMeeting(join.sessionId);
  assert.equal(result.ok, true);
  assert.ok(result.endedAt);
  const meetings = await listMeetings(ws);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].status, "ended");
  assert.ok(meetings[0].endedAt);
});

test("leaveMeeting requires a sessionId", async () => {
  await assert.rejects(() => leaveMeeting(""), /sessionId is required/);
});

test("leaveMeeting is a no-op for unknown sessions", async () => {
  // Should not throw, but should also not affect any persisted record.
  const result = await leaveMeeting("nonexistent-session-id");
  assert.equal(result.ok, true);
});

// ─── listMeetings / getMeeting / deleteMeeting ─────────────────────────────

test("listMeetings filters by platform", async () => {
  const ws = uniqueWs("filter");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/1", workspaceId: ws });
  await joinMeeting({ platform: "meet", meetingUrl: "https://meet.google.com/aaa-bbbb-ccc", workspaceId: ws });
  const zooms = await listMeetings(ws, { platform: "zoom" });
  assert.equal(zooms.length, 1);
  assert.equal(zooms[0].platform, "zoom");
});

test("listMeetings filters by status", async () => {
  const ws = uniqueWs("status");
  const a = await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/1", workspaceId: ws });
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/2", workspaceId: ws });
  await leaveMeeting(a.sessionId);
  const ended = await listMeetings(ws, { status: "ended" });
  const joined = await listMeetings(ws, { status: "joined" });
  assert.equal(ended.length, 1);
  assert.equal(joined.length, 1);
});

test("listMeetings respects limit and offset", async () => {
  const ws = uniqueWs("page");
  for (let i = 0; i < 5; i++) {
    await joinMeeting({ platform: "zoom", meetingUrl: `https://zoom.us/j/${i}`, workspaceId: ws });
  }
  const page1 = await listMeetings(ws, { limit: 2, offset: 0 });
  const page2 = await listMeetings(ws, { limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.notEqual(page1[0].id, page2[0].id);
});

test("getMeeting returns a stored meeting", async () => {
  const ws = uniqueWs("get");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/9", workspaceId: ws });
  const list = await listMeetings(ws);
  const m = await getMeeting(list[0].id, ws);
  assert.ok(m);
  assert.equal(m.id, list[0].id);
  assert.equal(m.platform, "zoom");
});

test("getMeeting returns null for unknown id", async () => {
  const ws = uniqueWs("getnull");
  const m = await getMeeting("nonexistent", ws);
  assert.equal(m, null);
});

test("deleteMeeting soft-deletes a meeting", async () => {
  const ws = uniqueWs("del");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/1", workspaceId: ws });
  const [meeting] = await listMeetings(ws);
  const result = await deleteMeeting(meeting.id, ws);
  assert.equal(result.ok, true);
  const after = await listMeetings(ws);
  assert.equal(after.length, 0);
  const got = await getMeeting(meeting.id, ws);
  assert.equal(got, null);
});

test("deleteMeeting throws for unknown id", async () => {
  const ws = uniqueWs("delmiss");
  await assert.rejects(() => deleteMeeting("nope", ws), /meeting not found/);
});

// ─── transcript storage ─────────────────────────────────────────────────────

test("appendTranscriptSegment stores transcript segments on a meeting", async () => {
  const ws = uniqueWs("trans");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/5", workspaceId: ws });
  const [meeting] = await listMeetings(ws);
  await appendTranscriptSegment(meeting.id, { speaker: "Alice", text: "Hello team", startMs: 0, endMs: 1500 }, ws);
  await appendTranscriptSegment(meeting.id, { speaker: "Bob", text: "Hi everyone", startMs: 1500, endMs: 3000 }, ws);
  const after = await getMeeting(meeting.id, ws);
  assert.equal(after.transcript.length, 2);
  assert.equal(after.transcript[0].speaker, "Alice");
  assert.equal(after.transcript[0].text, "Hello team");
  assert.equal(after.transcript[1].speaker, "Bob");
});

test("appendTranscriptSegment requires text", async () => {
  const ws = uniqueWs("transempty");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/6", workspaceId: ws });
  const [meeting] = await listMeetings(ws);
  await assert.rejects(
    () => appendTranscriptSegment(meeting.id, { speaker: "x", text: "" }, ws),
    /segment.text is required/
  );
});

test("appendTranscriptSegment throws for unknown meeting", async () => {
  await assert.rejects(
    () => appendTranscriptSegment("nope", { speaker: "x", text: "y" }, "test-ws-x"),
    /meeting not found/
  );
});

// ─── summarizeMeeting (with LLM mock) ───────────────────────────────────────

test("summarizeMeeting calls the injected LLM and stores summary fields", async () => {
  const ws = uniqueWs("sum");
  let calledWith = null;
  setLLMClient(async (messages) => {
    calledWith = messages;
    return JSON.stringify({
      summary: "Team discussed Q3 roadmap and agreed on three priorities.",
      topics: ["Q3 roadmap", "hiring plan", "infra budget"],
      decisions: ["Adopt Postgres for analytics", "Hire two SREs"],
    });
  });
  try {
    await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/77", workspaceId: ws });
    const [meeting] = await listMeetings(ws);
    await appendTranscriptSegment(meeting.id, { speaker: "Alice", text: "Let's discuss the Q3 roadmap" }, ws);
    await appendTranscriptSegment(meeting.id, { speaker: "Bob", text: "We agreed to adopt Postgres" }, ws);
    const result = await summarizeMeeting(meeting.id, ws);
    assert.equal(result.summary, "Team discussed Q3 roadmap and agreed on three priorities.");
    assert.equal(result.topics.length, 3);
    assert.equal(result.decisions.length, 2);
    assert.ok(Array.isArray(result.attendees));
    assert.ok(result.attendees.includes("Alice"));
    assert.ok(result.attendees.includes("Bob"));
    // The LLM should have been invoked with system+user messages.
    assert.ok(Array.isArray(calledWith));
    assert.equal(calledWith.length, 2);
    assert.equal(calledWith[0].role, "system");
    assert.equal(calledWith[1].role, "user");
    // The transcript text should appear in the user prompt.
    assert.ok(calledWith[1].content.includes("Q3 roadmap"));

    // Persisted on the meeting record.
    const persisted = await getMeeting(meeting.id, ws);
    assert.equal(persisted.summary, result.summary);
    assert.deepEqual(persisted.topics, result.topics);
    assert.deepEqual(persisted.decisions, result.decisions);
  } finally {
    _resetForTests();
  }
});

test("summarizeMeeting falls back to heuristic when LLM returns garbage", async () => {
  const ws = uniqueWs("sumfb");
  setLLMClient(async () => "this is not JSON at all");
  try {
    await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/78", workspaceId: ws });
    const [meeting] = await listMeetings(ws);
    await appendTranscriptSegment(meeting.id, {
      speaker: "Alice",
      text: "We decided to ship the launch on Friday and reviewed the dashboard plans",
    }, ws);
    const result = await summarizeMeeting(meeting.id, ws);
    // Heuristic should produce a non-empty summary because there is content.
    assert.ok(result.summary.length > 0);
    // "decided" should land in decisions.
    assert.ok(result.decisions.some((d) => /decided/i.test(d)));
  } finally {
    _resetForTests();
  }
});

test("summarizeMeeting on a meeting with no transcript returns empty summary", async () => {
  const ws = uniqueWs("sumempty");
  await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/79", workspaceId: ws });
  const [meeting] = await listMeetings(ws);
  const result = await summarizeMeeting(meeting.id, ws);
  assert.equal(result.summary, "");
  assert.deepEqual(result.topics, []);
  assert.deepEqual(result.decisions, []);
});

test("summarizeMeeting throws for unknown meeting", async () => {
  await assert.rejects(
    () => summarizeMeeting("nonexistent", "test-ws-summ-miss"),
    /meeting not found/
  );
});

// ─── extractActionItems (with LLM mock) ────────────────────────────────────

test("extractActionItems uses LLM client when available", async () => {
  setLLMClient(async () =>
    JSON.stringify({
      actionItems: [
        { text: "Send the design doc to Alice", owner: "Bob", dueDate: "2026-04-15", confidence: 0.9 },
        { text: "Schedule the kickoff meeting", owner: "Carol", dueDate: null, confidence: 0.7 },
      ],
    })
  );
  try {
    const items = await extractActionItems([
      { speaker: "Bob", text: "I will send the design doc to Alice" },
      { speaker: "Carol", text: "I'll schedule the kickoff" },
    ]);
    assert.equal(items.length, 2);
    assert.equal(items[0].text, "Send the design doc to Alice");
    assert.equal(items[0].owner, "Bob");
    assert.equal(items[0].dueDate, "2026-04-15");
    assert.equal(items[0].confidence, 0.9);
    assert.equal(items[1].dueDate, null);
  } finally {
    _resetForTests();
  }
});

test("extractActionItems clamps confidence and slices long lists", async () => {
  setLLMClient(async () =>
    JSON.stringify({
      actionItems: [
        { text: "do thing", owner: "x", dueDate: null, confidence: 5 },
        { text: "do other", owner: "y", dueDate: null, confidence: -1 },
        { text: "", owner: "z", dueDate: null, confidence: 0.5 }, // dropped
      ],
    })
  );
  try {
    const items = await extractActionItems("Bob: I will do something\nCarol: I will do other");
    assert.equal(items.length, 2);
    assert.equal(items[0].confidence, 1);
    assert.equal(items[1].confidence, 0);
  } finally {
    _resetForTests();
  }
});

test("extractActionItems falls back to heuristic when LLM returns null", async () => {
  // No client configured.
  _resetForTests();
  const items = await extractActionItems(
    "Alice: I will send the report tomorrow.\nBob: We should review the metrics."
  );
  assert.ok(items.length >= 1);
  assert.ok(items.some((it) => /send the report/i.test(it.text)));
});

test("extractActionItems returns empty array for empty input", async () => {
  _resetForTests();
  const empty1 = await extractActionItems("");
  assert.deepEqual(empty1, []);
  const empty2 = await extractActionItems([]);
  assert.deepEqual(empty2, []);
  const empty3 = await extractActionItems(null);
  assert.deepEqual(empty3, []);
});

test("extractActionItemsForMeeting persists items on the meeting", async () => {
  const ws = uniqueWs("extract");
  setLLMClient(async () =>
    JSON.stringify({
      actionItems: [{ text: "Follow up with the vendor", owner: "Alice", dueDate: null, confidence: 0.8 }],
    })
  );
  try {
    await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/80", workspaceId: ws });
    const [meeting] = await listMeetings(ws);
    await appendTranscriptSegment(meeting.id, { speaker: "Alice", text: "I will follow up with the vendor" }, ws);
    const items = await extractActionItemsForMeeting(meeting.id, ws);
    assert.equal(items.length, 1);
    const persisted = await getMeeting(meeting.id, ws);
    assert.equal(persisted.actionItems.length, 1);
    assert.equal(persisted.actionItems[0].owner, "Alice");
  } finally {
    _resetForTests();
  }
});

// ─── recordMeeting + custom adapter ─────────────────────────────────────────

test("recordMeeting uses the adapter and stores results on the meeting", async () => {
  const ws = uniqueWs("rec");
  const fakeAdapter = {
    join: async () => ({
      sessionId: "fake-session-1",
      joinedAt: new Date().toISOString(),
      meetingId: "fake-meeting-1",
      attendees: [],
    }),
    leave: async () => ({ ok: true }),
    record: async () => ({
      recordingId: "rec-fake-1",
      duration: 1234,
      audioPath: "/tmp/fake.wav",
      transcript: [
        { speaker: "Alice", text: "Hello", startMs: 0, endMs: 500 },
        { speaker: "Bob", text: "Hi", startMs: 500, endMs: 1000 },
      ],
    }),
  };
  setAdapter("zoom", fakeAdapter);
  try {
    const join = await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/100", workspaceId: ws });
    const rec = await recordMeeting(join.sessionId, { transcribe: true });
    assert.equal(rec.recordingId, "rec-fake-1");
    assert.equal(rec.duration, 1234);
    assert.equal(rec.audioPath, "/tmp/fake.wav");
    const [meeting] = await listMeetings(ws);
    assert.equal(meeting.recordingId, "rec-fake-1");
    assert.equal(meeting.audioPath, "/tmp/fake.wav");
    assert.equal(meeting.transcript.length, 2);
  } finally {
    setAdapter("zoom", zoomAdapter);
    _resetForTests();
  }
});

test("recordMeeting throws when session is unknown", async () => {
  await assert.rejects(
    () => recordMeeting("unknown-session"),
    /active session not found/
  );
});

test("recordMeeting with summarize=true triggers the LLM-based summary", async () => {
  const ws = uniqueWs("recsum");
  const fakeAdapter = {
    join: async () => ({
      sessionId: "fake-session-sum",
      joinedAt: new Date().toISOString(),
      meetingId: "fake-meeting-sum",
      attendees: [],
    }),
    leave: async () => ({ ok: true }),
    record: async () => ({
      recordingId: "rec-sum",
      duration: 60,
      audioPath: null,
      transcript: [{ speaker: "Alice", text: "Welcome to the meeting" }],
    }),
  };
  setAdapter("zoom", fakeAdapter);
  setLLMClient(async () =>
    JSON.stringify({ summary: "Quick welcome session.", topics: [], decisions: [] })
  );
  try {
    const join = await joinMeeting({ platform: "zoom", meetingUrl: "https://zoom.us/j/200", workspaceId: ws });
    await recordMeeting(join.sessionId, { transcribe: true, summarize: true });
    const [meeting] = await listMeetings(ws);
    assert.equal(meeting.summary, "Quick welcome session.");
  } finally {
    setAdapter("zoom", zoomAdapter);
    _resetForTests();
  }
});

// ─── adapter interface compliance ──────────────────────────────────────────

test("validateAdapter accepts a fully-formed adapter", () => {
  const ok = {
    join: async () => {},
    leave: async () => {},
    record: async () => {},
  };
  const result = validateAdapter(ok);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("validateAdapter reports missing functions", () => {
  const bad = { join: async () => {} };
  const result = validateAdapter(bad);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missing.sort(), ["leave", "record"]);
});

test("validateAdapter rejects null input", () => {
  const result = validateAdapter(null);
  assert.equal(result.valid, false);
  assert.equal(result.missing.length, 3);
});

test("zoom adapter implements the interface", () => {
  assert.equal(validateAdapter(zoomAdapter).valid, true);
});

test("google-meet adapter implements the interface", () => {
  assert.equal(validateAdapter(meetAdapter).valid, true);
});

test("teams adapter implements the interface", () => {
  assert.equal(validateAdapter(teamsAdapter).valid, true);
});

test("webex adapter implements the interface", () => {
  assert.equal(validateAdapter(webexAdapter).valid, true);
});

test("zoom adapter join returns sessionId/joinedAt/meetingId", async () => {
  const r = await zoomAdapter.join({ meetingUrl: "https://zoom.us/j/123456" });
  assert.ok(r.sessionId.startsWith("zoom-"));
  assert.ok(r.joinedAt);
  assert.equal(r.meetingId, "123456");
});

test("zoom adapter join requires meetingUrl", async () => {
  await assert.rejects(() => zoomAdapter.join({}), /meetingUrl is required/);
});

test("zoom adapter extractZoomMeetingId parses join URLs", () => {
  assert.equal(zoomAdapter.extractZoomMeetingId("https://us02web.zoom.us/j/9876543210?pwd=abc"), "9876543210");
  assert.equal(zoomAdapter.extractZoomMeetingId("not-a-url"), null);
});

test("google-meet adapter extractMeetCode parses meet URLs", () => {
  assert.equal(meetAdapter.extractMeetCode("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(meetAdapter.extractMeetCode("invalid"), null);
});

test("teams adapter extractTeamsThreadId parses join URLs", () => {
  const id = teamsAdapter.extractTeamsThreadId(
    "https://teams.microsoft.com/l/meetup-join/19:meeting_abcdef@thread.v2/0?context="
  );
  assert.match(id, /19:meeting_abcdef/);
});

test("webex adapter extractWebexMeetingNumber parses URLs", () => {
  assert.ok(webexAdapter.extractWebexMeetingNumber("https://example.webex.com/meet/12345678"));
});

test("setAdapter rejects unknown platform", () => {
  assert.throws(
    () => setAdapter("skype", { join: async () => {}, leave: async () => {}, record: async () => {} }),
    /unknown platform/
  );
});

test("setAdapter rejects non-object adapters", () => {
  assert.throws(() => setAdapter("zoom", null), /adapter must be an object/);
});

// ─── internals: heuristics ──────────────────────────────────────────────────

test("transcriptToText formats segments as 'speaker: text' lines", () => {
  const text = _internals.transcriptToText([
    { speaker: "Alice", text: "hi" },
    { speaker: "Bob", text: "hey" },
  ]);
  assert.equal(text, "Alice: hi\nBob: hey");
});

test("uniqueAttendeesFromTranscript dedupes speakers", () => {
  const out = _internals.uniqueAttendeesFromTranscript([
    { speaker: "Alice", text: "x" },
    { speaker: "Bob", text: "y" },
    { speaker: "Alice", text: "z" },
  ]);
  assert.deepEqual(out.sort(), ["Alice", "Bob"]);
});

test("heuristicSummary picks decision-like sentences", () => {
  const summary = _internals.heuristicSummary([
    { speaker: "Alice", text: "We decided to ship the feature next week" },
    { speaker: "Bob", text: "Let's discuss the rollout plan" },
  ]);
  assert.ok(summary.summary.length > 0);
  assert.ok(summary.decisions.length >= 1);
});

test("tryParseJson strips code fences", () => {
  const obj = _internals.tryParseJson("```json\n{\"a\": 1}\n```");
  assert.deepEqual(obj, { a: 1 });
});

test("tryParseJson extracts embedded objects", () => {
  const obj = _internals.tryParseJson("garbage before { \"x\": 2 } trailing");
  assert.deepEqual(obj, { x: 2 });
});

test("tryParseJson returns null for invalid input", () => {
  assert.equal(_internals.tryParseJson("not json"), null);
  assert.equal(_internals.tryParseJson(""), null);
});
