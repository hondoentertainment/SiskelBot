/**
 * Route module index — mounts all extracted route modules.
 *
 * Each route module exports a function: mountXRoutes(app, deps)
 * where `deps` is an object containing shared middleware, helpers, and config
 * that the routes need (apiError, auth middleware, rate limiters, etc.).
 *
 * Usage (in server.js):
 *   import { mountAllRoutes } from "./routes/index.js";
 *   mountAllRoutes(app, deps);
 *
 * Surface area is deliberately scoped to CORE + SUPPORTING per docs/ROUTE_AUDIT.md.
 * Most DEFER/DELETE-tier modules stay off this router (see routes/.wire-check-ignore).
 * Edge cache, mobile, and voice stacks remain mounted — CI and mobile/voice clients depend on them.
 */

// CORE
import mountAuthRoutes from "./auth.js";
import mountChatRoutes from "./chat.js";
import mountHealthRoutes from "./health.js";
import mountKnowledgeRoutes from "./knowledge.js";
import { mountDatasetRoutes } from "./datasets.js";
import { mountSearchRoutes } from "./search.js";
import { mountWorkflowRoutes } from "./workflows.js";
import mountWorkspacesRoutes from "./workspaces.js";
import { mountConversationRoutes } from "./conversations.js";
import { mountBillingRoutes } from "./billing.js";
import { mountPricingRoutes as mountPricingEngineRoutes } from "./pricing-engine.js";
import { mountMemoryRoutes } from "./memory.js";
import { mountAgentRunStreamRoutes } from "./agent-run-stream.js";
import { mountAgentHitlRoutes } from "./agent-hitl.js";
import { mountAgentArtifactRoutes } from "./agent-artifacts.js";
import { mountContextRoutes } from "./context.js";
import { mountMcpRoutes } from "./mcp.js";

// SUPPORTING
import mountTasksRoutes from "./tasks.js";
import mountIntegrationsRoutes from "./integrations.js";
import { mountSlackDiscordRoutes } from "./slack-discord.js";
import mountRecipesRoutes from "./recipes.js";
import { mountExecuteRoutes } from "./execute.js";
import { mountWebhookRoutes } from "./webhooks.js";
import mountTeamsRoutes from "./teams.js";
import { mountRbacRoutes } from "./rbac.js";
import mountAdminRoutes from "./admin.js";
import mountAgentStatsAdminRoutes from "./admin-agent-stats.js";
import mountAdminQuotaRoutes from "./admin-quotas.js";
import mountAdminFeatureFlagRoutes from "./admin-feature-flags.js";
import mountAdminPromptPatchesRoutes from "./admin-prompt-patches.js";
import mountAdminEvalHistoryRoutes from "./admin-eval-history.js";
import mountAdminTracesRoutes from "./admin-traces.js";
import mountAdminTraceStreamRoutes from "./admin-trace-stream.js";
import mountTraceShareRoutes from "./trace-share.js";
import { mountEvalRoutes } from "./eval.js";
import { mountCollaborationRoutes } from "./collaboration.js";
import { mountPresenceRoutes } from "./presence.js";
import mountUsageRoutes from "./usage.js";
import { mountAnalyticsRoutes } from "./analytics.js";
import { mountBackupRoutes } from "./backup.js";
import mountMultimodalRoutes from "./multimodal.js";
import { mountFeedbackRoutes } from "./feedback.js";
import { mountAgentFeedbackRoutes } from "./agent-feedback.js";
import { mountSecurityRoutes } from "./security.js";
import { mountSecurityScorecardRoutes } from "./security-scorecard.js";
import { mountModelQualityRoutes } from "./model-quality.js";
import { mountReplayRoutes } from "./replay.js";
import { mountTrajectoryBranchRoutes } from "./trajectory-branch.js";
import { mountAgentResumeRoutes } from "./agent-resume.js";
import { mountSignalsRoutes } from "./signals.js";
import { mountObservabilitySnapshotRoutes } from "./observability-snapshot.js";
import mountDocsRoutes from "./docs.js";
import { mountSecretsRoutes } from "./secrets.js";
import { mountPlaybookRoutes } from "./playbooks.js";
import { mountWikiRoutes } from "./wiki.js";
import { mountCodebaseSearchRoutes } from "./codebase-search.js";
import { mountGithubWorkflowRoutes } from "./github-workflow.js";
import mountPrReviewRoutes from "./pr-review-agent.js";
import mountRepoRagRoutes from "./repo-rag.js";
import { mountSessionInsightsRoutes } from "./session-insights.js";
import { mountReasoningMemoryRoutes } from "./reasoning-memory.js";
import { mountPluginRoutes } from "./plugins.js";
import mountTraceExplorerRoutes from "./traces.js";
import { mountAnnotationRoutes } from "./annotations.js";
import { mountHierarchyRoutes } from "./hierarchy.js";
import { mountExplainabilityRoutes } from "./explainability.js";
import { mountScheduledAgentRoutes } from "./scheduled-agents.js";
import mountPushNotificationRoutes from "./push-notifications.js";
import { mountCostEstimateRoutes } from "./cost-estimate.js";
import { mountEdgeCacheRoutes } from "./edge-cache.js";
import { mountMobileRoutes } from "./mobile.js";
import { mountVoiceRoutes } from "./voice.js";
import mountVoiceCloningRoutes from "./voice-cloning.js";

