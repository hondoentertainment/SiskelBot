/**
 * Phase 98 — System tray.
 *
 * Minimise-to-tray on window close (opt-in via DESKTOP_CLOSE_TO_TRAY=1).
 * Tray icon with context menu: Show/Hide, New Chat, Quit.
 * Badge dot for unread notifications (called from main process).
 */
const { Tray, Menu, nativeImage, app } = require("electron");
const path = require("path");

/** @type {Tray | null} */
let tray = null;
// hasBadge state is tracked via tooltip/dock badge in setTrayBadge

/**
 * Build a simple 16×16 tray icon programmatically so the app works
 * even without an icon file on disk.  If `build/icon.png` exists it
 * is preferred.
 */
function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "..", "build", "tray-icon.png"),
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    } catch (_) {
      /* ignore */
    }
  }
  // Fallback: 16×16 blue square
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x25; // R
    buf[i * 4 + 1] = 0x63; // G
    buf[i * 4 + 2] = 0xeb; // B
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function buildContextMenu(mainWindow, { onNewChat } = {}) {
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return Menu.buildFromTemplate([
    {
      label: visible ? "Hide" : "Show",
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "New Chat",
      click: () => {
        if (onNewChat) onNewChat();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Create or return the singleton tray.
 *
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} opts
 * @param {() => void} [opts.onNewChat]
 * @returns {Tray}
 */
function createTray(mainWindow, opts = {}) {
  if (tray && !tray.isDestroyed()) return tray;

  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip(app.name);
  tray.setContextMenu(buildContextMenu(mainWindow, opts));

  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Rebuild context menu when window visibility changes
  const refresh = () => {
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(buildContextMenu(mainWindow, opts));
    }
  };
  mainWindow.on("show", refresh);
  mainWindow.on("hide", refresh);

  return tray;
}

/**
 * Show or clear a notification badge on the tray icon.
 * On macOS this sets the dock badge; elsewhere it updates the tooltip.
 */
function setTrayBadge(count) {
  if (process.platform === "darwin") {
    app.dock?.setBadge(count > 0 ? String(count) : "");
  }
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(count > 0 ? `${app.name} (${count} new)` : app.name);
  }
}

function getTray() {
  return tray;
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { createTray, setTrayBadge, getTray, destroyTray };
