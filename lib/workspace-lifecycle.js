/**
 * Phase 74: Workspace export (JSON bundle) and owner delete with data removal.
 */
import * as storage from "./storage.js";
import { getWorkspaceOwner, deleteWorkspaceTeamData, resolveStorageUserId } from "./teams.js";
import { loadWorkspaceAgentSettings, saveWorkspaceAgentSettings } from "./workspace-agent-settings.js";

/**
 * @param {string} userId
 * @param {string} workspaceId
 */
export async function exportWorkspaceBundle(userId, workspaceId) {
  const su = await resolveStorageUserId(userId, workspaceId);
  const [context, recipes, conversations] = await Promise.all([
    storage.list("context", workspaceId, su),
    storage.list("recipes", workspaceId, su),
    storage.list("conversations", workspaceId, su),
  ]);
  const agentSettings = await loadWorkspaceAgentSettings(su, workspaceId);
  return {
    _version: 1,
    exportedAt: new Date().toISOString(),
    workspaceId: String(workspaceId),
    userId: String(userId),
    storageUserId: su,
    context,
    recipes,
    conversations,
    agentSettings,
  };
}

/**
 * Owner-only delete: clears storage types, agent settings, workspace metadata, team records.
 * @param {string} userId
 * @param {string} workspaceId
 */
export async function deleteWorkspaceForUser(userId, workspaceId) {
  if (String(workspaceId) === "default") {
    return { ok: false, error: "Cannot delete the default workspace" };
  }
  const owner = await getWorkspaceOwner(workspaceId);
  const ownerId = owner || userId;
  if (owner && String(owner) !== String(userId)) {
    return { ok: false, error: "Only the workspace owner can delete this workspace" };
  }
  const ws = await storage.getWorkspaceById(ownerId, workspaceId);
  if (!ws) {
    return { ok: false, error: "Workspace not found" };
  }
  const su = await resolveStorageUserId(userId, workspaceId);
  await storage.replace("context", [], workspaceId, su);
  await storage.replace("recipes", [], workspaceId, su);
  await storage.replace("conversations", [], workspaceId, su);
  await saveWorkspaceAgentSettings(su, workspaceId, { defaultSystemPrompt: "", memorySnippets: [] });

  const rm = await storage.removeWorkspaceFromOwnerList(ownerId, workspaceId);
  if (!rm.ok) {
    return { ok: false, error: rm.error || "Failed to update workspace list" };
  }
  await deleteWorkspaceTeamData(workspaceId);
  return { ok: true };
}
