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
import mountAgentStatsAdminRoutes from "./admin-agent-stats.js";
import mountAdminEvalHistoryRoutes from "./admin-eval-history.js";
import mountAdminTracesRoutes from "./admin-traces.js";
import mountAdminTraceStreamRoutes from "./admin-trace-stream.js";
import mountTraceShareRoutes from "./trace-share.js";
import mountAdminPromptPatchesRoutes from "./admin-prompt-patches.js";
import mountAdminQuotaRoutes from "./admin-quotas.js";
import { mountAgentFeedbackRoutes } from "./agent-feedback.js";
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
import { mountToolValidationRoutes } from "./tool-validation.js";
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
import { mountMobileAutomationRoutes } from "./mobile-automation.js";
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
import { mountToolCompositionRoutes } from "./tool-composition.js";
import { mountOutputClassifiersRoutes } from "./output-classifiers.js";
import { mountImageGenerationRoutes } from "./image-generation.js";
import { mountAudioClassificationRoutes } from "./audio-classification.js";
import { mount3dAssetsRoutes } from "./3d-assets.js";
import { mountScreenControlRoutes } from "./screen-control.js";
import { mountShellAgentRoutes } from "./shell-agent.js";
import { mountBrowserAgentRoutes } from "./browser-agent.js";
import { mountDocumentLayoutRoutes } from "./document-layout.js";
import { mountFsAgentRoutes } from "./fs-agent.js";
import { mountAgentSandboxRoutes } from "./agent-sandbox.js";
import { mountBenchmarkRunnerRoutes } from "./benchmark-runner.js";
import { mountCurriculumRoutes } from "./curriculum.js";
import { mountSpeculativeDecodingRoutes } from "./speculative-decoding.js";
import { mountSyntheticTasksRoutes } from "./synthetic-tasks.js";
import { mountDegradationTiersRoutes } from "./degradation-tiers.js";
import { mountQuantizationRoutes } from "./quantization.js";
import { mountChaosEngineeringRoutes } from "./chaos-engineering.js";
import { mountErrorBudgetRoutes } from "./error-budget.js";
import { mountCanaryRoutes } from "./canary.js";
import { mountApiPlaygroundRoutes } from "./api-playground.js";
import { mountDevSetupRoutes } from "./dev-setup.js";

// Phase 51-70 closeout (40 new subtasks)
// Phase 51.4-5, 52.4, 57, 58 (Agent A — 11 modules)
import mountPolicyAuditRoutes from "./policy-audit.js";
import mountRiskyOpsQuotaRoutes from "./risky-ops-quota.js";
import mountNeuroSymbolicRoutes from "./neuro-symbolic.js";
import mountDagPipelineRoutes from "./dag-pipeline.js";
import mountDataQualityRoutes from "./data-quality.js";
import mountSchemaEvolutionRoutes from "./schema-evolution.js";
import mountLineageRoutes from "./lineage.js";
import mountFeatureStoreRoutes from "./feature-store.js";
import mountCostAwareRouterRoutes from "./cost-aware-router.js";
import mountPromptCompressionRoutes from "./prompt-compression.js";
import mountDistillationRoutes from "./distillation.js";

// Phase 59.2, 60.1-5 (Agent B — 6 modules)
import mountLoadSheddingRoutes from "./load-shedding.js";
import mountProfilingRoutes from "./profiling.js";
import mountHeapDiffRoutes from "./heap-diff.js";
import mountStepLatencyRoutes from "./step-latency.js";
import mountLogAnalysisRoutes from "./log-analysis.js";
import mountStatusPageRoutes from "./status-page.js";

// Phase 61.2-3, 61.5, 62.1-5 (Agent C — 8 modules)
import mountWebhookInspectorRoutes from "./webhook-inspector.js";
import mountIntegrationTestHarnessRoutes from "./integration-test-harness.js";
import mountSchemaRegistryRoutes from "./schema-registry.js";
import mountIntentClassifierRoutes from "./intent-classifier.js";
import mountTicketRouterRoutes from "./ticket-router.js";
import mountResponseDrafterRoutes from "./response-drafter.js";
import mountEscalationRulesRoutes from "./escalation-rules.js";
import mountCsatTrackerRoutes from "./csat-tracker.js";

