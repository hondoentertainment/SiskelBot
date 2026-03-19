/**
 * Phase 29: Multi-Tenant Teams & Collaboration.
 * Invite codes, workspace members, roles, activity feed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const WORKSPACE_MEMBERS_PATH = join(DATA_DIR, "workspace-members.json");
const TEAM_INVITES_PATH = join(DATA_DIR, "team-invites.json");
const WORKSPACE_ACTIVITY_PATH = join(DATA_DIR, "workspace-activity.json");

const INVITE_CODE_LENGTH = 8;
const VALID_ROLES = new Set(["admin", "member", "viewer"]);
const ACTIVITY_MAX_ENTRIES = 500;

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(path, defaultVal) {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[teams] Failed to load", path, e.message);
  }
  return defaultVal ?? { _version: 1, items: {} };
}

function saveJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 0), "utf8");
}

/**
 * Get workspace access info: ownerId and user's role.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {{ allowed: boolean, ownerId?: string, role?: string }}
 */
export function canAccessWorkspace(workspaceId, userId, workspaceOwnerId) {
  if (!workspaceId || !userId) return { allowed: false };
  const members = loadJson(WORKSPACE_MEMBERS_PATH, { items: {} });
  const entry = members.items?.[String(workspaceId)];
  if (entry) {
    const mem = (entry.members || []).find((m) => String(m.userId) === String(userId));
    if (mem && VALID_ROLES.has(mem.role)) {
      return { allowed: true, ownerId: entry.ownerId, role: mem.role };
    }
  }
  if (workspaceOwnerId && String(workspaceOwnerId) === String(userId)) {
    return { allowed: true, ownerId: workspaceOwnerId, role: "admin" };
  }
  return { allowed: false };
}

/**
 * Register a team workspace with owner and initial members.
 * @param {string} workspaceId
 * @param {string} ownerId
 * @param {Array<{ userId: string, role: string }>} members
 */
export function registerWorkspaceMembers(workspaceId, ownerId, members = []) {
  const data = loadJson(WORKSPACE_MEMBERS_PATH, { _version: 1, items: {} });
  if (!data.items) data.items = {};
  const existing = (members || []).filter((m) => m?.userId && VALID_ROLES.has(m?.role));
  const withOwner = existing.some((m) => String(m.userId) === String(ownerId))
    ? existing
    : [{ userId: ownerId, role: "admin" }, ...existing];
  data.items[String(workspaceId)] = { ownerId, members: withOwner };
  saveJson(WORKSPACE_MEMBERS_PATH, data);
}

/**
 * Add a member to a team workspace.
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} role
 * @param {string} ownerId
 * @returns {boolean}
 */
export function addWorkspaceMember(workspaceId, userId, role, ownerId) {
  if (!VALID_ROLES.has(role)) role = "member";
  const data = loadJson(WORKSPACE_MEMBERS_PATH, { _version: 1, items: {} });
  if (!data.items) data.items = {};
  let entry = data.items[String(workspaceId)];
  if (!entry) {
    entry = { ownerId, members: [{ userId: ownerId, role: "admin" }] };
    data.items[String(workspaceId)] = entry;
  }
  const idx = (entry.members || []).findIndex((m) => String(m.userId) === String(userId));
  if (idx >= 0) {
    entry.members[idx].role = role;
  } else {
    entry.members.push({ userId, role });
  }
  saveJson(WORKSPACE_MEMBERS_PATH, data);
  return true;
}

/**
 * Get workspace owner ID (for team workspaces). Returns null for personal workspaces.
 */
export function getWorkspaceOwner(workspaceId) {
  const data = loadJson(WORKSPACE_MEMBERS_PATH, { items: {} });
  return data.items?.[String(workspaceId)]?.ownerId ?? null;
}

/**
 * Resolve which userId to use for storage path. For team workspaces, use ownerId; else use userId.
 */
export function resolveStorageUserId(userId, workspaceId) {
  const owner = getWorkspaceOwner(workspaceId);
  return owner || userId;
}

/**
 * Get members of a team workspace.
 * @param {string} workspaceId
 * @returns {{ ownerId: string, members: Array<{ userId: string, role: string }> } | null}
 */
export function getWorkspaceMembers(workspaceId) {
  const data = loadJson(WORKSPACE_MEMBERS_PATH, { items: {} });
  return data.items?.[String(workspaceId)] ?? null;
}

/**
 * Get team workspaces where user is a member but NOT owner (owner's workspaces come from their workspaces.json).
 * @param {string} userId
 * @returns {Array<{ workspaceId: string, ownerId: string, role: string }>}
 */
