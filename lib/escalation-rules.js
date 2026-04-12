/**
 * Phase 62.4: Escalation rules — rule engine for handoff to humans.
 *
 * Supported conditions (combined with logical AND within a rule):
 *   - slaBreachMinutes      → true when (now - createdAt) / 60000 >= N
 *   - sentimentBelow        → true when ticket.sentiment < threshold
 *   - keywordAny            → true when any keyword appears in subject/body
 *   - keywordAll            → true when all keywords appear
 *   - loopCountAtLeast      → true when ticket.loopCount >= N
 *   - priorityAtLeast       → true when ticket.priority index >= PRIORITIES[N]
 *
 * Storage layout (via json-path-store):
 *   data/escalation-rules/{id}.json        — rule record
 *   data/escalation-rules/_index.json      — rule id index
 *   data/escalation-rules/handoffs.json    — handoff log
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function rulePath(id) {
  return join(getDataDir(), "escalation-rules", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "escalation-rules", "_index.json");
}

function handoffsPath() {
  return join(getDataDir(), "escalation-rules", "handoffs.json");
}

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PRIORITY_ORDER = ["low", "normal", "high", "urgent"];

// ─── CRUD ──────────────────────────────────────────────────────────────────

/**
 * Create (or replace) an escalation rule.
 *
 * @param {{
 *   name: string,
 *   enabled?: boolean,
 *   conditions: {
 *     slaBreachMinutes?: number,
 *     sentimentBelow?: number,
 *     keywordAny?: string[],
 *     keywordAll?: string[],
 *     loopCountAtLeast?: number,
 *     priorityAtLeast?: string,
 *   },
 *   action?: {type: string, target?: string, message?: string},
 * }} opts
 */
export async function createRule(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  if (!opts.name || typeof opts.name !== "string") throw new Error("name is required");
  if (!opts.conditions || typeof opts.conditions !== "object") {
    throw new Error("conditions are required");
  }
  const id = opts.id || randomUUID();
  const rec = {
    id,
    name: opts.name,
    enabled: opts.enabled !== false,
    conditions: normalizeConditions(opts.conditions),
    action: normalizeAction(opts.action),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(rulePath(id), rec);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { ids: [] });
    const list = Array.isArray(idx.ids) ? idx.ids : [];
    if (!list.includes(id)) list.push(id);
    await writeJsonPath(indexPath(), { ids: list });
  });
  return rec;
}

function normalizeConditions(c) {
  return {
    slaBreachMinutes: typeof c.slaBreachMinutes === "number" ? c.slaBreachMinutes : null,
    sentimentBelow: typeof c.sentimentBelow === "number" ? c.sentimentBelow : null,
    keywordAny: Array.isArray(c.keywordAny) ? c.keywordAny.map((s) => String(s).toLowerCase()) : null,
    keywordAll: Array.isArray(c.keywordAll) ? c.keywordAll.map((s) => String(s).toLowerCase()) : null,
    loopCountAtLeast: typeof c.loopCountAtLeast === "number" ? c.loopCountAtLeast : null,
    priorityAtLeast: c.priorityAtLeast ? String(c.priorityAtLeast).toLowerCase() : null,
  };
}

function normalizeAction(a) {
  if (!a || typeof a !== "object") return { type: "handoff", target: "default-human", message: "" };
  return {
    type: String(a.type || "handoff"),
    target: a.target ? String(a.target) : "default-human",
    message: a.message ? String(a.message) : "",
  };
}

export async function getRule(id) {
  if (!id) return null;
  const rec = await readJsonPath(rulePath(id), null);
  if (!rec || !rec.id) return null;
  return rec;
}

export async function listRules() {
  const idx = await readJsonPath(indexPath(), { ids: [] });
  const ids = Array.isArray(idx.ids) ? idx.ids : [];
  const out = [];
  for (const id of ids) {
    const r = await getRule(id);
    if (r) out.push(r);
  }
  return out;
}

export async function deleteRule(id) {
  const rec = await getRule(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(rulePath(id), { _deleted: true });
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { ids: [] });
    const list = Array.isArray(idx.ids) ? idx.ids : [];
    await writeJsonPath(indexPath(), { ids: list.filter((x) => x !== id) });
  });
  return { ok: true };
}

