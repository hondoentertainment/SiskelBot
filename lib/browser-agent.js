// @ts-check
/* global document */
/**
 * Phase 55.2: Browser agent — Playwright/Puppeteer wrapper with safety rails.
 *
 * A pluggable driver interface compatible with Playwright and Puppeteer APIs.
 * A mock driver is included for tests; real Playwright/Puppeteer drivers can be
 * wired in at runtime via `registerDriver`. URL allowlists/blocklists guard
 * every navigation, and sandboxed script execution blocks dangerous patterns.
 *
 * Storage: JSON-backed via `json-path-store.js` so sessions and recordings
 * persist across file, SQLite, and Postgres KV backends.
 *
 * @module browser-agent
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

// ---- Driver registry ----

const drivers = new Map();

/**
 * Register a browser driver factory by name.
 * @param {string} name
 * @param {object} driverFactory - driver object implementing at least { newPage() }
 */
export function registerDriver(name, driverFactory) {
  if (!name || typeof name !== "string") {
    throw new Error("driver name is required");
  }
  if (!driverFactory || typeof driverFactory !== "object") {
    throw new Error("driverFactory must be an object");
  }
  if (typeof driverFactory.newPage !== "function") {
    throw new Error("driverFactory must implement newPage()");
  }
  drivers.set(name, driverFactory);
}

/**
 * Retrieve a registered driver by name.
 * @param {string} name
 * @returns {object|null}
 */
export function getDriver(name) {
  if (!name) return null;
  return drivers.get(name) || null;
}

/**
 * List names of all currently registered drivers.
 * @returns {string[]}
 */
export function listDrivers() {
  return Array.from(drivers.keys());
}

/**
 * Clear all registered drivers (test helper).
 */
export function _clearDrivers() {
  drivers.clear();
}

// ---- Mock driver (for tests and default) ----

export const mockDriver = {
  name: "mock",
  async newPage() {
    let closed = false;
    let currentUrl = "about:blank";
    const history = [];
    const ensureOpen = () => {
      if (closed) throw new Error("page is closed");
    };
    return {
      _mock: true,
      async goto(url) {
        ensureOpen();
        history.push(currentUrl);
        currentUrl = url;
        return { status: 200, url };
      },
      async title() {
        ensureOpen();
        return "Mock Page";
      },
      async content() {
        ensureOpen();
        return "<html><body>mock</body></html>";
      },
      async click(selector) {
        ensureOpen();
        return { success: true, selector };
      },
      async type(selector, text) {
        ensureOpen();
        return { success: true, selector, length: String(text || "").length };
      },
      async waitForSelector(selector, _opts) {
        ensureOpen();
        return { found: true, selector };
      },
      async screenshot() {
        ensureOpen();
        return Buffer.from("mock-png");
      },
      async evaluate(_fn) {
        ensureOpen();
        return null;
      },
      async url() {
        ensureOpen();
        return currentUrl;
      },
      async goBack() {
        ensureOpen();
        if (history.length > 0) {
          currentUrl = /** @type {string} */ (history.pop());
        }
        return { url: currentUrl };
      },
      async goForward() {
        ensureOpen();
        return { url: currentUrl };
      },
      async reload() {
        ensureOpen();
        return { url: currentUrl, status: 200 };
      },
      async close() {
        closed = true;
      },
      isClosed() {
        return closed;
      },
    };
  },
};

// Register the mock driver at module load so it is available by default.
registerDriver("mock", mockDriver);

// ---- URL allowlist / blocklist ----

export const URL_ALLOWLIST = process.env.BROWSER_AGENT_ALLOWLIST
  ? process.env.BROWSER_AGENT_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const URL_BLOCKLIST = ["file://", "chrome://", "javascript:", "data:", "about:"];