import { mountV2Routes } from "./v2/index.js";

const mountFunctions = [
  // CORE
  mountAuthRoutes,
  mountChatRoutes,
  mountHealthRoutes,
  mountKnowledgeRoutes,
  mountDatasetRoutes,
  mountSearchRoutes,
  mountWorkflowRoutes,
  mountWorkspacesRoutes,
  mountConversationRoutes,
  mountBillingRoutes,
  mountPricingEngineRoutes,
  mountMemoryRoutes,
  mountAgentRunStreamRoutes,
  mountAgentHitlRoutes,
  mountAgentArtifactRoutes,
  mountContextRoutes,
  mountMcpRoutes,

  // SUPPORTING — automation, integrations, multi-tenant
  mountTasksRoutes,
  mountIntegrationsRoutes,
  mountSlackDiscordRoutes,
  mountRecipesRoutes,
  mountExecuteRoutes,
  mountWebhookRoutes,
  mountTeamsRoutes,
  mountRbacRoutes,

  // SUPPORTING — admin & ops
  mountAdminRoutes,
  mountAgentStatsAdminRoutes,
  mountAdminQuotaRoutes,
  mountAdminFeatureFlagRoutes,
  mountAdminPromptPatchesRoutes,
  mountAdminEvalHistoryRoutes,
  mountAdminTracesRoutes,
  mountAdminTraceStreamRoutes,
  mountTraceShareRoutes,
  mountEvalRoutes,
  mountTraceExplorerRoutes,
  mountAnnotationRoutes,
  mountExplainabilityRoutes,

  // SUPPORTING — collaboration & multi-user
  mountCollaborationRoutes,
  mountPresenceRoutes,
  mountHierarchyRoutes,

  // SUPPORTING — observability for users
  mountUsageRoutes,
  mountAnalyticsRoutes,
  mountBackupRoutes,
  mountMultimodalRoutes,
  mountFeedbackRoutes,
  mountAgentFeedbackRoutes,
  mountSecurityRoutes,
  mountSecurityScorecardRoutes,
  mountModelQualityRoutes,
  mountReplayRoutes,
  mountTrajectoryBranchRoutes,
  mountAgentResumeRoutes,
  mountSignalsRoutes,
  mountObservabilitySnapshotRoutes,
  mountDocsRoutes,
  mountCostEstimateRoutes,

  // SUPPORTING — code vertical & developer tools
  mountSecretsRoutes,
  mountPlaybookRoutes,
  mountWikiRoutes,
  mountCodebaseSearchRoutes,
  mountGithubWorkflowRoutes,
  mountPrReviewRoutes,
  mountRepoRagRoutes,
  mountSessionInsightsRoutes,
  mountReasoningMemoryRoutes,
  mountPluginRoutes,
  mountScheduledAgentRoutes,
  mountPushNotificationRoutes,

  // SUPPORTING — edge CDN, mobile API, voice (mounted for regression tests & clients)
  mountEdgeCacheRoutes,
  mountMobileRoutes,
  mountVoiceRoutes,
  mountVoiceCloningRoutes,
];

/**
 * Mount all extracted route modules on the Express app.
 * @param {import("express").Express} app
 * @param {object} deps - Shared middleware, helpers, config, and lib imports
 */
export function mountAllRoutes(app, deps) {
  for (const mount of mountFunctions) {
    mount(app, deps);
  }
  // Mount v2 API routes
  mountV2Routes(app, deps);
}
