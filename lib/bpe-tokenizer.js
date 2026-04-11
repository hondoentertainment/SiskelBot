/**
 * Minimal BPE tokenizer based on Karpathy's minbpe.
 * Pure JavaScript, no external dependencies.
 *
 * Educational reference implementation of the Byte-Pair Encoding algorithm
 * used by GPT-2, GPT-4, Claude, Llama, and most modern LLMs.
 *
 * References:
 *   - https://github.com/karpathy/minbpe
 *   - "Let's build the GPT Tokenizer" by Andrej Karpathy
 *     https://www.youtube.com/watch?v=zduSFxRajkE
 *   - Sennrich et al. 2015 "Neural Machine Translation of Rare Words with Subword Units"
 *     https://arxiv.org/abs/1508.07909
 *
 * The algorithm in one paragraph:
 *   Start with the raw UTF-8 byte stream of a corpus (256 base tokens, one per
 *   byte). Repeatedly find the most frequent adjacent pair of tokens, mint a
 *   new token id for that pair, and replace every occurrence of the pair with
 *   the new id. Stop once the desired vocab size is reached. Encoding a new
 *   string re-applies the learned merges greedily in the order they were
 *   learned (lowest-id merge first). Decoding simply concatenates the bytes
 *   each token stands for and interprets them as UTF-8.
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Split patterns (Karpathy's minbpe uses the Python regex module which supports
// possessive quantifiers; JavaScript does not, so we drop the possessive `+`
// modifier. The resulting pattern is equivalent for well-formed input.)
// ---------------------------------------------------------------------------

export const GPT2_SPLIT_PATTERN =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

export const GPT4_SPLIT_PATTERN =
  /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+$|\s+(?!\S)|\s/gu;

// ---------------------------------------------------------------------------
// Low-level utilities
// ---------------------------------------------------------------------------

/**
 * Count the frequency of consecutive id pairs in an array (or across a list
 * of arrays). Returns a Map keyed by the string "a,b" so that Map equality
 * works on the tuple. Callers that want the numeric pair should split the key.
 *
 * @param {number[] | number[][]} ids
 * @param {Map<string, number>} [counts] - optional accumulator
 * @returns {Map<string, number>}
 */