/**
 * Check whether a URL is permitted by the allowlist/blocklist policy.
 * @param {string} url
 * @param {{ allowlist?: string[], blocklist?: string[] }} [options]
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkUrlAllowed(url, options = {}) {
  if (!url || typeof url !== "string") {
    return { allowed: false, reason: "url must be a non-empty string" };
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return { allowed: false, reason: "url is empty" };
  }
  const lower = trimmed.toLowerCase();

  const blocklist = Array.isArray(options.blocklist) && options.blocklist.length
    ? options.blocklist
    : URL_BLOCKLIST;
  for (const entry of blocklist) {
    if (!entry) continue;
    if (lower.startsWith(String(entry).toLowerCase())) {
      return { allowed: false, reason: `blocked by blocklist: ${entry}` };
    }
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return { allowed: false, reason: "invalid url" };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { allowed: false, reason: `protocol not permitted: ${protocol}` };
  }

  const allowlist = Array.isArray(options.allowlist) ? options.allowlist : URL_ALLOWLIST;
  if (allowlist && allowlist.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const matched = allowlist.some((entry) => {
      if (!entry) return false;
      const e = String(entry).trim().toLowerCase();
      if (!e) return false;
      if (e === host) return true;
      if (host.endsWith("." + e)) return true;
      if (e.startsWith("http://") || e.startsWith("https://")) {
        return lower.startsWith(e);
      }
      return false;
    });
    if (!matched) {
      return { allowed: false, reason: `host not in allowlist: ${parsed.hostname}` };
    }
  }
  return { allowed: true };
}

// ---- Page actions ----

function resolveDriver(name) {
  const driverName = name || "mock";
  const driver = getDriver(driverName);
  if (!driver) {
    throw new Error(`driver not registered: ${driverName}`);
  }
  return driver;
}

/**
 * Open a new page and optionally navigate to a URL.
 * @param {string} url
 * @param {{ driver?: string, viewport?: object, userAgent?: string, allowlist?: string[], blocklist?: string[] }} [options]
 */
export async function openPage(url, options = {}) {
  const check = checkUrlAllowed(url, options);
  if (!check.allowed) {
    throw new Error(`url not allowed: ${check.reason}`);
  }
  const driver = resolveDriver(options.driver);
  const page = await driver.newPage(options);
  try {
    const result = await page.goto(url);
    return { page, result };
  } catch (err) {
    try {
      await page.close();
    } catch (_) {}
    throw err;
  }
}

export async function clickElement(page, selector, options = {}) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  return page.click(selector, options);
}

export async function typeInField(page, selector, text, options = {}) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  if (typeof text !== "string") {
    throw new Error("text must be a string");
  }
  return page.type(selector, text, options);
}

/**
 * Wait for a condition — either a selector string or { selector, timeout }.
 */
export async function waitFor(page, condition, options = {}) {
  if (!page) throw new Error("page is required");
  if (!condition) throw new Error("condition is required");
  if (typeof condition === "string") {
    return page.waitForSelector(condition, options);
  }
  if (typeof condition === "object" && condition.selector) {
    return page.waitForSelector(condition.selector, { ...options, ...condition });
  }
  throw new Error("condition must be a selector string or object with .selector");
}

export async function extractText(page, selector) {
  if (!page) throw new Error("page is required");
  if (typeof page.evaluate !== "function") {
    throw new Error("page does not support evaluate");
  }
  try {
    const result = await page.evaluate((sel) => {
      if (!sel) return null;
      if (typeof document === "undefined") return null;
      const el = document.querySelector(sel);
      return el ? el.textContent : null;
    }, selector);
    return result;
  } catch (_) {
    // Mock page evaluate returns null; fall back to a deterministic stub.
    if (page._mock) return null;
    throw _;
  }
}

export async function extractAttribute(page, selector, attr) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  if (!attr || typeof attr !== "string") {
    throw new Error("attr must be a non-empty string");
  }
  if (typeof page.evaluate !== "function") {
    throw new Error("page does not support evaluate");
  }
  try {
    const result = await page.evaluate(
      (sel, a) => {
        if (typeof document === "undefined") return null;
        const el = document.querySelector(sel);
        return el ? el.getAttribute(a) : null;
      },
      selector,
      attr,
    );
    return result;
  } catch (_) {
    if (page._mock) return null;
    throw _;
  }
}

