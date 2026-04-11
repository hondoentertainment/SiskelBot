/**
 * Phase 44.5: Meeting bot — join meetings, transcribe, summarize, extract action items.
 *
 * Provides a platform-agnostic interface for joining online meetings as a
 * participant bot, recording audio, transcribing the conversation, summarizing
 * the result with an LLM, and extracting action items.
 *
 * Each platform (Zoom, Google Meet, Microsoft Teams, Webex) is implemented as
 * an adapter under lib/meeting-adapters/. Adapters expose a uniform interface:
 *
 *   { join(config), leave(sessionId), record(sessionId, options) }
 *
 * Storage layout: data/meetings/{workspaceId}.json
 *
 * The store keeps an array of meeting records keyed by id. The transcript is
 * stored as an array of segments: [{ speaker, text, startMs, endMs }, ...].
 *
 * Summarization and action-item extraction call an injectable LLM client via
 * setLLMClient(fn). When no client is configured the functions return a
 * deterministic heuristic fallback so tests and offline use work without an
 * upstream backend.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import * as zoomAdapter from "./meeting-adapters/zoom.js";
import * as meetAdapter from "./meeting-adapters/google-meet.js";
import * as teamsAdapter from "./meeting-adapters/teams.js";
import * as webexAdapter from "./meeting-adapters/webex.js";

const MAX_MEETINGS_PER_WORKSPACE = 10_000;
const MAX_TRANSCRIPT_SEGMENTS = 20_000;
const MAX_SUMMARY_LEN = 16_000;
const VALID_PLATFORMS = new Set(["zoom", "meet", "teams", "webex"]);

const ADAPTERS = {
  zoom: zoomAdapter,
  meet: meetAdapter,
  teams: teamsAdapter,
  webex: webexAdapter,
};

/** In-memory map of active sessions by sessionId. */
const activeSessions = new Map();

/** @type {((messages: object[], options?: object) => Promise<string>) | null} */
let llmClient = null;

/**
 * Inject an LLM client used by summarizeMeeting and extractActionItems. The
 * client receives an array of OpenAI-style messages and must return the
 * assistant text content. When no client is set the helpers fall back to a
 * deterministic heuristic so unit tests and offline use still produce output.
 * @param {(messages: object[], options?: object) => Promise<string>} fn
 */
export function setLLMClient(fn) {
  llmClient = typeof fn === "function" ? fn : null;
}

/**
 * Replace a platform adapter (used by tests or to inject a vendor SDK at
 * runtime). The adapter must expose join/leave/record functions.
 * @param {string} platform
 * @param {object} adapter
 */
export function setAdapter(platform, adapter) {
  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(`unknown platform: ${platform}`);
  }
  if (!adapter || typeof adapter !== "object") {
    throw new Error("adapter must be an object");
  }
  ADAPTERS[platform] = adapter;
}

/** Reset all in-memory state (used by tests). */
export function _resetForTests() {
  activeSessions.clear();
  llmClient = null;
}

function sanitizeWs(ws) {
  if (typeof ws !== "string" || !ws.trim()) return "default";
  return ws.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "default";
}

function meetingsPath(workspaceId) {
  const ws = sanitizeWs(workspaceId);
  return join(getDataDir(), "meetings", `${ws}.json`);
}

