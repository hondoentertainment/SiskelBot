/**
 * Phase 101 — IPC bridge & preload.
 *
 * Exposes a minimal, safe `window.siskelDesktop` API to the renderer
 * via contextBridge.  The main process registers matching ipcMain
 * handlers in electron/ipc-handlers.cjs.
 *
 * Security:
 *  - contextIsolation = true
 *  - sandbox = true
 *  - nodeIntegration = false
 *  - Only whitelisted channels are exposed
 */
const { contextBridge, ipcRenderer } = require("electron");

// Allowed IPC channels (documented for security review):
// Send:    desktop:new-chat, desktop:set-tray-badge, desktop:set-auto-launch, desktop:show-notification
// Invoke:  desktop:get-version, desktop:get-platform, desktop:get-auto-launch
// Receive: desktop:deep-link, desktop:update-available, desktop:theme-changed

contextBridge.exposeInMainWorld("siskelDesktop", {
  /** App version from package.json */
  getVersion: () => ipcRenderer.invoke("desktop:get-version"),

  /** Platform string: "win32" | "darwin" | "linux" */
  getPlatform: () => ipcRenderer.invoke("desktop:get-platform"),

  /** Get current auto-launch setting */
  getAutoLaunch: () => ipcRenderer.invoke("desktop:get-auto-launch"),

  /** Enable or disable launch on login */
  setAutoLaunch: (enabled) =>
    ipcRenderer.send("desktop:set-auto-launch", !!enabled),

  /** Show a native OS notification */
  showNativeNotification: (title, body) =>
    ipcRenderer.send("desktop:show-notification", { title, body }),

  /** Update the tray badge count */
  setTrayBadge: (count) =>
    ipcRenderer.send("desktop:set-tray-badge", Number(count) || 0),

  /** Request a new chat (tells main process) */
  newChat: () => ipcRenderer.send("desktop:new-chat"),

  /**
   * Listen for deep-link URLs forwarded from the main process.
   * Returns an unsubscribe function.
   */
  onDeepLink: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on("desktop:deep-link", handler);
    return () => ipcRenderer.removeListener("desktop:deep-link", handler);
  },

  /**
   * Listen for theme changes from the OS.
   * Returns an unsubscribe function.
   */
  onThemeChanged: (callback) => {
    const handler = (_event, theme) => callback(theme);
    ipcRenderer.on("desktop:theme-changed", handler);
    return () => ipcRenderer.removeListener("desktop:theme-changed", handler);
  },

  /**
   * Listen for update-available events.
   * Returns an unsubscribe function.
   */
  onUpdateAvailable: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on("desktop:update-available", handler);
    return () =>
      ipcRenderer.removeListener("desktop:update-available", handler);
  },
});
