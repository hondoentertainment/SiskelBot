/**
 * Workspace admins edit tool and network policy in the app.
 * Every save is an audited revise decision. Members can read the policy.
 */
import {
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
  normalizeWorkspaceAgentSettings,
} from "./workspace-agent-settings.js";
import { recordDecision, queryDecisions } from "./policy-audit.js";

export function canEditWorkspacePolicy(role) {
  return role === "admin";
}

function listField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\n,]/);
  return [];
}

export function policyDraftFromBody(body = {}) {
  const caps = body.toolCategoryCaps && typeof body.toolCategoryCaps === "object" ? body.toolCategoryCaps : {};
  return {
    deniedTools: listField(body.deniedTools),
    browserAllowedHosts: listField(body.browserAllowedHosts ?? body.browserHosts),
    toolCategoryCaps: {
      read: caps.read,
      write: caps.write,
      network: caps.network,
    },
    maxExternalFetches: body.maxExternalFetches,
    maxTotalToolMs: body.maxTotalToolMs,
    sqlQueryEnabled: body.sqlQueryEnabled === true,
    browserFileTransferEnabled: body.browserFileTransferEnabled === true,
    approvalTools: listField(body.approvalTools),
    requireMemoryCitations: body.requireMemoryCitations === true,
    transientToolRetryLimit: body.transientToolRetryLimit,
  };
}

function snapshot(policy = {}) {
  return {
    deniedTools: policy.deniedTools || [],
    browserAllowedHosts: policy.browserAllowedHosts || [],
    toolCategoryCaps: policy.toolCategoryCaps || {},
    maxExternalFetches: policy.maxExternalFetches || 0,
    maxTotalToolMs: policy.maxTotalToolMs || 0,
    sqlQueryEnabled: policy.sqlQueryEnabled === true,
    browserFileTransferEnabled: policy.browserFileTransferEnabled === true,
    approvalTools: policy.approvalTools || [],
    requireMemoryCitations: policy.requireMemoryCitations === true,
  };
}

export async function saveWorkspacePolicy({ storageUserId, workspaceId, userId, draft }) {
  const current = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const normalized = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: current.defaultSystemPrompt,
    memorySnippets: current.memorySnippets,
    allowedTools: current.allowedTools,
    agentPolicy: policyDraftFromBody(draft),
  });
  const saved = await saveWorkspaceAgentSettings(storageUserId, workspaceId, normalized);
  await recordDecision({
    workspaceId,
    policyId: "agent-policy",
    source: "policy-builder",
    action: "revise",
    userId: userId || storageUserId,
    reason: "Workspace admin updated tool and network policy",
    metadata: { before: snapshot(current.agentPolicy), after: snapshot(saved.agentPolicy) },
  });
  return saved.agentPolicy;
}

export async function listPolicyEdits(workspaceId) {
  const result = await queryDecisions({ workspaceId, source: "policy-builder", limit: 20 });
  return (result.decisions || []).map((entry) => ({
    decisionId: entry.decisionId,
    userId: entry.userId,
    timestamp: entry.timestamp,
    reason: entry.reason,
    after: entry.metadata?.after || null,
  }));
}
