// @ts-check
/**
 * Phase 51.3: Output classifiers — toxicity, PII, bias, hallucination detection
 * on streaming output.
 *
 * All classifiers in this module are deliberately rule-, keyword- and regex-based;
 * there are no ML dependencies. They are intended as a first-line-of-defense
 * safety net to flag obviously problematic model output, not as production-grade
 * replacements for dedicated moderation services.
 *
 * Exports:
 *   TOXICITY_KEYWORDS, classifyToxicity
 *   PII_PATTERNS, detectPii, redactPii
 *   BIAS_LEXICONS, classifyBias
 *   detectHallucination
 *   StreamingClassifier (class)
 *   classifyOutput
 *   logClassificationEvent, getClassificationStats
 *
 * Storage: JSON-backed via json-path-store.js; events live in
 * <STORAGE_PATH>/output-classifier-events.json.
 *
 * @module output-classifiers
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_EVENTS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// Toxicity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Category-keyword map used by the toxicity classifier. Deliberately generic
 * so tests can be written without exposing slurs. Consumers are expected to
 * extend this via options.extraKeywords if they need broader coverage.
 */
export const TOXICITY_KEYWORDS = Object.freeze({
  hate: Object.freeze([
    "hate",
    "racist",
    "racism",
    "bigot",
    "xenophobe",
    "supremacist",
    "inferior race",
    "subhuman",
    "ethnic cleansing",
  ]),
  violence: Object.freeze([
    "kill",
    "murder",
    "attack",
    "shoot",
    "stab",
    "bomb",
    "assault",
    "behead",
    "lynch",
    "massacre",
    "terrorize",
  ]),
  sexual: Object.freeze([
    "porn",
    "pornographic",
    "explicit sexual",
    "sexual acts",
    "nude minor",
    "child porn",
    "rape",
  ]),
  self_harm: Object.freeze([
    "suicide",
    "kill yourself",
    "kill myself",
    "self-harm",
    "self harm",
    "cut myself",
    "overdose",
    "hang myself",
  ]),
  harassment: Object.freeze([
    "stupid",
    "idiot",
    "moron",
    "loser",
    "worthless",
    "pathetic",
    "dumbass",
    "scumbag",
    "retard",
  ]),
});

/**
 * Simple word-boundary-aware substring search that is still tolerant of
 * punctuation around the keyword.
 */
function containsPhrase(haystack, needle) {
  if (!needle) return false;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx === -1) return false;
  const before = idx === 0 ? "" : h[idx - 1];
  const after = idx + n.length >= h.length ? "" : h[idx + n.length];
  const isWordChar = (c) => /[a-z0-9_]/i.test(c);
  // If the needle already has a space or punctuation we accept any boundary.
  if (/\s|[-]/.test(n)) return true;
  if (before && isWordChar(before)) return false;
  if (after && isWordChar(after)) return false;
  return true;
}

/**
 * @param {string} text
 * @param {{ extraKeywords?: Record<string, string[]> }} [options]
 * @returns {{ toxic: boolean, score: number, categories: Record<string, number>, flagged: Array<{ category: string, keyword: string }> }}
 */
