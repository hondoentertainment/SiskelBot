// Barrel exports for lib/agent-* modules
export { runAgentLoop } from "../agent-loop.js";
export {
  TOOLS,
  parseAgentToolsAllowlistSet,
  applyAgentToolsAllowlist,
  getAgentToolsAllowlistNames,
  intersectClientToolsWithAllowlist,
  getToolsSchema,
  getRegisteredToolNames,
  filterToolsByWorkspaceAllowlist,
  getToolsForNames,
  runTool,
} from "../agent-tools.js";
export { detectStagnation, stagnationDetectionEnabled } from "../agent-stagnation.js";
export {
  saveTrajectory,
  loadTrajectory,
  createTrajectoryCollector,
  trajectoryApiEnabled,
  listTrajectories,
} from "../agent-trajectory.js";
export { resolveAgentMaxIterations } from "../agent-iterations.js";
export {
  getDefaultAgentSystemFromEnv,
  augmentMessagesWithDefaultSystem,
  defaultAgentSystemConfigured,
} from "../agent-defaults.js";
export { truncateToolResultContent, getAgentToolResultMaxChars, trimToTokenBudget } from "../agent-context-trim.js";
export { invokeBeforeToolCall, invokeAfterToolCall } from "../agent-hooks.js";
export { agentFetchAllowedUrl } from "../agent-fetch-url.js";
