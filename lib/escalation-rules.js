// @ts-check
/**
 * Phase 62.4: Escalation rules.
 *
 * Rule-based engine for deciding when a ticket should be escalated to a
 * human. A rule has:
 *   - `id`, `name`, `description`
 *   - `conditions`: list of { field, op, value } predicates (AND)
 *   - `action`: { type: "escalate", target, priority }
 *
 * Supported ops: `equals`, `not_equals`, `contains`, `gt`, `gte`, `lt`,
 * `lte`, `in`, `regex`.
 *
 * @module escalation-rules
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function rulesPath() {
  return join(getDataDir(), "escalation-rules.json");
}

function historyPath() {
  return join(getDataDir(), "escalation-history.json");
}

async function loadRules() {
  const data = await readJsonPath(rulesPath(), { version: STORE_VERSION, rules: [] });
  if (!Array.isArray(data.rules)) data.rules = [];
  return data;
}

async function saveRules(data) {
  await writeJsonPath(rulesPath(), { version: STORE_VERSION, rules: data.rules || [] });
}

async function loadHistory() {
  const data = await readJsonPath(historyPath(), { version: STORE_VERSION, history: [] });
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

async function saveHistory(data) {
  await writeJsonPath(historyPath(), { version: STORE_VERSION, history: data.history || [] });
}

/* -------------------------------------------------------------------------- */
/* Predicates                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate a single predicate against a ticket-like object.
 *
 * @param {object} cond
 * @param {object} ticket
 * @returns {boolean}
 */
export function matchCondition(cond, ticket) {
  if (!cond || typeof cond !== "object") return false;
  const { field, op, value } = cond;
  if (!field || !op) return false;
  const actual = getField(ticket, field);
  switch (op) {
    case "equals":
      return actual === value;
    case "not_equals":
      return actual !== value;
    case "contains":
      if (actual == null) return false;
      return String(actual).toLowerCase().includes(String(value).toLowerCase());
    case "gt":
      return Number(actual) > Number(value);
    case "gte":
      return Number(actual) >= Number(value);
    case "lt":
      return Number(actual) < Number(value);
    case "lte":
      return Number(actual) <= Number(value);
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "regex":
      try {
        return new RegExp(String(value)).test(String(actual || ""));
      } catch (_e) {
        return false;
      }
    default:
      return false;
  }
}

/**
 * Resolve dotted `a.b.c` paths against an object.
 *
 * @param {object} obj
 * @param {string} field
 * @returns {any}
 */
function getField(obj, field) {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = String(field).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/* -------------------------------------------------------------------------- */
/* Rule CRUD                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Add an escalation rule.
 *
 * @param {object} rule
 * @returns {Promise<object>}
 */
export async function addRule(rule) {
  if (!rule || typeof rule !== "object") throw new Error("rule is required");
  if (!rule.name) throw new Error("rule.name is required");
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    throw new Error("rule.conditions must be a non-empty array");
  }
  const path = rulesPath();
  return withPathLock(path, async () => {
    const data = await loadRules();
    const now = new Date().toISOString();
    const id = rule.id || `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      id,
      name: String(rule.name),
      description: rule.description || "",
      conditions: rule.conditions,
      action: rule.action || { type: "escalate", target: "tier2", priority: "high" },
      enabled: rule.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    data.rules.push(rec);
    await saveRules(data);
    return rec;
  });
}

/** List all rules. */
export async function listRules() {
  const data = await loadRules();
  return data.rules;
}

/**
 * Remove a rule by id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function removeRule(id) {
  if (!id) throw new Error("id is required");
  const path = rulesPath();
  return withPathLock(path, async () => {
    const data = await loadRules();
    const before = data.rules.length;
    data.rules = data.rules.filter((r) => r.id !== id);
    await saveRules(data);
    return data.rules.length < before;
  });
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run all enabled rules against a ticket and return the rules that match.
 *
 * @param {object} ticket
 * @returns {Promise<Array<object>>}
 */
export async function evaluateRules(ticket) {
  if (!ticket || typeof ticket !== "object") return [];
  const data = await loadRules();
  const matched = [];
  for (const rule of data.rules) {
    if (!rule.enabled) continue;
    let ok = true;
    for (const cond of rule.conditions) {
      if (!matchCondition(cond, ticket)) {
        ok = false;
        break;
      }
    }
    if (ok) matched.push(rule);
  }
  return matched;
}

/* -------------------------------------------------------------------------- */
/* Escalation history                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Trigger an escalation for a ticket, persisting a history entry.
 * If rule is omitted, the first matching rule is used; if none match,
 * a manual escalation is recorded.
 *
 * @param {object} ticket
 * @param {object} [rule]
 * @returns {Promise<object>}
 */
export async function triggerEscalation(ticket, rule = null) {
  if (!ticket || typeof ticket !== "object") throw new Error("ticket is required");
  let matchedRule = rule;
  if (!matchedRule) {
    const matches = await evaluateRules(ticket);
    matchedRule = matches[0] || null;
  }
  const now = new Date().toISOString();
  const record = {
    id: `esc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ticketId: ticket.id || null,
    ticketSubject: ticket.subject || "",
    rule: matchedRule ? { id: matchedRule.id, name: matchedRule.name } : null,
    action: matchedRule ? matchedRule.action : { type: "escalate", target: "tier2", priority: "high" },
    manual: !matchedRule,
    createdAt: now,
  };
  await withPathLock(historyPath(), async () => {
    const data = await loadHistory();
    data.history.push(record);
    if (data.history.length > 10000) data.history = data.history.slice(-10000);
    await saveHistory(data);
  });
  return record;
}

/** List recent escalations, newest first. */
export async function listEscalations(limit = 100) {
  const data = await loadHistory();
  const arr = data.history.slice().reverse();
  if (Number.isFinite(limit) && limit > 0) return arr.slice(0, limit);
  return arr;
}

/**
 * Get full escalation history, optionally filtered by ticketId.
 *
 * @param {string} [ticketId]
 * @returns {Promise<Array<object>>}
 */
export async function getEscalationHistory(ticketId) {
  const data = await loadHistory();
  if (!ticketId) return data.history;
  return data.history.filter((h) => h.ticketId === ticketId);
}
