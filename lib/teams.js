/**
 * Phase 29: Multi-Tenant Teams & Collaboration.
 * Phase 68: Async durable store via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { randomBytes } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const INVITE_CODE_LENGTH = 8;
const VALID_ROLES = new Set(["admin", "member", "viewer"]);
const ACTIVITY_MAX_ENTRIES = 500;

function workspaceMembersPath() {
  return join(getDataDir(), "workspace-members.json");
}
function teamInvitesPath() {
  return join(getDataDir(), "team-invites.json");
}
function workspaceActivityPath() {
  return join(getDataDir(), "workspace-activity.json");
}

/**
 * Get workspace access info: ownerId and user's role.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, ownerId?: string, role?: string }>}
 */
export async function canAccessWorkspace(workspaceId, userId, workspaceOwnerId) {
  if (!workspaceId || !userId) return { allowed: false };
  const members = await readJsonPath(workspaceMembersPath(), { _version: 1, items: {} });
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
 */
export async function registerWorkspaceMembers(workspaceId, ownerId, members = []) {
  const path = workspaceMembersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, items: {} });
    if (!data.items) data.items = {};
    const existing = (members || []).filter((m) => m?.userId && VALID_ROLES.has(m?.role));
    const withOwner = existing.some((m) => String(m.userId) === String(ownerId))
      ? existing
      : [{ userId: ownerId, role: "admin" }, ...existing];
    data.items[String(workspaceId)] = { ownerId, members: withOwner };
    await writeJsonPath(path, data);
  });
}

/**
 * Add a member to a team workspace.
 */
export async function addWorkspaceMember(workspaceId, userId, role, ownerId) {
  if (!VALID_ROLES.has(role)) role = "member";
  const path = workspaceMembersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, items: {} });
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
    await writeJsonPath(path, data);
    return true;
  });
}

/**
 * Get workspace owner ID (for team workspaces). Returns null for personal workspaces.
 */
export async function getWorkspaceOwner(workspaceId) {
  const data = await readJsonPath(workspaceMembersPath(), { items: {} });
  return data.items?.[String(workspaceId)]?.ownerId ?? null;
}

/**
 * Resolve which userId to use for storage path. For team workspaces, use ownerId; else use userId.
 */
export async function resolveStorageUserId(userId, workspaceId) {
  const owner = await getWorkspaceOwner(workspaceId);
  return owner || userId;
}

/**
 * Get members of a team workspace.
 */
export async function getWorkspaceMembers(workspaceId) {
  const data = await readJsonPath(workspaceMembersPath(), { items: {} });
  return data.items?.[String(workspaceId)] ?? null;
}

/**
 * Get team workspaces where user is a member but NOT owner.
 */
export async function getWorkspacesForMember(userId) {
  const data = await readJsonPath(workspaceMembersPath(), { items: {} });
  const result = [];
  for (const [workspaceId, entry] of Object.entries(data.items || {})) {
    if (!entry?.ownerId || !entry?.members) continue;
    if (String(entry.ownerId) === String(userId)) continue;
    const mem = (entry.members || []).find((m) => String(m.userId) === String(userId));
    if (mem) result.push({ workspaceId, ownerId: entry.ownerId, role: mem.role });
  }
  return result;
}

function generateCode() {
  return randomBytes(INVITE_CODE_LENGTH / 2)
    .toString("hex")
    .toUpperCase()
    .slice(0, INVITE_CODE_LENGTH);
}

/**
 * Create an invite code for a team workspace.
 */
export async function createInviteCode(workspaceId, createdBy, opts = {}) {
  const path = teamInvitesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, invites: [] });
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
    await writeJsonPath(path, data);
    return { code, expiresAt: invite.expiresAt, maxUses: invite.maxUses };
  });
}

/**
 * Join a workspace by invite code.
 */
export async function joinByInviteCode(code, userId) {
  if (!code || !userId) return { ok: false, error: "Code and user required" };
  const invitesP = teamInvitesPath();
  return withPathLock(invitesP, async () => {
    const data = await readJsonPath(invitesP, { invites: [] });
    const invite = (data.invites || []).find((i) => String(i.code).toUpperCase() === String(code).toUpperCase());
    if (!invite) return { ok: false, error: "Invalid or expired invite code" };
    const now = new Date();
    if (invite.expiresAt && new Date(invite.expiresAt) < now) {
      return { ok: false, error: "Invite code has expired" };
    }
    if (invite.maxUses != null && (invite.usedCount || 0) >= invite.maxUses) {
      return { ok: false, error: "Invite code has reached maximum uses" };
    }
    const members = await getWorkspaceMembers(invite.workspaceId);
    if (!members) return { ok: false, error: "Workspace not found" };
    const alreadyMember = (members.members || []).some((m) => String(m.userId) === String(userId));
    if (alreadyMember) return { ok: false, error: "Already a member" };
    // Seat enforcement (no-op unless ENFORCE_PLAN_LIMITS=1). Fail open.
    try {
      const { enforcementEnabled, checkMemberLimit } = await import("./entitlements.js");
      if (enforcementEnabled()) {
        const seat = await checkMemberLimit(invite.workspaceId, (members.members || []).length);
        if (!seat.allowed) return { ok: false, error: seat.reason, code: "PLAN_LIMIT" };
      }
    } catch { /* entitlements optional */ }
    await addWorkspaceMember(invite.workspaceId, userId, "member", members.ownerId);
    invite.usedCount = (invite.usedCount || 0) + 1;
    await writeJsonPath(invitesP, data);
    return { ok: true, workspaceId: invite.workspaceId };
  });
}

/**
 * Log an activity event for a workspace.
 */
export async function logActivity(workspaceId, action, userId, meta = {}) {
  const path = workspaceActivityPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
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
    await writeJsonPath(path, data);
  });
}

/**
 * Get activity feed for a workspace.
 */
export async function getWorkspaceActivity(workspaceId, limit = 50) {
  const data = await readJsonPath(workspaceActivityPath(), { byWorkspace: {} });
  const entries = data.byWorkspace?.[String(workspaceId)] || [];
  return entries.slice(-limit).reverse();
}

/**
 * Phase 74: Remove team metadata for a deleted workspace (members, invites, activity).
 */
export async function deleteWorkspaceTeamData(workspaceId) {
  const wid = String(workspaceId);
  const mPath = workspaceMembersPath();
  await withPathLock(mPath, async () => {
    const d = await readJsonPath(mPath, { items: {} });
    if (d.items && d.items[wid]) delete d.items[wid];
    await writeJsonPath(mPath, d);
  });
  const iPath = teamInvitesPath();
  await withPathLock(iPath, async () => {
    const d = await readJsonPath(iPath, { invites: [] });
    d.invites = (d.invites || []).filter((inv) => String(inv.workspaceId) !== wid);
    await writeJsonPath(iPath, d);
  });
  const aPath = workspaceActivityPath();
  await withPathLock(aPath, async () => {
    const d = await readJsonPath(aPath, { byWorkspace: {} });
    if (d.byWorkspace && d.byWorkspace[wid]) delete d.byWorkspace[wid];
    await writeJsonPath(aPath, d);
  });
}
