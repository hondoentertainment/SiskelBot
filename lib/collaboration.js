/**
 * Real-time collaboration: cursors, typing indicators, shared edits, activity feed.
 * Provides per-workspace collaboration sessions with document locking,
 * cursor tracking, and activity recording.
 */
import { randomUUID } from "crypto";

/** @type {Map<string, CollaborationSession>} workspaceId -> session */
const sessions = new Map();

const MAX_ACTIVITY_ENTRIES = 200;
const TYPING_TIMEOUT_MS = 5_000;
const LOCK_TTL_MS = 120_000; // 2 minutes auto-unlock

/**
 * Create or retrieve a collaboration session for a workspace.
 * @param {string} workspaceId
 * @returns {CollaborationSession}
 */
export function createCollaborationSession(workspaceId) {
  if (sessions.has(workspaceId)) return sessions.get(workspaceId);

  /** @type {Map<string, { documentId: string, line: number, column: number, updatedAt: number }>} userId -> cursor */
  const cursors = new Map();

  /** @type {Map<string, { isTyping: boolean, updatedAt: number }>} userId -> typing state */
  const typingState = new Map();

  /** @type {Map<string, { userId: string, lockedAt: number }>} docId -> lock info */
  const documentLocks = new Map();

  /** @type {Array<{ id: string, userId: string, action: string, details: any, timestamp: string }>} */
  const activityFeed = [];

  /** @type {((message: object, excludeUserId?: string) => void)|null} */
  let broadcastFn = null;

  const session = {
    workspaceId,

    /**
     * Set the broadcast function used to push events to workspace members.
     * @param {(message: object, excludeUserId?: string) => void} fn
     */
    setBroadcast(fn) {
      broadcastFn = fn;
    },

    /**
     * Update cursor position for a user.
     * @param {string} userId
     * @param {{ documentId: string, line: number, column: number }} position
     */
    updateCursor(userId, position) {
      if (!userId || !position) return;
      const entry = {
        documentId: String(position.documentId || ""),
        line: Number(position.line) || 0,
        column: Number(position.column) || 0,
        updatedAt: Date.now(),
      };
      cursors.set(userId, entry);
      if (broadcastFn) {
        broadcastFn({ type: "cursor_update", userId, cursor: entry }, userId);
      }
    },

    /**
     * Get all active cursors in the workspace.
     * @returns {Array<{ userId: string, documentId: string, line: number, column: number }>}
     */
    getCursors() {
      const result = [];
      for (const [userId, entry] of cursors.entries()) {
        result.push({ userId, ...entry });
      }
      return result;
    },

    /**
     * Set typing indicator for a user.
     * @param {string} userId
     * @param {boolean} isTyping
     */
    setTyping(userId, isTyping) {
      if (!userId) return;
      typingState.set(userId, { isTyping: !!isTyping, updatedAt: Date.now() });
      if (broadcastFn) {
        broadcastFn({ type: "typing_indicator", userId, typing: !!isTyping }, userId);
      }
    },

    /**
     * Get list of users currently typing (within TYPING_TIMEOUT_MS).
     * @returns {string[]}
     */
    getTypingUsers() {
      const now = Date.now();
      const result = [];
      for (const [userId, state] of typingState.entries()) {
        if (state.isTyping && now - state.updatedAt < TYPING_TIMEOUT_MS) {
          result.push(userId);
        } else if (!state.isTyping || now - state.updatedAt >= TYPING_TIMEOUT_MS) {
          if (!state.isTyping) typingState.delete(userId);
        }
      }
      return result;
    },

    /**
     * Lock a document for editing (optimistic locking).
     * @param {string} userId
     * @param {string} docId
     * @returns {{ ok: boolean, error?: string }}
     */
    lockDocument(userId, docId) {
      if (!userId || !docId) return { ok: false, error: "userId and docId are required" };
      const existing = documentLocks.get(docId);
      if (existing) {
        // Auto-expire stale locks
        if (Date.now() - existing.lockedAt > LOCK_TTL_MS) {
          documentLocks.delete(docId);
        } else if (existing.userId !== userId) {
          return { ok: false, error: `Document locked by ${existing.userId}` };
        } else {
          // Already locked by this user, refresh
          existing.lockedAt = Date.now();
          return { ok: true };
        }
      }
      documentLocks.set(docId, { userId, lockedAt: Date.now() });
      if (broadcastFn) {
        broadcastFn({ type: "document_locked", userId, docId });
      }
      return { ok: true };
    },

    /**
     * Unlock a document.
     * @param {string} userId
     * @param {string} docId
     * @returns {{ ok: boolean, error?: string }}
     */
    unlockDocument(userId, docId) {
      if (!userId || !docId) return { ok: false, error: "userId and docId are required" };
      const existing = documentLocks.get(docId);
      if (!existing) return { ok: true };
      if (existing.userId !== userId) {
        return { ok: false, error: `Document locked by ${existing.userId}` };
      }
      documentLocks.delete(docId);
      if (broadcastFn) {
        broadcastFn({ type: "document_unlocked", userId, docId });
      }
      return { ok: true };
    },

    /**
     * Get all currently locked documents.
     * @returns {Array<{ docId: string, userId: string, lockedAt: number }>}
     */
    getLockedDocuments() {
      const now = Date.now();
      const result = [];
      for (const [docId, lock] of documentLocks.entries()) {
        if (now - lock.lockedAt > LOCK_TTL_MS) {
          documentLocks.delete(docId);
          continue;
        }
        result.push({ docId, userId: lock.userId, lockedAt: lock.lockedAt });
      }
      return result;
    },

    /**
     * Record an activity entry in the workspace feed.
     * @param {string} userId
     * @param {string} action
     * @param {any} details
     * @returns {{ id: string, userId: string, action: string, details: any, timestamp: string }}
     */
    recordActivity(userId, action, details) {
      const entry = {
        id: randomUUID(),
        userId: userId || "anonymous",
        action: String(action || "unknown"),
        details: details || null,
        timestamp: new Date().toISOString(),
      };
      activityFeed.unshift(entry);
      if (activityFeed.length > MAX_ACTIVITY_ENTRIES) {
        activityFeed.length = MAX_ACTIVITY_ENTRIES;
      }
      if (broadcastFn) {
        broadcastFn({ type: "activity", activity: entry });
      }
      return entry;
    },

    /**
     * Get recent activity entries.
     * @param {number} [limit=50]
     * @returns {Array<{ id: string, userId: string, action: string, details: any, timestamp: string }>}
     */
    getRecentActivity(limit = 50) {
      const n = Math.max(1, Math.min(limit, MAX_ACTIVITY_ENTRIES));
      return activityFeed.slice(0, n);
    },

    /**
     * Send a notification to all workspace members (via the broadcast function).
     * @param {object} message
     * @param {string} [excludeUserId]
     */
    notifyMembers(message, excludeUserId) {
      if (broadcastFn) {
        broadcastFn({ type: "collaboration_notification", ...message }, excludeUserId);
      }
    },

    /**
     * Remove a user's cursor and typing state (e.g. when they disconnect).
     * @param {string} userId
     */
    removeUser(userId) {
      cursors.delete(userId);
      typingState.delete(userId);
      // Release any locks held by this user
      for (const [docId, lock] of documentLocks.entries()) {
        if (lock.userId === userId) {
          documentLocks.delete(docId);
          if (broadcastFn) {
            broadcastFn({ type: "document_unlocked", userId, docId });
          }
        }
      }
    },

    /**
     * Destroy the session and clean up all state.
     */
    destroy() {
      cursors.clear();
      typingState.clear();
      documentLocks.clear();
      activityFeed.length = 0;
      broadcastFn = null;
      sessions.delete(workspaceId);
    },
  };

  sessions.set(workspaceId, session);
  return session;
}

