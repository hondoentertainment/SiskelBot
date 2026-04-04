/**
 * Phase 103 — Deep linking & protocol handler.
 *
 * Registers the `siskelbot://` custom protocol.
 * Supported routes:
 *   siskelbot://chat?prompt=...
 *   siskelbot://workspace/<id>
 *   siskelbot://recipe/<name>
 *
 * On macOS uses `open-url` event.
 * On Windows/Linux the URL comes via process.argv on second-instance.
 */
const { app } = require("electron");

const PROTOCOL = "siskelbot";

/**
 * Register the protocol with the OS.
 * Must be called before app.whenReady().
 */
function registerProtocol() {
  if (process.defaultApp) {
    // Dev mode: register with the script path
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        process.argv[1],
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/**
 * Parse a siskelbot:// URL into a route object.
 *
 * @param {string} url - e.g. "siskelbot://chat?prompt=hello"
 * @returns {{ action: string, params: Record<string, string> } | null}
 */
function parseDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return null;

  try {
    // URL constructor needs a valid scheme — siskelbot:// works
    const parsed = new URL(url);
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
    const params = Object.fromEntries(parsed.searchParams.entries());

    // Handle path segments: siskelbot://workspace/abc → action="workspace", params.id="abc"
    const pathParts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (pathParts.length > 0 && !params.id) {
      params.id = pathParts[0];
    }

    return { action, params };
  } catch (_) {
    return null;
  }
}

/**
 * Navigate the main window based on a deep link.
 *
 * @param {Electron.BrowserWindow} mainWindow
 * @param {string} serverBaseUrl
 * @param {string} url - the siskelbot:// URL
 */
function handleDeepLink(mainWindow, serverBaseUrl, url) {
  const link = parseDeepLink(url);
  if (!link) return;

  // Show and focus the window
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  // Forward to renderer via IPC
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:deep-link", url);
  }

  // Also navigate the window for known routes
  switch (link.action) {
    case "chat": {
      const prompt = link.params.prompt || "";
      const target = prompt
        ? `${serverBaseUrl}/?prompt=${encodeURIComponent(prompt)}`
        : `${serverBaseUrl}/`;
      mainWindow?.loadURL(target);
      break;
    }
    case "workspace": {
      if (link.params.id) {
        mainWindow?.loadURL(`${serverBaseUrl}/?workspace=${encodeURIComponent(link.params.id)}`);
      }
      break;
    }
    case "recipe": {
      const name = link.params.id || link.params.name || "";
      if (name) {
        mainWindow?.loadURL(`${serverBaseUrl}/?recipe=${encodeURIComponent(name)}`);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Extract a siskelbot:// URL from argv (Windows/Linux second-instance).
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
function extractDeepLinkFromArgv(argv) {
  for (const arg of argv) {
    if (arg.startsWith(`${PROTOCOL}://`)) return arg;
  }
  return null;
}

module.exports = {
  PROTOCOL,
  registerProtocol,
  parseDeepLink,
  handleDeepLink,
  extractDeepLinkFromArgv,
};