export async function screenshot(page, options = {}) {
  if (!page) throw new Error("page is required");
  const buf = await page.screenshot(options);
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf);
  if (typeof buf === "string") return Buffer.from(buf);
  return Buffer.from(String(buf || ""));
}

export async function closePage(page) {
  if (!page) return;
  if (typeof page.close === "function") {
    await page.close();
  }
}

// ---- Navigation ----

export async function navigate(page, url) {
  if (!page) throw new Error("page is required");
  const check = checkUrlAllowed(url);
  if (!check.allowed) {
    throw new Error(`url not allowed: ${check.reason}`);
  }
  return page.goto(url);
}

export async function back(page) {
  if (!page) throw new Error("page is required");
  if (typeof page.goBack !== "function") {
    throw new Error("page does not support back navigation");
  }
  return page.goBack();
}

export async function forward(page) {
  if (!page) throw new Error("page is required");
  if (typeof page.goForward !== "function") {
    throw new Error("page does not support forward navigation");
  }
  return page.goForward();
}

export async function reload(page) {
  if (!page) throw new Error("page is required");
  if (typeof page.reload !== "function") {
    throw new Error("page does not support reload");
  }
  return page.reload();
}

// ---- Session store ----

function sessionStorePath() {
  return join(getDataDir(), "browser-agent-sessions.json");
}

function normalizeSessionStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    sessions: base.sessions && typeof base.sessions === "object" ? base.sessions : {},
    recordings: base.recordings && typeof base.recordings === "object" ? base.recordings : {},
  };
}

async function loadSessionStore() {
  return normalizeSessionStore(
    await readJsonPath(sessionStorePath(), { _version: STORE_VERSION, sessions: {}, recordings: {} }),
  );
}

async function saveSessionStore(store) {
  await writeJsonPath(sessionStorePath(), store);
}

async function mutateSessions(fn) {
  return withPathLock(sessionStorePath(), async () => {
    const store = await loadSessionStore();
    const result = await fn(store);
    await saveSessionStore(store);
    return result;
  });
}

// In-process page handles keyed by sessionId so routes can reuse them.
const pageHandles = new Map();

export function _getPageHandle(sessionId) {
  return pageHandles.get(sessionId) || null;
}

export function _setPageHandle(sessionId, page) {
  if (page) pageHandles.set(sessionId, page);
  else pageHandles.delete(sessionId);
}

/**
 * Create a durable browser session record.
 * @param {string} name
 * @param {{ driver?: string, url?: string, viewport?: object, userAgent?: string }} [options]
 */
export async function createBrowserSession(name, options = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  const id = `bsession_${randomUUID()}`;
  const driverName = options.driver || "mock";
  if (!getDriver(driverName)) {
    throw new Error(`driver not registered: ${driverName}`);
  }
  const createdAt = Date.now();
  const session = {
    id,
    name,
    driver: driverName,
    viewport: options.viewport || null,
    userAgent: options.userAgent || null,
    url: options.url || null,
    status: "created",
    recording: false,
    createdAt,
    updatedAt: createdAt,
  };
  await mutateSessions((store) => {
    store.sessions[id] = session;
  });

  // If a starting URL was provided, validate and open a page eagerly so that
  // subsequent calls can reuse the in-process handle.
  if (options.url) {
    const check = checkUrlAllowed(options.url);
    if (!check.allowed) {
      // Persist the session but mark it as errored so callers can inspect it.
      await mutateSessions((store) => {
        if (store.sessions[id]) {
          store.sessions[id].status = "error";
          store.sessions[id].error = `url not allowed: ${check.reason}`;
          store.sessions[id].updatedAt = Date.now();
        }
      });
      throw new Error(`url not allowed: ${check.reason}`);
    }
    try {
      const { page } = await openPage(options.url, options);
      pageHandles.set(id, page);
      await mutateSessions((store) => {
        if (store.sessions[id]) {
          store.sessions[id].status = "open";
          store.sessions[id].updatedAt = Date.now();
        }
      });
    } catch (err) {
      await mutateSessions((store) => {
        if (store.sessions[id]) {
          store.sessions[id].status = "error";
          store.sessions[id].error = err?.message || "open failed";
          store.sessions[id].updatedAt = Date.now();
        }
      });
      throw err;
    }
  }
  return session;
}

