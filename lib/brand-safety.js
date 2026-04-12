/**
 * Phase 67.4: Brand safety — configurable rules engine.
 *
 * Rule kinds:
 *   - keyword : matches when content contains any of the provided terms (case-insensitive).
 *   - regex   : matches when any of the provided regex patterns hit.
 *   - negated : a keyword rule with a nearby-context exclusion. The base pattern
 *               must match AND a negation pattern must NOT appear within
 *               `windowChars` characters before/after the hit (e.g. "not a",
 *               "don't") to suppress false positives.
 *
 * Rules carry severity (info/warn/block) and tags. `evaluateContent` returns
 * all hits sorted by severity and allows the caller to decide policy.
 *
 * Storage:
 *   data/brand-safety/{id}.json      — rule record
 *   data/brand-safety/_index.json    — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const RULE_KIND_KEYWORD = "keyword";
export const RULE_KIND_REGEX = "regex";
export const RULE_KIND_NEGATED = "negated";
const RULE_KINDS = new Set([RULE_KIND_KEYWORD, RULE_KIND_REGEX, RULE_KIND_NEGATED]);

export const SEVERITY_INFO = "info";
export const SEVERITY_WARN = "warn";
export const SEVERITY_BLOCK = "block";
const SEVERITIES = new Set([SEVERITY_INFO, SEVERITY_WARN, SEVERITY_BLOCK]);
const SEVERITY_RANK = { info: 1, warn: 2, block: 3 };

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function rulePath(id) {
  return join(getDataDir(), "brand-safety", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "brand-safety", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { rules: [] });
    const list = Array.isArray(idx.rules) ? idx.rules : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { rules: filtered });
  });
}

// ─── Pattern compilation ───────────────────────────────────────────────────

function compileKeywords(keywords) {
  const arr = Array.isArray(keywords) ? keywords.filter((k) => typeof k === "string" && k.trim()) : [];
  return arr.map((k) => k.trim());
}

function compileRegex(patterns) {
  const arr = Array.isArray(patterns) ? patterns : [];
  const compiled = [];
  for (const p of arr) {
    if (typeof p !== "string" || !p) continue;
    try {
      compiled.push(new RegExp(p, "i"));
    } catch {
      // Skip invalid patterns.
    }
  }
  return compiled;
}

function findKeywordHits(content, keyword) {
  const lower = content.toLowerCase();
  const needle = keyword.toLowerCase();
  const hits = [];
  if (!needle) return hits;
  let start = 0;
  while (start < lower.length) {
    const idx = lower.indexOf(needle, start);
    if (idx < 0) break;
    hits.push({ index: idx, match: content.slice(idx, idx + needle.length) });
    start = idx + needle.length;
  }
  return hits;
}

function findRegexHits(content, regex) {
  const hits = [];
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  let m;
  while ((m = re.exec(content)) !== null) {
    hits.push({ index: m.index, match: m[0] });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return hits;
}

function isNegated(content, hit, negators, windowChars) {
  const start = Math.max(0, hit.index - windowChars);
  const end = Math.min(content.length, hit.index + hit.match.length + windowChars);
  const window = content.slice(start, end).toLowerCase();
  for (const n of negators) {
    if (typeof n === "string") {
      if (window.includes(n.toLowerCase())) return true;
    }
  }
  return false;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a brand safety rule.
 */
export async function createRule({
  name,
  kind,
  severity,
  keywords,
  patterns,
  negators,
  windowChars,
  tags,
  description,
  enabled,
} = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!kind || !RULE_KINDS.has(kind)) {
    throw new Error(`kind must be one of ${[...RULE_KINDS].join(", ")}`);
  }
  if (severity && !SEVERITIES.has(severity)) {
    throw new Error(`severity must be one of ${[...SEVERITIES].join(", ")}`);
  }
  const compiledKeywords = compileKeywords(keywords);
  const compiledPatterns = compileRegex(patterns);
  if (kind === RULE_KIND_KEYWORD || kind === RULE_KIND_NEGATED) {
    if (compiledKeywords.length === 0) {
      throw new Error("keywords array is required for this rule kind");
    }
  }
  if (kind === RULE_KIND_REGEX) {
    if (compiledPatterns.length === 0) {
      throw new Error("patterns array is required for regex rule");
    }
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name,
    kind,
    severity: severity || SEVERITY_WARN,
    keywords: compiledKeywords,
    patterns: Array.isArray(patterns) ? patterns.filter((p) => typeof p === "string") : [],
    negators: kind === RULE_KIND_NEGATED
      ? (Array.isArray(negators) ? negators.map(String) : [])
      : [],
    windowChars: Math.max(0, Math.min(500, Number(windowChars) || 40)),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    description: description || "",
    enabled: enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonPath(rulePath(id), record);
  await updateIndex(id, false, { id, name, kind, createdAt: now });
  return record;
}

