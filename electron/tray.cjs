/**
 * System tray support for Siskel Bot desktop.
 * Allows minimizing to tray to keep the local server running.
 */
const { Tray, Menu, nativeImage, app } = require("electron");
const path = require("path");

/** @type {Tray | null} */
let tray = null;

/**
 * Create the system tray icon and context menu.
 * @param {import('electron').BrowserWindow} mainWindow
 * @param {{ serverPort: number }} opts
 */
function createTray(mainWindow, opts) {
  // Use a small icon — ideally 16x16 or 22x22 PNG.
  // Falls back to a 1x1 transparent PNG if no icon file exists.
  let iconPath;
  if (app.isPackaged) {
    iconPath = path.join(process.resourcesPath, "tray-icon.png");
  } else {
    iconPath = path.join(__dirname, "..", "build", "tray-icon.png");
  }

  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("empty");
  } catch {
    // Fallback: tiny transparent icon
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip(`Siskel Bot — localhost:${opts.serverPort}`);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Siskel Bot",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: `Server: http://127.0.0.1:${opts.serverPort}`,
      enabled: false,
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

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Minimize to tray instead of closing (on Windows/Linux)
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
