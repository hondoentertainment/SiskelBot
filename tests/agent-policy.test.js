import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectivePolicy,
  createPolicyState,
  checkPolicyBeforeTool,
  recordPolicyToolCompletion,
  checkPolicyAfterRound,
} from "../lib/agent-policy.js";

test("resolveEffectivePolicy clamps workspace policy by env", () => {
  const prevCaps = process.env.AGENT_TOOL_CATEGORY_CAPS;
  const prevFetch = process.env.AGENT_MAX_EXTERNAL_FETCHES;
  process.env.AGENT_TOOL_CATEGORY_CAPS = "read:4,write:2,network:1";
  process.env.AGENT_MAX_EXTERNAL_FETCHES = "2";
  try {
    const out = resolveEffectivePolicy({
      toolCategoryCaps: { read: 9, write: 1, network: 3 },
      maxExternalFetches: 5,
    });
    assert.equal(out.toolCategoryCaps.read, 4);
    assert.equal(out.toolCategoryCaps.write, 1);
    assert.equal(out.toolCategoryCaps.network, 1);
    assert.equal(out.maxExternalFetches, 2);
  } finally {
    if (prevCaps === undefined) delete process.env.AGENT_TOOL_CATEGORY_CAPS;
    else process.env.AGENT_TOOL_CATEGORY_CAPS = prevCaps;
    if (prevFetch === undefined) delete process.env.AGENT_MAX_EXTERNAL_FETCHES;
    else process.env.AGENT_MAX_EXTERNAL_FETCHES = prevFetch;
  }
});

test("policy blocks external fetch cap and cumulative tool ms", () => {
  const st = createPolicyState({
    toolCategoryCaps: { read: 10, write: 10, network: 1 },
    maxExternalFetches: 1,
    maxTotalToolMs: 5,
  });
  assert.equal(checkPolicyBeforeTool(st, "fetch_allowed_url").ok, true);
  recordPolicyToolCompletion(st, "fetch_allowed_url", 6);
  assert.equal(checkPolicyBeforeTool(st, "fetch_allowed_url").ok, false);
  assert.equal(checkPolicyAfterRound(st).ok, false);
});

test("browser tools share external fetch budget with fetch_allowed_url", () => {
  const st = createPolicyState({
    toolCategoryCaps: { read: 10, write: 10, network: 10 },
    maxExternalFetches: 1,
    maxTotalToolMs: 0,
  });
  assert.equal(checkPolicyBeforeTool(st, "browser_open_extract_text").ok, true);
  recordPolicyToolCompletion(st, "browser_open_extract_text", 1);
  assert.equal(st.externalFetches, 1);
  assert.equal(checkPolicyBeforeTool(st, "fetch_allowed_url").ok, false);
  assert.equal(checkPolicyBeforeTool(st, "browser_capture_screenshot").ok, false);
});