export async function getBrowserSession(sessionId) {
  if (!sessionId) return null;
  const store = await loadSessionStore();
  return store.sessions[sessionId] || null;
}

export async function closeBrowserSession(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  const page = pageHandles.get(sessionId);
  if (page) {
    try {
      await closePage(page);
    } catch (_) {}
    pageHandles.delete(sessionId);
  }
  return mutateSessions((store) => {
    const existing = store.sessions[sessionId];
    if (!existing) return null;
    existing.status = "closed";
    existing.updatedAt = Date.now();
    return existing;
  });
}

export async function listBrowserSessions() {
  const store = await loadSessionStore();
  return Object.values(store.sessions).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ---- High-level workflows ----

/**
 * Fill a form by typing into each selector in formData.
 * @param {object} page
 * @param {Record<string, string>} formData
 */
export async function fillForm(page, formData) {
  if (!page) throw new Error("page is required");
  if (!formData || typeof formData !== "object") {
    throw new Error("formData must be an object");
  }
  const results = [];
  for (const [selector, value] of Object.entries(formData)) {
    const text = value == null ? "" : String(value);
    const r = await page.type(selector, text);
    results.push({ selector, ok: true, result: r });
  }
  return { filled: results.length, results };
}

export async function extractTable(page, selector) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  try {
    const rows = await page.evaluate((sel) => {
      if (typeof document === "undefined") return [];
      const table = document.querySelector(sel);
      if (!table) return [];
      const out = [];
      const trs = table.querySelectorAll("tr");
      for (const tr of trs) {
        const cells = [];
        for (const cell of tr.querySelectorAll("th,td")) {
          cells.push(cell.textContent ? cell.textContent.trim() : "");
        }
        out.push(cells);
      }
      return out;
    }, selector);
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    if (page._mock) return [];
    throw _;
  }
}

export async function downloadFile(page, url) {
  if (!page) throw new Error("page is required");
  const check = checkUrlAllowed(url);
  if (!check.allowed) {
    throw new Error(`url not allowed: ${check.reason}`);
  }
  // Drivers may implement .download() or fall back to navigation.
  if (typeof page.download === "function") {
    return page.download(url);
  }
  return { ok: true, url, bytes: 0, note: "download not implemented in driver" };
}

export async function uploadFile(page, selector, filepath) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  if (!filepath || typeof filepath !== "string") {
    throw new Error("filepath must be a non-empty string");
  }
  if (typeof page.setInputFiles === "function") {
    return page.setInputFiles(selector, filepath);
  }
  if (typeof page.uploadFile === "function") {
    return page.uploadFile(selector, filepath);
  }
  return { ok: true, selector, filepath, note: "upload not implemented in driver" };
}

export async function scrollTo(page, selector) {
  if (!page) throw new Error("page is required");
  if (!selector || typeof selector !== "string") {
    throw new Error("selector must be a non-empty string");
  }
  try {
    await page.evaluate((sel) => {
      if (typeof document === "undefined") return false;
      const el = document.querySelector(sel);
      if (!el) return false;
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
      return true;
    }, selector);
    return { ok: true, selector };
  } catch (_) {
    if (page._mock) return { ok: true, selector };
    throw _;
  }
}

export async function handleDialog(page, action = "accept") {
  if (!page) throw new Error("page is required");
  const normalized = String(action || "accept").toLowerCase();
  if (normalized !== "accept" && normalized !== "dismiss") {
    throw new Error("action must be 'accept' or 'dismiss'");
  }
  if (typeof page.on === "function") {
    page.on("dialog", async (dialog) => {
      try {
        if (normalized === "accept") await dialog.accept();
        else await dialog.dismiss();
      } catch (_) {}
    });
  }
  return { ok: true, action: normalized };
}