/**
 * Get a collaboration session for a workspace if it exists.
 * @param {string} workspaceId
 * @returns {CollaborationSession|null}
 */
export function getCollaborationSession(workspaceId) {
  return sessions.get(workspaceId) || null;
}

/**
 * Get active collaborators for a workspace.
 * Merges presence data with collaboration state (cursors, typing).
 * @param {string} workspaceId
 * @param {Array<{ userId: string, displayName?: string }>} onlineUsers - from realtime presence
 * @returns {Array<{ userId: string, displayName: string, cursor?: object, typing: boolean, lastSeen: string }>}
 */
export function getActiveCollaborators(workspaceId, onlineUsers = []) {
  const session = sessions.get(workspaceId);
  const typingUsers = session ? new Set(session.getTypingUsers()) : new Set();
  const cursorMap = new Map();
  if (session) {
    for (const c of session.getCursors()) {
      cursorMap.set(c.userId, { documentId: c.documentId, line: c.line, column: c.column });
    }
  }

  return onlineUsers.map((user) => ({
    userId: user.userId,
    displayName: user.displayName || user.userId,
    cursor: cursorMap.get(user.userId) || undefined,
    typing: typingUsers.has(user.userId),
    lastSeen: new Date().toISOString(),
  }));
}

/**
 * Get count of active collaboration sessions.
 * @returns {number}
 */
export function getSessionCount() {
  return sessions.size;
}
