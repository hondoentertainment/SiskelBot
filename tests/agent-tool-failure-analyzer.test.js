/**
 * Tests for the tool failure analyzer: classification, tracking, replan message.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  trackFailure,
  createTracker,
  buildReplanMessage,
  analyzeAndBuildReplan,
  argsFingerprint,
} from "../lib/agent-tool-failure-analyzer.js";

test("classifyFailure: validation error flagged as terminal 'validation'", () => {
  const parsed = { _tool_validation_error: true, error: "missing required field 'name'" };
  const c = classifyFailure("create_document", parsed, {});
  assert.equal(c.category, "validation");
  assert.equal(c.terminal, true);
  assert.equal(c.severity, "high");
  assert.match(c.hint, /schema/i);
});

test("classifyFailure: unknown tool flagged as terminal 'unknown_tool'", () => {
  const parsed = { ok: false, error: "Unknown tool: foo_bar" };
  const c = classifyFailure("foo_bar", parsed, {});
  assert.equal(c.category, "unknown_tool");
  assert.equal(c.terminal, true);
  assert.match(c.hint, /tool list|available/i);
});

test("classifyFailure: TOOL_NOT_ALLOWED code -> 'not_allowed' terminal", () => {
  const parsed = { ok: false, code: "TOOL_NOT_ALLOWED", error: "tool is disabled" };
  const c = classifyFailure("code_execute", parsed, {});
  assert.equal(c.category, "not_allowed");
  assert.equal(c.terminal, true);
});

test("classifyFailure: 403 -> 'permission' terminal", () => {
  const parsed = { ok: false, status: 403, error: "forbidden" };
  const c = classifyFailure("fetch_allowed_url", parsed, { url: "https://x" });
  assert.equal(c.category, "permission");
  assert.equal(c.terminal, true);
});

test("classifyFailure: 404 -> 'not_found' non-terminal", () => {
  const parsed = { ok: false, status: 404, error: "document not found" };
  const c = classifyFailure("get_context_document", parsed, { id: "abc" });
  assert.equal(c.category, "not_found");
  assert.equal(c.terminal, false);
  assert.match(c.hint, /list|search/i);
});

test("classifyFailure: 429 -> 'rate_limit' non-terminal", () => {
  const parsed = { ok: false, status: 429, error: "Too Many Requests" };
  const c = classifyFailure("web_search", parsed, { q: "node" });
  assert.equal(c.category, "rate_limit");
  assert.equal(c.terminal, false);
});

test("classifyFailure: timeout message -> 'timeout'", () => {
  const parsed = { ok: false, error: "operation timed out after 30s" };
  const c = classifyFailure("fetch_allowed_url", parsed, {});
  assert.equal(c.category, "timeout");
});

test("classifyFailure: ECONNRESET -> 'network'", () => {
  const parsed = { ok: false, code: "ECONNRESET", error: "connection reset" };
  const c = classifyFailure("fetch_allowed_url", parsed, {});
  assert.equal(c.category, "network");
});

test("classifyFailure: 502 -> 'backend_error'", () => {
  const parsed = { ok: false, status: 502, error: "bad gateway" };
  const c = classifyFailure("web_search", parsed, {});
  assert.equal(c.category, "backend_error");
});

test("classifyFailure: short query argument -> 'semantic' with helpful hint", () => {
  const parsed = { ok: false, error: "no match" };
  const c = classifyFailure("search_context", parsed, { query: "hi" });
  assert.equal(c.category, "semantic");
  assert.equal(c.terminal, true);
  assert.match(c.hint, /3 characters|too short/i);
});

test("classifyFailure: cancelled -> 'cancelled' terminal", () => {
  const parsed = { ok: false, code: "CANCELLED", error: "cancelled by user" };
  const c = classifyFailure("any_tool", parsed, {});
  assert.equal(c.category, "cancelled");
  assert.equal(c.terminal, true);
});

test("classifyFailure: unrecognized error -> 'unknown' non-terminal", () => {
  const parsed = { ok: false, error: "weird thing happened" };
  const c = classifyFailure("any_tool", parsed, {});
  assert.equal(c.category, "unknown");
  assert.equal(c.terminal, false);
});

test("argsFingerprint: object key order does not change fingerprint", () => {
  const a = argsFingerprint({ a: 1, b: "hello" });
  const b = argsFingerprint({ b: "hello", a: 1 });
  assert.equal(a, b);
});

test("argsFingerprint: handles null and non-object", () => {
  assert.equal(argsFingerprint(null), "∅");
  assert.equal(argsFingerprint(undefined), "∅");
  assert.equal(argsFingerprint(42), "42");
});

test("trackFailure: repeat count increments for same tool/category/args", () => {
  const t = createTracker();
  const h1 = trackFailure(t, "fetch_allowed_url", { url: "https://x" }, "network");
  const h2 = trackFailure(t, "fetch_allowed_url", { url: "https://x" }, "network");
  const h3 = trackFailure(t, "fetch_allowed_url", { url: "https://x" }, "network");
  assert.equal(h1.repeat, 1);
  assert.equal(h2.repeat, 2);
  assert.equal(h3.repeat, 3);
  assert.equal(h3.toolRepeat, 3);
  assert.equal(h3.sameCategoryAsLast, true);
});

test("trackFailure: different args produce different repeat counts but shared tool count", () => {
  const t = createTracker();
  trackFailure(t, "web_search", { q: "a" }, "rate_limit");
  const h = trackFailure(t, "web_search", { q: "b" }, "rate_limit");
  assert.equal(h.repeat, 1);
  assert.equal(h.toolRepeat, 2);
});

test("trackFailure: category change flips sameCategoryAsLast to false", () => {
  const t = createTracker();
  trackFailure(t, "web_search", {}, "rate_limit");
  const h = trackFailure(t, "web_search", {}, "network");
  assert.equal(h.sameCategoryAsLast, false);
});

test("buildReplanMessage: includes tool name, hint, and attempt banner", () => {
  const failure = classifyFailure("web_search", { status: 429, error: "rate limited" }, { q: "x" });
  const t = createTracker();
  const history = trackFailure(t, "web_search", { q: "x" }, failure.category);
  const msg = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.match(msg, /web_search/);
  assert.match(msg, /rate_limit/);
  assert.match(msg, /Re-plan attempt 1 of 3/);
});

test("buildReplanMessage: on 2nd identical repeat, adds 'do not repeat' escalation", () => {
  const failure = classifyFailure("foo", { ok: false, error: "Unknown tool: foo" }, { a: 1 });
  const t = createTracker();
  trackFailure(t, "foo", { a: 1 }, failure.category);
  const history = trackFailure(t, "foo", { a: 1 }, failure.category);
  const msg = buildReplanMessage({ toolName: "foo", failure, history });
  assert.match(msg, /already received this exact error/i);
  assert.match(msg, /Do not repeat/i);
});

test("buildReplanMessage: terminal errors mention non-self-resolving", () => {
  const failure = classifyFailure("x", { status: 403, error: "forbidden" }, {});
  const t = createTracker();
  const history = trackFailure(t, "x", {}, failure.category);
  const msg = buildReplanMessage({ toolName: "x", failure, history });
  assert.match(msg, /not self-resolving/i);
});

test("buildReplanMessage: terminal=false does NOT claim non-self-resolving", () => {
  const failure = classifyFailure("x", { status: 500, error: "server error" }, {});
  const t = createTracker();
  const history = trackFailure(t, "x", {}, failure.category);
  const msg = buildReplanMessage({ toolName: "x", failure, history });
  assert.doesNotMatch(msg, /not self-resolving/i);
});

test("analyzeAndBuildReplan: end-to-end classify+track+build in one call", () => {
  const t = createTracker();
  const out = analyzeAndBuildReplan({
    toolName: "search_context",
    parsed: { ok: false, error: "nothing found" },
    args: { query: "a" }, // too-short query -> semantic
    tracker: t,
    attempt: 2,
    maxAttempts: 3,
  });
  assert.equal(out.classified.category, "semantic");
  assert.equal(out.history.repeat, 1);
  assert.match(out.message, /Re-plan attempt 2 of 3/);
});

test("buildReplanMessage: different toolRepeat but fresh args escalates to 'prefer different tool'", () => {
  const t = createTracker();
  // First failure with args A
  let f = classifyFailure("fetch_allowed_url", { status: 500 }, { url: "https://a" });
  trackFailure(t, "fetch_allowed_url", { url: "https://a" }, f.category);
  // Second failure same tool, different args, same category
  f = classifyFailure("fetch_allowed_url", { status: 500 }, { url: "https://b" });
  const history = trackFailure(t, "fetch_allowed_url", { url: "https://b" }, f.category);
  const msg = buildReplanMessage({ toolName: "fetch_allowed_url", failure: f, history });
  assert.match(msg, /Prefer a different tool/i);
});
