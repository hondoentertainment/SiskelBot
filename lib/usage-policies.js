/**
 * Phase 65.2: Usage policies — per-department allow/deny rules.
 *
 * A policy has:
 *   - scope: { kind: "department" | "team" | "user", id: string }
 *   - allow: array of rule strings/patterns (model names, resources, etc.)
 *   - deny:  array of rule strings/patterns (takes precedence over allow)
 *   - priority: number (higher wins when multiple policies match)
 *
 * evaluatePolicy picks the highest-priority matching policy for the subject
 * and returns { allowed, matchedRule, policyId }. Deny always wins over allow
 * inside the same policy; across policies, priority breaks ties, with deny
 * beating allow at the same priority.
 *
 * Storage: data/usage-policies/{id}.json + _index.json
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const SCOPE_DEPARTMENT = "department";
export const SCOPE_TEAM = "team";
export const SCOPE_USER = "user";
const VALID_SCOPES = new Set([SCOPE_DEPARTMENT, SCOPE_TEAM, SCOPE_USER]);

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function policyPath(id) {
  return join(getDataDir(), "usage-policies", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "usage-policies", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { policies: [] });
    const list = Array.isArray(idx.policies) ? idx.policies : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { policies: filtered });
  });
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((r) => (typeof r === "string" ? r.trim() : null))
    .filter((r) => typeof r === "string" && r.length > 0);
}

// ─── Pattern matching ──────────────────────────────────────────────────────

/**
 * Match a value against a rule. Supports:
 *  - exact string match
 *  - "*" wildcard (full match everything)
 *  - "prefix*" / "*suffix" / "*mid*"
 *  - "re:..." prefix for a JavaScript regular expression
 */
export function matchesRule(rule, value) {
  if (!rule || typeof rule !== "string") return false;
  if (rule === "*") return true;
  const val = String(value ?? "");
  if (rule.startsWith("re:")) {
    try {
      const re = new RegExp(rule.slice(3));
      return re.test(val);
    } catch {
      return false;
    }
  }
  if (rule.includes("*")) {
    const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(`^${escaped}$`).test(val);
    } catch {
      return false;
    }
  }
  return rule === val;
}

function ruleMatchAny(rules, value) {
  for (const rule of rules) {
    if (matchesRule(rule, value)) return rule;
  }
  return null;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new usage policy.
 */
export async function createPolicy({
  name,
  scope,
  allow,
  deny,
  priority,
  description,
} = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!scope || typeof scope !== "object") {
    throw new Error("scope object is required");
  }
  if (!VALID_SCOPES.has(scope.kind)) {
    throw new Error("scope.kind must be department, team, or user");
  }
  if (!scope.id || typeof scope.id !== "string") {
    throw new Error("scope.id is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name,
    scope: { kind: scope.kind, id: scope.id },
    allow: normalizeRules(allow),
    deny: normalizeRules(deny),
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    description: description || "",
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonPath(policyPath(id), record);
  await updateIndex(id, false, {
    id,
    name,
    scope: record.scope,
    priority: record.priority,
    createdAt: now,
  });
  return record;
}

export async function getPolicy(id) {
  if (!id) return null;
  const data = await readJsonPath(policyPath(id), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

export async function listPolicies(filter = {}) {
  const idx = await readJsonPath(indexPath(), { policies: [] });
  const entries = Array.isArray(idx.policies) ? idx.policies : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getPolicy(entry.id);
    if (!rec) continue;
    if (filter.scopeKind && rec.scope.kind !== filter.scopeKind) continue;
    if (filter.scopeId && rec.scope.id !== filter.scopeId) continue;
    if (filter.name && rec.name !== filter.name) continue;
    records.push(rec);
  }
  // Highest priority first for convenient iteration.
  records.sort((a, b) => b.priority - a.priority);
  return records;
}

export async function deletePolicy(id) {
  const rec = await getPolicy(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(policyPath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

export async function updatePolicy(id, patch = {}) {
  return withPathLock(policyPath(id), async () => {
    const rec = await readJsonPath(policyPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`policy ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (patch.name != null) rec.name = String(patch.name);
    if (patch.allow != null) rec.allow = normalizeRules(patch.allow);
    if (patch.deny != null) rec.deny = normalizeRules(patch.deny);
    if (patch.priority != null) rec.priority = Number(patch.priority) || 0;
    if (patch.description != null) rec.description = String(patch.description);
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(policyPath(id), rec);
    await updateIndex(rec.id, false, {
      id: rec.id,
      name: rec.name,
      scope: rec.scope,
      priority: rec.priority,
      createdAt: rec.createdAt,
    });
    return rec;
  });
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

/**
 * Evaluate a subject's request against all policies matching their scope.
 *
 * subject: { department, team, user }
 * resource: string to match against allow/deny rules (e.g. "gpt-4", "models:claude-opus")
 *
 * Returns { allowed, matchedRule, policyId, reason }.
 * Default when no policy matches: allowed=true.
 */
export async function evaluatePolicy({ subject = {}, resource, policies: provided } = {}) {
  if (!resource || typeof resource !== "string") {
    throw new Error("resource is required");
  }
  const pool = Array.isArray(provided) ? provided.slice() : await listPolicies();

  // Find all policies whose scope matches the subject.
  const matching = pool.filter((p) => {
    const kind = p.scope?.kind;
    const scopeId = p.scope?.id;
    if (!kind || !scopeId) return false;
    const subjectKey = subject[kind];
    return subjectKey === scopeId;
  });
  // Sort: priority desc; within same priority, deny-bearing policies evaluated first.
  matching.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ad = (a.deny || []).length > 0 ? 1 : 0;
    const bd = (b.deny || []).length > 0 ? 1 : 0;
    return bd - ad;
  });

  for (const policy of matching) {
    const denyMatch = ruleMatchAny(policy.deny || [], resource);
    if (denyMatch) {
      return {
        allowed: false,
        matchedRule: denyMatch,
        policyId: policy.id,
        policyName: policy.name,
        reason: "denied_by_policy",
      };
    }
    const allowMatch = ruleMatchAny(policy.allow || [], resource);
    if (allowMatch) {
      return {
        allowed: true,
        matchedRule: allowMatch,
        policyId: policy.id,
        policyName: policy.name,
        reason: "allowed_by_policy",
      };
    }
  }
  return {
    allowed: true,
    matchedRule: null,
    policyId: null,
    policyName: null,
    reason: "no_matching_policy",
  };
}

export const _internals = { policyPath, indexPath, ruleMatchAny };
