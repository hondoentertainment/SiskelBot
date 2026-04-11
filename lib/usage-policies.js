// @ts-check
/**
 * Phase 65.2: Usage policies.
 *
 * Per-department allow/deny rules evaluated against request context.
 * A policy targets a department (or "*") and lists ordered rules with an
 * action (`allow` / `deny`) and a predicate matching fields like `model`,
 * `tags`, `maxTokens`, `hoursOfDay`, etc. Policies are stored JSON-backed.
 *
 * Exports:
 *   - createPolicy
 *   - evaluatePolicy
 *   - listPolicies
 *   - updatePolicy
 *   - testPolicy
 *   - deletePolicy
 *   - getPolicy
 *
 * @module usage-policies
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
const VALID_ACTIONS = new Set(["allow", "deny"]);

function storePath() {
  return join(getDataDir(), "usage-policies.json");
}

function newId() {
  return `pol_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    policies: {},
  });
  if (!data.policies || typeof data.policies !== "object") data.policies = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    policies: data.policies || {},
  });
}

/**
 * @typedef {Object} PolicyRule
 * @property {string} [id]
 * @property {string} action
 * @property {object} [match]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} UsagePolicy
 * @property {string} id
 * @property {string} name
 * @property {string} department
 * @property {PolicyRule[]} rules
 * @property {string} defaultAction
 * @property {boolean} enabled
 * @property {string} createdAt
 * @property {string} updatedAt
 */

function validateRule(rule, i) {
  if (!rule || typeof rule !== "object") {
    throw new Error(`rule[${i}] must be an object`);
  }
  const action = String(rule.action || "").toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`rule[${i}].action must be "allow" or "deny"`);
  }
  if (rule.match && typeof rule.match !== "object") {
    throw new Error(`rule[${i}].match must be an object`);
  }
  return {
    id: rule.id ? String(rule.id) : `r_${i}`,
    action,
    match: rule.match && typeof rule.match === "object" ? { ...rule.match } : {},
    reason: rule.reason ? String(rule.reason) : "",
  };
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("policy payload is required");
  }
  if (!payload.name || typeof payload.name !== "string") {
    throw new Error("name is required");
  }
  if (!payload.department || typeof payload.department !== "string") {
    throw new Error("department is required");
  }
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const defaultAction = String(payload.defaultAction || "allow").toLowerCase();
  if (!VALID_ACTIONS.has(defaultAction)) {
    throw new Error("defaultAction must be allow or deny");
  }
  return {
    name: String(payload.name),
    department: String(payload.department),
    description: payload.description ? String(payload.description) : "",
    rules: rules.map(validateRule),
    defaultAction,
    enabled: payload.enabled !== false,
  };
}

/**
 * Create a new usage policy.
 *
 * @param {object} payload
 * @returns {Promise<UsagePolicy>}
 */
export async function createPolicy(payload) {
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
    data.policies[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Update fields on an existing policy.
 *
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<UsagePolicy>}
 */
export async function updatePolicy(id, updates) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!updates || typeof updates !== "object") throw new Error("updates required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = data.policies[id];
    if (!existing) throw new Error(`policy ${id} not found`);
    const merged = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt };
    const clean = validatePayload(merged);
    const record = {
      id,
      ...clean,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    data.policies[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Delete a policy.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deletePolicy(id) {
  if (!id || typeof id !== "string") return false;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.policies[id]) return false;
    delete data.policies[id];
    await saveStore(data);
    return true;
  });
}

/**
 * Fetch a policy by id.
 * @param {string} id
 */
export async function getPolicy(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.policies[id] || null;
}

/**
 * List all policies, optionally filtered by department.
 *
 * @param {{department?: string, enabledOnly?: boolean}} [filter]
 * @returns {Promise<UsagePolicy[]>}
 */
