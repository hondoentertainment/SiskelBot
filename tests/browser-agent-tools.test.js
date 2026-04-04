import test from "node:test";
import assert from "node:assert/strict";
import { browserOpenExtractText, agentBrowserToolsEnabled } from "../lib/browser-agent-tools.js";

test("agentBrowserToolsEnabled reads env", () => {
  const prev = process.env.AGENT_BROWSER_TOOLS;
  process.env.AGENT_BROWSER_TOOLS = "1";
  assert.equal(agentBrowserToolsEnabled(), true);
  delete process.env.AGENT_BROWSER_TOOLS;
  assert.equal(agentBrowserToolsEnabled(), false);
  if (prev !== undefined) process.env.AGENT_BROWSER_TOOLS = prev;
});

test("browserOpenExtractText requires allowlist", async () => {
  const prevA = process.env.AGENT_BROWSER_TOOLS;
  const prevB = process.env.BROWSER_URL_ALLOWLIST;
  const prevC = process.env.AGENT_FETCH_ALLOWLIST;
  const prevK = process.env.KNOWLEDGE_URL_ALLOWLIST;
  delete process.env.BROWSER_URL_ALLOWLIST;
  delete process.env.AGENT_FETCH_ALLOWLIST;
  delete process.env.KNOWLEDGE_URL_ALLOWLIST;
  process.env.AGENT_BROWSER_TOOLS = "1";
  try {
    const r = await browserOpenExtractText("https://example.com/");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "ALLOWLIST_REQUIRED");
  } finally {
    if (prevA === undefined) delete process.env.AGENT_BROWSER_TOOLS;
    else process.env.AGENT_BROWSER_TOOLS = prevA;
    if (prevB === undefined) delete process.env.BROWSER_URL_ALLOWLIST;
    else process.env.BROWSER_URL_ALLOWLIST = prevB;
    if (prevC === undefined) delete process.env.AGENT_FETCH_ALLOWLIST;
    else process.env.AGENT_FETCH_ALLOWLIST = prevC;
    if (prevK === undefined) delete process.env.KNOWLEDGE_URL_ALLOWLIST;
    else process.env.KNOWLEDGE_URL_ALLOWLIST = prevK;
  }
});

test("browserOpenExtractText rejects non-allowlisted host", async () => {
  const prevB = process.env.BROWSER_URL_ALLOWLIST;
  process.env.BROWSER_URL_ALLOWLIST = "example.com";
  try {
    const r = await browserOpenExtractText("https://evil.test/");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "URL_NOT_ALLOWED");
  } finally {
    if (prevB === undefined) delete process.env.BROWSER_URL_ALLOWLIST;
    else process.env.BROWSER_URL_ALLOWLIST = prevB;
  }
});
