/**
 * Phase 44.5: Zoom meeting adapter (stub).
 *
 * Production integration paths:
 *   1. Zoom Meeting SDK (native) — requires a Meeting SDK App registered in
 *      the Zoom App Marketplace and a JWT signature endpoint. The bot joins
 *      via the Web Meeting SDK in a headless browser context (Puppeteer or
 *      Playwright) and captures audio via the SDK's audio raw data callback.
 *
 *   2. RTMP livestreaming — Zoom can stream a meeting to an RTMP endpoint
 *      ("Custom Live Streaming Service"). The bot listens on the RTMP URL
 *      with ffmpeg and extracts the audio track. Requires the host to have
 *      Custom Live Streaming enabled and the bot to be promoted to host or
 *      co-host (or to have the meeting host configured to auto-stream).
 *
 *   3. Cloud recording webhook — register for the recording.completed Zoom
 *      webhook, download the recording from the temporary download URL, and
 *      transcribe offline. This is post-meeting only.
 *
 * Configuration env vars:
 *   ZOOM_SDK_KEY        - Meeting SDK App Key
 *   ZOOM_SDK_SECRET     - Meeting SDK App Secret
 *   ZOOM_BOT_TOKEN      - Per-bot OAuth token (optional)
 *   ZOOM_RTMP_LISTEN    - "rtmp://0.0.0.0:1935/live" for option (2)
 *
 * This file is a stub. Each function returns a deterministic mock result so
 * the meeting-bot lifecycle can be exercised without vendor SDKs installed.
 */
import { randomUUID } from "crypto";

const SDK_KEY = process.env.ZOOM_SDK_KEY || "";
const SDK_SECRET = process.env.ZOOM_SDK_SECRET || "";

export function isConfigured() {
  return Boolean(SDK_KEY && SDK_SECRET);
}

/**
 * Join a Zoom meeting as a bot participant.
 *
 * @param {{
 *   meetingUrl: string,
 *   displayName?: string,
 *   botToken?: string,
 *   meetingId?: string,
 *   passcode?: string,
 * }} config
 * @returns {Promise<{ sessionId: string, joinedAt: string, meetingId: string, attendees: string[] }>}
 */
export async function join(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config is required");
  }
  if (!config.meetingUrl) {
    throw new Error("meetingUrl is required");
  }
  // Production: invoke Zoom Meeting SDK or RTMP listener.
  return {
    sessionId: `zoom-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    meetingId: config.meetingId || extractZoomMeetingId(config.meetingUrl) || randomUUID(),
    attendees: [],
  };
}

/**
 * Leave a Zoom meeting.
 * @param {string} sessionId
 */
export async function leave(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  // Production: gracefully tear down SDK / disconnect RTMP listener.
  return { ok: true };
}

/**
 * Record audio from a Zoom meeting. Returns an empty stub recording so the
 * meeting-bot lifecycle can be exercised without an SDK present.
 * @param {string} sessionId
 * @param {{ transcribe?: boolean, diarize?: boolean }} [options]
 */
export async function record(sessionId, _options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  return {
    recordingId: `zoom-rec-${randomUUID()}`,
    duration: 0,
    audioPath: null,
    transcript: [],
  };
}

/**
 * Extract a numeric meeting id from a Zoom join URL.
 * Examples handled:
 *   https://us02web.zoom.us/j/1234567890
 *   https://zoom.us/j/1234567890?pwd=abc
 * @param {string} url
 * @returns {string|null}
 */
export function extractZoomMeetingId(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/\/j\/(\d+)/);
  return m ? m[1] : null;
}
