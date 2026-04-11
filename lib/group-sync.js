/**
 * Phase 46.4: Group synchronization from external identity providers.
 *
 * Maps LDAP / SCIM / OAuth / SAML group memberships onto SiskelBot workspaces
 * and roles via declarative sync rules. Stores rules, sync history, and a
 * mapping of which user belongs to which workspace because of which rules so
 * that membership can be reconciled (added when a rule starts matching, removed
 * when a rule stops matching).
 *
 * Storage layout (json-path-store):
 *   data/group-sync-rules.json     { _version, items: [rule, ...] }
 *   data/group-sync-history.json   { _version, runs: [run, ...] }
 *   data/group-sync-state.json     { _version, byUser: { userId: { wsId: { ruleIds, role } } } }
 *
 * Rule shape:
 *   {
 *     id, name,
 *     source: "ldap" | "scim" | "oauth" | "saml",
 *     groupPattern,           // literal | "/regex/flags" | glob with * ?
 *     patternType,            // optional explicit "literal" | "regex" | "glob"
 *     targetWorkspace,
 *     targetRole,             // viewer | member | admin | owner
 *     autoCreateWorkspace,    // boolean
 *     permissions,            // optional list of extra permission strings
 *     enabled,                // boolean (default true)
 *     createdAt, updatedAt, createdBy
 *   }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import {
  evaluateRules,
  reduceMatchesByWorkspace,
  resolveRoleConflict,
  ROLE_ORDER,
} from "./group-rule-engine.js";

const VALID_SOURCES = new Set(["ldap", "scim", "oauth", "saml"]);
const VALID_ROLES = new Set(ROLE_ORDER);
const MAX_HISTORY_RUNS = 500;

function rulesPath() {
  return join(getDataDir(), "group-sync-rules.json");
}
function historyPath() {
  return join(getDataDir(), "group-sync-history.json");
}
function statePath() {
  return join(getDataDir(), "group-sync-state.json");
}

async function loadRules() {
  const data = await readJsonPath(rulesPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}
async function saveRules(items) {
  await writeJsonPath(rulesPath(), { _version: 1, items });
}

async function loadHistory() {
  const data = await readJsonPath(historyPath(), { _version: 1, runs: [] });
  return Array.isArray(data.runs) ? data.runs : [];
}
async function saveHistory(runs) {
  const trimmed = runs.length > MAX_HISTORY_RUNS ? runs.slice(-MAX_HISTORY_RUNS) : runs;
  await writeJsonPath(historyPath(), { _version: 1, runs: trimmed });
}

async function loadState() {
  const data = await readJsonPath(statePath(), { _version: 1, byUser: {} });
  if (!data.byUser || typeof data.byUser !== "object") data.byUser = {};
  return data;
}
async function saveState(state) {
  await writeJsonPath(statePath(), { _version: 1, byUser: state.byUser || {} });
}

function publicRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    source: rule.source,
    groupPattern: rule.groupPattern,
    patternType: rule.patternType || null,
    targetWorkspace: rule.targetWorkspace,
    targetRole: rule.targetRole,
    autoCreateWorkspace: !!rule.autoCreateWorkspace,
    permissions: Array.isArray(rule.permissions) ? rule.permissions : [],
    enabled: rule.enabled !== false,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    createdBy: rule.createdBy || null,
  };
}

function normalizeConfig(config, partial = false) {
  if (!config || typeof config !== "object") {
    throw new Error("rule config is required");
  }
  const out = {};
  if (config.name != null) {
    if (typeof config.name !== "string" || !config.name.trim()) {
      throw new Error("name is required");
    }
    out.name = config.name.trim().slice(0, 200);
  } else if (!partial) {
    throw new Error("name is required");
  }
  if (config.source != null) {
    if (!VALID_SOURCES.has(config.source)) {
      throw new Error(`source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`);
    }
    out.source = config.source;
  } else if (!partial) {
    throw new Error(`source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`);
  }
  if (config.groupPattern != null) {
    if (typeof config.groupPattern !== "string" || !config.groupPattern.trim()) {
      throw new Error("groupPattern is required");
    }
    out.groupPattern = config.groupPattern.trim().slice(0, 500);
  } else if (!partial) {
    throw new Error("groupPattern is required");
  }
  if (config.patternType != null) {
    const t = String(config.patternType);
    if (!["literal", "regex", "glob"].includes(t)) {
      throw new Error("patternType must be literal, regex, or glob");
    }
    out.patternType = t;
  }
  if (config.targetWorkspace != null) {
    if (typeof config.targetWorkspace !== "string" || !config.targetWorkspace.trim()) {
      throw new Error("targetWorkspace is required");
    }
    out.targetWorkspace = config.targetWorkspace.trim().slice(0, 200);
  } else if (!partial) {
    throw new Error("targetWorkspace is required");
  }
  if (config.targetRole != null) {
    if (!VALID_ROLES.has(config.targetRole)) {
      throw new Error(`targetRole must be one of: ${Array.from(VALID_ROLES).join(", ")}`);
    }
    out.targetRole = config.targetRole;
  } else if (!partial) {
    throw new Error(`targetRole must be one of: ${Array.from(VALID_ROLES).join(", ")}`);
  }
  if (config.autoCreateWorkspace != null) {
    out.autoCreateWorkspace = !!config.autoCreateWorkspace;
  }
  if (config.permissions != null) {
    if (!Array.isArray(config.permissions)) {
      throw new Error("permissions must be an array");
    }
    out.permissions = config.permissions.map(String);
  }
  if (config.enabled != null) {
    out.enabled = !!config.enabled;
  }
  return out;
}

// ─── Rule CRUD ──────────────────────────────────────────────────────────────

/**
 * Create a new group sync rule.
 * @param {object} config
 * @returns {Promise<object>} created rule (public view)
 */
