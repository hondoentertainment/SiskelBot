import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  needsBrowserDomainHitl,
  browserUrlHostname,
} from "../lib/browser-agent-tools.js";

describe("browser new-domain HITL", () => {
  const prevHitl = process.env.AGENT_BROWSER_HITL_NEW_DOMAINS;
  const prevAllow = process.env.BROWSER_URL_ALLOWLIST;

  before(() => {
    process.env.AGENT_BROWSER_HITL_NEW_DOMAINS = "1";
    process.env.BROWSER_URL_ALLOWLIST = "https://example.com,https://docs.example.com";
  });

  after(() => {
    if (prevHitl === undefined) delete process.env.AGENT_BROWSER_HITL_NEW_DOMAINS;
    else process.env.AGENT_BROWSER_HITL_NEW_DOMAINS = prevHitl;
    if (prevAllow === undefined) delete process.env.BROWSER_URL_ALLOWLIST;
    else process.env.BROWSER_URL_ALLOWLIST = prevAllow;
  });

  it("parses hostname", () => {
    assert.equal(browserUrlHostname("https://Example.COM/path"), "example.com");
  });

  it("requires HITL when workspace allowlist empty", () => {
    const d = needsBrowserDomainHitl("https://example.com/a", []);
    assert.equal(d.needsHitl, true);
    assert.equal(d.host, "example.com");
  });

  it("skips HITL when host is workspace-approved", () => {
    const d = needsBrowserDomainHitl("https://example.com/a", ["https://example.com"]);
    assert.equal(d.needsHitl, false);
  });

  it("requires HITL for host outside workspace allowlist", () => {
    const d = needsBrowserDomainHitl("https://docs.example.com/x", ["https://example.com"]);
    assert.equal(d.needsHitl, true);
  });

  it("disabled when env off", () => {
    delete process.env.AGENT_BROWSER_HITL_NEW_DOMAINS;
    const d = needsBrowserDomainHitl("https://example.com/a", []);
    assert.equal(d.needsHitl, false);
    process.env.AGENT_BROWSER_HITL_NEW_DOMAINS = "1";
  });
});
