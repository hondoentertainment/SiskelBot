// @ts-check
/**
 * Phase 67.4: Brand safety rules.
 *
 * Configurable brand guardrails. Each brand rule set has:
 *   - bannedKeywords  — hard-stop words/phrases
 *   - riskyKeywords   — flag-for-review
 *   - blockedTopics   — topic labels to block entirely
 *   - requiredTopics  — content must include at least one
 *   - caseSensitive   — default false
 *
 * `evaluateContent` scans text against a named rule set and returns a
 * verdict object. `testContent` is a convenience variant that accepts
 * the rule set inline.
 *
 * Exports:
 *   - createRuleSet
 *   - evaluateContent
 *   - listRuleSets
 *   - updateRuleSet
 *   - testContent
 *   - deleteRuleSet
 *
 * @module brand-safety
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "brand-safety.json");
}

function newId() {
  return `brand_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    ruleSets: {},
  });
  if (!data.ruleSets || typeof data.ruleSets !== "object") data.ruleSets = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    ruleSets: data.ruleSets || {},
  });
}

function sanitizeArray(input) {
  if (!Array.isArray(input)) return [];
  return input.map((s) => String(s).trim()).filter(Boolean);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.name) throw new Error("name required");
  if (!payload.brand) throw new Error("brand required");
  return {
    name: String(payload.name),
    brand: String(payload.brand),
    bannedKeywords: sanitizeArray(payload.bannedKeywords),
    riskyKeywords: sanitizeArray(payload.riskyKeywords),
    blockedTopics: sanitizeArray(payload.blockedTopics),
    requiredTopics: sanitizeArray(payload.requiredTopics),
    caseSensitive: payload.caseSensitive === true,
    enabled: payload.enabled !== false,
  };
}

/**
 * Create a rule set.
 *
 * @param {object} payload
 * @returns {Promise<object>}
 */
export async function createRuleSet(payload) {
  const clean = validatePayload(payload);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId();
    const ts = nowIso();
    const record = {
      id,
      ...clean,
      createdAt: ts,
      updatedAt: ts,
    };
    data.ruleSets[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Update a rule set by id. Merges with existing, then revalidates.
 *
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<object>}
 */
export async function updateRuleSet(id, updates) {
  if (!id) throw new Error("id required");
  if (!updates || typeof updates !== "object") throw new Error("updates required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = data.ruleSets[id];
    if (!existing) throw new Error(`rule set ${id} not found`);
    const merged = { ...existing, ...updates };
    const clean = validatePayload(merged);
    const record = {
      id,
      ...clean,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    data.ruleSets[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Delete a rule set.
 * @param {string} id
 */
export async function deleteRuleSet(id) {
  if (!id) return false;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.ruleSets[id]) return false;
    delete data.ruleSets[id];
    await saveStore(data);
    return true;
  });
}

/**
 * List rule sets.
 *
 * @param {{brand?: string, enabledOnly?: boolean}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listRuleSets(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.ruleSets || {});
  if (filter.brand) all = all.filter((r) => r.brand === filter.brand);
  if (filter.enabledOnly) all = all.filter((r) => r.enabled);
  all.sort((a, b) => (a.name < b.name ? -1 : 1));
  return all;
}

/**
 * Core evaluation — runs a rule set against a content payload.
 *
 * @param {object} ruleSet
 * @param {{text: string, topics?: string[]}} content
 * @returns {{verdict: "allow"|"flag"|"block", reasons: string[], flaggedKeywords: string[], blockedTopics: string[], missingRequired: string[]}}
 */
export function applyRuleSet(ruleSet, content) {
  if (!ruleSet || typeof ruleSet !== "object") throw new Error("ruleSet required");
  if (!content || typeof content !== "object") throw new Error("content required");
  const text = typeof content.text === "string" ? content.text : "";
  const topics = Array.isArray(content.topics) ? content.topics.map(String) : [];
  const cs = ruleSet.caseSensitive === true;
  const haystack = cs ? text : text.toLowerCase();

  const reasons = [];
  const flaggedKeywords = [];
  const blockedTopics = [];
  let verdict = "allow";

  const hasKeyword = (kw) => {
    const needle = cs ? kw : kw.toLowerCase();
    return haystack.includes(needle);
  };

  for (const kw of ruleSet.bannedKeywords || []) {
    if (hasKeyword(kw)) {
      flaggedKeywords.push(kw);
      verdict = "block";
      reasons.push(`banned keyword: ${kw}`);
    }
  }
  for (const topic of ruleSet.blockedTopics || []) {
    if (topics.includes(topic)) {
      blockedTopics.push(topic);
      verdict = "block";
      reasons.push(`blocked topic: ${topic}`);
    }
  }
  if (verdict !== "block") {
    for (const kw of ruleSet.riskyKeywords || []) {
      if (hasKeyword(kw)) {
        flaggedKeywords.push(kw);
        verdict = verdict === "allow" ? "flag" : verdict;
        reasons.push(`risky keyword: ${kw}`);
      }
    }
  }
  let missingRequired = [];
  if (Array.isArray(ruleSet.requiredTopics) && ruleSet.requiredTopics.length > 0) {
    const has = ruleSet.requiredTopics.some((t) => topics.includes(t));
    if (!has) {
      missingRequired = [...ruleSet.requiredTopics];
      verdict = verdict === "block" ? verdict : "flag";
      reasons.push(`missing required topic(s): ${missingRequired.join(", ")}`);
    }
  }

  return {
    verdict,
    reasons,
    flaggedKeywords,
    blockedTopics,
    missingRequired,
  };
}

/**
 * Evaluate content against a persisted rule set by id.
 *
 * @param {string} id
 * @param {{text: string, topics?: string[]}} content
 */
export async function evaluateContent(id, content) {
  if (!id) throw new Error("ruleSetId required");
  const data = await loadStore();
  const ruleSet = data.ruleSets[id];
  if (!ruleSet) throw new Error(`rule set ${id} not found`);
  if (ruleSet.enabled === false) {
    return { verdict: "allow", reasons: ["rule set disabled"], flaggedKeywords: [], blockedTopics: [], missingRequired: [] };
  }
  return applyRuleSet(ruleSet, content || { text: "" });
}

/**
 * Ad-hoc evaluation with an inline rule set (no persistence).
 *
 * @param {{ruleSet: object, content: object}} payload
 */
export function testContent(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  const clean = validatePayload({ ...payload.ruleSet, name: payload.ruleSet?.name || "inline", brand: payload.ruleSet?.brand || "inline" });
  return applyRuleSet(clean, payload.content || { text: "" });
}