export async function createGroupSyncRule(config) {
  const norm = normalizeConfig(config, false);
  const path = rulesPath();
  let created;
  await withPathLock(path, async () => {
    const items = await loadRules();
    const now = new Date().toISOString();
    created = {
      id: randomUUID(),
      name: norm.name,
      source: norm.source,
      groupPattern: norm.groupPattern,
      patternType: norm.patternType || null,
      targetWorkspace: norm.targetWorkspace,
      targetRole: norm.targetRole,
      autoCreateWorkspace: !!norm.autoCreateWorkspace,
      permissions: norm.permissions || [],
      enabled: norm.enabled !== false,
      createdAt: now,
      updatedAt: now,
      createdBy: config.createdBy || null,
    };
    items.push(created);
    await saveRules(items);
  });
  return publicRule(created);
}

/**
 * List rules. Optionally filter by target workspace.
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function listGroupSyncRules(workspaceId) {
  const items = await loadRules();
  const filtered = workspaceId
    ? items.filter((r) => String(r.targetWorkspace) === String(workspaceId))
    : items;
  return filtered.map(publicRule);
}

/**
 * Get a single rule by id.
 * @param {string} ruleId
 * @returns {Promise<object|null>}
 */
export async function getGroupSyncRule(ruleId) {
  const items = await loadRules();
  const found = items.find((r) => r.id === ruleId);
  return found ? publicRule(found) : null;
}

/**
 * Update a rule. Only the supplied fields are changed.
 * @param {string} ruleId
 * @param {object} updates
 * @returns {Promise<object|null>}
 */
export async function updateGroupSyncRule(ruleId, updates) {
  const norm = normalizeConfig(updates || {}, true);
  const path = rulesPath();
  let updated = null;
  await withPathLock(path, async () => {
    const items = await loadRules();
    const idx = items.findIndex((r) => r.id === ruleId);
    if (idx < 0) return;
    items[idx] = {
      ...items[idx],
      ...norm,
      updatedAt: new Date().toISOString(),
    };
    updated = items[idx];
    await saveRules(items);
  });
  return updated ? publicRule(updated) : null;
}

/**
 * Delete a rule.
 * @param {string} ruleId
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteGroupSyncRule(ruleId) {
  const path = rulesPath();
  let removed = false;
  await withPathLock(path, async () => {
    const items = await loadRules();
    const next = items.filter((r) => r.id !== ruleId);
    removed = next.length !== items.length;
    if (removed) await saveRules(next);
  });
  return { ok: removed };
}

// ─── Workspace membership backend (file-level helpers) ─────────────────────

const WORKSPACE_MEMBERS_FILE = "workspace-members.json";

function membersPath() {
  return join(getDataDir(), WORKSPACE_MEMBERS_FILE);
}

async function loadMembers() {
  return readJsonPath(membersPath(), { _version: 1, items: {} });
}

async function ensureWorkspaceEntry(data, workspaceId, ownerHint) {
  const key = String(workspaceId);
  if (!data.items[key]) {
    data.items[key] = {
      ownerId: ownerHint || "group-sync",
      members: [],
      autoCreated: true,
      createdAt: new Date().toISOString(),
    };
  }
  return data.items[key];
}

/**
 * Apply add/update/remove membership operations atomically against the
 * workspace-members.json store.
 * @param {Array<{ op: "add"|"update"|"remove", workspaceId: string, userId: string, role?: string, autoCreate?: boolean }>} ops
 */
