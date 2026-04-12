/**
 * Phase 55.2: Browser agent tests.
 *
 * Covers the pluggable driver registry, mock driver, page actions, URL
 * allowlist/blocklist enforcement, session management, form filling,
 * sandboxed script execution, and recording lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-browser-agent-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerDriver,
  getDriver,
  listDrivers,
  _clearDrivers,
  mockDriver,
  openPage,
  clickElement,
  typeInField,
  waitFor,
  screenshot,
  closePage,
  navigate,
  back,
  forward,
  reload,
  checkUrlAllowed,
  URL_BLOCKLIST,
  createBrowserSession,
  getBrowserSession,
  closeBrowserSession,
  listBrowserSessions,
  fillForm,
  extractTable,
  downloadFile,
  uploadFile,
  scrollTo,
  handleDialog,
  runScript,
  validateScript,
  startRecording,
  stopRecording,
  getRecording,
  recordEvent,
} = await import("../lib/browser-agent.js");

// Ensure the mock driver is registered for every test (module-level
// registration runs once but some tests exercise _clearDrivers below).
function ensureMockRegistered() {
  if (!getDriver("mock")) {
    registerDriver("mock", mockDriver);
  }
}

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test.beforeEach(() => {
  ensureMockRegistered();
});

// ---- Driver registry ----

test("registerDriver + getDriver exposes registered drivers", () => {
  const fake = { name: "fake-x", async newPage() { return {}; } };
  registerDriver("fake-x", fake);
  assert.equal(getDriver("fake-x"), fake);
  assert.ok(listDrivers().includes("fake-x"));
});

test("registerDriver validates input", () => {
  assert.throws(() => registerDriver("", {}), /name is required/);
  assert.throws(() => registerDriver("bad", null), /driverFactory must be an object/);
  assert.throws(() => registerDriver("nomethod", {}), /newPage/);
});

test("getDriver returns null for unknown names", () => {
  assert.equal(getDriver("nonexistent-driver"), null);
  assert.equal(getDriver(""), null);
});

test("mockDriver newPage returns a page with expected methods", async () => {
  const page = await mockDriver.newPage();
  assert.equal(typeof page.goto, "function");
  assert.equal(typeof page.click, "function");
  assert.equal(typeof page.type, "function");
  assert.equal(typeof page.screenshot, "function");
  assert.equal(typeof page.close, "function");
  const r = await page.goto("https://example.com/");
  assert.equal(r.status, 200);
  assert.equal(r.url, "https://example.com/");
  const title = await page.title();
  assert.equal(title, "Mock Page");
});

// ---- openPage + actions ----

test("openPage opens a mock page and navigates to the URL", async () => {
  const { page, result } = await openPage("https://example.com/", { driver: "mock" });
  assert.equal(result.status, 200);
  assert.equal(result.url, "https://example.com/");
  await page.close();
});

test("openPage rejects disallowed URLs", async () => {
  await assert.rejects(() => openPage("file:///etc/passwd"), /url not allowed/);
  await assert.rejects(() => openPage("chrome://settings"), /url not allowed/);
  await assert.rejects(() => openPage("javascript:alert(1)"), /url not allowed/);
});

test("clickElement invokes page.click with the selector", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const r = await clickElement(page, "button#submit");
  assert.equal(r.success, true);
  assert.equal(r.selector, "button#submit");
  await page.close();
});

test("clickElement validates inputs", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  await assert.rejects(() => clickElement(null, "button"), /page is required/);
  await assert.rejects(() => clickElement(page, ""), /selector/);
  await page.close();
});

test("typeInField invokes page.type with the text", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const r = await typeInField(page, "input[name=email]", "x@y.com");
  assert.equal(r.success, true);
  assert.equal(r.length, 7);
  await page.close();
});

test("waitFor accepts a selector string", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const r = await waitFor(page, "div.ready");
  assert.equal(r.found, true);
  assert.equal(r.selector, "div.ready");
  await page.close();
});

test("screenshot returns a Buffer", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const buf = await screenshot(page);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 0);
  await page.close();
});

test("navigate enforces the URL allowlist", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  await assert.rejects(() => navigate(page, "file:///bad"), /url not allowed/);
  const ok = await navigate(page, "https://example.com/other");
  assert.equal(ok.status, 200);
  await page.close();
});

test("back / forward / reload dispatch to the page driver", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  await navigate(page, "https://example.com/next");
  const b = await back(page);
  assert.equal(b.url, "https://example.com/");
  const f = await forward(page);
  assert.ok(f);
  const r = await reload(page);
  assert.equal(r.status, 200);
  await page.close();
});

// ---- URL allowlist ----

test("checkUrlAllowed allows https URLs", () => {
  assert.equal(checkUrlAllowed("https://example.com/").allowed, true);
  assert.equal(checkUrlAllowed("http://example.com/").allowed, true);
});

test("checkUrlAllowed blocks file://", () => {
  const r = checkUrlAllowed("file:///etc/passwd");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /blocked by blocklist/);
});

test("checkUrlAllowed blocks chrome://", () => {
  const r = checkUrlAllowed("chrome://settings");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /blocked by blocklist/);
});

test("checkUrlAllowed blocks javascript: URLs", () => {
  const r = checkUrlAllowed("javascript:alert(1)");
  assert.equal(r.allowed, false);
});

test("checkUrlAllowed enforces a provided allowlist", () => {
  const allow = ["example.com"];
  assert.equal(checkUrlAllowed("https://example.com/", { allowlist: allow }).allowed, true);
  assert.equal(checkUrlAllowed("https://sub.example.com/", { allowlist: allow }).allowed, true);
  const blocked = checkUrlAllowed("https://evil.com/", { allowlist: allow });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /host not in allowlist/);
});

test("checkUrlAllowed rejects invalid URLs", () => {
  assert.equal(checkUrlAllowed("").allowed, false);
  assert.equal(checkUrlAllowed("not a url").allowed, false);
  assert.equal(checkUrlAllowed(null).allowed, false);
});

test("checkUrlAllowed rejects non-http(s) protocols", () => {
  assert.equal(checkUrlAllowed("ftp://example.com/file").allowed, false);
  assert.equal(checkUrlAllowed("ws://example.com/").allowed, false);
});

test("URL_BLOCKLIST contains the documented prefixes", () => {
  assert.ok(URL_BLOCKLIST.includes("file://"));
  assert.ok(URL_BLOCKLIST.includes("chrome://"));
  assert.ok(URL_BLOCKLIST.includes("javascript:"));
});

// ---- Sessions ----

test("createBrowserSession persists a session record", async () => {
  const s = await createBrowserSession("my-session", { driver: "mock" });
  assert.ok(s.id.startsWith("bsession_"));
  assert.equal(s.name, "my-session");
  assert.equal(s.driver, "mock");
  assert.equal(s.status, "created");
});

test("createBrowserSession with a URL opens a page eagerly", async () => {
  const s = await createBrowserSession("opened", {
    driver: "mock",
    url: "https://example.com/",
  });
  assert.equal(s.status, "created");
  const fetched = await getBrowserSession(s.id);
  assert.equal(fetched.status, "open");
  await closeBrowserSession(s.id);
});

test("createBrowserSession rejects disallowed URL", async () => {
  await assert.rejects(
    () => createBrowserSession("bad", { driver: "mock", url: "file:///etc/passwd" }),
    /url not allowed/,
  );
});

test("listBrowserSessions returns all persisted sessions", async () => {
  await createBrowserSession("list-a", { driver: "mock" });
  await createBrowserSession("list-b", { driver: "mock" });
  const all = await listBrowserSessions();
  const names = all.map((s) => s.name);
  assert.ok(names.includes("list-a"));
  assert.ok(names.includes("list-b"));
});

test("closeBrowserSession marks a session as closed", async () => {
  const s = await createBrowserSession("close-me", { driver: "mock" });
  const closed = await closeBrowserSession(s.id);
  assert.equal(closed.status, "closed");
});

// ---- Form and high-level workflows ----

test("fillForm types into multiple fields", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const r = await fillForm(page, {
    "input[name=email]": "x@y.com",
    "input[name=password]": "secret",
    "input[name=first]": "Jane",
  });
  assert.equal(r.filled, 3);
  assert.equal(r.results.length, 3);
  await page.close();
});

test("extractTable returns an array for mock driver", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const rows = await extractTable(page, "table.data");
  assert.ok(Array.isArray(rows));
  await page.close();
});

test("downloadFile and uploadFile return deterministic mock results", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const dl = await downloadFile(page, "https://example.com/file.zip");
  assert.equal(dl.ok, true);
  const up = await uploadFile(page, "input[type=file]", "/tmp/x");
  assert.equal(up.ok, true);
  await page.close();
});

test("downloadFile rejects disallowed URLs", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  await assert.rejects(() => downloadFile(page, "file:///etc/passwd"), /url not allowed/);
  await page.close();
});

test("scrollTo and handleDialog are safe on mock pages", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const s = await scrollTo(page, "#bottom");
  assert.equal(s.ok, true);
  const d = await handleDialog(page, "accept");
  assert.equal(d.action, "accept");
  await assert.rejects(() => handleDialog(page, "nope"), /must be/);
  await page.close();
});

// ---- Script execution ----

test("validateScript allows safe code", () => {
  assert.equal(validateScript("return 1 + 1;").safe, true);
  assert.equal(validateScript("document.querySelector('h1').textContent").safe, true);
});

test("validateScript blocks eval / require / process", () => {
  assert.equal(validateScript("eval('1+1')").safe, false);
  assert.equal(validateScript("require('fs')").safe, false);
  assert.equal(validateScript("process.exit(1)").safe, false);
  assert.equal(validateScript("new Function('return 1')()").safe, false);
  assert.equal(validateScript("import('fs')").safe, false);
});

test("runScript runs safe code on mock pages", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  const r = await runScript(page, "return 'hi';");
  assert.equal(r.ok, true);
  await page.close();
});

test("runScript blocks dangerous code", async () => {
  const { page } = await openPage("https://example.com/", { driver: "mock" });
  await assert.rejects(() => runScript(page, "eval('1+1')"), /script blocked/);
  await assert.rejects(() => runScript(page, "require('fs')"), /script blocked/);
  await page.close();
});

// ---- Recording ----

test("startRecording / stopRecording / getRecording lifecycle", async () => {
  const s = await createBrowserSession("recorded", { driver: "mock" });
  const rec = await startRecording(s.id);
  assert.ok(rec.startedAt > 0);
  assert.equal(rec.stoppedAt, null);
  await recordEvent(s.id, { action: "click", selector: "button" });
  const stopped = await stopRecording(s.id);
  assert.ok(stopped.stoppedAt >= stopped.startedAt);
  assert.equal(stopped.events.length, 1);
  assert.equal(stopped.events[0].action, "click");
  const fetched = await getRecording(s.id);
  assert.ok(fetched);
  assert.equal(fetched.events.length, 1);
});

test("startRecording rejects unknown sessions", async () => {
  await assert.rejects(() => startRecording("bsession_does_not_exist"), /session not found/);
});

// ---- Invalid URL and page close ----

test("Invalid URL rejected by openPage", async () => {
  await assert.rejects(() => openPage("not a url"), /url not allowed/);
  await assert.rejects(() => openPage(""), /url not allowed/);
});

test("Mock page close marks it closed and further actions throw", async () => {
  const page = await mockDriver.newPage();
  assert.equal(page.isClosed(), false);
  await page.close();
  assert.equal(page.isClosed(), true);
  await assert.rejects(() => page.goto("https://example.com/"), /closed/);
});