// ---- Sandboxed script execution ----

const SCRIPT_BLOCKLIST = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\brequire\s*\(/,
  /\bprocess\b/,
  /\bchild_process\b/,
  /\bfs\b\s*\./,
  /\bimport\s*\(/,
  /\bglobalThis\b/,
  /\bWebAssembly\b/,
  /\bXMLHttpRequest\b/,
  /\bfetch\s*\(/,
  /\bdocument\.cookie\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
];

/**
 * Validate code against the script blocklist.
 * @param {string} code
 * @returns {{ safe: boolean, reason?: string }}
 */
export function validateScript(code) {
  if (!code || typeof code !== "string") {
    return { safe: false, reason: "code must be a non-empty string" };
  }
  if (code.length > 20000) {
    return { safe: false, reason: "code too large (max 20000 chars)" };
  }
  for (const pattern of SCRIPT_BLOCKLIST) {
    if (pattern.test(code)) {
      return { safe: false, reason: `blocked pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

/**
 * Execute a script inside the page context after validating it against the blocklist.
 * @param {object} page
 * @param {string} code
 * @param {{ args?: any[] }} [options]
 */
export async function runScript(page, code, options = {}) {
  if (!page) throw new Error("page is required");
  const check = validateScript(code);
  if (!check.safe) {
    throw new Error(`script blocked: ${check.reason}`);
  }
  if (typeof page.evaluate !== "function") {
    throw new Error("page does not support evaluate");
  }
  const args = Array.isArray(options.args) ? options.args : [];
  try {
    // Wrap the code in a function body. The driver is responsible for marshaling
    // the function into its own evaluation context; we pass it as a string so
    // Playwright/Puppeteer can serialize it. The mock driver ignores the body.
    const wrapped = `(function(){ "use strict"; ${code} })()`;
    if (page._mock) {
      // Mock path: return a deterministic stub result so tests can assert.
      return { ok: true, result: null, mock: true };
    }
    const result = await page.evaluate(wrapped, ...args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || "script error" };
  }
}

// ---- Recording ----

/**
 * Start a recording for a session. Recordings track action timestamps in the
 * session store and can be retrieved via getRecording.
 * @param {string} sessionId
 */
export async function startRecording(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  return mutateSessions((store) => {
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session not found: ${sessionId}`);
    session.recording = true;
    session.updatedAt = Date.now();
    const rec = store.recordings[sessionId] || {
      sessionId,
      startedAt: Date.now(),
      stoppedAt: null,
      events: [],
    };
    rec.startedAt = Date.now();
    rec.stoppedAt = null;
    store.recordings[sessionId] = rec;
    return rec;
  });
}

export async function stopRecording(sessionId) {
  if (!sessionId) throw new Error("sessionId is required");
  return mutateSessions((store) => {
    const session = store.sessions[sessionId];
    if (session) {
      session.recording = false;
      session.updatedAt = Date.now();
    }
    const rec = store.recordings[sessionId];
    if (!rec) return null;
    rec.stoppedAt = Date.now();
    return rec;
  });
}

export async function getRecording(sessionId) {
  if (!sessionId) return null;
  const store = await loadSessionStore();
  return store.recordings[sessionId] || null;
}

/**
 * Append an event to a recording, if one is active.
 * @param {string} sessionId
 * @param {{ action: string, [k: string]: any }} event
 */
export async function recordEvent(sessionId, event) {
  if (!sessionId || !event) return null;
  return mutateSessions((store) => {
    const rec = store.recordings[sessionId];
    if (!rec || rec.stoppedAt) return null;
    rec.events.push({ ...event, at: Date.now() });
    return rec;
  });
}

export const _internals = {
  SCRIPT_BLOCKLIST,
  sessionStorePath,
  pageHandles,
};