async function applyMembershipOps(ops) {
  const path = membersPath();
  await withPathLock(path, async () => {
    const data = await loadMembers();
    if (!data.items) data.items = {};
    for (const op of ops) {
      const key = String(op.workspaceId);
      let entry = data.items[key];
      if (!entry) {
        if (op.op === "remove") continue;
        if (!op.autoCreate) continue;
        entry = await ensureWorkspaceEntry(data, key, op.userId);
      }
      if (!Array.isArray(entry.members)) entry.members = [];
      const idx = entry.members.findIndex((m) => String(m.userId) === String(op.userId));
      if (op.op === "remove") {
        if (idx >= 0) entry.members.splice(idx, 1);
        continue;
      }
      // add or update
      const role = VALID_ROLES.has(op.role) ? op.role : "member";
      if (idx >= 0) {
        entry.members[idx].role = role;
        entry.members[idx].source = "group-sync";
      } else {
        entry.members.push({ userId: op.userId, role, source: "group-sync" });
      }
    }
    await writeJsonPath(path, data);
  });
}

// ─── Sync state ────────────────────────────────────────────────────────────

async function getUserState(userId) {
  const state = await loadState();
  return state.byUser[String(userId)] || {};
}

async function setUserState(userId, value) {
  const path = statePath();
  await withPathLock(path, async () => {
    const state = await loadState();
    state.byUser[String(userId)] = value;
    await saveState(state);
  });
}

// ─── Audit / observability ─────────────────────────────────────────────────

let auditSink = null;
/**
 * Install an audit sink. Called for every sync operation. Defaults to a
 * console-only sink. Tests use this to capture audit events.
 * @param {(entry: object) => Promise<void>|void} fn
 */
export function setAuditSink(fn) {
  auditSink = typeof fn === "function" ? fn : null;
}

async function audit(entry) {
  const e = { timestamp: new Date().toISOString(), kind: "group-sync", ...entry };
  if (auditSink) {
    try { await auditSink(e); } catch (err) {
      console.warn("[group-sync] audit sink error:", err.message);
    }
    return;
  }
  // Best-effort default: write through action-executor's audit log if available.
  try {
    const mod = await import("./action-executor.js");
    if (mod && typeof mod.appendAuditLog === "function") {
      await mod.appendAuditLog({ action: "group-sync", payload: entry, ok: !entry.error, error: entry.error, source: entry.source || "group-sync" });
    }
  } catch {
    // ignore
  }
}

// ─── Sync ──────────────────────────────────────────────────────────────────

/**
 * Synchronize a single user against current rules and the supplied list of
 * external groups for that user from a specific source. Adds the user to
 * workspaces that newly match, removes the user from workspaces they no
 * longer belong to (only those previously assigned by sync from the same
 * source), and leaves untouched any workspace they kept on.
 *
 * @param {string} userId
 * @param {string[]} externalGroups
 * @param {"ldap"|"scim"|"oauth"|"saml"} source
 * @returns {Promise<{ added: object[], removed: object[], unchanged: object[] }>}
 */