export function getWorkspacesForMember(userId) {
  const data = loadJson(WORKSPACE_MEMBERS_PATH, { items: {} });
  const result = [];
  for (const [workspaceId, entry] of Object.entries(data.items || {})) {
    if (!entry?.ownerId || !entry?.members) continue;
    if (String(entry.ownerId) === String(userId)) continue;
    const mem = (entry.members || []).find((m) => String(m.userId) === String(userId));
    if (mem) result.push({ workspaceId, ownerId: entry.ownerId, role: mem.role });
  }
  return result;
}

// --- Invite codes ---

function generateCode() {
  return randomBytes(INVITE_CODE_LENGTH / 2)
    .toString("hex")
    .toUpperCase()
    .slice(0, INVITE_CODE_LENGTH);
}

/**
 * Create an invite code for a team workspace.
 * @param {string} workspaceId
 * @param {string} createdBy - userId of admin creating invite
 * @param {object} opts - { expiresInHours?, maxUses? }
 * @returns {{ code: string, expiresAt?: string, maxUses?: number }}
 */
export function createInviteCode(workspaceId, createdBy, opts = {}) {
  const data = loadJson(TEAM_INVITES_PATH, { _version: 1, invites: [] });
  if (!Array.isArray(data.invites)) data.invites = [];
  let code;
  const used = new Set(data.invites.map((i) => i.code));
  do {
    code = generateCode();
  } while (used.has(code));
  const invite = {
    code,
    workspaceId,
    createdBy,
    createdAt: new Date().toISOString(),
    usedCount: 0,
  };
  if (opts.expiresInHours) {
    invite.expiresAt = new Date(Date.now() + opts.expiresInHours * 60 * 60 * 1000).toISOString();
  }
  if (opts.maxUses != null) invite.maxUses = Number(opts.maxUses);
  data.invites.push(invite);
  saveJson(TEAM_INVITES_PATH, data);
  return { code, expiresAt: invite.expiresAt, maxUses: invite.maxUses };
}

/**
 * Join a workspace by invite code.
 * @param {string} code
 * @param {string} userId
 * @returns {{ ok: boolean, workspaceId?: string, workspaceName?: string, error?: string }}
 */
export function joinByInviteCode(code, userId) {
  if (!code || !userId) return { ok: false, error: "Code and user required" };
  const data = loadJson(TEAM_INVITES_PATH, { invites: [] });
  const invite = (data.invites || []).find((i) => String(i.code).toUpperCase() === String(code).toUpperCase());
  if (!invite) return { ok: false, error: "Invalid or expired invite code" };
  const now = new Date();
  if (invite.expiresAt && new Date(invite.expiresAt) < now) {
    return { ok: false, error: "Invite code has expired" };
  }
  if (invite.maxUses != null && (invite.usedCount || 0) >= invite.maxUses) {
    return { ok: false, error: "Invite code has reached maximum uses" };
  }
  const members = getWorkspaceMembers(invite.workspaceId);
  if (!members) return { ok: false, error: "Workspace not found" };
  const alreadyMember = (members.members || []).some((m) => String(m.userId) === String(userId));
  if (alreadyMember) return { ok: false, error: "Already a member" };
  addWorkspaceMember(invite.workspaceId, userId, "member", members.ownerId);
  invite.usedCount = (invite.usedCount || 0) + 1;
  saveJson(TEAM_INVITES_PATH, data);
  return { ok: true, workspaceId: invite.workspaceId };
}

// --- Activity feed ---

/**
 * Log an activity event for a workspace.
 * @param {string} workspaceId
 * @param {string} action - e.g. "context_added", "recipe_ran", "conversation_created"
 * @param {string} userId
 * @param {object} meta - optional extra data
 */
export function logActivity(workspaceId, action, userId, meta = {}) {
  const data = loadJson(WORKSPACE_ACTIVITY_PATH, { _version: 1, byWorkspace: {} });
  if (!data.byWorkspace) data.byWorkspace = {};
  const key = String(workspaceId);
  if (!data.byWorkspace[key]) data.byWorkspace[key] = [];
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    userId,
    ...meta,
  };
  data.byWorkspace[key].push(entry);
  if (data.byWorkspace[key].length > ACTIVITY_MAX_ENTRIES) {
    data.byWorkspace[key] = data.byWorkspace[key].slice(-ACTIVITY_MAX_ENTRIES);
  }
  saveJson(WORKSPACE_ACTIVITY_PATH, data);
}

/**
 * Get activity feed for a workspace.
 * @param {string} workspaceId
 * @param {number} limit
 * @returns {Array<object>}
 */
export function getWorkspaceActivity(workspaceId, limit = 50) {
  const data = loadJson(WORKSPACE_ACTIVITY_PATH, { byWorkspace: {} });
  const entries = data.byWorkspace?.[String(workspaceId)] || [];
  return entries.slice(-limit).reverse();
}
