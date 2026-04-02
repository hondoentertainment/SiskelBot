/**
 * Application menu for Siskel Bot desktop.
 */
const { Menu, app, shell, BrowserWindow } = require("electron");

function buildAppMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    // File
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    // Edit
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // View
    {
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
    },
    // Window
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close" }]),
      ],
    },
    // Help
    {
      label: "Help",
      submenu: [
        {
          label: "Documentation",
          click: () => shell.openExternal("https://github.com/hondoentertainment/siskelbot#readme"),
        },
        {
          label: "Report Issue",
          click: () => shell.openExternal("https://github.com/hondoentertainment/siskelbot/issues"),
        },
        { type: "separator" },
        {
          label: "About Siskel Bot",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            const { dialog } = require("electron");
            dialog.showMessageBox(win, {
              type: "info",
              title: "About Siskel Bot",
              message: `Siskel Bot v${app.getVersion()}`,
              detail: "Streaming AI assistant proxy.\n\n© hondoentertainment",
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildAppMenu };
