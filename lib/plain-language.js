// @ts-check
/**
 * Phase 70.5: Plain-language mode.
 *
 * Computes Flesch Reading Ease over a block of text, simplifies it
 * by swapping complex words for plain-language synonyms, and
 * supports a user-extendable synonym rule set.
 *
 * The syllable counter is a heuristic that handles most English
 * words acceptably — it is not a pronunciation dictionary.
 *
 * Exports:
 *   - computeReadability
 *   - simplifyText
 *   - listSynonymRules
 *   - addSynonymRule
 *   - grade
 *
 * @module plain-language
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_SYNONYMS = [
  { from: "utilize", to: "use" },
  { from: "commence", to: "start" },
  { from: "terminate", to: "end" },
  { from: "purchase", to: "buy" },
  { from: "approximately", to: "about" },
  { from: "subsequently", to: "then" },
  { from: "assistance", to: "help" },
  { from: "endeavor", to: "try" },
  { from: "demonstrate", to: "show" },
  { from: "facilitate", to: "help" },
  { from: "additional", to: "more" },
  { from: "initiate", to: "start" },
  { from: "methodology", to: "method" },
];

function storePath() {
  return join(getDataDir(), "plain-language-rules.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, rules: [] });
  if (!Array.isArray(data.rules) || data.rules.length === 0) {
    data.rules = DEFAULT_SYNONYMS.slice();
  }
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, rules: data.rules || [] });
}

/**
 * Count syllables in a word using a vowel-group heuristic. Handles
 * silent 'e' at the end and consecutive vowels as a single group.
 *
 * @param {string} word
 * @returns {number}
 */
export function countSyllables(word) {
  if (!word || typeof word !== "string") return 0;
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/e\b/g, "").match(/[aeiouy]+/g);
  const n = groups ? groups.length : 0;
  return Math.max(1, n);
}

/**
 * Split text into sentences using terminal punctuation.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split a string into raw word tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function splitWords(text) {
  if (!text || typeof text !== "string") return [];
  return text.split(/\s+/).map((w) => w.replace(/[^a-zA-Z']/g, "")).filter(Boolean);
}

/**
 * Compute Flesch Reading Ease for a block of text. Returns the score
 * plus the component counts used in the formula.
 *
 * @param {string} text
 * @returns {{ score: number, sentences: number, words: number, syllables: number }}
 */
export function computeReadability(text) {
  if (!text || typeof text !== "string") {
    return { score: 0, sentences: 0, words: 0, syllables: 0 };
  }
  const sentences = splitSentences(text);
  const words = splitWords(text);
  if (sentences.length === 0 || words.length === 0) {
    return { score: 0, sentences: sentences.length, words: words.length, syllables: 0 };
  }
  let syllables = 0;
  for (const w of words) syllables += countSyllables(w);
  const wordsPerSentence = words.length / sentences.length;
  const syllablesPerWord = syllables / words.length;
  const score = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  return {
    score: Math.round(score * 100) / 100,
    sentences: sentences.length,
    words: words.length,
    syllables,
  };
}

/**
 * Map a Flesch Reading Ease score to a human-friendly grade.
 * @param {number} score
 * @returns {string}
 */
export function grade(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score >= 90) return "very easy";
  if (score >= 80) return "easy";
  if (score >= 70) return "fairly easy";
  if (score >= 60) return "standard";
  if (score >= 50) return "fairly difficult";
  if (score >= 30) return "difficult";
  return "very difficult";
}

/**
 * Simplify a text by applying synonym rules and shortening very
 * long sentences by splitting on coordinators.
 *
 * @param {string} text
 * @param {{ extraRules?: Array<{ from: string, to: string }> }} [opts]
 * @returns {Promise<{ text: string, replacements: number, readabilityBefore: object, readabilityAfter: object }>}
 */
export async function simplifyText(text, opts = {}) {
  if (typeof text !== "string") throw new Error("text must be a string");
  const data = await loadStore();
  const rules = Array.isArray(data.rules) ? data.rules.slice() : [];
  if (Array.isArray(opts.extraRules)) rules.push(...opts.extraRules);
  const before = computeReadability(text);
  let out = text;
  let replacements = 0;
  for (const rule of rules) {
    if (!rule || typeof rule.from !== "string" || typeof rule.to !== "string") continue;
    const re = new RegExp(`\\b${escapeRegex(rule.from)}\\b`, "gi");
    out = out.replace(re, (match) => {
      replacements += 1;
      return preserveCase(match, rule.to);
    });
  }
  // Split very long sentences (> 25 words) at ", and" / ", but".
  out = out
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const words = splitWords(sentence);
      if (words.length <= 25) return sentence;
      return sentence.replace(/,\s+(and|but|or)\s+/gi, ". ");
    })
    .join(" ");
  const after = computeReadability(out);
  return {
    text: out,
    replacements,
    readabilityBefore: before,
    readabilityAfter: after,
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preserveCase(original, replacement) {
  if (!original) return replacement;
  if (original.toUpperCase() === original) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * List every synonym rule (defaults + persisted additions).
 * @returns {Promise<Array<{ from: string, to: string }>>}
 */
export async function listSynonymRules() {
  const data = await loadStore();
  return Array.isArray(data.rules) ? data.rules.slice() : [];
}

/**
 * Persist a new synonym rule. Replaces any existing rule with the
 * same `from` keyword.
 *
 * @param {{ from: string, to: string }} rule
 * @returns {Promise<Array<{ from: string, to: string }>>}
 */
export async function addSynonymRule(rule) {
  if (!rule || typeof rule !== "object") throw new Error("rule is required");
  if (typeof rule.from !== "string" || !rule.from.trim()) throw new Error("rule.from is required");
  if (typeof rule.to !== "string" || !rule.to.trim()) throw new Error("rule.to is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rules = data.rules || [];
    const idx = rules.findIndex((r) => r.from.toLowerCase() === rule.from.toLowerCase());
    const normalized = { from: rule.from.toLowerCase(), to: rule.to };
    if (idx >= 0) rules[idx] = normalized;
    else rules.push(normalized);
    data.rules = rules;
    await saveStore(data);
    return rules.slice();
  });
}