async function loadAll(workspaceId) {
  const path = meetingsPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveAll(workspaceId, items) {
  const path = meetingsPath(workspaceId);
  const trimmed = items.length > MAX_MEETINGS_PER_WORKSPACE
    ? items.slice(-MAX_MEETINGS_PER_WORKSPACE)
    : items;
  await writeJsonPath(path, { _version: 1, items: trimmed });
}

function publicView(meeting) {
  if (!meeting) return null;
  return {
    id: meeting.id,
    workspaceId: meeting.workspaceId,
    platform: meeting.platform,
    meetingUrl: meeting.meetingUrl || null,
    meetingId: meeting.meetingId || null,
    sessionId: meeting.sessionId || null,
    status: meeting.status || "unknown",
    startedAt: meeting.startedAt || null,
    endedAt: meeting.endedAt || null,
    duration: Number.isFinite(meeting.duration) ? meeting.duration : 0,
    attendees: Array.isArray(meeting.attendees) ? meeting.attendees : [],
    transcript: Array.isArray(meeting.transcript) ? meeting.transcript : [],
    summary: meeting.summary || "",
    topics: Array.isArray(meeting.topics) ? meeting.topics : [],
    decisions: Array.isArray(meeting.decisions) ? meeting.decisions : [],
    actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems : [],
    recordingUrl: meeting.recordingUrl || null,
    recordingId: meeting.recordingId || null,
    audioPath: meeting.audioPath || null,
    deleted: !!meeting.deleted,
  };
}

function findActive(items, id) {
  return items.find((m) => String(m.id) === String(id) && !m.deleted);
}

function findActiveBySession(items, sessionId) {
  return items.find((m) => String(m.sessionId) === String(sessionId) && !m.deleted);
}

function pickAdapter(platform) {
  const a = ADAPTERS[platform];
  if (!a || typeof a.join !== "function") {
    throw new Error(`no adapter registered for platform: ${platform}`);
  }
  return a;
}

/**
 * Join a meeting as a participant bot.
 *
 * @param {{
 *   platform: "zoom"|"meet"|"teams"|"webex",
 *   meetingUrl: string,
 *   displayName?: string,
 *   botToken?: string,
 *   workspaceId?: string,
 *   meetingId?: string,
 *   passcode?: string,
 * }} config
 * @returns {Promise<{ sessionId: string, joinedAt: string, meetingId: string }>}
 */
export async function joinMeeting(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config is required");
  }
  const platform = String(config.platform || "").trim().toLowerCase();
  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(`platform must be one of: ${Array.from(VALID_PLATFORMS).join(", ")}`);
  }
  if (!config.meetingUrl || typeof config.meetingUrl !== "string") {
    throw new Error("meetingUrl is required");
  }
  const workspaceId = sanitizeWs(config.workspaceId);
  const adapter = pickAdapter(platform);

  const adapterResult = await adapter.join({
    meetingUrl: config.meetingUrl,
    displayName: config.displayName || "SiskelBot",
    botToken: config.botToken || null,
    meetingId: config.meetingId || null,
    passcode: config.passcode || null,
  });

  const sessionId = adapterResult?.sessionId || randomUUID();
  const joinedAt = adapterResult?.joinedAt || new Date().toISOString();
  const meetingId = adapterResult?.meetingId || config.meetingId || randomUUID();

  const id = randomUUID();
  const record = {
    id,
    workspaceId,
    platform,
    meetingUrl: config.meetingUrl,
    meetingId,
    sessionId,
    status: "joined",
    startedAt: joinedAt,
    endedAt: null,
    duration: 0,
    attendees: Array.isArray(adapterResult?.attendees) ? adapterResult.attendees : [],
    transcript: [],
    summary: "",
    topics: [],
    decisions: [],
    actionItems: [],
    recordingUrl: null,
    recordingId: null,
    audioPath: null,
    deleted: false,
  };

  await withPathLock(meetingsPath(workspaceId), async () => {
    const items = await loadAll(workspaceId);
    items.push(record);
    await saveAll(workspaceId, items);
  });

  activeSessions.set(sessionId, { meetingId: id, workspaceId, platform });

  return { sessionId, joinedAt, meetingId };
}

/**
 * Leave a meeting and mark the corresponding record ended.
 * @param {string} sessionId
 * @returns {Promise<{ ok: boolean, endedAt: string, duration: number }>}
 */
export async function leaveMeeting(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  const session = activeSessions.get(sessionId);
  const workspaceId = session?.workspaceId || "default";
  const platform = session?.platform || null;

  if (platform && ADAPTERS[platform] && typeof ADAPTERS[platform].leave === "function") {
    try {
      await ADAPTERS[platform].leave(sessionId);
    } catch (e) {
      console.warn("[meeting-bot] adapter leave error:", e && e.message);
    }
  }

  let endedAt = new Date().toISOString();
  let duration = 0;
  await withPathLock(meetingsPath(workspaceId), async () => {
    const items = await loadAll(workspaceId);
    const meeting = findActiveBySession(items, sessionId);
    if (!meeting) return;
    meeting.status = "ended";
    meeting.endedAt = endedAt;
    if (meeting.startedAt) {
      duration = Math.max(
        0,
        Math.round((new Date(endedAt).getTime() - new Date(meeting.startedAt).getTime()) / 1000)
      );
    }
    meeting.duration = duration;
    await saveAll(workspaceId, items);
  });

  activeSessions.delete(sessionId);
  return { ok: true, endedAt, duration };
}