// Phase 65, 67, 68 (Agent D — 15 modules)
import mountModelApprovalRoutes from "./model-approval.js";
import mountUsagePoliciesRoutes from "./usage-policies.js";
import mountBudgetAllocationRoutes from "./budget-allocation.js";
import mountAuditReportsRoutes from "./audit-reports.js";
import mountAiRiskScoringRoutes from "./ai-risk-scoring.js";
import mountHashDetectionRoutes from "./hash-detection.js";
import mountCopyrightSimilarityRoutes from "./copyright-similarity.js";
import mountFactualityCrossrefRoutes from "./factuality-crossref.js";
import mountBrandSafetyRoutes from "./brand-safety.js";
import mountHitlModerationRoutes from "./hitl-moderation.js";
import mountWebIngestionRoutes from "./web-ingestion.js";
import mountLargeRetrievalRoutes from "./large-retrieval.js";
import mountFactVerificationRoutes from "./fact-verification.js";
import mountSourceCredibilityRoutes from "./source-credibility.js";
import mountFreshnessSlaRoutes from "./freshness-sla.js";

// Wave 1 web interface — realtime agent run stream + replay
import { mountAgentRunStreamRoutes } from "./agent-run-stream.js";
import { mountReplayRoutes } from "./replay.js";
import { mountSignalsRoutes } from "./signals.js";
import { mountObservabilitySnapshotRoutes } from "./observability-snapshot.js";
import { mountAgentHitlRoutes } from "./agent-hitl.js";
import { mountAgentArtifactRoutes } from "./agent-artifacts.js";
import { mountAgentProfileRoutes } from "./agent-profiles.js";
import { mountAgentToolsDiscoverRoutes } from "./agent-tools-discover.js";
import { mountCostEstimateRoutes } from "./cost-estimate.js";
import { mountTrajectoryBranchRoutes } from "./trajectory-branch.js";
import { mountAgentResumeRoutes } from "./agent-resume.js";
import { mountContextRoutes } from "./context.js";
import { mountContinuousLearningRoutes } from "./continuous-learning.js";
import mountKarpathyPipelineRoutes from "./karpathy-pipeline.js";
import mountZeroToHeroRoutes from "./zero-to-hero.js";

// Phase 63 — Code Generation vertical (5 modules)
import mountRepoRagRoutes from "./repo-rag.js";
import mountPrReviewRoutes from "./pr-review-agent.js";
import mountTestGenRoutes from "./test-gen.js";
import mountRefactorRoutes from "./refactor-agent.js";
import mountMigrationRoutes from "./migration-assistant.js";

// Phase 64 — Research pack (5 modules)
import mountLiteratureRoutes from "./literature-search.js";
import mountPaperSummaryRoutes from "./paper-summary.js";
import mountCitationGraphRoutes from "./citation-graph.js";
import mountExperimentBridgeRoutes from "./experiment-bridge.js";
import mountReproducibilityRoutes from "./reproducibility-checks.js";

// Phase 71 — Agent Economics (5 modules)
import mountPricingRoutes from "./pricing-engine.js";
import mountOutcomeRoutes from "./outcome-verification.js";
import mountRevenueShareRoutes from "./revenue-share.js";
import mountCreditRoutes from "./credit-system.js";
import mountInvoicingRoutes from "./invoicing.js";

// Phase 72 — Trust & Safety Pro (5 modules)
import mountRedTeamRoutes from "./red-team-harness.js";
import mountModelCardRoutes from "./model-card-generator.js";
import mountBiasEvalRoutes from "./bias-eval-suite.js";
import mountKTelemetryRoutes from "./k-anonymous-telemetry.js";
import mountSafetySlaRoutes from "./safety-sla.js";

