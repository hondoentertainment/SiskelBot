/**
 * Phase 82: Tool-writable workspace memory (extends agent-settings memorySnippets).
 */
import {
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
  normalizeWorkspaceAgentSettings,
} from "./workspace-agent-settings.js";
import { appendAuditLog } from "./action-executor.js";

const PREFIX = "[agent-memory]";

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 * @param {string} fact
 */
export async function appendWorkspaceMemoryFact(storageUserId, workspaceId, fact) {
  const line = String(fact || "").trim();
  if (!line) return { ok: false, error: "fact is empty" };
  const cur = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const entry = `${PREFIX} ${line}`;
  const combined = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: cur.defaultSystemPrompt,
    memorySnippets: [...(cur.memorySnippets || []), entry],
  });
  await saveWorkspaceAgentSettings(storageUserId, workspaceId, {
    defaultSystemPrompt: combined.defaultSystemPrompt,
    memorySnippets: combined.memorySnippets,
  });
  appendAuditLog({
    action: "agent_remember_workspace",
    payload: { workspaceId, snippetLen: line.length },
    ok: true,
  });
  return { ok: true, count: combined.memorySnippets.length };
}