export async function getRule(id) {
  if (!id) return null;
  const rec = await readJsonPath(rulePath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listRules(filter = {}) {
  const idx = await readJsonPath(indexPath(), { rules: [] });
  const entries = Array.isArray(idx.rules) ? idx.rules : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getRule(entry.id);
    if (!rec) continue;
    if (filter.kind && rec.kind !== filter.kind) continue;
    if (filter.severity && rec.severity !== filter.severity) continue;
    if (filter.tag && !rec.tags.includes(filter.tag)) continue;
    if (filter.enabled != null && rec.enabled !== Boolean(filter.enabled)) continue;
    records.push(rec);
  }
  return records;
}

export async function updateRule(id, patch = {}) {
  return withPathLock(rulePath(id), async () => {
    const rec = await readJsonPath(rulePath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`rule ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (patch.name != null) rec.name = String(patch.name);
    if (patch.severity != null && SEVERITIES.has(patch.severity)) rec.severity = patch.severity;
    if (patch.keywords != null) rec.keywords = compileKeywords(patch.keywords);
    if (patch.patterns != null) rec.patterns = patch.patterns.filter((p) => typeof p === "string");
    if (patch.negators != null) rec.negators = patch.negators.map(String);
    if (patch.windowChars != null) rec.windowChars = Math.max(0, Math.min(500, Number(patch.windowChars) || 40));
    if (patch.tags != null) rec.tags = patch.tags.map(String);
    if (patch.description != null) rec.description = String(patch.description);
    if (patch.enabled != null) rec.enabled = Boolean(patch.enabled);
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(rulePath(id), rec);
    return rec;
  });
}

export async function deleteRule(id) {
  const rec = await getRule(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(rulePath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

// ─── Evaluation ────────────────────────────────────────────────────────────

function evaluateRule(rule, content) {
  const hits = [];
  if (!rule || !rule.enabled) return hits;
  const kwHits = [];
  for (const kw of rule.keywords || []) {
    kwHits.push(...findKeywordHits(content, kw).map((h) => ({ ...h, keyword: kw })));
  }
  const reHits = [];
  const compiledRegexes = compileRegex(rule.patterns || []);
  for (const re of compiledRegexes) {
    reHits.push(...findRegexHits(content, re).map((h) => ({ ...h, pattern: re.source })));
  }
  const base = [...kwHits, ...reHits];
  for (const h of base) {
    if (rule.kind === RULE_KIND_NEGATED) {
      if (isNegated(content, h, rule.negators || [], rule.windowChars || 40)) continue;
    }
    hits.push({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      index: h.index,
      match: h.match,
      keyword: h.keyword,
      pattern: h.pattern,
    });
  }
  return hits;
}

/**
 * Evaluate content against all enabled rules (or a supplied subset).
 * Returns { hits[], highestSeverity, blocked } ordered by severity desc.
 */
export async function evaluateContent(content, { ruleIds, rules: provided } = {}) {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  const all = Array.isArray(provided) ? provided : await listRules();
  const pool = Array.isArray(ruleIds) && ruleIds.length > 0
    ? all.filter((r) => ruleIds.includes(r.id))
    : all;
  const allHits = [];
  for (const rule of pool) {
    allHits.push(...evaluateRule(rule, content));
  }
  allHits.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  const highestSeverity = allHits.length > 0 ? allHits[0].severity : null;
  return {
    hits: allHits,
    highestSeverity,
    blocked: highestSeverity === SEVERITY_BLOCK,
    evaluatedRules: pool.length,
  };
}

export const _internals = {
  rulePath,
  indexPath,
  evaluateRule,
  findKeywordHits,
  findRegexHits,
  isNegated,
};