export async function listPolicies(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.policies || {});
  if (filter.department) {
    all = all.filter((p) => p.department === filter.department || p.department === "*");
  }
  if (filter.enabledOnly) {
    all = all.filter((p) => p.enabled);
  }
  all.sort((a, b) => (a.name < b.name ? -1 : 1));
  return all;
}

/**
 * Match a rule's `match` object against a request context.
 *
 * Supported match keys:
 *   - model (string or array)
 *   - tags (array) — at least one must be in ctx.tags
 *   - maxTokens (number) — denies if ctx.tokens > maxTokens
 *   - minTokens (number) — denies if ctx.tokens < minTokens
 *   - hoursOfDay ([startHour, endHour]) — inclusive range in local time
 *   - users (array) — ctx.user in list
 *   - workspaces (array)
 *
 * @param {object} match
 * @param {object} ctx
 * @returns {boolean}
 */
export function matchRule(match, ctx) {
  if (!match || typeof match !== "object") return true;
  const c = ctx || {};
  if (match.model != null) {
    const list = Array.isArray(match.model) ? match.model : [match.model];
    if (!list.includes(c.model)) return false;
  }
  if (Array.isArray(match.tags)) {
    const ctxTags = Array.isArray(c.tags) ? c.tags : [];
    const any = match.tags.some((t) => ctxTags.includes(t));
    if (!any) return false;
  }
  if (Number.isFinite(match.maxTokens) && Number.isFinite(c.tokens)) {
    if (c.tokens > match.maxTokens) return false;
  }
  if (Number.isFinite(match.minTokens) && Number.isFinite(c.tokens)) {
    if (c.tokens < match.minTokens) return false;
  }
  if (Array.isArray(match.hoursOfDay) && match.hoursOfDay.length === 2 && c.hour != null) {
    const [start, end] = match.hoursOfDay;
    if (start <= end) {
      if (c.hour < start || c.hour > end) return false;
    } else {
      // wraps midnight (e.g. [22, 6])
      if (c.hour < start && c.hour > end) return false;
    }
  }
  if (Array.isArray(match.users)) {
    if (!match.users.includes(c.user)) return false;
  }
  if (Array.isArray(match.workspaces)) {
    if (!match.workspaces.includes(c.workspace)) return false;
  }
  return true;
}

/**
 * Evaluate a single policy against a context. Returns the effective
 * action and the triggering rule (if any).
 *
 * @param {UsagePolicy} policy
 * @param {object} ctx
 * @returns {{ action: string, rule: PolicyRule | null, reason: string }}
 */
export function evaluatePolicyObject(policy, ctx) {
  if (!policy || policy.enabled === false) {
    return { action: "allow", rule: null, reason: "policy disabled" };
  }
  for (const rule of policy.rules || []) {
    if (matchRule(rule.match, ctx)) {
      return { action: rule.action, rule, reason: rule.reason || "rule matched" };
    }
  }
  return { action: policy.defaultAction || "allow", rule: null, reason: "default" };
}

/**
 * Evaluate an identified policy by id against a request context.
 *
 * @param {string} id
 * @param {object} ctx
 * @returns {Promise<{ action: string, rule: PolicyRule | null, reason: string, policyId: string }>}
 */
export async function evaluatePolicy(id, ctx) {
  const policy = await getPolicy(id);
  if (!policy) {
    throw new Error(`policy ${id} not found`);
  }
  const result = evaluatePolicyObject(policy, ctx);
  return { ...result, policyId: id };
}

/**
 * Run a test evaluation against an ad-hoc policy without persisting it.
 *
 * @param {object} payload
 * @param {object} ctx
 * @returns {{ action: string, rule: PolicyRule | null, reason: string }}
 */
export function testPolicy(payload, ctx) {
  const clean = validatePayload(payload);
  // We don't need the persistence fields here; evaluate the in-memory shape.
  const policy = { id: "test", ...clean, createdAt: "", updatedAt: "" };
  return evaluatePolicyObject(policy, ctx);
}
