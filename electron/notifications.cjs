/**
 * Phase 102 — Native notifications bridge.
 *
 * Connects to the server's WebSocket and listens for events that should
 * trigger native OS notifications (new_message, agent_complete,
 * swarm_complete, schedule_fired).
 *
 * Notification preferences are stored in a JSON file under userData.
 * Respects OS Do Not Disturb (Electron handles this automatically).
 */
const { Notification, app } = require("electron");
const { WebSocket } = require("ws");
const path = require("path");
const fs = require("fs");

/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;
let prefsCache = null;

const PREFS_FILE = "notification-prefs.json";
const DEFAULT_PREFS = {
  new_message: true,
  agent_complete: true,
  swarm_complete: true,
  schedule_fired: true,
};

const EVENT_LABELS = {
  new_message: { title: "New Message", body: "You have a new chat message" },
  agent_complete: { title: "Agent Complete", body: "An agent task has finished" },
  swarm_complete: { title: "Swarm Complete", body: "Multi-agent swarm has finished" },
  schedule_fired: { title: "Schedule Fired", body: "A scheduled recipe has executed" },
};

function prefsPath() {
  return path.join(app.getPath("userData"), PREFS_FILE);
}

function loadPrefs() {
  if (prefsCache) return prefsCache;
  try {
    const raw = fs.readFileSync(prefsPath(), "utf8");
    prefsCache = { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch (_) {
    prefsCache = { ...DEFAULT_PREFS };
  }
  return prefsCache;
}

function savePrefs(prefs) {
  prefsCache = { ...DEFAULT_PREFS, ...prefs };
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefsCache, null, 2));
  } catch (e) {
    console.error("[notifications] Failed to save prefs:", e.message);
  }
}

function getPrefs() {
  return loadPrefs();
}

function setPrefs(prefs) {
  savePrefs(prefs);
}

/**
 * Show a native notification for a server event.
 *
 * @param {string} eventType - one of new_message, agent_complete, etc.
 * @param {object} [data]    - optional extra data from the WS message
 * @param {Electron.BrowserWindow} [mainWindow]
 */
function showEventNotification(eventType, data, mainWindow) {
  const prefs = loadPrefs();
  if (!prefs[eventType]) return;
  if (!Notification.isSupported()) return;

  const label = EVENT_LABELS[eventType] || { title: eventType, body: "" };
  const title = data?.title || label.title;
  const body = data?.body || data?.message || label.body;

  const n = new Notification({ title, body });
  n.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  n.show();
}

/**
 * Connect to the server WebSocket and subscribe to notification events.
 *
 * @param {string} serverBaseUrl - e.g. "http://127.0.0.1:38447"
 * @param {Electron.BrowserWindow} mainWindow
 */
function connectNotificationWs(serverBaseUrl, mainWindow) {
  if (ws) return;

  const wsUrl = serverBaseUrl.replace(/^http/, "ws") + "/ws";

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      // Subscribe to notification events
      try {
        ws.send(JSON.stringify({ type: "subscribe", channels: ["notifications"] }));
      } catch (_) {
        /* best effort */
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const eventType = msg.event || msg.type;
        if (eventType && EVENT_LABELS[eventType]) {
          showEventNotification(eventType, msg, mainWindow);
        }
      } catch (_) {
        /* ignore non-JSON */
      }
    });

    ws.on("close", () => {
      ws = null;
      scheduleReconnect();
    });

    ws.on("error", () => {
      try { ws?.close(); } catch (_) { /* ignore */ }
      ws = null;
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!ws) connect();
    }, 5000);
  }

  connect();
}

function disconnectNotificationWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) { /* ignore */ }
    ws = null;
  }
}

module.exports = {
  connectNotificationWs,
  disconnectNotificationWs,
  showEventNotification,
  getPrefs,
  setPrefs,
};
