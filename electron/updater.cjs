/**
 * Phase 100 — Auto-updater.
 *
 * Uses electron-updater with GitHub Releases as the update feed.
 * Checks on launch and on a configurable interval
 * (DESKTOP_UPDATE_INTERVAL_HOURS, default 6).
 *
 * In development (non-packaged) builds the updater is a no-op.
 */
const { app, dialog, BrowserWindow } = require("electron");

/** @type {import('electron-updater').AppUpdater | null} */
let autoUpdater = null;
let updateAvailable = false;
let intervalId = null;

function log(msg) {
  if (process.env.DESKTOP_DEBUG) console.log(`[updater] ${msg}`);
}

/**
 * Initialise the auto-updater.  Safe to call in dev — it will
 * silently skip when the app is not packaged.
 */
function initUpdater() {
  if (!app.isPackaged) {
    log("Skipping updater in development mode");
    return;
  }

  try {
    // electron-updater is an optional peer dep — guard the require
    const eu = require("electron-updater");
    autoUpdater = eu.autoUpdater;
  } catch (e) {
    log(`electron-updater not available: ${e.message}`);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => log("Checking for update…"));

  autoUpdater.on("update-available", (info) => {
    updateAvailable = true;
    log(`Update available: ${info.version}`);

    const win = BrowserWindow.getFocusedWindow();
    dialog
      .showMessageBox(win ? win : undefined, {
        type: "info",
        title: "Update Available",
        message: `A new version (${info.version}) is available.`,
        detail: "Would you like to download it now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
  });

  autoUpdater.on("update-not-available", () => {
    updateAvailable = false;
    log("No update available");
  });

  autoUpdater.on("download-progress", (progress) => {
    log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(`Update downloaded: ${info.version}`);
    const win = BrowserWindow.getFocusedWindow();
    dialog
      .showMessageBox(win ? win : undefined, {
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    log(`Update error: ${err.message}`);
  });

  // Initial check (delay 5 s so the window is visible first)
  setTimeout(() => checkForUpdates(), 5000);

  // Periodic checks
  const hours = Math.max(
    1,
    parseInt(process.env.DESKTOP_UPDATE_INTERVAL_HOURS || "6", 10) || 6
  );
  intervalId = setInterval(() => checkForUpdates(), hours * 3600_000);
}

/** Trigger an update check.  Safe to call at any time. */
function checkForUpdates() {
  if (!autoUpdater) {
    log("Updater not initialised (dev mode or missing dependency)");
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    log(`Check failed: ${err.message}`);
  });
}

function isUpdateAvailable() {
  return updateAvailable;
}

function destroyUpdater() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
}

module.exports = { initUpdater, checkForUpdates, isUpdateAvailable, destroyUpdater };