export function classifyToxicity(text, options = {}) {
  const result = {
    toxic: false,
    score: 0,
    categories: {},
    flagged: [],
  };
  if (typeof text !== "string" || text.length === 0) return result;

  const extra = options.extraKeywords || {};
  const categories = { ...TOXICITY_KEYWORDS, ...extra };

  let totalHits = 0;
  for (const [category, keywords] of Object.entries(categories)) {
    let hits = 0;
    for (const kw of keywords) {
      if (containsPhrase(text, kw)) {
        hits += 1;
        result.flagged.push({ category, keyword: kw });
      }
    }
    if (hits > 0) {
      result.categories[category] = hits;
      totalHits += hits;
    }
  }

  if (totalHits > 0) {
    result.toxic = true;
    // Score: saturating at 1 with diminishing returns so a single
    // keyword does not flip to max severity.
    result.score = Math.min(1, 0.3 + totalHits * 0.15);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PII detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regular expressions used by detectPii / redactPii. Each pattern carries the
 * `g` flag so matchAll can iterate over every occurrence.
 */
export const PII_PATTERNS = Object.freeze({
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  credit_card: /\b(?:\d[ -]?){13,19}\b/g,
  ip_address: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  // GitHub personal access tokens, Stripe live keys, OpenAI, generic "sk-..."
  api_key: /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  // Three-segment base64url JWT
  jwt: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
});

/** Luhn check used to validate credit card candidates. */
export function luhnCheck(numStr) {
  const digits = String(numStr).replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * @param {string} text
 * @returns {{ found: boolean, types: string[], matches: Array<{ type: string, value: string, start: number, end: number }> }}
 */
export function detectPii(text) {
  const result = { found: false, types: [], matches: [] };
  if (typeof text !== "string" || text.length === 0) return result;

  const typeSet = new Set();
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    // Reset lastIndex because the frozen regex is shared across calls.
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const value = m[0];
      // Credit card must also pass Luhn to avoid catching arbitrary 13-19 digit
      // numeric runs like timestamps or tracking ids.
      if (type === "credit_card" && !luhnCheck(value)) continue;
      // Phone numbers are very loose; skip values that overlap with an SSN.
      if (type === "phone" && /^\d{3}-\d{2}-\d{4}$/.test(value)) continue;
      result.matches.push({ type, value, start: m.index, end: m.index + value.length });
      typeSet.add(type);
      // Guard against zero-width matches that would infinite-loop.
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // Sort by position for stable output regardless of pattern ordering.
  result.matches.sort((a, b) => a.start - b.start);
  result.types = Array.from(typeSet).sort();
  result.found = result.matches.length > 0;
  return result;
}

function hashValue(value) {
  return "sha256:" + crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

/**
 * @param {string} text
 * @param {{ mode?: "redact" | "hash" | "mask", placeholder?: string, types?: string[] }} [options]
 * @returns {{ text: string, matches: Array<{ type: string, value: string, start: number, end: number }>, redactedCount: number }}
 */
export function redactPii(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", matches: [], redactedCount: 0 };
  }
  const mode = options.mode || "redact";
  const placeholder = options.placeholder || "[REDACTED]";
  const onlyTypes = Array.isArray(options.types) && options.types.length > 0 ? new Set(options.types) : null;

  const { matches } = detectPii(text);
  const filtered = onlyTypes ? matches.filter((m) => onlyTypes.has(m.type)) : matches;
  if (filtered.length === 0) {
    return { text, matches: [], redactedCount: 0 };
  }

  // Walk from end to start so slice indices stay valid.
  const sorted = [...filtered].sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of sorted) {
    let replacement;
    if (mode === "hash") replacement = `[${m.type.toUpperCase()}:${hashValue(m.value)}]`;
    else if (mode === "mask") replacement = "*".repeat(Math.max(4, m.value.length));
    else replacement = placeholder;
    out = out.slice(0, m.start) + replacement + out.slice(m.end);
  }
  return { text: out, matches: filtered, redactedCount: filtered.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bias detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lexicons used by the bias classifier. These are grouped by protected class
 * and are combined with "trigger" words that indicate a stereotype is being
 * stated rather than described neutrally.
 */
export const BIAS_LEXICONS = Object.freeze({
  gender: Object.freeze([
    "women are",
    "men are",
    "girls are",
    "boys are",
    "females are",
    "males are",
    "a woman's place",
    "a man's job",
  ]),
  race: Object.freeze([
    "black people are",
    "white people are",
    "asians are",
    "hispanics are",
    "latinos are",
    "arabs are",
    "jews are",
  ]),
  age: Object.freeze([
    "old people are",
    "young people are",
    "boomers are",
    "millennials are",
    "gen z is",
    "elderly are",
  ]),
  religion: Object.freeze([
    "christians are",
    "muslims are",
    "jews are",
    "hindus are",
    "buddhists are",
    "atheists are",
  ]),
});

const BIAS_TRIGGERS = Object.freeze([
  "inferior",
  "superior",
  "stupid",
  "smart",
  "lazy",
  "violent",
  "greedy",
  "aggressive",
  "weak",
  "strong",
  "bad at",
  "good at",
  "always",
  "never",
  "all of them",
]);

/**
 * @param {string} text
 * @returns {{ biased: boolean, score: number, categories: Record<string, number>, flagged: Array<{ category: string, phrase: string }> }}
 */
export function classifyBias(text) {
  const result = { biased: false, score: 0, categories: {}, flagged: [] };
  if (typeof text !== "string" || text.length === 0) return result;

  const lower = text.toLowerCase();
  let totalHits = 0;
  for (const [category, phrases] of Object.entries(BIAS_LEXICONS)) {
    let hits = 0;
    for (const phrase of phrases) {
      const idx = lower.indexOf(phrase);
      if (idx === -1) continue;
      // Look for a trigger word within 40 chars after the phrase.
      const window = lower.slice(idx, idx + phrase.length + 40);
      const hasTrigger = BIAS_TRIGGERS.some((t) => window.includes(t));
      if (hasTrigger) {
        hits += 1;
        result.flagged.push({ category, phrase });
      }
    }
    if (hits > 0) {
      result.categories[category] = hits;
      totalHits += hits;
    }
  }

  if (totalHits > 0) {
    result.biased = true;
    result.score = Math.min(1, 0.4 + totalHits * 0.2);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hallucination heuristic
// ─────────────────────────────────────────────────────────────────────────────

const HEDGE_WORDS = [
  "maybe",
  "perhaps",
  "possibly",
  "might",
  "could",
  "i think",
  "i believe",
  "i'm not sure",
  "it seems",
  "appears",
  "probably",
  "likely",
  "in some cases",
  "according to",
];

const CONFIDENT_MARKERS = [
  "definitely",
  "certainly",
  "absolutely",
  "undoubtedly",
  "always",
  "never",
  "exactly",
  "precisely",
  "without question",
  "it is a fact",
  "it's a fact",
  "proven",
  "clearly",
];

/** Tokenize lowercased, alphanumeric word tokens. */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

/** Jaccard similarity on token sets, in [0, 1]. */
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * @param {string} text
 * @param {string | string[] | null} [groundTruth]
 * @returns {{ likelyHallucination: boolean, confidence: number, flags: string[], overlap?: number }}
 */
export function detectHallucination(text, groundTruth = null) {
  const result = { likelyHallucination: false, confidence: 0, flags: [] };
  if (typeof text !== "string" || text.length === 0) return result;

  const lower = text.toLowerCase();
  const hedgeHits = HEDGE_WORDS.filter((w) => lower.includes(w)).length;
  const confidentHits = CONFIDENT_MARKERS.filter((w) => lower.includes(w)).length;

  // "Confident numbers" — specific numeric claims without hedges.
  const numberHits = (text.match(/\b\d{2,}(?:\.\d+)?%?\b/g) || []).length;
  const yearHits = (text.match(/\b(?:1[89]\d{2}|20\d{2})\b/g) || []).length;

  if (confidentHits > 0 && hedgeHits === 0) {
    result.flags.push("confident_unhedged");
    result.confidence += 0.3 + confidentHits * 0.1;
  }
  if (numberHits >= 2 && hedgeHits === 0) {
    result.flags.push("specific_numbers_unhedged");
    result.confidence += 0.2;
  }
  if (yearHits >= 2 && hedgeHits === 0) {
    result.flags.push("multiple_years_unhedged");
    result.confidence += 0.15;
  }
  if (/\b(?:according to|as reported by|as stated in)\b [A-Za-z ]+/i.test(text) && hedgeHits === 0) {
    result.flags.push("unverifiable_citation");
    result.confidence += 0.2;
  }

  if (groundTruth != null) {
    const truth = Array.isArray(groundTruth) ? groundTruth.join(" ") : String(groundTruth);
    const overlap = jaccard(text, truth);
    result.overlap = overlap;
    if (overlap < 0.1) {
      result.flags.push("no_overlap_with_ground_truth");
      result.confidence += 0.4;
    } else if (overlap < 0.3) {
      result.flags.push("low_overlap_with_ground_truth");
      result.confidence += 0.2;
    } else {
      // High overlap strongly suggests grounded output; reduce confidence.
      result.confidence = Math.max(0, result.confidence - 0.2);
    }
  }

  result.confidence = Math.max(0, Math.min(1, result.confidence));
  result.likelyHallucination = result.confidence >= 0.5;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accumulates streaming text chunks and runs classifiers incrementally. A
 * running score is kept so the caller can abort a stream the moment a category
 * threshold is crossed, without waiting for completion.
 *
 * Usage:
 *   const sc = new StreamingClassifier({ blockOnToxic: true });
 *   for (const chunk of stream) {
 *     const r = sc.feed(chunk);
 *     if (r.blocked) { abort(); break; }
 *   }
 *   const report = sc.getFinalReport();
 */
export class StreamingClassifier {
  /**
   * @param {{
   *   blockOnToxic?: boolean,
   *   blockOnPii?: boolean,
   *   blockOnBias?: boolean,
   *   toxicityThreshold?: number,
   *   biasThreshold?: number,
   *   maxBuffer?: number,
   *   classifyEveryNChars?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.options = {
      blockOnToxic: options.blockOnToxic ?? true,
      blockOnPii: options.blockOnPii ?? false,
      blockOnBias: options.blockOnBias ?? false,
      toxicityThreshold: options.toxicityThreshold ?? 0.5,
      biasThreshold: options.biasThreshold ?? 0.5,
      maxBuffer: options.maxBuffer ?? 200_000,
      classifyEveryNChars: options.classifyEveryNChars ?? 200,
    };
    this.reset();
  }

  reset() {
    this.buffer = "";
    this.chunkCount = 0;
    this.bytesSinceLastScan = 0;
    this.blocked = false;
    this.violation = null;
  }

  /**
   * @param {string} chunk
   * @returns {{ blocked: boolean, violation?: object }}
   */
  feed(chunk) {
    if (this.blocked) return { blocked: true, violation: this.violation };
    if (typeof chunk !== "string" || chunk.length === 0) return { blocked: false };

    this.buffer += chunk;
    this.chunkCount += 1;
    this.bytesSinceLastScan += chunk.length;

    if (this.buffer.length > this.options.maxBuffer) {
      // Keep the tail so we can still detect spans that cross chunk boundaries.
      const tail = this.buffer.slice(-this.options.maxBuffer);
      this.buffer = tail;
    }

    if (this.bytesSinceLastScan < this.options.classifyEveryNChars) {
      return { blocked: false };
    }
    this.bytesSinceLastScan = 0;

    const tox = classifyToxicity(this.buffer);
    if (this.options.blockOnToxic && tox.score >= this.options.toxicityThreshold) {
      this.blocked = true;
      this.violation = { type: "toxicity", detail: tox };
      return { blocked: true, violation: this.violation };
    }

    const pii = detectPii(this.buffer);
    if (this.options.blockOnPii && pii.found) {
      this.blocked = true;
      this.violation = { type: "pii", detail: pii };
      return { blocked: true, violation: this.violation };
    }

    const bias = classifyBias(this.buffer);
    if (this.options.blockOnBias && bias.score >= this.options.biasThreshold) {
      this.blocked = true;
      this.violation = { type: "bias", detail: bias };
      return { blocked: true, violation: this.violation };
    }

    return { blocked: false };
  }

  /**
   * Finalize the stream and run one last pass over the full buffer. Callers
   * should always invoke this, even when no chunks hit the threshold, so that
   * short streams (shorter than classifyEveryNChars) are still scanned.
   */
  getFinalReport() {
    const toxicity = classifyToxicity(this.buffer);
    const pii = detectPii(this.buffer);
    const bias = classifyBias(this.buffer);
    const hallucination = detectHallucination(this.buffer);

    return {
      blocked: this.blocked,
      violation: this.violation,
      chunkCount: this.chunkCount,
      bufferLength: this.buffer.length,
      toxicity,
      pii,
      bias,
      hallucination,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified classifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @param {{ groundTruth?: string | string[] | null, includeFlagged?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function classifyOutput(text, options = {}) {
  const toxicity = classifyToxicity(text);
  const pii = detectPii(text);
  const bias = classifyBias(text);
  const hallucination = detectHallucination(text, options.groundTruth ?? null);

  const safe = !toxicity.toxic && !pii.found && !bias.biased && !hallucination.likelyHallucination;
  const severity = [toxicity.score, pii.found ? 1 : 0, bias.score, hallucination.confidence]
    .reduce((a, b) => Math.max(a, b), 0);

  const report = {
    safe,
    severity,
    toxicity,
    pii: {
      found: pii.found,
      types: pii.types,
      count: pii.matches.length,
      ...(options.includeFlagged ? { matches: pii.matches } : {}),
    },
    bias,
    hallucination,
  };
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: classification events
// ─────────────────────────────────────────────────────────────────────────────

function storePath() {
  return join(getDataDir(), "output-classifier-events.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    events: Array.isArray(base.events) ? base.events : [],
  };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), {}));
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

/**
 * Persist a single classification event. Events are kept in a ring buffer
 * capped at MAX_EVENTS so tests and long-running servers do not grow unbounded.
 *
 * @param {{
 *   id?: string,
 *   timestamp?: number,
 *   workspaceId?: string | null,
 *   userId?: string | null,
 *   source?: string,
 *   text?: string,
 *   report?: object,
 * }} event
 * @returns {Promise<object>}
 */
export async function logClassificationEvent(event) {
  const record = {
    id: event.id || crypto.randomUUID(),
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
    workspaceId: event.workspaceId ?? null,
    userId: event.userId ?? null,
    source: event.source || "unknown",
    // Never persist raw text — only a truncated preview and a hash so operators
    // can spot duplicates without retaining the PII itself.
    textPreview: typeof event.text === "string" ? event.text.slice(0, 200) : null,
    textHash: typeof event.text === "string" ? hashValue(event.text) : null,
    report: event.report || null,
  };

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.events.push(record);
    if (store.events.length > MAX_EVENTS) {
      store.events = store.events.slice(-MAX_EVENTS);
    }
    await saveStore(store);
  });

  return record;
}

/**
 * @param {{ from?: number, to?: number, workspaceId?: string, source?: string }} [timeRange]
 * @returns {Promise<object>}
 */
export async function getClassificationStats(timeRange = {}) {
  const store = await loadStore();
  const from = typeof timeRange.from === "number" ? timeRange.from : 0;
  const to = typeof timeRange.to === "number" ? timeRange.to : Number.MAX_SAFE_INTEGER;

  let total = 0;
  let toxic = 0;
  let pii = 0;
  let biased = 0;
  let hallucination = 0;
  const byCategory = { toxicity: {}, bias: {}, pii: {} };
  const bySource = {};

  for (const e of store.events) {
    if (e.timestamp < from || e.timestamp > to) continue;
    if (timeRange.workspaceId && e.workspaceId !== timeRange.workspaceId) continue;
    if (timeRange.source && e.source !== timeRange.source) continue;
    total += 1;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
    const r = e.report || {};
    if (r.toxicity?.toxic) {
      toxic += 1;
      for (const c of Object.keys(r.toxicity.categories || {})) {
        byCategory.toxicity[c] = (byCategory.toxicity[c] || 0) + 1;
      }
    }
    if (r.pii?.found) {
      pii += 1;
      for (const t of r.pii.types || []) {
        byCategory.pii[t] = (byCategory.pii[t] || 0) + 1;
      }
    }
    if (r.bias?.biased) {
      biased += 1;
      for (const c of Object.keys(r.bias.categories || {})) {
        byCategory.bias[c] = (byCategory.bias[c] || 0) + 1;
      }
    }
    if (r.hallucination?.likelyHallucination) hallucination += 1;
  }

  return {
    total,
    toxic,
    pii,
    biased,
    hallucination,
    byCategory,
    bySource,
    range: { from, to },
  };
}

/**
 * Test-only: wipe persisted events.
 * @returns {Promise<void>}
 */
export async function _resetStore() {
  await writeJsonPath(storePath(), { _version: STORE_VERSION, events: [] });
}
