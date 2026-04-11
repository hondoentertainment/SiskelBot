/**
 * Phase 41.3: Real-time presence tracking with cursor positions and user status.
 *
 * Tracks active sessions per user/workspace, with live cursor positions and
 * status transitions (active/idle/away). Sessions are scoped by sessionId so
 * a single user may have multiple concurrent sessions (e.g. browser tabs).
 *
 * Stale sessions (no activity for STALE_SESSION_MS) are pruned via cleanup().
 */

const STALE_SESSION_MS = 60_000; // 60s
const VALID_STATUSES = new Set(["active", "idle", "away"]);

/**
 * Create a new presence manager. Each manager keeps its own state map so the
 * tests can spin up independent instances; `globalPresence` is the singleton
 * used by the rest of the server.
 */
export function createPresenceManager() {
  /** @type {Map<string, { sessionId: string, userId: string, workspace: string, cursor: object|null, status: string, metadata: object, joinedAt: number, lastSeen: number }>} */
  const sessions = new Map();

  /** @type {NodeJS.Timeout|null} */
  let cleanupTimer = null;

  function sanitize(value, fallback) {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return value.trim().slice(0, 200);
  }

  return {
    /**
     * Register a session for a user in a workspace.
     * @param {string} sessionId
     * @param {string} userId
     * @param {string} workspace
     * @param {object} [metadata]
     * @returns {object|null} the session entry, or null if sessionId is invalid
     */
    joinSession(sessionId, userId, workspace, metadata) {
      if (!sessionId || typeof sessionId !== "string") return null;
      const now = Date.now();
      const entry = {
        sessionId,
        userId: sanitize(userId, "anonymous"),
        workspace: sanitize(workspace, "default"),
        cursor: null,
        status: "active",
        metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
        joinedAt: now,
        lastSeen: now,
      };
      sessions.set(sessionId, entry);
      return entry;
    },

    /**
     * Remove a session.
     * @param {string} sessionId
     * @returns {boolean} true if a session was removed
     */
    leaveSession(sessionId) {
      if (!sessionId) return false;
      return sessions.delete(sessionId);
    },

    /**
     * Update the cursor position for a session.
     * @param {string} sessionId
     * @param {{ line?: number, column?: number, documentId?: string }} position
     */
    updateCursor(sessionId, position) {
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      if (!position || typeof position !== "object") return null;
      entry.cursor = {
        line: Number.isFinite(position.line) ? Number(position.line) : 0,
        column: Number.isFinite(position.column) ? Number(position.column) : 0,
        documentId: typeof position.documentId === "string" ? position.documentId : null,
      };
      entry.lastSeen = Date.now();
      return entry.cursor;
    },

    /**
     * Update the status (active|idle|away) for a session.
     * @param {string} sessionId
     * @param {"active"|"idle"|"away"} status
     */
    updateStatus(sessionId, status) {
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      if (!VALID_STATUSES.has(status)) return null;
      entry.status = status;
      entry.lastSeen = Date.now();
      return entry.status;
    },

    /**
     * Mark a session as active (touch lastSeen) without changing fields.
     * @param {string} sessionId
     */
    touchSession(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return false;
      entry.lastSeen = Date.now();
      return true;
    },

    /**
     * Get a single session by id.
     * @param {string} sessionId
     */
    getSession(sessionId) {
      return sessions.get(sessionId) || null;
    },

    /**
     * Return all (non-stale) sessions in a workspace.
     * @param {string} workspace
     */
    getPresence(workspace) {
      const target = sanitize(workspace, "default");
      const now = Date.now();
      const result = [];
      for (const entry of sessions.values()) {
        if (entry.workspace !== target) continue;
        if (now - entry.lastSeen > STALE_SESSION_MS) continue;
        result.push({ ...entry, cursor: entry.cursor ? { ...entry.cursor } : null });
      }
      return result;
    },

    /**
     * Return all sessions belonging to a user (across workspaces).
     * @param {string} userId
     */
    getUserSessions(userId) {
      const target = sanitize(userId, "anonymous");
      const result = [];
      for (const entry of sessions.values()) {
        if (entry.userId === target) {
          result.push({ ...entry, cursor: entry.cursor ? { ...entry.cursor } : null });
        }
      }
      return result;
    },

    /**
     * Total number of sessions currently tracked (including stale ones until cleanup).
     */
    sessionCount() {
      return sessions.size;
    },

    /**
     * Drop sessions that haven't been seen for STALE_SESSION_MS.
     * @returns {number} number of sessions removed
     */
    cleanup() {
      const now = Date.now();
      let removed = 0;
      for (const [sessionId, entry] of sessions.entries()) {
        if (now - entry.lastSeen > STALE_SESSION_MS) {
          sessions.delete(sessionId);
          removed++;
        }
      }
      return removed;
    },

    /**
     * Start a periodic cleanup timer. Re-entrant: existing timer is replaced.
     * @param {number} [intervalMs=30000]
     */
    startCleanupTimer(intervalMs = 30_000) {
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
      if (cleanupTimer.unref) cleanupTimer.unref();
      return cleanupTimer;
    },

    /**
     * Stop the cleanup timer if running.
     */
    stopCleanupTimer() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },

    /**
     * Reset all in-memory state. Mainly for tests.
     */
    reset() {
      sessions.clear();
      this.stopCleanupTimer();
    },
  };
}

/** Singleton presence manager used by the running server. */
export const globalPresence = createPresenceManager();

/**
 * Generate a deterministic HSL avatar color from a user identifier.
 * Same userId always produces the same color.
 * @param {string} userId
 * @returns {string}
 */
export function getAvatarColor(userId) {
  const id = String(userId || "anonymous");
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}

/**
 * Extract up to two initials from a display name. Falls back to the first
 * character if only a single name token is present, or "?" for empty input.
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  if (typeof name !== "string") return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) {
    return tokens[0].slice(0, 2).toUpperCase();
  }
  return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
}
