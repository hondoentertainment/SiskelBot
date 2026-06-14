/**
 * Phase 44.5: Microsoft Teams meeting adapter (stub).
 *
 * Production integration paths:
 *   1. Microsoft Graph API for meeting management — list, create, and read
 *      meeting metadata via /me/onlineMeetings and /communications/calls.
 *      Requires an Azure AD app with the OnlineMeetings.ReadWrite and
 *      Calls.JoinGroupCall.All application permissions and tenant admin
 *      consent.
 *
 *   2. Compliance recording API (Microsoft Cloud Communications) — register
 *      a "compliance recording bot" with the tenant. The bot uses the
 *      Microsoft Bot Framework + Teams Communications SDK to receive a
 *      real-time audio media socket for every call placed by users in scope.
 *      This is the supported way to record Teams meetings.
 *
 *   3. Teams Bot Framework + Live Share — for in-meeting bot chat and side
 *      panels but does not provide raw audio capture.
 *
 * Configuration env vars:
 *   TEAMS_TENANT_ID
 *   TEAMS_CLIENT_ID
 *   TEAMS_CLIENT_SECRET
 *   TEAMS_BOT_APP_ID            - Bot Framework app id (compliance recorder)
 *   TEAMS_BOT_APP_PASSWORD
 *   TEAMS_COMPLIANCE_RECORDING  - "1" to enable the compliance recording path
 *
 * This file is a stub.
 */
import { randomUUID } from "crypto";

const TENANT_ID = process.env.TEAMS_TENANT_ID || "";
const CLIENT_ID = process.env.TEAMS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET || "";

export function isConfigured() {
  return Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
}

/**
 * Join a Microsoft Teams meeting as a bot.
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
  // Production: call Graph API /communications/calls with the Teams join URL.
  return {
    sessionId: `teams-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    meetingId: config.meetingId || extractTeamsThreadId(config.meetingUrl) || randomUUID(),
    attendees: [],
  };
}

/**
 * Leave a Microsoft Teams meeting.
 * @param {string} sessionId
 */
export async function leave(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  // Production: DELETE /communications/calls/{call-id}.
  return { ok: true };
}

/**
 * Record audio from a Teams meeting via the compliance recording bot.
 * Returns a stub.
 * @param {string} sessionId
 * @param {{ transcribe?: boolean, diarize?: boolean }} [options]
 */
export async function record(sessionId, _options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  return {
    recordingId: `teams-rec-${randomUUID()}`,
    duration: 0,
    audioPath: null,
    transcript: [],
  };
}

/**
 * Extract the Teams thread id from a join URL.
 * Example: https://teams.microsoft.com/l/meetup-join/19:meeting_xyz@thread.v2/0?context=...
 * @param {string} url
 */
export function extractTeamsThreadId(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/19[:%]meeting_[^/?@]+/i);
  return m ? decodeURIComponent(m[0]) : null;
}
