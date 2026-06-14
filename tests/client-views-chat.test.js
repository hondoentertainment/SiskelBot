/**
 * Unit tests for pure helpers exported from client/src/views/chat.js.
 * No JSDOM — helpers are string-in, string-out.
 */
import test from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ appendChild() {}, addEventListener() {}, setAttribute() {}, dataset: {} }),
    head: { appendChild() {} },
  };
}

const { parseSseLine, renderMarkdown, formatUsd } = await import("../client/src/views/chat.js");

// ── parseSseLine ────────────────────────────────────────────────────
test("parseSseLine: valid data line parses JSON", () => {
  assert.deepEqual(parseSseLine('data: {"a":1}'), { type: "data", data: { a: 1 } });
});
test("parseSseLine: event line returns event type", () => {
  assert.deepEqual(parseSseLine("event: tool_call"), { type: "event", data: "tool_call" });
});
test("parseSseLine: blank and comment lines return null", () => {
  assert.equal(parseSseLine(""), null);
  assert.equal(parseSseLine(": heartbeat"), null);
});
test("parseSseLine: malformed JSON returns null (does not throw)", () => {
  assert.equal(parseSseLine("data: {oops"), null);
});
test("parseSseLine: [DONE] sentinel", () => {
  assert.deepEqual(parseSseLine("data: [DONE]"), { type: "done", data: null });
});

// ── renderMarkdown ──────────────────────────────────────────────────
test("renderMarkdown: fenced code block", () => {
  const out = renderMarkdown("```js\nconst a = 1;\n```");
  assert.match(out, /<pre><code class="lang-js">const a = 1;\n<\/code><\/pre>/);
});
test("renderMarkdown: inline code, bold, italic", () => {
  const out = renderMarkdown("use `x` and **bold** and *ital*");
  assert.match(out, /<code>x<\/code>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>ital<\/em>/);
});
test("renderMarkdown: link renders href and escapes text", () => {
  const out = renderMarkdown("[click](https://example.com)");
  assert.match(out, /href="https:\/\/example\.com"/);
  assert.match(out, /target="_blank"/);
});
test("renderMarkdown: javascript: href is sanitized", () => {
  const out = renderMarkdown("[x](javascript:alert(1))");
  assert.doesNotMatch(out, /javascript:/);
  assert.match(out, /href="#"/);
});
test("renderMarkdown: <script> in input is escaped, no raw tag in output", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

// ── formatUsd ───────────────────────────────────────────────────────
test("formatUsd: sub-dollar uses 4 decimals", () => {
  assert.equal(formatUsd(0.0042), "$0.0042");
});
test("formatUsd: >=1 uses 2 decimals", () => {
  assert.equal(formatUsd(1.234), "$1.23");
});
test("formatUsd: zero", () => {
  assert.equal(formatUsd(0), "$0.0000");
});
test("formatUsd: negative", () => {
  assert.equal(formatUsd(-0.5), "-$0.5000");
});
test("formatUsd: non-numbers produce em-dash", () => {
  assert.equal(formatUsd(NaN), "—");
  assert.equal(formatUsd("x"), "—");
  assert.equal(formatUsd(null), "—");
});
