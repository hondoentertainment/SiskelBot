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
 * Route modules:
 *   auth.js          - /config, /auth/*
 *   chat.js          - /v1/chat/completions, /v1/agent/swarm, /v1/swarm
 *   tasks.js         - /v1/tasks/plan
 *   health.js        - /health/*, /metrics
 *   integrations.js  - /api/github/*, /api/vercel/*, /api/integrations/*
 *   usage.js         - /api/usage*, /api/analytics*
 *   knowledge.js     - /api/context*, /api/embeddings*, /api/knowledge*
 *   workspaces.js    - /api/workspaces*, templates, agent settings
 *   recipes.js       - /api/recipes*, /api/schedules*
 *   teams.js         - /api/teams/*
 *   admin.js         - /api/admin/*, /api/routing/*, /api/regions/*
 *   docs.js          - /api/docs*, /docs
 *   backup.js        - /api/backup*
 *   conversations.js - /api/conversations*
 *   plugins.js       - /api/plugins*, /api/marketplace*, /api/workspaces/:id/plugins
 *   webhooks.js      - /api/webhooks*, /api/ws-token, /api/ws-replay, /api/notifications*, /api/workspaces/:id/presence
 *   eval.js          - /api/eval*, /api/traces*, /api/agent/trajectory*
 *   execute.js       - /api/execute-step, /api/automations/validate
 *   multimodal.js    - /api/vision/describe, /api/documents/extract, /api/ocr
 *   federation.js    - /api/federation/*
 *   mcp.js           - /mcp, /mcp/sse
 *   slack-discord.js - /api/integrations/slack/*, /api/integrations/discord/*, /api/integrations/bots/*
 *   voice.js         - /api/voice/transcribe, /api/voice/synthesize, /api/voice/capabilities
 *   slo.js           - /api/slo, /api/slo/:name, /api/slo/:name/burndown
 *   synthetic.js     - /api/synthetic/checks, history, stats, manual runs
 *   runbooks.js      - /api/runbooks, generate, report (on-call automation)
 */

import mountAuthRoutes from "./auth.js";
import mountChatRoutes from "./chat.js";
import mountTasksRoutes from "./tasks.js";
import mountHealthRoutes from "./health.js";
import mountIntegrationsRoutes from "./integrations.js";
import mountUsageRoutes from "./usage.js";
import mountKnowledgeRoutes from "./knowledge.js";
import mountWorkspacesRoutes from "./workspaces.js";
import mountRecipesRoutes from "./recipes.js";
import mountTeamsRoutes from "./teams.js";
import mountAdminRoutes from "./admin.js";
import mountDocsRoutes from "./docs.js";
import { mountBackupRoutes } from "./backup.js";
import { mountConversationRoutes } from "./conversations.js";
import { mountPluginRoutes } from "./plugins.js";
import { mountWebhookRoutes } from "./webhooks.js";
import { mountEvalRoutes } from "./eval.js";
import { mountExecuteRoutes } from "./execute.js";
import mountMultimodalRoutes from "./multimodal.js";
import { mountFederationRoutes } from "./federation.js";
import { mountMcpRoutes } from "./mcp.js";
import { mountSlackDiscordRoutes } from "./slack-discord.js";
import { mountMemoryRoutes } from "./memory.js";
import { mountReasoningMemoryRoutes } from "./reasoning-memory.js";
import { mountRbacRoutes } from "./rbac.js";
import { mountAnalyticsRoutes } from "./analytics.js";
import { mountModelQualityRoutes } from "./model-quality.js";
import { mountCollaborationRoutes } from "./collaboration.js";
import { mountPresenceRoutes } from "./presence.js";
import { mountScheduledAgentRoutes } from "./scheduled-agents.js";
import { mountBillingRoutes } from "./billing.js";
import { mountBrandingRoutes } from "./branding.js";
import { mountSecurityRoutes } from "./security.js";
import { mountSecurityScorecardRoutes } from "./security-scorecard.js";
import { mountFeedbackRoutes } from "./feedback.js";
import { mountVoiceRoutes } from "./voice.js";
import { mountVoiceRealtimeRoutes } from "./voice-realtime.js";
import { mountVoiceCloningRoutes } from "./voice-cloning.js";
import { mountVoiceCommandRoutes } from "./voice-commands.js";
import { mountDiarizationRoutes } from "./diarization.js";
import mountTraceExplorerRoutes from "./traces.js";
import { mountSLORoutes } from "./slo.js";
import { mountSyntheticRoutes } from "./synthetic.js";
import { mountRunbookRoutes } from "./runbooks.js";
import { mountPromptEvolutionRoutes } from "./prompt-evolution.js";
import { mountToolDiscoveryRoutes } from "./tool-discovery.js";
import { mountExplainabilityRoutes } from "./explainability.js";
import { mountComplianceRoutes } from "./compliance.js";
import { mountRecipeMarketplaceRoutes } from "./recipe-marketplace.js";
import { mountAgentMarketplaceRoutes } from "./agent-marketplace.js";
import { mountPluginCertificationRoutes } from "./plugin-certification.js";
import { mountDeveloperPortalRoutes } from "./developer-portal.js";
import { mountReferralRoutes } from "./referrals.js";
import { mountTemplateGalleryRoutes } from "./template-gallery.js";
import { mountEdgeCacheRoutes } from "./edge-cache.js";
import mountQueryAnalyzerRoutes from "./query-analyzer.js";
import { mountServiceAuthRoutes } from "./service-auth.js";
import { mountSecretRotationRoutes } from "./secret-rotation.js";
import { mountExperimentRoutes } from "./experiments.js";
import { mountMobileRoutes } from "./mobile.js";
import mountModelRegistryRoutes from "./model-registry.js";
import { mountLoraAdapterRoutes } from "./lora-adapters.js";
import { mountFineTuningRoutes } from "./fine-tuning.js";
import mountPushNotificationRoutes from "./push-notifications.js";
import { mountWebAuthnRoutes } from "./webauthn.js";
import { mountLdapRoutes } from "./ldap.js";
import { mountHSMRoutes } from "./hsm.js";
import { mountCohortAnalysisRoutes } from "./cohort-analysis.js";
import { mountFunnelRoutes } from "./funnels.js";
import { mountDashboardRoutes } from "./dashboards.js";
import { mountAnomalyRoutes } from "./anomalies.js";
import { mountGeoRoutingRoutes } from "./geo-routing.js";
import { mountMultiRegionRoutes } from "./multi-region.js";
import mountOfflineModelsRoutes from "./offline-models.js";
import { mountCrdtRoutes } from "./crdt.js";
import mountDataWarehouseRoutes from "./data-warehouse.js";
import { mountAnnotationRoutes } from "./annotations.js";
import { mountDataResidencyRoutes } from "./data-residency.js";
import { mountScreenShareRoutes } from "./screen-share.js";
import { mountJitProvisioningRoutes } from "./jit-provisioning.js";
import { mountEntitlementReviewRoutes } from "./entitlement-reviews.js";
import { mountHierarchyRoutes } from "./hierarchy.js";
import { mountGroupSyncRoutes } from "./group-sync.js";
import { mountAgentNegotiationRoutes } from "./agent-negotiation.js";
import { mountLongMissionRoutes } from "./long-missions.js";
import { mountScimRoutes } from "./scim.js";
import { mountAgentConsensusRoutes } from "./agent-consensus.js";
import { mountMeetingBotRoutes } from "./meeting-bot.js";
import { mountV2Routes } from "./v2/index.js";

