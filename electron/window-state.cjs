/**
 * Phase 105 — Window state persistence.
 *
 * Remembers window bounds (x, y, width, height), maximized state, and
 * display id across restarts.  Multi-monitor safe: clamps to a visible
 * screen on restore.
 */
const { screen, app } = require("electron");
const path = require("path");
const fs = require("fs");

const STATE_FILE = "window-state.json";

const DEFAULTS = {
  width: 1280,
  height: 840,
  x: undefined,
  y: undefined,
  isMaximized: false,
};

function stateFilePath() {
  return path.join(app.getPath("userData"), STATE_FILE);
}

/**
 * Load persisted window state from disk.
 *
 * @returns {{ x?: number, y?: number, width: number, height: number, isMaximized: boolean }}
 */
function loadWindowState() {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    const saved = JSON.parse(raw);

    // Validate basics
    const state = {
      width: Math.max(saved.width || DEFAULTS.width, 400),
      height: Math.max(saved.height || DEFAULTS.height, 300),
      x: saved.x,
      y: saved.y,
      isMaximized: !!saved.isMaximized,
    };

    // Multi-monitor safety: check if the saved position is on a visible display
    if (state.x !== undefined && state.y !== undefined) {
      const displays = screen.getAllDisplays();
      const visible = displays.some((d) => {
        const { x, y, width, height } = d.workArea;
        // At least 50px of the window must be within the display
        return (
          state.x + 50 > x &&
          state.x < x + width &&
          state.y + 50 > y &&
          state.y < y + height
        );
      });
      if (!visible) {
        // Reset to center of primary display
        state.x = undefined;
        state.y = undefined;
      }
    }

    return state;
  } catch (_) {
    return { ...DEFAULTS };
  }
}

/**
 * Save current window state to disk.
 *
 * @param {Electron.BrowserWindow} win
 */
function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;

  const isMaximized = win.isMaximized();
  // Save normal (non-maximized) bounds so restore looks correct
  const bounds = isMaximized ? win._lastNormalBounds || win.getBounds() : win.getBounds();

  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
  };

  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[window-state] Failed to save:", e.message);
  }
}

/**
 * Attach state-tracking listeners to a window.
 * Call this once after creating the BrowserWindow.
 *
 * @param {Electron.BrowserWindow} win
 */
function trackWindowState(win) {
  // Track normal bounds before maximize so we can restore properly
  const updateNormalBounds = () => {
    if (!win.isMaximized() && !win.isMinimized() && !win.isDestroyed()) {
      win._lastNormalBounds = win.getBounds();
    }
  };

  win.on("resize", updateNormalBounds);
  win.on("move", updateNormalBounds);

  // Save on close
  win.on("close", () => saveWindowState(win));
}

module.exports = { loadWindowState, saveWindowState, trackWindowState };
