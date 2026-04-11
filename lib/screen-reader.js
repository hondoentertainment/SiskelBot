// @ts-check
/**
 * Phase 70.1: Screen reader support.
 *
 * Audits snippets of HTML for common ARIA/semantic issues and
 * suggests ARIA labels for unlabeled interactive elements. Audit
 * reports are persisted so an admin UI can list and fix them.
 *
 * The HTML parser is intentionally naive: we walk the tag stream
 * with a regex rather than a full HTML parser. Good enough for
 * linting component strings and templates; not for arbitrary pages.
 *
 * Exports:
 *   - auditHtml
 *   - suggestAriaLabels
 *   - getAuditReport
 *   - listIssues
 *   - fixIssue
 *
 * @module screen-reader
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "screen-reader-audits.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, audits: {}, issues: {} });
  if (!data.audits || typeof data.audits !== "object") data.audits = {};
  if (!data.issues || typeof data.issues !== "object") data.issues = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    audits: data.audits || {},
    issues: data.issues || {},
  });
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * Parse an HTML snippet into a flat list of element descriptors.
 * Self-closing / void tags are captured the same as open tags.
 *
 * @param {string} html
 * @returns {Array<{ tag: string, attrs: Record<string,string>, raw: string, start: number }>}
 */
export function parseHtml(html) {
  if (!html || typeof html !== "string") return [];
  /** @type {Array<{ tag: string, attrs: Record<string,string>, raw: string, start: number }>} */
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrsRaw = m[2] || "";
    /** @type {Record<string,string>} */
    const attrs = {};
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrsRaw))) {
      const name = a[1].toLowerCase();
      const value = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : "";
      attrs[name] = value;
    }
    out.push({ tag, attrs, raw: m[0], start: m.index });
  }
  return out;
}

/**
 * Suggest an ARIA label for an element based on its tag and contents.
 * Returns an empty string if no sensible label can be inferred.
 *
 * @param {{ tag: string, attrs: Record<string,string>, text?: string }} el
 * @returns {string}
 */
export function suggestAriaLabels(el) {
  if (!el || typeof el !== "object") return "";
  const tag = String(el.tag || "").toLowerCase();
  const attrs = el.attrs || {};
  if (attrs["aria-label"]) return attrs["aria-label"];
  if (attrs["alt"]) return attrs["alt"];
  const text = String(el.text || "").trim();
  if (tag === "img" && attrs.src) {
    return attrs.alt || `Image: ${attrs.src.split("/").pop() || "image"}`;
  }
  if (tag === "button") return text || `${attrs.name || "button"} button`;
  if (tag === "a") return text || attrs.title || `Link to ${attrs.href || "destination"}`;
  if (tag === "input") {
    const type = (attrs.type || "text").toLowerCase();
    return attrs.placeholder || attrs.name || `${type} input`;
  }
  if (tag === "iframe") return attrs.title || "Embedded content";
  return "";
}

/**
 * Audit an HTML snippet. Returns a report with issues & suggestions
 * and persists both the report and its individual issues so the fix
 * helpers can update them later.
 *
 * @param {string} html
 * @param {{ id?: string }} [opts]
 * @returns {Promise<{ id: string, html: string, issues: object[], createdAt: string }>}
 */
export async function auditHtml(html, opts = {}) {
  if (typeof html !== "string") throw new Error("html must be a string");
  const id = opts.id && typeof opts.id === "string" ? opts.id : `audit_${Date.now()}`;
  const elements = parseHtml(html);
  /** @type {object[]} */
  const issues = [];
  for (const el of elements) {
    if (el.tag === "img" && !el.attrs.alt && !el.attrs["aria-label"]) {
      issues.push({
        id: `${id}_${issues.length}`,
        auditId: id,
        tag: el.tag,
        severity: "error",
        message: "img is missing an alt attribute",
        suggestion: suggestAriaLabels({ tag: "img", attrs: el.attrs }),
        status: "open",
      });
    }
    if (el.tag === "button" && !el.attrs["aria-label"]) {
      issues.push({
        id: `${id}_${issues.length}`,
        auditId: id,
        tag: el.tag,
        severity: "warning",
        message: "button has no aria-label (ok if it contains visible text)",
        suggestion: suggestAriaLabels({ tag: "button", attrs: el.attrs }),
        status: "open",
      });
    }
    if (el.tag === "a" && !el.attrs.href) {
      issues.push({
        id: `${id}_${issues.length}`,
        auditId: id,
        tag: el.tag,
        severity: "warning",
        message: "anchor tag has no href",
        suggestion: "Add href or use a <button>",
        status: "open",
      });
    }
    if (el.tag === "input" && !el.attrs["aria-label"] && !el.attrs["aria-labelledby"] && !el.attrs.name) {
      issues.push({
        id: `${id}_${issues.length}`,
        auditId: id,
        tag: el.tag,
        severity: "warning",
        message: "input has no accessible name",
        suggestion: suggestAriaLabels({ tag: "input", attrs: el.attrs }),
        status: "open",
      });
    }
    if (el.tag === "iframe" && !el.attrs.title) {
      issues.push({
        id: `${id}_${issues.length}`,
        auditId: id,
        tag: el.tag,
        severity: "error",
        message: "iframe has no title attribute",
        suggestion: "Add title=\"Embedded content\"",
        status: "open",
      });
    }
  }
  const now = new Date().toISOString();
  const report = {
    id,
    html,
    issues,
    createdAt: now,
    elementCount: elements.length,
  };
  await withPathLock(storePath(), async () => {
    const data = await loadStore();
    data.audits[id] = report;
    for (const issue of issues) {
      data.issues[issue.id] = issue;
    }
    await saveStore(data);
  });
  return report;
}

/**
 * Retrieve a stored audit report.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getAuditReport(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.audits[id] || null;
}

/**
 * List all open issues, optionally filtered.
 * @param {{ status?: string, severity?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listIssues(opts = {}) {
  const data = await loadStore();
  let out = Object.values(data.issues || {});
  if (opts.status) out = out.filter((i) => i.status === opts.status);
  if (opts.severity) out = out.filter((i) => i.severity === opts.severity);
  return out;
}

/**
 * Mark an issue as fixed with an optional note.
 * @param {string} issueId
 * @param {{ note?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function fixIssue(issueId, opts = {}) {
  if (!issueId || typeof issueId !== "string") throw new Error("issueId is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const issue = data.issues[issueId];
    if (!issue) throw new Error(`unknown issue: ${issueId}`);
    issue.status = "fixed";
    issue.fixedAt = new Date().toISOString();
    if (opts.note) issue.note = opts.note;
    data.issues[issueId] = issue;
    await saveStore(data);
    return issue;
  });
}