/**
 * Record audio for an active meeting and optionally transcribe + diarize.
 *
 * @param {string} sessionId
 * @param {{ transcribe?: boolean, diarize?: boolean, summarize?: boolean }} [options]
 * @returns {Promise<{ recordingId: string, duration: number, audioPath: string|null, transcript?: object[] }>}
 */
export async function recordMeeting(sessionId, options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("active session not found");

  const adapter = pickAdapter(session.platform);
  let recording = { recordingId: randomUUID(), duration: 0, audioPath: null, transcript: [] };
  if (typeof adapter.record === "function") {
    try {
      const r = await adapter.record(sessionId, options);
      if (r && typeof r === "object") {
        recording = {
          recordingId: r.recordingId || recording.recordingId,
          duration: Number.isFinite(r.duration) ? r.duration : 0,
          audioPath: r.audioPath || null,
          transcript: Array.isArray(r.transcript) ? r.transcript : [],
        };
      }
    } catch (e) {
      console.warn("[meeting-bot] adapter record error:", e && e.message);
    }
  }

  const workspaceId = session.workspaceId;
  await withPathLock(meetingsPath(workspaceId), async () => {
    const items = await loadAll(workspaceId);
    const meeting = findActive(items, session.meetingId);
    if (!meeting) return;
    meeting.recordingId = recording.recordingId;
    meeting.audioPath = recording.audioPath;
    if (recording.duration > 0) meeting.duration = recording.duration;
    if (recording.transcript.length > 0) {
      meeting.transcript = recording.transcript.slice(0, MAX_TRANSCRIPT_SEGMENTS);
    }
    await saveAll(workspaceId, items);
  });

  if (options.summarize) {
    try {
      await summarizeMeetingBySession(sessionId);
    } catch (e) {
      console.warn("[meeting-bot] auto-summary error:", e && e.message);
    }
  }

  return recording;
}

/**
 * Append a transcript segment to a meeting (used by streaming transcription).
 * @param {string} meetingId
 * @param {{ speaker?: string, text: string, startMs?: number, endMs?: number }} segment
 * @param {string} [workspaceId]
 */
export async function appendTranscriptSegment(meetingId, segment, workspaceId = "default") {
  if (!meetingId) throw new Error("meetingId is required");
  if (!segment || typeof segment.text !== "string" || !segment.text.trim()) {
    throw new Error("segment.text is required");
  }
  const ws = sanitizeWs(workspaceId);
  await withPathLock(meetingsPath(ws), async () => {
    const items = await loadAll(ws);
    const meeting = findActive(items, meetingId);
    if (!meeting) throw new Error("meeting not found");
    if (!Array.isArray(meeting.transcript)) meeting.transcript = [];
    if (meeting.transcript.length >= MAX_TRANSCRIPT_SEGMENTS) {
      meeting.transcript.shift();
    }
    meeting.transcript.push({
      speaker: typeof segment.speaker === "string" ? segment.speaker.slice(0, 200) : "unknown",
      text: segment.text.trim().slice(0, 8_000),
      startMs: Number.isFinite(segment.startMs) ? segment.startMs : 0,
      endMs: Number.isFinite(segment.endMs) ? segment.endMs : 0,
    });
    await saveAll(ws, items);
  });
}

