/**
 * Phase 44.5: Webex meeting adapter (stub).
 *
 * Production integration paths:
 *   1. Webex Meetings XML API and REST API — programmatic meeting management
 *      and post-meeting recording download. Requires a Webex integration with
 *      meeting:recordings_read scope.
 *
 *   2. Webex Meeting SDK (Browser/JS) — embed the Webex meeting client in a
 *      headless browser context to join as a guest. Audio capture is performed
 *      via WebRTC like the Google Meet path.
 *
 *   3. Webex Compliance Officer (CO) — for enterprise tenants, register a
 *      compliance officer that receives a copy of every meeting recording.
 *
 * Configuration env vars:
 *   WEBEX_CLIENT_ID
 *   WEBEX_CLIENT_SECRET
 *   WEBEX_BOT_TOKEN
 *
 * This file is a stub.
 */
import { randomUUID } from "crypto";

const CLIENT_ID = process.env.WEBEX_CLIENT_ID || "";
const CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET || "";
const BOT_TOKEN = process.env.WEBEX_BOT_TOKEN || "";

export function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET) || Boolean(BOT_TOKEN);
}

/**
 * Join a Webex meeting as a bot.
 *
 * @param {{
 *   meetingUrl: string,
 *   displayName?: string,
 *   botToken?: string,
 *   meetingId?: string,
 * }} config
 */
export async function join(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config is required");
  }
  if (!config.meetingUrl) {
    throw new Error("meetingUrl is required");
  }
  return {
    sessionId: `webex-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    meetingId: config.meetingId || extractWebexMeetingNumber(config.meetingUrl) || randomUUID(),
    attendees: [],
  };
}

/**
 * Leave a Webex meeting.
 * @param {string} sessionId
 */
export async function leave(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  return { ok: true };
}

/**
 * Record audio from a Webex meeting. Returns a stub recording.
 * @param {string} sessionId
 * @param {{ transcribe?: boolean, diarize?: boolean }} [options]
 */
export async function record(sessionId, _options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  return {
    recordingId: `webex-rec-${randomUUID()}`,
    duration: 0,
    audioPath: null,
    transcript: [],
  };
}

/**
 * Extract a numeric meeting number from a Webex URL.
 * @param {string} url
 */
export function extractWebexMeetingNumber(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/MTID=([^&]+)/) || url.match(/\/(\d{8,})/);
  return m ? m[1] : null;
}
