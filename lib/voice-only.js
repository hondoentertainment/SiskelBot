// @ts-check
/**
 * Phase 70.4: Voice-only mode.
 *
 * A small command grammar with fuzzy matching so a user can
 * control the app entirely by voice. Commands are registered with
 * a `pattern` string (e.g. "open {section}") that can contain
 * placeholder slots.
 *
 * Exports:
 *   - registerCommand
 *   - matchCommand
 *   - listCommands
 *   - disambiguate
 *   - clearCommands
 *
 * @module voice-only
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
  return join(getDataDir(), "voice-only-commands.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, commands: {} });
  if (!data.commands || typeof data.commands !== "object") data.commands = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, commands: data.commands || {} });
}

/**
 * Compile a pattern string like "open {section}" into a regex and
 * a list of slot names.
 *
 * @param {string} pattern
 * @returns {{ regex: RegExp, slots: string[] }}
 */
export function compilePattern(pattern) {
  if (!pattern || typeof pattern !== "string") throw new Error("pattern is required");
  /** @type {string[]} */
  const slots = [];
  const escaped = pattern.trim().toLowerCase().replace(/\s+/g, " ");
  const regexBody = escaped
    .split(" ")
    .map((word) => {
      const m = word.match(/^\{([a-z_][a-z0-9_]*)\}$/);
      if (m) {
        slots.push(m[1]);
        return "(?<" + m[1] + ">[a-z0-9_]+(?:\\s+[a-z0-9_]+)?)";
      }
      return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("\\s+");
  return { regex: new RegExp(`^${regexBody}$`, "i"), slots };
}

/**
 * Register (or update) a voice command.
 *
 * @param {{ id: string, pattern: string, action?: string }} spec
 * @returns {Promise<object>}
 */
export async function registerCommand(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  if (!spec.pattern || typeof spec.pattern !== "string") throw new Error("pattern is required");
  const { slots } = compilePattern(spec.pattern);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: spec.id,
      pattern: spec.pattern,
      slots,
      action: typeof spec.action === "string" ? spec.action : spec.id,
      createdAt: data.commands[spec.id]?.createdAt || now,
      updatedAt: now,
    };
    data.commands[spec.id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * List all registered commands.
 * @returns {Promise<object[]>}
 */
export async function listCommands() {
  const data = await loadStore();
  return Object.values(data.commands || {});
}

/**
 * Levenshtein distance for fuzzy token matching. Small enough to
 * implement inline; used for one-word command nudges.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  /** @type {number[][]} */
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[m][n];
}

/**
 * Match a spoken utterance against the registered commands.
 * Returns the single best match (score = 1.0 for exact, lower for
 * fuzzy) or null if nothing is close enough.
 *
 * @param {string} utterance
 * @param {{ minScore?: number }} [opts]
 * @returns {Promise<{ id: string, action: string, slots: Record<string, string>, score: number } | null>}
 */
export async function matchCommand(utterance, opts = {}) {
  if (!utterance || typeof utterance !== "string") return null;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.6;
  const phrase = utterance.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return null;
  const data = await loadStore();
  const commands = Object.values(data.commands || {});
  /** @type {{ id: string, action: string, slots: Record<string, string>, score: number } | null} */
  let best = null;
  for (const cmd of commands) {
    const { regex } = compilePattern(cmd.pattern);
    const m = phrase.match(regex);
    if (m) {
      return {
        id: cmd.id,
        action: cmd.action,
        slots: { ...(m.groups || {}) },
        score: 1,
      };
    }
    // Fuzzy nudge against the full pattern string (ignoring slots).
    const flat = cmd.pattern.replace(/\{[^}]+\}/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!flat) continue;
    const d = distance(phrase, flat);
    const score = 1 - d / Math.max(phrase.length, flat.length);
    if (!best || score > best.score) {
      best = { id: cmd.id, action: cmd.action, slots: {}, score: Math.round(score * 1000) / 1000 };
    }
  }
  if (best && best.score >= minScore) return best;
  return null;
}

/**
 * Return every command that has a fuzzy score above the threshold,
 * sorted descending. Useful for "Did you mean…?" prompts.
 *
 * @param {string} utterance
 * @param {{ minScore?: number, limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, action: string, score: number }>>}
 */
export async function disambiguate(utterance, opts = {}) {
  if (!utterance || typeof utterance !== "string") return [];
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.4;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const phrase = utterance.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return [];
  const data = await loadStore();
  const commands = Object.values(data.commands || {});
  /** @type {Array<{ id: string, action: string, score: number }>} */
  const out = [];
  for (const cmd of commands) {
    const flat = cmd.pattern.replace(/\{[^}]+\}/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!flat) continue;
    const d = distance(phrase, flat);
    const score = 1 - d / Math.max(phrase.length, flat.length);
    if (score >= minScore) {
      out.push({ id: cmd.id, action: cmd.action, score: Math.round(score * 1000) / 1000 });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * Remove every registered command. Returns the count cleared.
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearCommands() {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const n = Object.keys(data.commands || {}).length;
    data.commands = {};
    await saveStore(data);
    return { cleared: n };
  });
}
