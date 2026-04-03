/**
 * Real-time event replay buffer.
 * Stores recent events (last 5 minutes) in a circular buffer so clients
 * can fetch missed events on WebSocket reconnect.
 *
 * Events stored: notifications, presence updates, activity feed items.
 */

const BUFFER_SIZE = parseInt(process.env.REPLAY_BUFFER_SIZE, 10) || 2000;
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Circular buffer entry.
 * @typedef {{ workspaceId: string, type: string, payload: object, timestamp: number }} ReplayEvent
 */

/** @type {ReplayEvent[]} */
const buffer = new Array(BUFFER_SIZE);
let writeIndex = 0;
let count = 0;

/**
 * Record an event for potential replay.
 * @param {string} workspaceId
 * @param {string} type - e.g. "notification", "presence", "activity"
 * @param {object} payload - the event data
 */
export function recordEvent(workspaceId, type, payload) {
  const entry = {
    workspaceId,
    type,
    payload,
    timestamp: Date.now(),
  };
  buffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % BUFFER_SIZE;
  if (count < BUFFER_SIZE) count++;
}

/**
 * Retrieve events for a workspace since a given timestamp.
 * @param {string} workspaceId
 * @param {number} sinceTimestamp - Unix ms timestamp
 * @returns {ReplayEvent[]}
 */
export function getEventsSince(workspaceId, sinceTimestamp) {
  const now = Date.now();
  const cutoff = Math.max(sinceTimestamp, now - MAX_AGE_MS);
  const results = [];

  // Walk the circular buffer from oldest to newest
  const start = count < BUFFER_SIZE ? 0 : writeIndex;
  for (let i = 0; i < count; i++) {
    const idx = (start + i) % BUFFER_SIZE;
    const entry = buffer[idx];
    if (!entry) continue;
    if (entry.timestamp <= cutoff) continue;
    if (entry.workspaceId !== workspaceId) continue;
    results.push({
      type: entry.type,
      payload: entry.payload,
      timestamp: entry.timestamp,
    });
  }

  return results;
}

/**
 * Clear all state — for testing only.
 */
export function _resetForTesting() {
  buffer.fill(undefined);
  writeIndex = 0;
  count = 0;
}