export async function syncUserGroups(userId, externalGroups, source) {
  if (!userId) throw new Error("userId is required");
  if (!Array.isArray(externalGroups)) externalGroups = [];
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`);
  }

  const allRules = await loadRules();
  const sourceRules = allRules.filter((r) => r.source === source && r.enabled !== false);
  const matches = evaluateRules(externalGroups, sourceRules);
  const desired = reduceMatchesByWorkspace(matches); // Map<wsId, { role, ruleIds, matchedGroups }>

  // Previous state for this user from this source
  const prevAll = await getUserState(userId);
  const prevForSource = prevAll[source] || {}; // { wsId: { role, ruleIds } }

  const added = [];
  const removed = [];
  const unchanged = [];
  const ops = [];

  // Determine adds and updates
  for (const [wsId, info] of desired.entries()) {
    const prev = prevForSource[wsId];
    const rule = allRules.find((r) => info.ruleIds.includes(r.id));
    const autoCreate = !!rule?.autoCreateWorkspace;
    if (!prev) {
      added.push({ workspaceId: wsId, role: info.role, ruleIds: info.ruleIds, matchedGroups: info.matchedGroups });
      ops.push({ op: "add", workspaceId: wsId, userId, role: info.role, autoCreate });
    } else if (prev.role !== info.role) {
      added.push({ workspaceId: wsId, role: info.role, previousRole: prev.role, updated: true, ruleIds: info.ruleIds, matchedGroups: info.matchedGroups });
      ops.push({ op: "update", workspaceId: wsId, userId, role: info.role, autoCreate });
    } else {
      unchanged.push({ workspaceId: wsId, role: info.role, ruleIds: info.ruleIds });
    }
  }

  // Determine removals: workspaces previously sync'd from this source but no longer matched
  for (const wsId of Object.keys(prevForSource)) {
    if (!desired.has(wsId)) {
      removed.push({ workspaceId: wsId, previousRole: prevForSource[wsId].role });
      ops.push({ op: "remove", workspaceId: wsId, userId });
    }
  }

  if (ops.length > 0) {
    await applyMembershipOps(ops);
  }

  // Persist new state for this source
  const nextForSource = {};
  for (const [wsId, info] of desired.entries()) {
    nextForSource[wsId] = { role: info.role, ruleIds: info.ruleIds };
  }
  const nextAll = { ...prevAll, [source]: nextForSource };
  await setUserState(userId, nextAll);

  await audit({
    op: "sync-user",
    source,
    userId,
    added: added.length,
    removed: removed.length,
    unchanged: unchanged.length,
    addedDetails: added,
    removedDetails: removed,
  });

  return { added, removed, unchanged };
}

/**
 * Pluggable provider used by {@link runFullGroupSync} to enumerate all users
 * from a particular source. Tests / integrations install this with the
 * appropriate adapter for their identity provider.
 *
 * @callback FullSyncProvider
 * @param {string} source
 * @returns {Promise<Array<{ userId: string, groups: string[] }>>}
 */

/** @type {FullSyncProvider | null} */
let fullSyncProvider = null;
/**
 * Install a provider that enumerates users for a source. Without this hook,
 * runFullGroupSync returns an empty result.
 * @param {FullSyncProvider} fn
 */
export function setFullSyncProvider(fn) {
  fullSyncProvider = typeof fn === "function" ? fn : null;
}

/**
 * Run a full sync for all users from a source. Persists a run summary to
 * history. Intended to be called by the scheduler.
 * @param {"ldap"|"scim"|"oauth"|"saml"} source
 * @returns {Promise<{ usersProcessed: number, changes: number, errors: Array<{ userId: string, error: string }>, runId: string }>}
 */
export async function runFullGroupSync(source) {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`source must be one of: ${Array.from(VALID_SOURCES).join(", ")}`);
  }
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  let usersProcessed = 0;
  let changes = 0;
  const errors = [];
  let users = [];
  if (fullSyncProvider) {
    try {
      users = (await fullSyncProvider(source)) || [];
    } catch (err) {
      errors.push({ userId: "*", error: err.message });
    }
  }
  for (const u of users) {
    if (!u || !u.userId) continue;
    try {
      const result = await syncUserGroups(u.userId, u.groups || [], source);
      usersProcessed++;
      changes += result.added.length + result.removed.length;
    } catch (err) {
      errors.push({ userId: u.userId, error: err.message });
    }
  }
  const finishedAt = new Date().toISOString();
  const run = {
    id: runId,
    source,
    startedAt,
    finishedAt,
    usersProcessed,
    changes,
    errorCount: errors.length,
    errors: errors.slice(0, 50),
  };
  await withPathLock(historyPath(), async () => {
    const runs = await loadHistory();
    runs.push(run);
    await saveHistory(runs);
  });
  await audit({ op: "full-sync", source, runId, usersProcessed, changes, errorCount: errors.length });
  return { usersProcessed, changes, errors, runId };
}

/**
 * Return recent sync history runs.
 * @param {{ source?: string, limit?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function getGroupSyncHistory(options = {}) {
  const runs = await loadHistory();
  let filtered = runs;
  if (options.source) {
    filtered = filtered.filter((r) => r.source === options.source);
  }
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
  return filtered.slice(-limit).reverse();
}

/**
 * Dry-run a rule against a sample list of group names. Returns what would
 * happen without modifying any state.
 *
 * @param {object} rule - normalized or partial rule definition
 * @param {string[]} testGroups
 * @returns {{ matched: boolean, matchedGroup: string|null, wouldAssign: { workspaceId: string, role: string }|null }}
 */
export function testGroupSyncRule(rule, testGroups) {
  if (!rule || typeof rule !== "object") {
    throw new Error("rule is required");
  }
  if (!Array.isArray(testGroups)) testGroups = [];
  // Wrap as a single rule list and reuse the same evaluation engine to
  // guarantee dry-run behaviour matches real sync.
  const matches = evaluateRules(testGroups, [{ ...rule, enabled: true }]);
  if (matches.length === 0) {
    return { matched: false, matchedGroup: null, wouldAssign: null };
  }
  const m = matches[0];
  const role = resolveRoleConflict([rule.targetRole]) || rule.targetRole || "viewer";
  return {
    matched: true,
    matchedGroup: m.matchedGroup,
    wouldAssign: rule.targetWorkspace
      ? { workspaceId: rule.targetWorkspace, role }
      : null,
  };
}

// ─── Scheduler hook ────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let scheduledTimer = null;

function intervalMs() {
  const fromEnv = Number(process.env.GROUP_SYNC_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_INTERVAL_MS;
}

function isEnabled() {
  return process.env.GROUP_SYNC_ENABLED === "1";
}

/**
 * Run a scheduled tick. Iterates over all sources that have at least one
 * enabled rule and runs a full sync for each.
 * @returns {Promise<{ ran: number, sources: string[], errors: Array<object> }>}
 */
export async function runScheduledGroupSync() {
  if (!isEnabled()) {
    return { ran: 0, sources: [], errors: [], skipped: true };
  }
  const allRules = await loadRules();
  const sources = Array.from(
    new Set(allRules.filter((r) => r.enabled !== false).map((r) => r.source).filter(Boolean))
  );
  let ran = 0;
  const errors = [];
  for (const source of sources) {
    try {
      await runFullGroupSync(source);
      ran++;
    } catch (err) {
      errors.push({ source, error: err.message });
    }
  }
  return { ran, sources, errors };
}

/**
 * Start a periodic timer that runs {@link runScheduledGroupSync}. Safe to call
 * multiple times — replaces any existing timer.
 */
export function startScheduledGroupSync() {
  stopScheduledGroupSync();
  if (!isEnabled()) return;
  const ms = intervalMs();
  scheduledTimer = setInterval(() => {
    runScheduledGroupSync().catch((err) => {
      console.warn("[group-sync] scheduled tick error:", err.message);
    });
  }, ms);
  if (typeof scheduledTimer.unref === "function") scheduledTimer.unref();
}

/**
 * Stop the periodic sync timer.
 */
export function stopScheduledGroupSync() {
  if (scheduledTimer) {
    clearInterval(scheduledTimer);
    scheduledTimer = null;
  }
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Reset all group-sync persisted state. Test only.
 */
export async function _resetForTests() {
  await saveRules([]);
  await saveHistory([]);
  await writeJsonPath(statePath(), { _version: 1, byUser: {} });
  // Also wipe membership entries marked as auto-created by group-sync.
  await withPathLock(membersPath(), async () => {
    const data = await loadMembers();
    if (data.items) {
      for (const key of Object.keys(data.items)) {
        const entry = data.items[key];
        if (entry?.autoCreated && entry?.ownerId === "group-sync") {
          delete data.items[key];
        } else if (Array.isArray(entry?.members)) {
          entry.members = entry.members.filter((m) => m.source !== "group-sync");
        }
      }
      await writeJsonPath(membersPath(), data);
    }
  });
}

/**
 * Read the raw membership entry for a workspace. Test helper.
 */
export async function _getWorkspaceMembersRaw(workspaceId) {
  const data = await loadMembers();
  return data.items?.[String(workspaceId)] || null;
}
