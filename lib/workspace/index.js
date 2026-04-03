// Barrel exports for lib/workspace-* modules
export {
  getWorkspaceAgentSettingsPath,
  normalizeWorkspaceAgentSettings,
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
  buildWorkspaceAgentAugmentation,
  augmentMessagesWithWorkspaceAgent,
  userHasWorkspaceAccess,
  getWorkspaceAgentAccess,
  canEditWorkspaceAgentSettings,
} from "../workspace-agent-settings.js";
export { exportWorkspaceBundle, deleteWorkspaceForUser } from "../workspace-lifecycle.js";
export { appendWorkspaceMemoryFact } from "../workspace-memory-tool.js";
export {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  createWorkspaceFromTemplate,
} from "../workspace-templates.js";
