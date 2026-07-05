/**
 * Coverage for the tail of lib/agent-tools.js: web_search (all provider
 * branches, fetch stubbed), code_execute (vm sandbox), create_document,
 * schedule_task, send_notification, query_database and workspace tool
 * gating. Hermetic — global fetch is stubbed wherever a provider would go
 * out to the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agent-tools-tail-"));
process.env.STORAGE_PATH = tmp;
delete process.env.AGENT_TOOLS_ALLOWLIST;

const mod = await import("../lib/agent-tools.js");

const realFetch = global.fetch;
function stubFetch(fn) {
  global.fetch = fn;
}
test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SEARCH_API;
  delete process.env.SEARCH_API_URL;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_CX;
  delete process.env.AGENT_CODE_EXECUTE;
  delete process.env.ENABLE_SCHEDULED_RECIPES;
  delete process.env.AGENT_DB_QUERY;
  delete process.env.WORKSPACE_FILE_TOOLS;
});

function parse(result) {
  return JSON.parse(result.content);
}

// --- web_search ---

test("web_search: requires query and SEARCH_API", async () => {
  const noQuery = parse(await mod.runTool("web_search", {}, {}));
  assert.equal(noQuery.ok, false);
  assert.match(noQuery.error, /query is required/);

  const noApi = parse(await mod.runTool("web_search", { query: "x" }, {}));
  assert.equal(noApi.ok, false);
  assert.match(noApi.error, /not configured/i);
});

test("web_search: provider config validation branches", async () => {
  process.env.SEARCH_API = "searxng";
  let r = parse(await mod.runTool("web_search", { query: "x" }, {}));
  assert.match(r.error, /SEARCH_API_URL/);

  process.env.SEARCH_API = "brave";
  r = parse(await mod.runTool("web_search", { query: "x" }, {}));
  assert.match(r.error, /BRAVE_SEARCH_API_KEY/);

  process.env.SEARCH_API = "google";
  r = parse(await mod.runTool("web_search", { query: "x" }, {}));
  assert.match(r.error, /GOOGLE_SEARCH_API_KEY/);

  process.env.SEARCH_API = "altavista";
  r = parse(await mod.runTool("web_search", { query: "x" }, {}));
  assert.match(r.error, /Unknown SEARCH_API/);
});

test("web_search: searxng success path with stubbed fetch", async () => {
  process.env.SEARCH_API = "searxng";
  process.env.SEARCH_API_URL = "http://searx.local";
  stubFetch(async (url) => {
    assert.match(String(url), /searx\.local\/search\?q=agents/);
    return {
      ok: true,
      json: async () => ({
        results: [
          { title: "A", url: "http://a", content: "first" },
          { title: "B", url: "http://b", content: "second" },
        ],
      }),
    };
  });
  const r = parse(await mod.runTool("web_search", { query: "agents", limit: 1 }, {}));
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].title, "A");
});

test("web_search: brave success and google success with stubbed fetch", async () => {
  process.env.SEARCH_API = "brave";
  process.env.BRAVE_SEARCH_API_KEY = "k";
  stubFetch(async () => ({
    ok: true,
    json: async () => ({ web: { results: [{ title: "BR", url: "http://br", description: "d" }] } }),
  }));
  let r = parse(await mod.runTool("web_search", { query: "q" }, {}));
  assert.equal(r.ok, true);
  assert.equal(r.results[0].title, "BR");

  process.env.SEARCH_API = "google";
  process.env.GOOGLE_SEARCH_API_KEY = "k";
  process.env.GOOGLE_SEARCH_CX = "cx";
  stubFetch(async () => ({
    ok: true,
    json: async () => ({ items: [{ title: "GG", link: "http://gg", snippet: "s" }] }),
  }));
  r = parse(await mod.runTool("web_search", { query: "q" }, {}));
  assert.equal(r.ok, true);
  assert.equal(r.results[0].url, "http://gg");
});

test("web_search: provider HTTP error becomes ok:false", async () => {
  process.env.SEARCH_API = "searxng";
  process.env.SEARCH_API_URL = "http://searx.local";
  stubFetch(async () => ({ ok: false, status: 502 }));
  const r = parse(await mod.runTool("web_search", { query: "q" }, {}));
  assert.equal(r.ok, false);
  assert.match(r.error, /502/);
});

// --- code_execute ---

test("code_execute: disabled by default and requires code", async () => {
  const off = parse(await mod.runTool("code_execute", { code: "1+1" }, {}));
  assert.equal(off.ok, false);
  assert.match(off.error, /disabled/i);

  process.env.AGENT_CODE_EXECUTE = "1";
  const noCode = parse(await mod.runTool("code_execute", {}, {}));
  assert.match(noCode.error, /code is required/);
});

test("code_execute: runs sandboxed code with console output and result", async () => {
  process.env.AGENT_CODE_EXECUTE = "1";
  const r = parse(
    await mod.runTool("code_execute", { code: "console.log('hi'); [1,2,3].reduce((a,b)=>a+b,0)" }, {})
  );
  assert.equal(r.ok, true);
  assert.equal(r.output, "hi");
  assert.equal(r.result, 6);
});

test("code_execute: execution errors are captured", async () => {
  process.env.AGENT_CODE_EXECUTE = "1";
  const r = parse(await mod.runTool("code_execute", { code: "throw new Error('boom')" }, {}));
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

// --- create_document ---

test("create_document: validates title and content", async () => {
  const noTitle = parse(await mod.runTool("create_document", { content: "c" }, {}));
  assert.match(noTitle.error, /title is required/);
  const noContent = parse(await mod.runTool("create_document", { title: "t" }, {}));
  assert.match(noContent.error, /content is required/);
});

test("create_document: indexes a document", async () => {
  const r = parse(
    await mod.runTool("create_document", { title: "Notes", content: "Body of the note about deploys." }, {})
  );
  assert.equal(r.ok, true);
  assert.ok(r.id);
  assert.equal(r.created, true);
});

// --- schedule_task ---

test("schedule_task: disabled, validation, and recipe-not-found branches", async () => {
  const off = parse(await mod.runTool("schedule_task", { recipeName: "x", cron: "* * * * *" }, {}));
  assert.match(off.error, /disabled/i);

  process.env.ENABLE_SCHEDULED_RECIPES = "1";
  const noName = parse(await mod.runTool("schedule_task", { cron: "* * * * *" }, {}));
  assert.match(noName.error, /recipeName is required/);

  const noWhen = parse(await mod.runTool("schedule_task", { recipeName: "x" }, {}));
  assert.match(noWhen.error, /cron or runAt/);

  const missing = parse(await mod.runTool("schedule_task", { recipeName: "nope", cron: "* * * * *" }, {}));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);
  assert.ok(Array.isArray(missing.available));
});

// --- send_notification ---

test("send_notification: requires message and reports channels", async () => {
  const noMsg = parse(await mod.runTool("send_notification", {}, {}));
  assert.match(noMsg.error, /message is required/);

  const r = parse(await mod.runTool("send_notification", { message: "deploy done", urgency: "weird" }, {}));
  assert.equal(r.ok, true);
  assert.equal(r.sent, true);
  assert.ok(Array.isArray(r.channels));
});

// --- query_database ---

test("query_database: requires postgres backend", async () => {
  const off = parse(await mod.runTool("query_database", { query: "SELECT 1" }, {}));
  assert.equal(off.ok, false);
  assert.match(off.error, /postgres/i);
});

// --- workspace file tools ---

test("workspace_read_file is gated; list_dir and git_status respond", async () => {
  const read = parse(await mod.runTool("workspace_read_file", { path: "package.json" }, {}));
  assert.equal(read.ok, false, "read gated off without WORKSPACE_FILE_TOOLS");

  // These are permitted read-only surfaces; assert they return structured JSON.
  const list = parse(await mod.runTool("workspace_list_dir", { path: "." }, {}));
  assert.equal(typeof list, "object");
  const git = parse(await mod.runTool("workspace_git_status", {}, {}));
  assert.equal(typeof git, "object");
});