// Phase 75 — Evaluation 2.0 (5 modules)
import mountEvalInProdRoutes from "./eval-in-prod.js";
import mountJudgeCalibrationRoutes from "./judge-calibration.js";
import mountPreferenceRoutes from "./preference-collection.js";
import mountBisectionRoutes from "./regression-bisection.js";
import mountSyntheticUsersRoutes from "./synthetic-users.js";

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
  mountAgentStatsAdminRoutes,
  mountAdminEvalHistoryRoutes,
  mountAdminTracesRoutes,
  mountAdminTraceStreamRoutes,
  mountTraceShareRoutes,
  mountAdminPromptPatchesRoutes,
  mountAdminQuotaRoutes,
  mountAgentFeedbackRoutes,
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
  mountToolValidationRoutes,
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
  mountMobileAutomationRoutes,
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
  mountToolCompositionRoutes,
  mountOutputClassifiersRoutes,
  mountImageGenerationRoutes,
  mountAudioClassificationRoutes,
  mount3dAssetsRoutes,
  mountScreenControlRoutes,
  mountShellAgentRoutes,
  mountBrowserAgentRoutes,
  mountDocumentLayoutRoutes,
  mountFsAgentRoutes,
  mountAgentSandboxRoutes,
  mountBenchmarkRunnerRoutes,
  mountCurriculumRoutes,
  mountSpeculativeDecodingRoutes,
  mountSyntheticTasksRoutes,
  mountDegradationTiersRoutes,
  mountQuantizationRoutes,
  mountChaosEngineeringRoutes,
  mountErrorBudgetRoutes,
  mountCanaryRoutes,
  mountApiPlaygroundRoutes,
  mountDevSetupRoutes,

  // Phase 51-70 closeout (40 new subtasks) — see AGENT_{A,B,C,D}_WIRING.md
  // Agent A — safety audit, data engineering, cost
  mountPolicyAuditRoutes,
  mountRiskyOpsQuotaRoutes,
  mountNeuroSymbolicRoutes,
  mountDagPipelineRoutes,
  mountDataQualityRoutes,
  mountSchemaEvolutionRoutes,
  mountLineageRoutes,
  mountFeatureStoreRoutes,
  mountCostAwareRouterRoutes,
  mountPromptCompressionRoutes,
  mountDistillationRoutes,

  // Agent B — load shedding + observability pro
  mountLoadSheddingRoutes,
  mountProfilingRoutes,
  mountHeapDiffRoutes,
  mountStepLatencyRoutes,
  mountLogAnalysisRoutes,
  mountStatusPageRoutes,

  // Agent C — dev platform finish + customer support vertical
  mountWebhookInspectorRoutes,
  mountIntegrationTestHarnessRoutes,
  mountSchemaRegistryRoutes,
  mountIntentClassifierRoutes,
  mountTicketRouterRoutes,
  mountResponseDrafterRoutes,
  mountEscalationRulesRoutes,
  mountCsatTrackerRoutes,

  // Agent D — governance, moderation, knowledge augmentation
  mountModelApprovalRoutes,
  mountUsagePoliciesRoutes,
  mountBudgetAllocationRoutes,
  mountAuditReportsRoutes,
  mountAiRiskScoringRoutes,
  mountHashDetectionRoutes,
  mountCopyrightSimilarityRoutes,
  mountFactualityCrossrefRoutes,
  mountBrandSafetyRoutes,
  mountHitlModerationRoutes,
  mountWebIngestionRoutes,
  mountLargeRetrievalRoutes,
  mountFactVerificationRoutes,
  mountSourceCredibilityRoutes,
  mountFreshnessSlaRoutes,

  // Wave 1 web interface — realtime agent run stream + replay
  mountAgentRunStreamRoutes,
  mountReplayRoutes,
  mountSignalsRoutes,
  mountObservabilitySnapshotRoutes,
  mountAgentHitlRoutes,
  mountAgentArtifactRoutes,
  mountAgentProfileRoutes,
  mountAgentToolsDiscoverRoutes,
  mountCostEstimateRoutes,
  mountTrajectoryBranchRoutes,
  mountAgentResumeRoutes,
  mountContextRoutes,
  mountContinuousLearningRoutes,
  mountKarpathyPipelineRoutes,
  mountZeroToHeroRoutes,

  // Phase 63 — Code Generation vertical
  mountRepoRagRoutes,
  mountPrReviewRoutes,
  mountTestGenRoutes,
  mountRefactorRoutes,
  mountMigrationRoutes,

  // Phase 64 — Research pack
  mountLiteratureRoutes,
  mountPaperSummaryRoutes,
  mountCitationGraphRoutes,
  mountExperimentBridgeRoutes,
  mountReproducibilityRoutes,

  // Phase 71 — Agent Economics
  mountPricingRoutes,
  mountOutcomeRoutes,
  mountRevenueShareRoutes,
  mountCreditRoutes,
  mountInvoicingRoutes,

  // Phase 72 — Trust & Safety Pro
  mountRedTeamRoutes,
  mountModelCardRoutes,
  mountBiasEvalRoutes,
  mountKTelemetryRoutes,
  mountSafetySlaRoutes,

  // Phase 75 — Evaluation 2.0
  mountEvalInProdRoutes,
  mountJudgeCalibrationRoutes,
  mountPreferenceRoutes,
  mountBisectionRoutes,
  mountSyntheticUsersRoutes,
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
