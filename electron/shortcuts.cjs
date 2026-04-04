/**
 * Phase 104 — Keyboard shortcuts (global & local).
 *
 * Global hotkey to summon the window (DESKTOP_GLOBAL_HOTKEY, default CmdOrCtrl+Shift+S).
 * Local accelerators are handled via the menu (Phase 97) but this module
 * adds extra in-app shortcuts via the webContents before-input-event.
 */
const { globalShortcut } = require("electron");

const DEFAULT_GLOBAL_HOTKEY = "CmdOrCtrl+Shift+S";

/** @type {string | null} */
let registeredHotkey = null;

/**
 * Register the global summon hotkey.
 *
 * @param {Electron.BrowserWindow} mainWindow
 * @param {string} [hotkey] - Electron accelerator string
 */
function registerGlobalShortcuts(mainWindow, hotkey) {
  const accel = hotkey || process.env.DESKTOP_GLOBAL_HOTKEY || DEFAULT_GLOBAL_HOTKEY;

  try {
    const ok = globalShortcut.register(accel, () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    if (ok) {
      registeredHotkey = accel;
    } else {
      console.warn(`[shortcuts] Failed to register global hotkey: ${accel}`);
    }
  } catch (e) {
    console.warn(`[shortcuts] Error registering hotkey: ${e.message}`);
  }
}

/**
 * Register local (in-app) keyboard shortcuts via before-input-event.
 * These fire even when the menu doesn't have focus (e.g. inside the webview).
 *
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} opts
 * @param {() => void}  [opts.onNewChat]     - Ctrl+N
 * @param {string}       opts.serverBaseUrl
 */
function registerLocalShortcuts(mainWindow, { serverBaseUrl } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const ctrlOrCmd = input.control || input.meta;

    // Ctrl+L — clear chat (reload page)
    if (ctrlOrCmd && !input.shift && !input.alt && input.key === "l") {
      mainWindow.loadURL(`${serverBaseUrl || ""}/`);
      _event.preventDefault();
      return;
    }

    // Ctrl+K — command palette (forward to renderer)
    if (ctrlOrCmd && !input.shift && !input.alt && input.key === "k") {
      mainWindow.webContents.send("desktop:shortcut", "command-palette");
      return;
    }

    // Ctrl+, — settings (forward to renderer)
    if (ctrlOrCmd && !input.shift && !input.alt && input.key === ",") {
      mainWindow.webContents.send("desktop:shortcut", "settings");
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle conversations (forward to renderer)
    if (ctrlOrCmd && input.key === "Tab") {
      const direction = input.shift ? "prev" : "next";
      mainWindow.webContents.send("desktop:shortcut", `cycle-${direction}`);
      return;
    }
  });
}

function unregisterGlobalShortcuts() {
  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch (_) {
      /* ignore */
    }
    registeredHotkey = null;
  }
}

function unregisterAll() {
  unregisterGlobalShortcuts();
}

module.exports = {
  registerGlobalShortcuts,
  registerLocalShortcuts,
  unregisterGlobalShortcuts,
  unregisterAll,
};
