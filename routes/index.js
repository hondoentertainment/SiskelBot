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
import { mountToolRagRoutes } from "./tool-rag.js";
import { mountToolDisclosureRoutes } from "./tool-disclosure.js";
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
import { mountBpeTokenizerRoutes } from "./bpe-tokenizer.js";
import { mountPreferenceDatasetRoutes } from "./preference-datasets.js";
import { mountGBrainRoutes } from "./gbrain.js";
import { mountFederatedTrainingRoutes } from "./federated-training.js";
import { mountFlConsortiumRoutes } from "./fl-consortium.js";
import { mountPrivacyAccountingRoutes } from "./privacy-accounting.js";
import { mountSecureAggregationRoutes } from "./secure-aggregation.js";
import { mountDifferentialPrivacyRoutes } from "./differential-privacy.js";
import { mountPqJwtRoutes } from "./pq-jwt.js";
import { mountPqMigrationRoutes } from "./pq-migration.js";
import { mountPqTlsRoutes } from "./pq-tls.js";
import { mountPqDilithiumRoutes } from "./pq-dilithium.js";
import { mountPqKyberRoutes } from "./pq-kyber.js";
import { mountXrRoutes } from "./xr.js";
import { mountNftGatingRoutes } from "./nft-gating.js";
import { mountCryptoPaymentRoutes } from "./crypto-payments.js";
import { mountWalletAuthRoutes } from "./wallet-auth.js";
import { mountDecentralizedStorageRoutes } from "./decentralized-storage.js";
import { mountAuditAnchorRoutes } from "./audit-anchor.js";
import { mountVrRoomsRoutes } from "./vr-rooms.js";
import { mountAvatarAgentsRoutes } from "./avatar-agents.js";
import { mountSpatialGraphRoutes } from "./spatial-graph.js";
import { mountGestureControlRoutes } from "./gesture-control.js";
import { mountJailbreakDetectorRoutes } from "./jailbreak-detector.js";
import { mountConstitutionalAiRoutes } from "./constitutional-ai.js";
import { mountSelfConsistencyRoutes } from "./self-consistency.js";
import { mountVerificationLoopRoutes } from "./verification-loop.js";
import { mountTreeOfThoughtRoutes } from "./tree-of-thought.js";
import { mountGraphOfThoughtRoutes } from "./graph-of-thought.js";
import { mountToolGraphRoutes } from "./tool-graph.js";
import { mountVideoUnderstandingRoutes } from "./video-understanding.js";
// Phases 51-55 gap fills
import { mountRedTeamRoutes } from "./red-team.js";
import { mountNeuroSymbolicRoutes } from "./neuro-symbolic.js";
import { mountToolDepGraphRoutes } from "./tool-dep-graph.js";
import { mountToolDisclosureProgressiveRoutes } from "./tool-disclosure-progressive.js";
import { mountSchemaRepairRoutes } from "./schema-repair.js";
import { mountDocLayoutRoutes } from "./doc-layout.js";
import { mountShellAgentRoutes } from "./shell-agent.js";
import { mountFilesystemAgentRoutes } from "./filesystem-agent.js";
import { mountMobileAutomationRoutes } from "./mobile-automation.js";
// Phase 56 — Training Environments
import { mountAgentSandboxRoutes } from "./agent-sandbox.js";
import { mountBenchmarkRunnerRoutes } from "./benchmark-runner.js";
import { mountSyntheticTasksRoutes } from "./synthetic-tasks.js";
import { mountCurriculumSchedulerRoutes } from "./curriculum-scheduler.js";
import { mountRewardModelRoutes } from "./reward-model.js";
// Phase 57 — Data Engineering
import { mountDataPipelineRoutes } from "./data-pipeline.js";
import { mountDataQualityRoutes } from "./data-quality.js";
import { mountSchemaEvolutionRoutes } from "./schema-evolution.js";
import { mountDataLineageRoutes } from "./data-lineage.js";
import { mountFeatureStoreRoutes } from "./feature-store.js";
// Phase 58 — Cost & Efficiency
import { mountCostRouterRoutes } from "./cost-router.js";
import { mountSpeculativeDecodingRoutes } from "./speculative-decoding.js";
import { mountPromptCompressionRoutes } from "./prompt-compression.js";
import { mountDistillationRoutes } from "./distillation.js";
import { mountQuantizationRoutes } from "./quantization.js";
// Phase 59 — Reliability Engineering
import { mountChaosRoutes } from "./chaos.js";
import { mountLoadSheddingRoutes } from "./load-shedding.js";
import { mountDegradationRoutes } from "./degradation.js";
import { mountCanaryRoutes } from "./canary.js";
import { mountErrorBudgetRoutes } from "./error-budget.js";
// Phase 60 — Observability Pro
import { mountContinuousProfilingRoutes } from "./continuous-profiling.js";
import { mountMemoryLeakRoutes } from "./memory-leak.js";
import { mountStepLatencyRoutes } from "./step-latency.js";
import { mountLogAnalysisRoutes } from "./log-analysis.js";
import { mountStatusPageRoutes } from "./status-page.js";
// Phase 61 — Developer Platform
import { mountApiPlaygroundRoutes } from "./api-playground.js";
import { mountWebhookInspectorRoutes } from "./webhook-inspector.js";
import { mountIntegrationHarnessRoutes } from "./integration-harness.js";
import { mountLocalDevEnvRoutes } from "./local-dev-env.js";
import { mountSchemaRegistryRoutes } from "./schema-registry.js";
// Phase 62 — Customer Support
import { mountIntentClassificationRoutes } from "./intent-classification.js";
import { mountTicketRoutingRoutes } from "./ticket-routing.js";
import { mountResponseDraftingRoutes } from "./response-drafting.js";
import { mountEscalationRulesRoutes } from "./escalation-rules.js";
import { mountCsatRoutes } from "./csat.js";
// Phase 63 — Code Generation
import { mountRepoRagRoutes } from "./repo-rag.js";
import { mountPrReviewRoutes } from "./pr-review.js";
import { mountTestGenerationRoutes } from "./test-generation.js";
import { mountRefactoringRoutes } from "./refactoring.js";
import { mountMigrationAssistantRoutes } from "./migration-assistant.js";
// Phase 64 — Research
import { mountLiteratureSearchRoutes } from "./literature-search.js";
import { mountPaperSummaryRoutes } from "./paper-summary.js";
import { mountCitationGraphRoutes } from "./citation-graph.js";
import { mountExperimentTrackingRoutes } from "./experiment-tracking.js";
import { mountReproducibilityRoutes } from "./reproducibility.js";
// Phase 65 — Enterprise Governance
import { mountModelApprovalsRoutes } from "./model-approvals.js";
import { mountUsagePoliciesRoutes } from "./usage-policies.js";
import { mountBudgetAllocationRoutes } from "./budget-allocation.js";
import { mountAuditReportsRoutes } from "./audit-reports.js";
import { mountAiRiskScoringRoutes } from "./ai-risk-scoring.js";
// Phase 66 — Multi-Tenancy Hardening
import { mountResourceIsolationRoutes } from "./resource-isolation.js";
import { mountNoisyNeighborRoutes } from "./noisy-neighbor.js";
import { mountFairRateLimitsRoutes } from "./fair-rate-limits.js";
import { mountTenantEncryptionRoutes } from "./tenant-encryption.js";
import { mountTenantMigrationRoutes } from "./tenant-migration.js";
// Phase 67 — Content Moderation
import { mountCsamDetectionRoutes } from "./csam-detection.js";
import { mountCopyrightDetectionRoutes } from "./copyright-detection.js";
import { mountMisinfoChecksRoutes } from "./misinfo-checks.js";
import { mountBrandSafetyRoutes } from "./brand-safety.js";
import { mountHitlModerationRoutes } from "./hitl-moderation.js";
// Phase 68 — Knowledge Augmentation
import { mountWebIngestionRoutes } from "./web-ingestion.js";
import { mountWikiRetrievalRoutes } from "./wiki-retrieval.js";
import { mountFactVerificationRoutes } from "./fact-verification.js";
import { mountSourceCredibilityRoutes } from "./source-credibility.js";
import { mountFreshnessSlaRoutes } from "./freshness-sla.js";
// Phase 69 — Personalization
import { mountPreferenceModelingRoutes } from "./preference-modeling.js";
import { mountAdaptiveUiRoutes } from "./adaptive-ui.js";
import { mountRecommendationEngineRoutes } from "./recommendation-engine.js";
import { mountPersonalizedPromptsRoutes } from "./personalized-prompts.js";
import { mountOptinFinetuneRoutes } from "./optin-finetune.js";
// Phase 70 — Accessibility
import { mountScreenReaderRoutes } from "./screen-reader.js";
import { mountHighContrastThemesRoutes } from "./high-contrast-themes.js";
import { mountKeyboardNavRoutes } from "./keyboard-nav.js";
import { mountVoiceOnlyRoutes } from "./voice-only.js";
import { mountPlainLanguageRoutes } from "./plain-language.js";
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
  mountToolRagRoutes,
  mountToolDisclosureRoutes,
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
  mountBpeTokenizerRoutes,
  mountPreferenceDatasetRoutes,
  mountGBrainRoutes,
  mountFederatedTrainingRoutes,
  mountFlConsortiumRoutes,
  mountPrivacyAccountingRoutes,
  mountSecureAggregationRoutes,
  mountDifferentialPrivacyRoutes,
  mountPqJwtRoutes,
  mountPqMigrationRoutes,
  mountPqTlsRoutes,
  mountPqDilithiumRoutes,
  mountPqKyberRoutes,
  mountXrRoutes,
  mountNftGatingRoutes,
  mountCryptoPaymentRoutes,
  mountWalletAuthRoutes,
  mountDecentralizedStorageRoutes,
  mountAuditAnchorRoutes,
  mountVrRoomsRoutes,
  mountAvatarAgentsRoutes,
  mountSpatialGraphRoutes,
  mountGestureControlRoutes,
  mountJailbreakDetectorRoutes,
  mountConstitutionalAiRoutes,
  mountSelfConsistencyRoutes,
  mountVerificationLoopRoutes,
  mountTreeOfThoughtRoutes,
  mountGraphOfThoughtRoutes,
  mountToolGraphRoutes,
  mountVideoUnderstandingRoutes,
  // Phases 51-55 gap fills
  mountRedTeamRoutes,
  mountNeuroSymbolicRoutes,
  mountToolDepGraphRoutes,
  mountToolDisclosureProgressiveRoutes,
  mountSchemaRepairRoutes,
  mountDocLayoutRoutes,
  mountShellAgentRoutes,
  mountFilesystemAgentRoutes,
  mountMobileAutomationRoutes,
  // Phase 56 — Training Environments
  mountAgentSandboxRoutes,
  mountBenchmarkRunnerRoutes,
  mountSyntheticTasksRoutes,
  mountCurriculumSchedulerRoutes,
  mountRewardModelRoutes,
  // Phase 57 — Data Engineering
  mountDataPipelineRoutes,
  mountDataQualityRoutes,
  mountSchemaEvolutionRoutes,
  mountDataLineageRoutes,
  mountFeatureStoreRoutes,
  // Phase 58 — Cost & Efficiency
  mountCostRouterRoutes,
  mountSpeculativeDecodingRoutes,
  mountPromptCompressionRoutes,
  mountDistillationRoutes,
  mountQuantizationRoutes,
  // Phase 59 — Reliability Engineering
  mountChaosRoutes,
  mountLoadSheddingRoutes,
  mountDegradationRoutes,
  mountCanaryRoutes,
  mountErrorBudgetRoutes,
  // Phase 60 — Observability Pro
  mountContinuousProfilingRoutes,
  mountMemoryLeakRoutes,
  mountStepLatencyRoutes,
  mountLogAnalysisRoutes,
  mountStatusPageRoutes,
  // Phase 61 — Developer Platform
  mountApiPlaygroundRoutes,
  mountWebhookInspectorRoutes,
  mountIntegrationHarnessRoutes,
  mountLocalDevEnvRoutes,
  mountSchemaRegistryRoutes,
  // Phase 62 — Customer Support
  mountIntentClassificationRoutes,
  mountTicketRoutingRoutes,
  mountResponseDraftingRoutes,
  mountEscalationRulesRoutes,
  mountCsatRoutes,
  // Phase 63 — Code Generation
  mountRepoRagRoutes,
  mountPrReviewRoutes,
  mountTestGenerationRoutes,
  mountRefactoringRoutes,
  mountMigrationAssistantRoutes,
  // Phase 64 — Research
  mountLiteratureSearchRoutes,
  mountPaperSummaryRoutes,
  mountCitationGraphRoutes,
  mountExperimentTrackingRoutes,
  mountReproducibilityRoutes,
  // Phase 65 — Enterprise Governance
  mountModelApprovalsRoutes,
  mountUsagePoliciesRoutes,
  mountBudgetAllocationRoutes,
  mountAuditReportsRoutes,
  mountAiRiskScoringRoutes,
  // Phase 66 — Multi-Tenancy Hardening
  mountResourceIsolationRoutes,
  mountNoisyNeighborRoutes,
  mountFairRateLimitsRoutes,
  mountTenantEncryptionRoutes,
  mountTenantMigrationRoutes,
  // Phase 67 — Content Moderation
  mountCsamDetectionRoutes,
  mountCopyrightDetectionRoutes,
  mountMisinfoChecksRoutes,
  mountBrandSafetyRoutes,
  mountHitlModerationRoutes,
  // Phase 68 — Knowledge Augmentation
  mountWebIngestionRoutes,
  mountWikiRetrievalRoutes,
  mountFactVerificationRoutes,
  mountSourceCredibilityRoutes,
  mountFreshnessSlaRoutes,
  // Phase 69 — Personalization
  mountPreferenceModelingRoutes,
  mountAdaptiveUiRoutes,
  mountRecommendationEngineRoutes,
  mountPersonalizedPromptsRoutes,
  mountOptinFinetuneRoutes,
  // Phase 70 — Accessibility
  mountScreenReaderRoutes,
  mountHighContrastThemesRoutes,
  mountKeyboardNavRoutes,
  mountVoiceOnlyRoutes,
  mountPlainLanguageRoutes,
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
