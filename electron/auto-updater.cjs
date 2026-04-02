/**
 * Auto-updater for Siskel Bot desktop app.
 * Uses electron-updater to check GitHub Releases for new versions.
 */
const { autoUpdater } = require("electron-updater");
const { dialog, BrowserWindow } = require("electron");

let updateNotificationShown = false;

function initAutoUpdater() {
  // Don't check for updates in dev mode
  const { app } = require("electron");
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    if (updateNotificationShown) return;
    updateNotificationShown = true;

    const win = BrowserWindow.getFocusedWindow();
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "Update Available",
        message: `Siskel Bot v${info.version} is available. Download now?`,
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
        }
        updateNotificationShown = false;
      });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const win = BrowserWindow.getFocusedWindow();
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "Update Ready",
        message: `Siskel Bot v${info.version} has been downloaded. Restart to apply?`,
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall(false, true);
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[auto-updater]", err.message);
  });

  // Check after a brief delay to not slow down startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 10000);
}

module.exports = { initAutoUpdater };