export function getStats(ids, counts) {
  const out = counts || new Map();
  if (ids.length === 0) return out;
  // Support both a single id array and a list of chunk arrays.
  if (Array.isArray(ids[0])) {
    for (const chunk of ids) {
      for (let i = 0; i < chunk.length - 1; i++) {
        const key = chunk[i] + "," + chunk[i + 1];
        out.set(key, (out.get(key) || 0) + 1);
      }
    }
    return out;
  }
  for (let i = 0; i < ids.length - 1; i++) {
    const key = ids[i] + "," + ids[i + 1];
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

/**
 * Replace every occurrence of the given pair in `ids` with `newId`.
 * Returns a new array and does not mutate the input.
 *
 * @param {number[]} ids
 * @param {[number, number]} pair
 * @param {number} newId
 * @returns {number[]}
 */
export function merge(ids, pair, newId) {
  const [a, b] = pair;
  const out = [];
  let i = 0;
  while (i < ids.length) {
    if (i < ids.length - 1 && ids[i] === a && ids[i + 1] === b) {
      out.push(newId);
      i += 2;
    } else {
      out.push(ids[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * GPT-2's reversible byte-to-unicode mapping. Every one of the 256 byte values
 * gets mapped to a printable Unicode character so that tokens never contain
 * control characters when serialized as text. Returns a Map<number, string>.
 *
 * This is the same mapping used by tiktoken/HF GPT-2.
 */
export function bytesToUnicode() {
  const bs = [];
  // Visible ASCII range and visible Latin-1 supplement ranges.
  for (let b = "!".charCodeAt(0); b <= "~".charCodeAt(0); b++) bs.push(b);
  for (let b = "¡".charCodeAt(0); b <= "¬".charCodeAt(0); b++) bs.push(b);
  for (let b = "®".charCodeAt(0); b <= "ÿ".charCodeAt(0); b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) {
    map.set(bs[i], String.fromCodePoint(cs[i]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// BasicBPETokenizer — the simplest possible BPE: train directly on the byte
// stream of the whole corpus with no pre-tokenization.
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

function bytesFromString(text) {
  return Array.from(TEXT_ENCODER.encode(text));
}

function bytesFromBufferLike(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf);
}

/**
 * The base BPE tokenizer. Subclass this and override train/encode to add
 * regex pre-tokenization or special-token handling.
 */
export class BasicBPETokenizer {
  constructor() {
    /** @type {Map<string, number>} string "a,b" -> new id */
    this.merges = new Map();
    /** @type {Map<number, Uint8Array>} id -> raw bytes */
    this.vocab = new Map();
    /** @type {RegExp | null} */
    this.pattern = null;
    /** @type {Map<string, number>} special token string -> id */
    this.specialTokens = new Map();
    this._buildInitialVocab();
  }

  _buildInitialVocab() {
    this.vocab = new Map();
    for (let i = 0; i < 256; i++) {
      this.vocab.set(i, new Uint8Array([i]));
    }
  }

  /**
   * Train on a text corpus until the vocabulary reaches `vocabSize` tokens.
   * @param {string} text
   * @param {number} vocabSize - must be >= 256
   * @param {boolean} [verbose=false]
   */
  train(text, vocabSize, verbose = false) {
    if (vocabSize < 256) {
      throw new Error("vocabSize must be >= 256 (one entry per byte)");
    }
    const numMerges = vocabSize - 256;

    let ids = bytesFromString(text);
    this.merges = new Map();
    this._buildInitialVocab();

    for (let i = 0; i < numMerges; i++) {
      const stats = getStats(ids);
      if (stats.size === 0) break;
      const topKey = pickMostFrequent(stats);
      if (!topKey) break;
      const [a, b] = topKey.split(",").map(Number);
      const newId = 256 + i;
      ids = merge(ids, [a, b], newId);
      this.merges.set(topKey, newId);
      const bytesA = this.vocab.get(a);
      const bytesB = this.vocab.get(b);
      const combined = new Uint8Array(bytesA.length + bytesB.length);
      combined.set(bytesA, 0);
      combined.set(bytesB, bytesA.length);
      this.vocab.set(newId, combined);
      if (verbose) {
        console.log(
          `merge ${i + 1}/${numMerges}: (${a},${b}) -> ${newId} ` +
            `(${safeDecodeBytes(combined)}) count=${stats.get(topKey)}`,
        );
      }
    }
  }

  /**
   * Encode text to a flat array of token ids by applying learned merges
   * greedily. Lowest-id merges are applied first, which matches Karpathy's
   * ordering and is the same thing tiktoken does.
   *
   * @param {string} text
   * @returns {number[]}
   */
  encode(text) {
    const ids = bytesFromString(text);
    return this._encodeChunk(ids);
  }

  _encodeChunk(ids) {
    if (ids.length < 2) return ids.slice();
    let cur = ids.slice();
    while (cur.length >= 2) {
      const stats = getStats(cur);
      // Find the pair with the lowest merge id — i.e. the one learned earliest.
      let bestKey = null;
      let bestId = Infinity;
      for (const key of stats.keys()) {
        const id = this.merges.get(key);
        if (id !== undefined && id < bestId) {
          bestId = id;
          bestKey = key;
        }
      }
      if (bestKey === null) break;
      const [a, b] = bestKey.split(",").map(Number);
      cur = merge(cur, [a, b], bestId);
    }
    return cur;
  }

  /**
   * Decode a flat array of ids back to a JS string. Unknown ids are dropped.
   * Invalid UTF-8 is replaced with U+FFFD (standard WHATWG decoder behavior).
   *
   * @param {number[]} ids
   * @returns {string}
   */
  decode(ids) {
    const parts = [];
    let total = 0;
    for (const id of ids) {
      if (this.specialTokens && this._specialTokenById?.has?.(id)) {
        const bytes = TEXT_ENCODER.encode(this._specialTokenById.get(id));
        parts.push(bytes);
        total += bytes.length;
        continue;
      }
      const bytes = this.vocab.get(id);
      if (!bytes) continue;
      parts.push(bytes);
      total += bytes.length;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      joined.set(p, offset);
      offset += p.length;
    }
    return TEXT_DECODER.decode(joined);
  }

  /**
   * Register a special token (e.g. "<|endoftext|>") with a specific id.
   * Special tokens are never produced by training — the user assigns them.
   */
  registerSpecialToken(token, id) {
    if (typeof token !== "string" || !token.length) {
      throw new Error("special token must be a non-empty string");
    }
    if (!Number.isInteger(id) || id < 0) {
      throw new Error("special token id must be a non-negative integer");
    }
    this.specialTokens.set(token, id);
    if (!this._specialTokenById) this._specialTokenById = new Map();
    this._specialTokenById.set(id, token);
    // Store the utf-8 bytes in the vocab so decode() works even without the
    // side-channel lookup.
    this.vocab.set(id, TEXT_ENCODER.encode(token));
  }

  /**
   * Serialize to Karpathy's .model format:
   *   line 1: "minbpe v1"
   *   line 2: pattern source (or empty string)
   *   line 3: number of special tokens
   *   next N lines: "<token> <id>" for each special
   *   remaining: one "a b" per merge, implicit id = 256 + index
   *
   * @param {string} path
   */
  save(path) {
    const lines = [];
    lines.push("minbpe v1");
    lines.push(this.pattern ? this.pattern.source : "");
    lines.push(String(this.specialTokens.size));
    for (const [tok, id] of this.specialTokens) {
      lines.push(`${tok} ${id}`);
    }
    // Merges must be in id order to be replayable.
    const merges = Array.from(this.merges.entries()).sort(
      (x, y) => x[1] - y[1],
    );
    for (const [key] of merges) {
      const [a, b] = key.split(",");
      lines.push(`${a} ${b}`);
    }
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
  }

  /**
   * Restore from a .model file written by save().
   * @param {string} path
   */
  load(path) {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== "minbpe v1") {
      throw new Error(`unsupported model file header: ${lines[0]}`);
    }
    const patternSrc = lines[1] || "";
    this.pattern = patternSrc ? new RegExp(patternSrc, "gu") : null;
    const numSpecial = Number(lines[2] || "0");
    this.specialTokens = new Map();
    this._specialTokenById = new Map();
    this._buildInitialVocab();

    let cursor = 3;
    for (let i = 0; i < numSpecial; i++) {
      const line = lines[cursor++];
      const sep = line.lastIndexOf(" ");
      const tok = line.slice(0, sep);
      const id = Number(line.slice(sep + 1));
      this.specialTokens.set(tok, id);
      this._specialTokenById.set(id, tok);
      this.vocab.set(id, TEXT_ENCODER.encode(tok));
    }

    this.merges = new Map();
    let nextId = 256;
    for (; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (!line.trim()) continue;
      const [a, b] = line.split(/\s+/).map(Number);
      const key = `${a},${b}`;
      this.merges.set(key, nextId);
      const bytesA = this.vocab.get(a);
      const bytesB = this.vocab.get(b);
      const combined = new Uint8Array(bytesA.length + bytesB.length);
      combined.set(bytesA, 0);
      combined.set(bytesB, bytesA.length);
      this.vocab.set(nextId, combined);
      nextId += 1;
    }
  }

  getVocabSize() {
    return this.vocab.size;
  }
}

// ---------------------------------------------------------------------------
// RegexBPETokenizer — GPT-2/GPT-4 style with regex pre-tokenization.
// ---------------------------------------------------------------------------

/**
 * BPE that first splits the text by a regex (preventing merges across word
 * or punctuation boundaries) and then trains/encodes each chunk independently.
 * This is what real tokenizers like GPT-2 and tiktoken do.
 */
export class RegexBPETokenizer extends BasicBPETokenizer {
  /**
   * @param {RegExp | string} [pattern] - defaults to GPT4_SPLIT_PATTERN
   */
  constructor(pattern) {
    super();
    this.pattern = cloneRegex(pattern || GPT4_SPLIT_PATTERN);
  }

  train(text, vocabSize, verbose = false) {
    if (vocabSize < 256) {
      throw new Error("vocabSize must be >= 256 (one entry per byte)");
    }
    const numMerges = vocabSize - 256;

    const chunks = splitByPattern(text, this.pattern).map(bytesFromString);
    this.merges = new Map();
    this._buildInitialVocab();

    let working = chunks;
    for (let i = 0; i < numMerges; i++) {
      const stats = new Map();
      for (const chunk of working) getStats(chunk, stats);
      if (stats.size === 0) break;
      const topKey = pickMostFrequent(stats);
      if (!topKey) break;
      const [a, b] = topKey.split(",").map(Number);
      const newId = 256 + i;
      working = working.map((chunk) => merge(chunk, [a, b], newId));
      this.merges.set(topKey, newId);
      const bytesA = this.vocab.get(a);
      const bytesB = this.vocab.get(b);
      const combined = new Uint8Array(bytesA.length + bytesB.length);
      combined.set(bytesA, 0);
      combined.set(bytesB, bytesA.length);
      this.vocab.set(newId, combined);
      if (verbose) {
        console.log(
          `merge ${i + 1}/${numMerges}: (${a},${b}) -> ${newId} ` +
            `(${safeDecodeBytes(combined)}) count=${stats.get(topKey)}`,
        );
      }
    }
  }

  encode(text, options = {}) {
    const allowSpecial = options.allowSpecial || "none"; // "all" | "none"
    if (allowSpecial === "all" && this.specialTokens.size > 0) {
      return this._encodeWithSpecials(text);
    }
    // If special tokens appear verbatim and we aren't allowing them, that's
    // a hazard — Karpathy's impl errors. We follow the same rule.
    if (allowSpecial === "none" && this.specialTokens.size > 0) {
      for (const tok of this.specialTokens.keys()) {
        if (text.includes(tok)) {
          throw new Error(
            `encountered special token "${tok}" with allowSpecial="none"`,
          );
        }
      }
    }
    return this._encodeOrdinary(text);
  }

  _encodeOrdinary(text) {
    const chunks = splitByPattern(text, this.pattern);
    const out = [];
    for (const chunk of chunks) {
      const ids = this._encodeChunk(bytesFromString(chunk));
      for (const id of ids) out.push(id);
    }
    return out;
  }

  _encodeWithSpecials(text) {
    // Build a regex that splits on any special token, keeping delimiters.
    const keys = Array.from(this.specialTokens.keys()).sort(
      (a, b) => b.length - a.length,
    );
    const escaped = keys.map(escapeRegex).join("|");
    const splitter = new RegExp(`(${escaped})`, "g");
    const parts = text.split(splitter);
    const out = [];
    for (const part of parts) {
      if (part.length === 0) continue;
      if (this.specialTokens.has(part)) {
        out.push(this.specialTokens.get(part));
      } else {
        for (const id of this._encodeOrdinary(part)) out.push(id);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Helper: simple counter that works with any tokenizer exposing encode().
// ---------------------------------------------------------------------------

/**
 * Count the number of tokens `tokenizer` produces for the given text.
 * Falls back to a cheap byte-length heuristic when no tokenizer is supplied.
 *
 * @param {string} text
 * @param {{ encode(text: string): number[] } | null} [tokenizer]
 * @returns {number}
 */
export function countTokens(text, tokenizer) {
  if (typeof text !== "string") return 0;
  if (tokenizer && typeof tokenizer.encode === "function") {
    return tokenizer.encode(text).length;
  }
  // Heuristic: approximate ~4 bytes per token (GPT-ish average) so callers
  // without a trained tokenizer still get a useful estimate.
  const byteLen = TEXT_ENCODER.encode(text).length;
  return Math.max(1, Math.ceil(byteLen / 4));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function pickMostFrequent(stats) {
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of stats) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestKey;
}

function safeDecodeBytes(bytes) {
  try {
    const s = TEXT_DECODER.decode(bytes);
    return JSON.stringify(s);
  } catch {
    return `<${bytes.length} bytes>`;
  }
}

function splitByPattern(text, pattern) {
  const rx = cloneRegex(pattern);
  const out = [];
  let m;
  // Use matchAll-style iteration so the gu flags are respected.
  while ((m = rx.exec(text)) !== null) {
    if (m[0].length === 0) {
      // Avoid infinite loops on zero-width matches.
      rx.lastIndex += 1;
      continue;
    }
    out.push(m[0]);
  }
  return out;
}

function cloneRegex(rx) {
  if (rx instanceof RegExp) {
    const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
    return new RegExp(rx.source, flags);
  }
  return new RegExp(rx, "gu");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-export a couple of helpers used by consumers that want to work with the
// raw byte arrays without going through the class.
export { bytesFromString, bytesFromBufferLike };
