/**
 * Phase 101 — IPC main-process handlers.
 *
 * Registers ipcMain handlers that match the channels exposed by
 * electron/preload.cjs.
 */
const { ipcMain, app, Notification, nativeTheme } = require("electron");

/**
 * Register all IPC handlers.
 *
 * @param {object} opts
 * @param {() => void}                  [opts.onNewChat]     - new-chat callback
 * @param {(count: number) => void}     [opts.onSetBadge]    - tray badge callback
 * @param {Electron.BrowserWindow|null} [opts.mainWindow]    - for forwarding events
 */
function registerIpcHandlers({ onNewChat, onSetBadge, mainWindow } = {}) {
  // ── Invoke (request / response) ───────────────────────────────────
  ipcMain.handle("desktop:get-version", () => app.getVersion());
  ipcMain.handle("desktop:get-platform", () => process.platform);
  ipcMain.handle("desktop:get-auto-launch", () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  // ── Send (fire-and-forget) ────────────────────────────────────────
  ipcMain.on("desktop:new-chat", () => {
    if (onNewChat) onNewChat();
  });

  ipcMain.on("desktop:set-tray-badge", (_event, count) => {
    if (onSetBadge) onSetBadge(count);
  });

  ipcMain.on("desktop:set-auto-launch", (_event, enabled) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
    } catch (e) {
      console.error("[ipc] setLoginItemSettings failed:", e.message);
    }
  });

  ipcMain.on("desktop:show-notification", (_event, { title, body }) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || app.name, body: body || "" });
      n.on("click", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  });

  // ── Forward OS theme changes to renderer ──────────────────────────
  nativeTheme.on("updated", () => {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:theme-changed", theme);
    }
  });
}

module.exports = { registerIpcHandlers };
