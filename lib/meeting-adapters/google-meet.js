/**
 * Phase 44.5: Google Meet meeting adapter (stub).
 *
 * Production integration paths:
 *   1. Google Meet REST API + Conference Records — the Meet REST API allows
 *      programmatic creation/management of meeting spaces and reading
 *      conference records (participants, recordings, transcripts) AFTER the
 *      meeting completes. It does NOT yet support a first-party "join as a
 *      bot" mode.
 *
 *   2. Headless browser join — the practical workaround is to launch a
 *      headless Chromium with a fake media device, navigate to meet.google.com,
 *      sign in (or accept guest mode), and join. Audio capture is performed
 *      via Chromium's WebRTC stack and routed to a virtual sink (PulseAudio's
 *      `module-null-sink` on Linux). Workspace admins can also enable a
 *      tag-based bot allowlist to skip the lobby.
 *
 *   3. Google Meet Add-ons SDK — for in-meeting side panels rather than for
 *      bot participation. Not suitable for transcription bots.
 *
 * Configuration env vars:
 *   GOOGLE_MEET_OAUTH_CLIENT_ID
 *   GOOGLE_MEET_OAUTH_CLIENT_SECRET
 *   GOOGLE_MEET_REFRESH_TOKEN     - service account or user refresh token
 *   GOOGLE_MEET_HEADLESS_BROWSER  - "1" to use the Chromium join path
 *
 * Note: official Google Meet API for bots is limited; the headless browser
 * path is the most reliable today. This file is a stub.
 */
import { randomUUID } from "crypto";

const CLIENT_ID = process.env.GOOGLE_MEET_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_MEET_OAUTH_CLIENT_SECRET || "";

export function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/**
 * Join a Google Meet conference.
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
  // Production: launch headless Chromium and join meet.google.com URL.
  return {
    sessionId: `meet-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    meetingId: config.meetingId || extractMeetCode(config.meetingUrl) || randomUUID(),
    attendees: [],
  };
}

/**
 * Leave a Google Meet conference.
 * @param {string} sessionId
 */
export async function leave(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  // Production: close the Chromium tab / quit the browser context.
  return { ok: true };
}

/**
 * Record audio from a Google Meet conference. Returns a stub recording.
 * @param {string} sessionId
 * @param {{ transcribe?: boolean, diarize?: boolean }} [options]
 */
export async function record(sessionId, _options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  return {
    recordingId: `meet-rec-${randomUUID()}`,
    duration: 0,
    audioPath: null,
    transcript: [],
  };
}

/**
 * Extract the meeting code from a Google Meet URL.
 * Example: https://meet.google.com/abc-defg-hij → "abc-defg-hij"
 * @param {string} url
 */
export function extractMeetCode(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/meet\.google\.com\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}