// ─── Evaluation ────────────────────────────────────────────────────────────

/**
 * Evaluate all enabled rules against a ticket-like object. Returns the list
 * of rules that match.
 *
 * Ticket shape: {
 *   id, subject, body, priority, sentiment, loopCount, createdAt
 * }
 */
export async function evaluateRules(ticket, nowMs = Date.now()) {
  if (!ticket || typeof ticket !== "object") throw new Error("ticket is required");
  const rules = await listRules();
  const matches = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    const result = matchRule(rule, ticket, nowMs);
    if (result.matched) {
      matches.push({ rule, matchedOn: result.matchedOn });
    }
  }
  return matches;
}

function matchRule(rule, ticket, nowMs) {
  const c = rule.conditions || {};
  const matchedOn = [];

  if (c.slaBreachMinutes != null) {
    const created = Date.parse(ticket.createdAt || 0) || 0;
    const elapsedMin = (nowMs - created) / 60000;
    if (elapsedMin < c.slaBreachMinutes) return { matched: false };
    matchedOn.push(`sla>=${c.slaBreachMinutes}m`);
  }
  if (c.sentimentBelow != null) {
    if (typeof ticket.sentiment !== "number") return { matched: false };
    if (!(ticket.sentiment < c.sentimentBelow)) return { matched: false };
    matchedOn.push(`sentiment<${c.sentimentBelow}`);
  }
  if (c.keywordAny) {
    const hay = `${ticket.subject || ""} ${ticket.body || ""}`.toLowerCase();
    if (!c.keywordAny.some((k) => hay.includes(k))) return { matched: false };
    matchedOn.push(`keywordAny`);
  }
  if (c.keywordAll) {
    const hay = `${ticket.subject || ""} ${ticket.body || ""}`.toLowerCase();
    if (!c.keywordAll.every((k) => hay.includes(k))) return { matched: false };
    matchedOn.push(`keywordAll`);
  }
  if (c.loopCountAtLeast != null) {
    const lc = Number(ticket.loopCount) || 0;
    if (lc < c.loopCountAtLeast) return { matched: false };
    matchedOn.push(`loopCount>=${c.loopCountAtLeast}`);
  }
  if (c.priorityAtLeast != null) {
    const needed = PRIORITY_ORDER.indexOf(c.priorityAtLeast);
    const got = PRIORITY_ORDER.indexOf(String(ticket.priority || "normal").toLowerCase());
    if (needed < 0 || got < needed) return { matched: false };
    matchedOn.push(`priority>=${c.priorityAtLeast}`);
  }
  // If no conditions produced a match criterion, do not consider it a match.
  if (matchedOn.length === 0) return { matched: false };
  return { matched: true, matchedOn };
}

// ─── Handoff ──────────────────────────────────────────────────────────────

/**
 * Record a handoff to a human. Called by callers after evaluating rules.
 *
 * @param {{ticketId: string, ruleId?: string, target?: string, reason?: string}} opts
 */
export async function triggerHandoff(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  if (!opts.ticketId) throw new Error("ticketId is required");
  const entry = {
    id: randomUUID(),
    ticketId: opts.ticketId,
    ruleId: opts.ruleId || null,
    target: opts.target || "default-human",
    reason: opts.reason || "",
    at: new Date().toISOString(),
  };
  await withPathLock(handoffsPath(), async () => {
    const data = await readJsonPath(handoffsPath(), { handoffs: [] });
    const list = Array.isArray(data.handoffs) ? data.handoffs : [];
    list.unshift(entry);
    if (list.length > 1000) list.length = 1000;
    await writeJsonPath(handoffsPath(), { handoffs: list });
  });
  return entry;
}

export async function listHandoffs(limit = 100) {
  const data = await readJsonPath(handoffsPath(), { handoffs: [] });
  const list = Array.isArray(data.handoffs) ? data.handoffs : [];
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  return list.slice(0, n);
}

export const _internals = {
  normalizeConditions,
  normalizeAction,
  matchRule,
  PRIORITY_ORDER,
  rulePath,
  indexPath,
  handoffsPath,
};
