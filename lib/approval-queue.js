/**
 * Human approval queue for tools the workspace policy marks.
 * Off unless APPROVAL_QUEUE=1. Notifications are off unless APPROVAL_NOTIFY=1.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { sanitizeWorkspace } from "./storage.js";
import { recordDecision } from "./policy-audit.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function storePath(workspaceId) {
  return join(getDataDir(), "approvals", sanitizeWorkspace(workspaceId) + ".json");
}

function timeoutMs() {
  const n = Number(process.env.APPROVAL_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 20 ? n : DEFAULT_TIMEOUT_MS;
}

function publicRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    tool: row.tool,
    args: row.args,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt || null,
    decidedBy: row.decidedBy || null,
  };
}

async function readStore(workspaceId) {
  const store = await readJsonPath(storePath(workspaceId), { items: [] });
  return Array.isArray(store.items) ? store : { items: [] };
}

function expire(items, now = Date.now()) {
  for (const item of items) {
    if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
  }
}

export async function listApprovals(workspaceId, opts = {}) {
  const store = await readStore(workspaceId);
  expire(store.items);
  let items = store.items;
  if (opts.status) items = items.filter((item) => item.status === opts.status);
  return items.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(publicRow);
}

export async function createApproval({ workspaceId, userId, tool, args }) {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    workspaceId: sanitizeWorkspace(workspaceId),
    userId: String(userId || "anonymous"),
    tool: String(tool || ""),
    args: args && typeof args === "object" ? args : {},
    status: "pending",
    createdAt: now,
    expiresAt: now + timeoutMs(),
    decidedAt: null,
    decidedBy: null,
  };
  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { items: [] });
    if (!Array.isArray(store.items)) store.items = [];
    expire(store.items, now);
    store.items.push(row);
    store.items = store.items.slice(-200);
    await writeJsonPath(path, store);
  });
  if (process.env.APPROVAL_NOTIFY === "1") {
    await notifyApproval(row).catch(() => {});
  }
  return publicRow(row);
}

async function notifyApproval(row) {
  const text = `Approval needed for ${row.tool} in ${row.workspaceId}`;
  const emailTo = String(process.env.APPROVAL_NOTIFY_EMAIL || "").trim();
  if (emailTo) {
    const { sendEmail, isEmailConfigured } = await import("./email-notifications.js");
    if (isEmailConfigured()) await sendEmail(emailTo, "Approval needed", text);
  }
  const { notifySlack, isSlackConfigured } = await import("./slack-bot.js");
  if (isSlackConfigured()) await notifySlack("agent_notification", { summary: text, workspaceId: row.workspaceId });
}

export async function decideApproval(workspaceId, id, { status, by }) {
  if (status !== "approved" && status !== "denied") {
    const err = new Error("status must be approved or denied");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const path = storePath(workspaceId);
  let updated = null;
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { items: [] });
    expire(store.items || []);
    const row = (store.items || []).find((item) => item.id === id);
    if (!row) return;
    if (row.status !== "pending") {
      updated = row;
      return;
    }
    row.status = status;
    row.decidedAt = Date.now();
    row.decidedBy = String(by || "admin");
    updated = row;
    await writeJsonPath(path, store);
  });
  if (!updated) return null;
  await recordDecision({
    workspaceId,
    policyId: "approval-queue",
    source: "approval-queue",
    action: status === "approved" ? "allow" : "block",
    userId: updated.decidedBy,
    reason: `${status} ${updated.tool}`,
    metadata: { approvalId: updated.id, tool: updated.tool },
  });
  return publicRow(updated);
}

export async function waitForApproval(workspaceId, id, opts = {}) {
  const interval = Math.max(15, Number(opts.intervalMs) || 40);
  const deadline = Date.now() + (Number(opts.timeoutMs) || timeoutMs());
  while (Date.now() <= deadline) {
    const store = await readStore(workspaceId);
    expire(store.items);
    const row = store.items.find((item) => item.id === id);
    if (!row) return { status: "missing", approved: false };
    if (row.status === "approved") return { status: "approved", approved: true, row: publicRow(row) };
    if (row.status === "denied" || row.status === "expired") {
      return { status: row.status, approved: false, row: publicRow(row) };
    }
    if (row.expiresAt <= Date.now()) return { status: "expired", approved: false, row: publicRow(row) };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { status: "timeout", approved: false };
}

export async function approvalGate(workspaceId, userId, toolName) {
  if (process.env.APPROVAL_QUEUE !== "1") return { required: false };
  const { loadWorkspaceAgentSettings } = await import("./workspace-agent-settings.js");
  const { sanitizeUserId } = await import("./storage.js");
  const settings = await loadWorkspaceAgentSettings(sanitizeUserId(userId || "anonymous"), workspaceId);
  const names = settings?.agentPolicy?.approvalTools || [];
  return { required: names.includes(toolName) };
}
