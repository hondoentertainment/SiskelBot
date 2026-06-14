/**
 * Regression guard: @vercel/node must trace dynamic imports that load the main app.
 * Using `import(new URL("./lib/...", import.meta.url).href)` produced absolute file://
 * specifiers that were not packaged under /var/task → ERR_MODULE_NOT_FOUND at cold start.
 *
 * Production entries use no query on `server.js`, so imports stay static strings for the bundler.
 * Tests load `server.js?test=…`; `bootSearch` must be forwarded so server-configured-app is not an
 * env-frozen process singleton across loadApp() calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER_JS = fileURLToPath(new URL("../server.js", import.meta.url));

test("server.js uses relative dynamic imports for Vercel bundling", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  assert.ok(src.includes("bootSearch"), "expected bootSearch from import.meta.url");
  assert.ok(
    src.includes('? await import("./lib/server-configured-app.js")'),
    "expected static-string import branch for prod (Vercel bundler)",
  );
  assert.ok(
    src.includes(': await import(`./lib/server-configured-app.js${bootSearch}`)'),
    "expected query-forwarded import branch for tests",
  );
  assert.ok(
    src.includes('? await import("./lib/server-production-listener.js")'),
    "expected static-string listener import branch for prod",
  );
  assert.ok(
    src.includes(': await import(`./lib/server-production-listener.js${bootSearch}`)'),
    "expected query-forwarded listener import branch for tests",
  );
  assert.ok(
    !src.includes("configuredModuleUrl.href"),
    "do not use file-URL href for server-configured-app (breaks Vercel packaging)",
  );
  assert.ok(
    !src.includes("listenerModuleUrl.href"),
    "do not use file-URL href for server-production-listener (breaks Vercel packaging)",
  );
});