const mountFunctions = [
  mountAuthRoutes,
  mountChatRoutes,
  mountTasksRoutes,
  mountHealthRoutes,
  mountIntegrationsRoutes,
  mountUsageRoutes,
  mountKnowledgeRoutes,
  mountWorkspacesRoutes,
  mountRecipesRoutes,
  mountTeamsRoutes,
  mountAdminRoutes,
  mountDocsRoutes,
  mountBackupRoutes,
  mountConversationRoutes,
  mountPluginRoutes,
  mountWebhookRoutes,
  mountEvalRoutes,
  mountExecuteRoutes,
  mountMultimodalRoutes,
  mountFederationRoutes,
  mountMcpRoutes,
  mountSlackDiscordRoutes,
  mountMemoryRoutes,
  mountReasoningMemoryRoutes,
  mountRbacRoutes,
  mountAnalyticsRoutes,
  mountModelQualityRoutes,
  mountCollaborationRoutes,
  mountPresenceRoutes,
  mountScheduledAgentRoutes,
  mountBillingRoutes,
  mountBrandingRoutes,
  mountSecurityRoutes,
  mountSecurityScorecardRoutes,
  mountFeedbackRoutes,
  mountVoiceRoutes,
  mountVoiceRealtimeRoutes,
  mountVoiceCloningRoutes,
  mountVoiceCommandRoutes,
  mountDiarizationRoutes,
  mountTraceExplorerRoutes,
  mountSLORoutes,
  mountSyntheticRoutes,
  mountRunbookRoutes,
  mountPromptEvolutionRoutes,
  mountToolDiscoveryRoutes,
  mountExplainabilityRoutes,
  mountComplianceRoutes,
  mountRecipeMarketplaceRoutes,
  mountAgentMarketplaceRoutes,
  mountPluginCertificationRoutes,
  mountDeveloperPortalRoutes,
  mountReferralRoutes,
  mountTemplateGalleryRoutes,
  mountEdgeCacheRoutes,
  mountQueryAnalyzerRoutes,
  mountServiceAuthRoutes,
  mountSecretRotationRoutes,
  mountExperimentRoutes,
  mountMobileRoutes,
  mountModelRegistryRoutes,
  mountLoraAdapterRoutes,
  mountFineTuningRoutes,
  mountPushNotificationRoutes,
  mountWebAuthnRoutes,
  mountLdapRoutes,
  mountHSMRoutes,
  mountCohortAnalysisRoutes,
  mountFunnelRoutes,
  mountDashboardRoutes,
  mountAnomalyRoutes,
  mountGeoRoutingRoutes,
  mountMultiRegionRoutes,
  mountOfflineModelsRoutes,
  mountCrdtRoutes,
  mountDataWarehouseRoutes,
  mountAnnotationRoutes,
  mountDataResidencyRoutes,
  mountScreenShareRoutes,
  mountJitProvisioningRoutes,
  mountEntitlementReviewRoutes,
  mountHierarchyRoutes,
  mountGroupSyncRoutes,
  mountAgentNegotiationRoutes,
  mountLongMissionRoutes,
  mountScimRoutes,
  mountAgentConsensusRoutes,
  mountMeetingBotRoutes,
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
