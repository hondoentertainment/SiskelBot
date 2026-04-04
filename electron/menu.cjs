/**
 * Phase 97 — Native menu bar.
 *
 * File / Edit / View / Help menus with platform-aware accelerators.
 * macOS gets the standard app menu as the first entry.
 */
const { Menu, app, shell, BrowserWindow, dialog } = require("electron");
const path = require("path");

/**
 * @param {object} opts
 * @param {() => void}  opts.onNewChat       - callback to open a new chat
 * @param {() => void}  opts.onCheckUpdates  - callback to trigger update check
 * @param {string}      opts.serverBaseUrl   - e.g. "http://127.0.0.1:38447"
 */
function buildMenu({ onNewChat, onCheckUpdates, serverBaseUrl } = {}) {
  const isMac = process.platform === "darwin";

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [];

  // ── macOS app menu ──────────────────────────────────────────────────
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        ...(onCheckUpdates
          ? [
              { label: "Check for Updates…", click: onCheckUpdates },
              { type: "separator" },
            ]
          : []),
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  // ── File ────────────────────────────────────────────────────────────
  template.push({
    label: "File",
    submenu: [
      {
        label: "New Chat",
        accelerator: "CmdOrCtrl+N",
        click: () => {
          if (onNewChat) return onNewChat();
          const win = BrowserWindow.getFocusedWindow();
          if (win) win.loadURL(`${serverBaseUrl || ""}/`);
        },
      },
      { type: "separator" },
      {
        label: "Open Data Folder",
        click: () => {
          const dataDir = path.join(app.getPath("userData"), "data");
          shell.openPath(dataDir);
        },
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  });

  // ── Edit ────────────────────────────────────────────────────────────
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? [
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
          ]
        : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
    ],
  });

  // ── View ────────────────────────────────────────────────────────────
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  // ── Help ────────────────────────────────────────────────────────────
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const helpItems = [
    {
      label: "Documentation",
      click: () =>
        shell.openExternal(
          "https://github.com/hondoentertainment/SiskelBot#readme"
        ),
    },
    {
      label: "Report Issue",
      click: () =>
        shell.openExternal(
          "https://github.com/hondoentertainment/SiskelBot/issues"
        ),
    },
  ];

  if (!isMac && onCheckUpdates) {
    helpItems.push(
      { type: "separator" },
      { label: "Check for Updates…", click: onCheckUpdates }
    );
  }

  if (!isMac) {
    helpItems.push(
      { type: "separator" },
      {
        label: `About ${app.name}`,
        click: () => {
          dialog.showMessageBox({
            type: "info",
            title: `About ${app.name}`,
            message: app.name,
            detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChromium ${process.versions.chrome}`,
          });
        },
      }
    );
  }

  template.push({ label: "Help", submenu: helpItems });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { buildMenu };
