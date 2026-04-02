/**
 * Security hardening for Siskel Bot desktop shell.
 * Restricts permissions, navigation, and web features.
 */
const { session, app } = require("electron");

/**
 * Apply security policies to the default session.
 * Call once after app is ready.
 * @param {{ serverPort: number }} opts
 */
function applySecurity(opts) {
  const allowedOrigin = `http://127.0.0.1:${opts.serverPort}`;

  // Block permission requests (camera, mic, geolocation, notifications, etc.)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["clipboard-read", "clipboard-sanitized-write"];
      callback(allowed.includes(permission));
    }
  );

  // Block permission checks for same permissions
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      const allowed = ["clipboard-read", "clipboard-sanitized-write"];
      return allowed.includes(permission);
    }
  );

  // Restrict new window creation
  app.on("web-contents-created", (_event, contents) => {
    // Block navigation away from the app
    contents.on("will-navigate", (event, url) => {
      const parsed = new URL(url);
      if (parsed.origin !== new URL(allowedOrigin).origin) {
        event.preventDefault();
      }
    });

    // Block new window creation except for external links (handled by setWindowOpenHandler)
    contents.setWindowOpenHandler(({ url }) => {
      const { shell } = require("electron");
      // Only open http/https URLs externally
      if (url.startsWith("http://") || url.startsWith("https://")) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });
  });
}

/**
 * Return a Content-Security-Policy header value for the local app.
 * @param {number} serverPort
 * @returns {string}
 */
function getCSPHeader(serverPort) {
  const origin = `http://127.0.0.1:${serverPort}`;
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' 'unsafe-inline' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `connect-src 'self' ${origin} ws://127.0.0.1:${serverPort}`,
    `img-src 'self' ${origin} data: blob:`,
    `font-src 'self' ${origin} data:`,
    `media-src 'self' ${origin} blob:`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join("; ");
}

module.exports = { applySecurity, getCSPHeader };
