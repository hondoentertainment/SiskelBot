/**
 * Phase 41.3: Client-side presence renderer.
 *
 * Renders avatar stacks at the top of a document and inline cursor indicators
 * for each remote user. Avatars use deterministic per-userId colors and
 * initials. Tooltips show full name and status.
 *
 * Usage:
 *   const renderer = SiskelPresence.createPresenceRenderer(container, wsManager);
 *   renderer.renderAvatars(users);
 *   renderer.renderCursors(cursors);
 *   renderer.onUserJoin((user) => console.log("joined", user));
 *   renderer.onUserLeave((user) => console.log("left", user));
 *   // later:
 *   renderer.destroy();
 */
(function () {
  "use strict";

  function getAvatarColor(userId) {
    const id = String(userId || "anonymous");
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    return "hsl(" + hue + ", 65%, 50%)";
  }

  function getInitials(name) {
    if (typeof name !== "string") return "?";
    const trimmed = name.trim();
    if (!trimmed) return "?";
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return "?";
    if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
    return (tokens[0][0] + tokens[tokens.length - 1][0]).toUpperCase();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        const v = attrs[k];
        if (k === "style" && v && typeof v === "object") {
          Object.assign(node.style, v);
        } else if (k === "className") {
          node.className = v;
        } else if (k === "text") {
          node.textContent = v;
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    if (Array.isArray(children)) {
      children.forEach((c) => c && node.appendChild(c));
    }
    return node;
  }

  function statusDotColor(status) {
    if (status === "active") return "#3fb950";
    if (status === "idle") return "#d29922";
    if (status === "away") return "#8b949e";
    return "#8b949e";
  }

  function createPresenceRenderer(container, wsManager) {
    if (!container) throw new Error("createPresenceRenderer requires a container element");

    const avatarStrip = el("div", {
      className: "siskel-presence-avatars",
      style: {
        display: "flex",
        flexDirection: "row",
        gap: "4px",
        padding: "6px 8px",
        alignItems: "center",
      },
    });
    const cursorLayer = el("div", {
      className: "siskel-presence-cursors",
      style: { position: "relative", pointerEvents: "none" },
    });
    container.appendChild(avatarStrip);
    container.appendChild(cursorLayer);

    const knownUsers = new Map(); // userId -> last seen user object
    const joinHandlers = [];
    const leaveHandlers = [];

    function renderAvatars(users) {
      avatarStrip.innerHTML = "";
      if (!Array.isArray(users)) return;
      const seen = new Set();

      for (const user of users) {
        if (!user || !user.userId) continue;
        const userId = user.userId;
        const displayName =
          (user.metadata && (user.metadata.displayName || user.metadata.name)) ||
          user.displayName ||
          userId;
        const status = user.status || "active";
        const color =
          (user.avatar && user.avatar.color) || getAvatarColor(userId);
        const initials =
          (user.avatar && user.avatar.initials) || getInitials(displayName);

        seen.add(userId);
        if (!knownUsers.has(userId)) {
          knownUsers.set(userId, user);
          joinHandlers.forEach((fn) => {
            try {
              fn(user);
            } catch (_) {}
          });
        } else {
          knownUsers.set(userId, user);
        }

        const avatar = el("div", {
          className: "siskel-presence-avatar",
          title: displayName + " (" + status + ")",
          "data-user-id": userId,
          "data-status": status,
          style: {
            position: "relative",
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            background: color,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "11px",
            fontWeight: "600",
            fontFamily: "system-ui, sans-serif",
            border: "2px solid #fff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          },
        });
        avatar.textContent = initials;

        const dot = el("span", {
          className: "siskel-presence-status-dot",
          style: {
            position: "absolute",
            bottom: "-2px",
            right: "-2px",
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: statusDotColor(status),
            border: "2px solid #fff",
          },
        });
        avatar.appendChild(dot);
        avatarStrip.appendChild(avatar);
      }

      // Detect leaves
      for (const [userId, user] of Array.from(knownUsers.entries())) {
        if (!seen.has(userId)) {
          knownUsers.delete(userId);
          leaveHandlers.forEach((fn) => {
            try {
              fn(user);
            } catch (_) {}
          });
        }
      }
    }

    function renderCursors(cursors) {
      cursorLayer.innerHTML = "";
      if (!Array.isArray(cursors)) return;
      for (const c of cursors) {
        if (!c || !c.userId || !c.cursor) continue;
        const userId = c.userId;
        const displayName =
          (c.metadata && (c.metadata.displayName || c.metadata.name)) ||
          c.displayName ||
          userId;
        const color = (c.avatar && c.avatar.color) || getAvatarColor(userId);
        const initials = (c.avatar && c.avatar.initials) || getInitials(displayName);

        const top = (Number(c.cursor.line) || 0) * 18;
        const left = (Number(c.cursor.column) || 0) * 8;

        const cursor = el("div", {
          className: "siskel-presence-cursor",
          "data-user-id": userId,
          "data-document-id": c.cursor.documentId || "",
          style: {
            position: "absolute",
            top: top + "px",
            left: left + "px",
            width: "2px",
            height: "16px",
            background: color,
          },
        });
        const label = el("div", {
          className: "siskel-presence-cursor-label",
          style: {
            position: "absolute",
            top: "-14px",
            left: "0",
            background: color,
            color: "#fff",
            fontSize: "9px",
            padding: "1px 4px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
            fontFamily: "system-ui, sans-serif",
            fontWeight: "600",
          },
        });
        label.textContent = initials;
        cursor.appendChild(label);
        cursorLayer.appendChild(cursor);
      }
    }

    // Wire up wsManager events if provided
    let wsHandler = null;
    if (wsManager && typeof wsManager.on === "function") {
      wsHandler = (msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === "presence_join") {
          if (!knownUsers.has(msg.userId)) {
            const user = { userId: msg.userId, status: "active" };
            knownUsers.set(msg.userId, user);
            joinHandlers.forEach((fn) => {
              try {
                fn(user);
              } catch (_) {}
            });
          }
        } else if (msg.type === "presence_leave") {
          const user = knownUsers.get(msg.userId);
          if (user) {
            knownUsers.delete(msg.userId);
            leaveHandlers.forEach((fn) => {
              try {
                fn(user);
              } catch (_) {}
            });
          }
        }
      };
      wsManager.on("message", wsHandler);
    }

    return {
      renderAvatars,
      renderCursors,
      onUserJoin(callback) {
        if (typeof callback === "function") joinHandlers.push(callback);
      },
      onUserLeave(callback) {
        if (typeof callback === "function") leaveHandlers.push(callback);
      },
      destroy() {
        if (wsManager && wsHandler && typeof wsManager.off === "function") {
          wsManager.off("message", wsHandler);
        }
        avatarStrip.remove();
        cursorLayer.remove();
        knownUsers.clear();
        joinHandlers.length = 0;
        leaveHandlers.length = 0;
      },
    };
  }

  const SiskelPresence = {
    createPresenceRenderer,
    getAvatarColor,
    getInitials,
  };

  if (typeof window !== "undefined") {
    window.SiskelPresence = SiskelPresence;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SiskelPresence;
  }
})();
