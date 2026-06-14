import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function storePath(workspaceId) {
  return join(getDataDir(), "issue-pickup", `${workspaceId}.json`);
}

async function loadRecords(workspaceId) {
  const data = await readJsonPath(storePath(workspaceId), { records: [] });
  return Array.isArray(data.records) ? data.records : [];
}

async function saveRecords(workspaceId, records) {
  await writeJsonPath(storePath(workspaceId), { records });
}

export async function createIssuePickupRecord(workspaceId, data) {
  const now = Date.now();
  const record = {
    pickupId: randomUUID(),
    workspaceId,
    source: data.source || "github",
    issueId: String(data.issueId || ""),
    title: String(data.title || ""),
    body: String(data.body || ""),
    repoFullName: data.repoFullName ?? null,
    status: "pending",
    sessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  await withPathLock(storePath(workspaceId), async () => {
    const records = await loadRecords(workspaceId);
    records.push(record);
    await saveRecords(workspaceId, records);
  });
  return record;
}

export async function listPickedUpIssues(workspaceId) {
  return loadRecords(workspaceId);
}

export async function updateIssuePickupRecord(workspaceId, pickupId, updates) {
  let updated = null;
  await withPathLock(storePath(workspaceId), async () => {
    const records = await loadRecords(workspaceId);
    const idx = records.findIndex((r) => r.pickupId === pickupId);
    if (idx === -1) return;
    records[idx] = { ...records[idx], ...updates, updatedAt: Date.now() };
    updated = records[idx];
    await saveRecords(workspaceId, records);
  });
  return updated;
}

export async function handleGithubIssueWebhook(payload, workspaceId, opts = {}) {
  const triggerLabel = opts.triggerLabel ?? "devin";
  const { action, issue, label } = payload || {};

  if (!issue) return { triggered: false };

  const labelTriggered = action === "labeled" && label?.name === triggerLabel;
  const assignedTriggered =
    action === "assigned" &&
    Array.isArray(issue.assignees) &&
    issue.assignees.some(
      (a) => a.login === opts.botUser || a.type === "Bot",
    );

  if (!labelTriggered && !assignedTriggered) {
    return { triggered: false };
  }

  const repoFullName = payload.repository?.full_name ?? null;
  const record = await createIssuePickupRecord(workspaceId, {
    source: "github",
    issueId: String(issue.number || issue.id || ""),
    title: issue.title || "",
    body: issue.body || "",
    repoFullName,
  });

  return {
    triggered: true,
    issueId: record.issueId,
    title: record.title,
    body: record.body,
    repoFullName: record.repoFullName,
    branch: null,
    pickupId: record.pickupId,
  };
}

export async function handleLinearIssueWebhook(payload, workspaceId, opts = {}) {
  const triggerLabel = opts.triggerLabel ?? "devin";
  const issue = payload?.data || payload?.issue || payload;

  if (!issue) return { triggered: false };

  const labels = issue.labels ?? issue.labelIds ?? [];
  const hasLabel = Array.isArray(labels)
    ? labels.some((l) => (typeof l === "string" ? l === triggerLabel : l?.name === triggerLabel))
    : false;

  if (!hasLabel) return { triggered: false };

  const record = await createIssuePickupRecord(workspaceId, {
    source: "linear",
    issueId: String(issue.id || issue.identifier || ""),
    title: issue.title || "",
    body: issue.description || issue.body || "",
    repoFullName: null,
  });

  return {
    triggered: true,
    issueId: record.issueId,
    title: record.title,
    body: record.body,
    repoFullName: null,
    branch: null,
    pickupId: record.pickupId,
  };
}

export async function handleJiraIssueWebhook(payload, workspaceId, opts = {}) {
  const triggerLabel = opts.triggerLabel ?? "devin";
  const issue = payload?.issue || payload;

  if (!issue) return { triggered: false };

  const fields = issue.fields || issue;
  const labels = fields.labels ?? [];
  const hasLabel = Array.isArray(labels) && labels.includes(triggerLabel);

  if (!hasLabel) return { triggered: false };

  const record = await createIssuePickupRecord(workspaceId, {
    source: "jira",
    issueId: String(issue.id || issue.key || ""),
    title: fields.summary || "",
    body: fields.description || "",
    repoFullName: null,
  });

  return {
    triggered: true,
    issueId: record.issueId,
    title: record.title,
    body: record.body,
    repoFullName: null,
    branch: null,
    pickupId: record.pickupId,
  };
}
