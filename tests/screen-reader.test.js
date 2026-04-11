/**
 * Phase 70.1: Screen reader tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-sr-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  auditHtml,
  suggestAriaLabels,
  getAuditReport,
  listIssues,
  fixIssue,
  parseHtml,
} = await import("../lib/screen-reader.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("parseHtml extracts tags and attributes", () => {
  const els = parseHtml('<img src="a.png"><a href="/x">Go</a>');
  assert.equal(els.length, 2);
  assert.equal(els[0].tag, "img");
  assert.equal(els[0].attrs.src, "a.png");
  assert.equal(els[1].tag, "a");
  assert.equal(els[1].attrs.href, "/x");
});

test("parseHtml handles empty or invalid input", () => {
  assert.deepEqual(parseHtml(""), []);
  assert.deepEqual(parseHtml(null), []);
});

test("suggestAriaLabels returns existing aria-label if present", () => {
  const s = suggestAriaLabels({ tag: "button", attrs: { "aria-label": "Close" } });
  assert.equal(s, "Close");
});

test("suggestAriaLabels falls back to alt, placeholder, or generated text", () => {
  assert.ok(suggestAriaLabels({ tag: "img", attrs: { src: "/foo/bar.png" } }).length > 0);
  assert.equal(suggestAriaLabels({ tag: "button", attrs: {}, text: "Save" }), "Save");
  assert.ok(suggestAriaLabels({ tag: "a", attrs: { href: "/x" } }).length > 0);
  assert.ok(suggestAriaLabels({ tag: "input", attrs: { type: "text", placeholder: "name" } }).length > 0);
  assert.ok(suggestAriaLabels({ tag: "iframe", attrs: {} }).length > 0);
});

test("suggestAriaLabels returns empty for unknown tags", () => {
  assert.equal(suggestAriaLabels({ tag: "div", attrs: {} }), "");
  assert.equal(suggestAriaLabels(null), "");
});

test("auditHtml flags img without alt as an error", async () => {
  const report = await auditHtml('<img src="pic.png">');
  const errors = report.issues.filter((i) => i.severity === "error");
  assert.ok(errors.length >= 1);
  assert.ok(errors[0].message.includes("alt"));
});

test("auditHtml flags iframe without title and input without name", async () => {
  const report = await auditHtml('<iframe src="x"></iframe><input type="text">');
  const tags = report.issues.map((i) => i.tag);
  assert.ok(tags.includes("iframe"));
  assert.ok(tags.includes("input"));
});

test("auditHtml rejects non-string input", async () => {
  await assert.rejects(() => auditHtml(42));
});

test("auditHtml returns empty issues for clean HTML", async () => {
  const report = await auditHtml('<img src="x.png" alt="a thing"><button aria-label="Close">x</button>');
  const errors = report.issues.filter((i) => i.severity === "error");
  assert.equal(errors.length, 0);
});

test("getAuditReport retrieves stored audit", async () => {
  const r = await auditHtml('<img src="y.png">', { id: "fixed-id-1" });
  const fetched = await getAuditReport("fixed-id-1");
  assert.ok(fetched);
  assert.equal(fetched.id, "fixed-id-1");
  assert.equal(await getAuditReport("nope"), null);
});

test("listIssues filters by status and severity", async () => {
  await auditHtml('<img src="a.png"><iframe src="b"></iframe>');
  const open = await listIssues({ status: "open" });
  assert.ok(open.every((i) => i.status === "open"));
  const errs = await listIssues({ severity: "error" });
  assert.ok(errs.every((i) => i.severity === "error"));
});

test("fixIssue marks an issue as fixed", async () => {
  const report = await auditHtml('<img src="toremove.png">');
  const issue = report.issues[0];
  const fixed = await fixIssue(issue.id, { note: "added alt" });
  assert.equal(fixed.status, "fixed");
  assert.ok(fixed.fixedAt);
  assert.equal(fixed.note, "added alt");
});

test("fixIssue rejects invalid input", async () => {
  await assert.rejects(() => fixIssue("missing"));
  await assert.rejects(() => fixIssue(""));
});