function transcriptToText(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return "";
  return transcript
    .map((s) => `${s.speaker || "unknown"}: ${typeof s.text === "string" ? s.text : ""}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
}

function uniqueAttendeesFromTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  const seen = new Set();
  for (const seg of transcript) {
    if (seg && typeof seg.speaker === "string" && seg.speaker.trim()) {
      seen.add(seg.speaker.trim());
    }
  }
  return Array.from(seen);
}

async function callLLM(messages, options = {}) {
  if (!llmClient) return null;
  try {
    const out = await llmClient(messages, options);
    return typeof out === "string" ? out : null;
  } catch (e) {
    console.warn("[meeting-bot] LLM call failed:", e && e.message);
    return null;
  }
}

function tryParseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch (_) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

function heuristicSummary(transcript) {
  const text = transcriptToText(transcript);
  if (!text) {
    return {
      summary: "",
      topics: [],
      decisions: [],
    };
  }
  const sentences = text.split(/[\n.!?]+/).map((s) => s.trim()).filter(Boolean);
  const summary = sentences.slice(0, 3).join(". ").slice(0, MAX_SUMMARY_LEN);
  const topics = [];
  const decisions = [];
  for (const s of sentences) {
    if (/\b(decided|agreed|concluded|will use|chose)\b/i.test(s)) {
      decisions.push(s);
    } else if (/\b(discuss|review|talk about|topic|consider)\b/i.test(s) && topics.length < 5) {
      topics.push(s);
    }
  }
  return { summary, topics: topics.slice(0, 5), decisions: decisions.slice(0, 5) };
}

function heuristicActionItems(transcript) {
  const text = transcriptToText(transcript);
  if (!text) return [];
  const items = [];
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    const speaker = m ? m[1].trim() : "unknown";
    const body = m ? m[2] : line;
    const sentences = body.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      if (/\b(I will|I'll|we will|we'll|please|action item|todo|follow up|follow-up|need to|should)\b/i.test(s)) {
        const ownerMatch = s.match(/\b([A-Z][a-zA-Z]+)\s+(?:will|should|to)\b/);
        items.push({
          text: s,
          owner: ownerMatch ? ownerMatch[1] : speaker,
          dueDate: null,
          confidence: 0.5,
        });
      }
      if (items.length >= 50) break;
    }
    if (items.length >= 50) break;
  }
  return items;
}

/**
 * Summarize a meeting transcript with the configured LLM client. Falls back to
 * a heuristic summary when no client is configured or the LLM fails.
 *
 * @param {string} meetingId
 * @param {string} [workspaceId]
 * @returns {Promise<{ summary: string, topics: string[], decisions: string[], attendees: string[], duration: number }>}
 */
export async function summarizeMeeting(meetingId, workspaceId = "default") {
  if (!meetingId) throw new Error("meetingId is required");
  const ws = sanitizeWs(workspaceId);
  let meeting = null;
  await withPathLock(meetingsPath(ws), async () => {
    const items = await loadAll(ws);
    meeting = findActive(items, meetingId);
  });
  if (!meeting) throw new Error("meeting not found");

  const transcriptText = transcriptToText(meeting.transcript);
  const attendees = meeting.attendees && meeting.attendees.length
    ? meeting.attendees
    : uniqueAttendeesFromTranscript(meeting.transcript);

  let summary = "";
  let topics = [];
  let decisions = [];

  if (transcriptText) {
    const prompt = [
      {
        role: "system",
        content:
          "You are a meeting assistant. Summarize the following meeting transcript. " +
          'Return JSON: { "summary": "...", "topics": ["..."], "decisions": ["..."] }. ' +
          "Be concise. The summary should be 2-4 sentences.",
      },
      {
        role: "user",
        content: `Transcript:\n${transcriptText}\n\nReturn only the JSON object.`,
      },
    ];
    const llmText = await callLLM(prompt, { temperature: 0.2, maxTokens: 800 });
    const parsed = tryParseJson(llmText || "");
    if (parsed && typeof parsed === "object") {
      summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, MAX_SUMMARY_LEN) : "";
      topics = Array.isArray(parsed.topics) ? parsed.topics.map(String).slice(0, 20) : [];
      decisions = Array.isArray(parsed.decisions) ? parsed.decisions.map(String).slice(0, 20) : [];
    }
    if (!summary) {
      const fallback = heuristicSummary(meeting.transcript);
      summary = fallback.summary;
      topics = fallback.topics;
      decisions = fallback.decisions;
    }
  }

  await withPathLock(meetingsPath(ws), async () => {
    const items = await loadAll(ws);
    const m = findActive(items, meetingId);
    if (!m) return;
    m.summary = summary;
    m.topics = topics;
    m.decisions = decisions;
    if (attendees.length && (!m.attendees || m.attendees.length === 0)) {
      m.attendees = attendees;
    }
    await saveAll(ws, items);
  });

  return {
    summary,
    topics,
    decisions,
    attendees,
    duration: Number.isFinite(meeting.duration) ? meeting.duration : 0,
  };
}

async function summarizeMeetingBySession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("active session not found");
  return summarizeMeeting(session.meetingId, session.workspaceId);
}

/**
 * Extract action items from a transcript (string or segment array). Uses the
 * injected LLM client when available; otherwise applies a heuristic.
 *
 * @param {string|object[]} transcript
 * @returns {Promise<Array<{ text: string, owner: string, dueDate: string|null, confidence: number }>>}
 */
export async function extractActionItems(transcript) {
  if (!transcript) return [];
  const segments = Array.isArray(transcript)
    ? transcript
    : String(transcript)
        .split(/\n+/)
        .map((line) => {
          const m = line.match(/^([^:]+):\s*(.*)$/);
          return m
            ? { speaker: m[1].trim(), text: m[2].trim() }
            : { speaker: "unknown", text: line.trim() };
        })
        .filter((s) => s.text);

  const text = transcriptToText(segments);
  if (!text) return [];

  const prompt = [
    {
      role: "system",
      content:
        "You extract action items from meeting transcripts. " +
        'Return JSON: { "actionItems": [{ "text": "...", "owner": "Name|null", "dueDate": "ISO date or null", "confidence": 0..1 }] }. ' +
        "Only include items where someone commits to do something.",
    },
    {
      role: "user",
      content: `Transcript:\n${text}\n\nReturn only the JSON object.`,
    },
  ];
  const llmText = await callLLM(prompt, { temperature: 0.1, maxTokens: 600 });
  const parsed = tryParseJson(llmText || "");
  if (parsed && Array.isArray(parsed.actionItems)) {
    return parsed.actionItems
      .filter((it) => it && typeof it.text === "string" && it.text.trim())
      .map((it) => ({
        text: String(it.text).slice(0, 2_000),
        owner: typeof it.owner === "string" ? it.owner.slice(0, 200) : "unknown",
        dueDate: typeof it.dueDate === "string" ? it.dueDate : null,
        confidence: Number.isFinite(it.confidence) ? Math.max(0, Math.min(1, it.confidence)) : 0.5,
      }))
      .slice(0, 100);
  }
  return heuristicActionItems(segments);
}

/**
 * Extract action items for a stored meeting and persist them on the record.
 * @param {string} meetingId
 * @param {string} [workspaceId]
 */
export async function extractActionItemsForMeeting(meetingId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  let meeting = null;
  await withPathLock(meetingsPath(ws), async () => {
    const items = await loadAll(ws);
    meeting = findActive(items, meetingId);
  });
  if (!meeting) throw new Error("meeting not found");
  const items = await extractActionItems(meeting.transcript);
  await withPathLock(meetingsPath(ws), async () => {
    const all = await loadAll(ws);
    const m = findActive(all, meetingId);
    if (!m) return;
    m.actionItems = items;
    await saveAll(ws, all);
  });
  return items;
}

/**
 * List meetings in a workspace.
 * @param {string} workspaceId
 * @param {{ limit?: number, offset?: number, status?: string, platform?: string }} [options]
 */
export async function listMeetings(workspaceId, options = {}) {
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  let filtered = items.filter((m) => !m.deleted);
  if (options.status) {
    filtered = filtered.filter((m) => m.status === options.status);
  }
  if (options.platform) {
    filtered = filtered.filter((m) => m.platform === options.platform);
  }
  filtered.sort((a, b) => {
    const at = new Date(a.startedAt || 0).getTime();
    const bt = new Date(b.startedAt || 0).getTime();
    return bt - at;
  });
  const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, options.limit)) : 50;
  return filtered.slice(offset, offset + limit).map(publicView);
}

/**
 * Get a single meeting by id.
 * @param {string} meetingId
 * @param {string} [workspaceId]
 */
export async function getMeeting(meetingId, workspaceId = "default") {
  if (!meetingId) return null;
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  const m = findActive(items, meetingId);
  return m ? publicView(m) : null;
}

/**
 * Soft-delete a meeting.
 * @param {string} meetingId
 * @param {string} [workspaceId]
 */
export async function deleteMeeting(meetingId, workspaceId = "default") {
  if (!meetingId) throw new Error("meetingId is required");
  const ws = sanitizeWs(workspaceId);
  let found = false;
  await withPathLock(meetingsPath(ws), async () => {
    const items = await loadAll(ws);
    const m = findActive(items, meetingId);
    if (!m) return;
    m.deleted = true;
    found = true;
    await saveAll(ws, items);
  });
  if (!found) throw new Error("meeting not found");
  return { ok: true };
}

/**
 * Validate that a value implements the meeting adapter interface.
 * @param {object} adapter
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateAdapter(adapter) {
  const required = ["join", "leave", "record"];
  const missing = [];
  if (!adapter || typeof adapter !== "object") {
    return { valid: false, missing: required };
  }
  for (const fn of required) {
    if (typeof adapter[fn] !== "function") missing.push(fn);
  }
  return { valid: missing.length === 0, missing };
}

/** Internal accessors for tests. */
export const _internals = {
  heuristicSummary,
  heuristicActionItems,
  transcriptToText,
  uniqueAttendeesFromTranscript,
  tryParseJson,
  meetingsPath,
};
