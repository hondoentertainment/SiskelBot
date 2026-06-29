import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveMaxTransientRetries,
  isTransientToolFailure,
  getDeployToolRetryExtraMax,
  toolEligibleForTransientRetry,
} from "../lib/agent-tool-retry.js";

test("getDeployToolRetryExtraMax is 0 when unset and capped at 5", () => {
  const prev = process.env.AGENT_TOOL_RETRY_MAX;
  try {
    delete process.env.AGENT_TOOL_RETRY_MAX;
    assert.equal(getDeployToolRetryExtraMax(), 0);
    process.env.AGENT_TOOL_RETRY_MAX = "2";
    assert.equal(getDeployToolRetryExtraMax(), 2);
    process.env.AGENT_TOOL_RETRY_MAX = "99";
    assert.equal(getDeployToolRetryExtraMax(), 5);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_RETRY_MAX;
    else process.env.AGENT_TOOL_RETRY_MAX = prev;
  }
});

test("resolveEffectiveMaxTransientRetries merges deploy and workspace", () => {
  const prev = process.env.AGENT_TOOL_RETRY_MAX;
  try {
    process.env.AGENT_TOOL_RETRY_MAX = "4";
    assert.equal(resolveEffectiveMaxTransientRetries({}), 4);
    assert.equal(resolveEffectiveMaxTransientRetries({ transientToolRetryLimit: null }), 4);
    assert.equal(resolveEffectiveMaxTransientRetries({ transientToolRetryLimit: 0 }), 0);
    assert.equal(resolveEffectiveMaxTransientRetries({ transientToolRetryLimit: 2 }), 2);
    assert.equal(resolveEffectiveMaxTransientRetries({ transientToolRetryLimit: 10 }), 4);
    delete process.env.AGENT_TOOL_RETRY_MAX;
    assert.equal(resolveEffectiveMaxTransientRetries({ transientToolRetryLimit: 3 }), 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_RETRY_MAX;
    else process.env.AGENT_TOOL_RETRY_MAX = prev;
  }
});

test("isTransientToolFailure respects allowlist and codes", () => {
  assert.equal(toolEligibleForTransientRetry("search_context"), true);
  assert.equal(isTransientToolFailure("search_context", { ok: false, code: "FETCH_FAILED" }, { ok: false }), true);
  assert.equal(isTransientToolFailure("search_context", { ok: false, code: "URL_NOT_ALLOWED" }, { ok: false }), false);
  assert.equal(
    isTransientToolFailure("search_context", { ok: false, error: "read ECONNRESET", code: "TOOL_EXCEPTION" }, { ok: false }),
    true
  );
  assert.equal(
    isTransientToolFailure("search_context", { ok: false, error: "not allowed", code: "TOOL_EXCEPTION" }, { ok: false }),
    false
  );
  assert.equal(isTransientToolFailure("execute_step", { ok: false, code: "FETCH_FAILED" }, { ok: false }), false);
});
