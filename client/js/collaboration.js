/**
 * Client-side collaboration module.
 * Renders cursors, typing indicators, presence panels, and activity feeds.
 * Communicates via WebSocket through the wsManager.
 *
 * Usage:
 *   const collab = SiskelCollaboration.initCollaboration(wsManager, workspaceId);
 *   collab.showPresencePanel(document.getElementById('presence'));
 *   collab.showTypingIndicators(document.getElementById('typing'));
 *   collab.showActivityFeed(document.getElementById('activity'));
 *   // later:
 *   collab.destroy();
 */
(function () {
  "use strict";

  const CURSOR_COLORS = [
    "#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd",
    "#56b6c2", "#e5c07b", "#be5046", "#7ec8e3", "#f0a7c3",
  ];

  function getUserColor(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
    }
    return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "style" && typeof v === "object") {
          Object.assign(node.style, v);
        } else if (k === "className") {
          node.className = v;
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    if (children) {
      if (typeof children === "string") {
        node.textContent = children;
      } else if (Array.isArray(children)) {
        for (const child of children) {
          if (typeof child === "string") {
            node.appendChild(document.createTextNode(child));
          } else if (child) {
            node.appendChild(child);
          }
        }
      }
    }
    return node;
  }

  function initCollaboration(wsManager, workspaceId) {
    const state = {
      cursors: new Map(),
      typingUsers: new Map(),
      collaborators: [],
      activities: [],
      destroyed: false,
    };

    const containers = {
      cursors: null,
      typing: null,
      presence: null,
      activity: null,
    };

    function handleMessage(data) {
      if (state.destroyed) return;
      let msg;
      try {
        msg = typeof data === "string" ? JSON.parse(data) : data;
      } catch (_) {
        return;
      }

      if (msg.type === "cursor_update") {
        state.cursors.set(msg.userId, msg.cursor);
        renderCursors();
      }

      if (msg.type === "typing_indicator") {
        if (msg.typing) {
          state.typingUsers.set(msg.userId, Date.now());
        } else {
          state.typingUsers.delete(msg.userId);
        }
        renderTyping();
      }

      if (msg.type === "document_locked" || msg.type === "document_unlocked") {
        // Could extend to show lock indicators in UI
        renderPresence();
      }

      if (msg.type === "activity") {
        if (msg.activity) {
          state.activities.unshift(msg.activity);
          if (state.activities.length > 100) state.activities.length = 100;
          renderActivity();
        }
      }

      if (msg.type === "collaboration_notification") {
        renderActivity();
      }
    }

    // Register listener with wsManager
    let removeListener = null;
    if (wsManager && typeof wsManager.onMessage === "function") {
      removeListener = wsManager.onMessage(handleMessage);
    } else if (wsManager && typeof wsManager.addEventListener === "function") {
      const handler = (event) => handleMessage(event.data);
      wsManager.addEventListener("message", handler);
      removeListener = () => wsManager.removeEventListener("message", handler);
    }

    // Periodically clean stale typing indicators
    const typingCleanup = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [uid, ts] of state.typingUsers.entries()) {
        if (now - ts > 5000) {
          state.typingUsers.delete(uid);
          changed = true;
        }
      }
      if (changed) renderTyping();
    }, 2000);

    function sendWs(msg) {
      if (!wsManager || state.destroyed) return;
      const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
      if (typeof wsManager.send === "function") {
        wsManager.send(payload);
      }
    }

    function renderCursors() {
      const container = containers.cursors;
      if (!container) return;
      container.innerHTML = "";
      for (const [userId, cursor] of state.cursors.entries()) {
        const color = getUserColor(userId);
        const indicator = el("div", {
          className: "collab-cursor",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
            margin: "2px",
            borderRadius: "3px",
            backgroundColor: color + "22",
            border: "1px solid " + color,
            fontSize: "12px",
          },
        }, [
          el("span", { style: { width: "8px", height: "8px", borderRadius: "50%", backgroundColor: color, display: "inline-block" } }),
          el("span", null, userId),
          el("span", { style: { color: "#888", fontSize: "10px" } },
            cursor.documentId ? ` L${cursor.line}:${cursor.column}` : ""),
        ]);
        container.appendChild(indicator);
      }
    }

    function renderTyping() {
      const container = containers.typing;
      if (!container) return;
      const users = Array.from(state.typingUsers.keys());
      if (users.length === 0) {
        container.textContent = "";
        container.style.display = "none";
        return;
      }
      container.style.display = "block";
      if (users.length === 1) {
        container.textContent = users[0] + " is typing\u2026";
      } else if (users.length === 2) {
        container.textContent = users[0] + " and " + users[1] + " are typing\u2026";
      } else {
        container.textContent = users[0] + " and " + (users.length - 1) + " others are typing\u2026";
      }
    }

    function renderPresence() {
      const container = containers.presence;
      if (!container) return;
      container.innerHTML = "";
      const title = el("div", {
        style: { fontWeight: "bold", marginBottom: "6px", fontSize: "13px" },
      }, "Collaborators (" + state.collaborators.length + ")");
      container.appendChild(title);

      for (const user of state.collaborators) {
        const color = getUserColor(user.userId);
        const row = el("div", {
          className: "collab-presence-row",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "3px 0",
            fontSize: "13px",
          },
        }, [
          el("span", {
            style: {
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              backgroundColor: color,
              display: "inline-block",
              flexShrink: "0",
            },
          }),
          el("span", null, user.displayName || user.userId),
          user.typing ? el("span", { style: { color: "#888", fontSize: "11px" } }, " typing\u2026") : null,
        ]);
        container.appendChild(row);
      }
    }

    function renderActivity() {
      const container = containers.activity;
      if (!container) return;
      container.innerHTML = "";
      const title = el("div", {
        style: { fontWeight: "bold", marginBottom: "6px", fontSize: "13px" },
      }, "Recent Activity");
      container.appendChild(title);

      const items = state.activities.slice(0, 20);
      for (const item of items) {
        const time = new Date(item.timestamp).toLocaleTimeString();
        const row = el("div", {
          className: "collab-activity-row",
          style: { padding: "3px 0", fontSize: "12px", borderBottom: "1px solid #eee" },
        }, [
          el("span", { style: { fontWeight: "600" } }, item.userId),
          el("span", null, " " + item.action),
          el("span", { style: { color: "#888", marginLeft: "6px" } }, time),
        ]);
        container.appendChild(row);
      }
    }

    // Load initial activity feed via API
    async function loadActivity() {
      try {
        const resp = await fetch("/api/v1/workspaces/" + encodeURIComponent(workspaceId) + "/activity?limit=50");
        if (resp.ok) {
          const data = await resp.json();
          state.activities = data.items || [];
          renderActivity();
        }
      } catch (_) { /* offline or error, skip */ }
    }

    // Load collaborators via API
    async function loadCollaborators() {
      try {
        const resp = await fetch("/api/v1/workspaces/" + encodeURIComponent(workspaceId) + "/collaborators");
        if (resp.ok) {
          const data = await resp.json();
          state.collaborators = data.items || [];
          renderPresence();
        }
      } catch (_) { /* offline or error, skip */ }
    }

    // Poll collaborators periodically
    const presenceInterval = setInterval(() => {
      if (!state.destroyed) loadCollaborators();
    }, 10000);

    return {
      /**
       * Render colored cursor indicators into a container.
       * @param {HTMLElement} container
       */
      showCursors(container) {
        containers.cursors = container;
        renderCursors();
      },

      /**
       * Render typing indicators ("Alice is typing...") into a container.
       * @param {HTMLElement} container
       */
      showTypingIndicators(container) {
        containers.typing = container;
        renderTyping();
      },

      /**
       * Render presence panel (list of active collaborators) into a container.
       * @param {HTMLElement} container
       */
      showPresencePanel(container) {
        containers.presence = container;
        loadCollaborators();
      },

      /**
       * Render activity feed into a container.
       * @param {HTMLElement} container
       */
      showActivityFeed(container) {
        containers.activity = container;
        loadActivity();
      },

      /**
       * Send a cursor position update.
       * @param {{ documentId: string, line: number, column: number }} position
       */
      updateCursor(position) {
        sendWs({ type: "cursor_update", position });
      },

      /**
       * Send a typing indicator.
       * @param {boolean} isTyping
       */
      setTyping(isTyping) {
        sendWs({ type: "typing_indicator", typing: !!isTyping });
      },

      /**
       * Request a document lock.
       * @param {string} docId
       */
      lockDocument(docId) {
        sendWs({ type: "lock_document", docId });
      },

      /**
       * Release a document lock.
       * @param {string} docId
       */
      unlockDocument(docId) {
        sendWs({ type: "unlock_document", docId });
      },

      /**
       * Record an activity entry.
       * @param {string} action
       * @param {any} [details]
       */
      recordActivity(action, details) {
        sendWs({ type: "record_activity", action, details });
      },

      /**
       * Clean up all listeners and intervals.
       */
      destroy() {
        state.destroyed = true;
        clearInterval(typingCleanup);
        clearInterval(presenceInterval);
        if (removeListener) removeListener();
        containers.cursors = null;
        containers.typing = null;
        containers.presence = null;
        containers.activity = null;
      },
    };
  }

  // Expose on window
  window.SiskelCollaboration = { initCollaboration };
})();
