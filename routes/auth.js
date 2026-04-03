import passport from "passport";

export default function mountAuthRoutes(app, deps) {
  const {
    oauthProviders,
    BACKEND,
    MODEL_PRESETS,
    API_KEY,
    IS_PRODUCTION,
    isMonitoringEnabled,
    STREAM_AGENT_FINAL,
    STREAM_SWARM_SYNTH,
    MAX_AGENT_TOOL_CALLS_ENV,
    AGENT_MAX_WALL_MS_ENV,
    getSwarmSelectableSpecialistNames,
    getSwarmSpecialistsAllowlistNames,
    getAgentToolsAllowlistNames,
    toolValidationEnabled,
    stagnationDetectionEnabled,
    trajectoryApiEnabled,
    defaultAgentSystemConfigured,
    isAuthConfigured,
  } = deps;

  // Config endpoint for client (backend, model presets)
  app.get("/config", (req, res) => {
    const payload = {
      backend: BACKEND,
      modelPresets: MODEL_PRESETS[BACKEND] || [],
      modelPlaceholder: MODEL_PRESETS[BACKEND]?.[0] || "model",
      requiresApiKey: Boolean(API_KEY),
      isProduction: IS_PRODUCTION,
      defaultGenerationConfig: {
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 512,
      },
      monitoringEnabled: isMonitoringEnabled(),
      allowRecipeStepExecution: process.env.ALLOW_RECIPE_STEP_EXECUTION === "1",
      scheduleEnabled: process.env.ENABLE_SCHEDULED_RECIPES === "1",
      swarmEnabled: process.env.ENABLE_AGENT_SWARM === "1",
      swarmParallelAgentsDefault: process.env.SWARM_PARALLEL_AGENTS === "1",
      swarmClientSpecialistsAllowed: process.env.SWARM_CLIENT_SPECIALISTS === "1",
      swarmMaxSpecialists: Math.min(12, Math.max(1, Number(process.env.SWARM_MAX_SPECIALISTS) || 8)),
      swarmSelectableSpecialists: getSwarmSelectableSpecialistNames(),
      swarmSpecialistsAllowlist: getSwarmSpecialistsAllowlistNames(),
      authRequired: isAuthConfigured(),
      oauthProviders,
      storageBackend:
        process.env.STORAGE_BACKEND === "postgres"
          ? "postgres"
          : process.env.STORAGE_BACKEND === "sqlite"
            ? "sqlite"
            : "json",
      quotaEnabled: process.env.QUOTA_ENABLED === "1",
      quotaDefaultLimit: process.env.QUOTA_DEFAULT_LIMIT ? Number(process.env.QUOTA_DEFAULT_LIMIT) : null,
      realtimeEnabled: true,
      agentEnabled: true,
      agentToolsEnabled: true,
      streamAgentFinalEnabled: STREAM_AGENT_FINAL,
      streamAgentFinalChunksWhenAgentMode: true,
      fallbackBackend: process.env.FALLBACK_BACKEND || null,
      otelEnabled: process.env.OTEL_ENABLED === "1",
      otelAutoInstrument: process.env.OTEL_AUTO_INSTRUMENT !== "0",
      toolValidationEnabled: toolValidationEnabled(),
      agentStagnationStop: stagnationDetectionEnabled(),
      agentRequireCitations: process.env.AGENT_REQUIRE_CITATIONS === "1",
      agentTrajectoryApi: trajectoryApiEnabled(),
      agentDefaultSystemSet: defaultAgentSystemConfigured(),
      legacySwarmSpecialists: getSwarmSelectableSpecialistNames(),
      streamSwarmSynth: STREAM_SWARM_SYNTH,
      agentPlanReflect: process.env.AGENT_PLAN_REFLECT === "1",
      agentHooksConfigured: Boolean((process.env.AGENT_HOOKS_MODULE || "").trim()),
      agentBudgetToolCalls: MAX_AGENT_TOOL_CALLS_ENV || null,
      agentBudgetWallMs: AGENT_MAX_WALL_MS_ENV || null,
      agentToolsAllowlist: getAgentToolsAllowlistNames(),
      agentMaxIterationsCeiling: Math.max(1, Number(process.env.MAX_AGENT_ITERATIONS) || 5),
      agentMaxIterationsClientTunable: process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT !== "1",
      prometheusEnabled: process.env.ENABLE_METRICS === "1",
      prometheusPath: "/metrics",
    };
    if (IS_PRODUCTION && !API_KEY) {
      payload.productionHint = "Set API_KEY in Vercel env vars to protect /v1/chat/completions";
    }
    res.json(payload);
  });

  // OAuth routes (when configured)
  function oauthCallback(req, res) {
    if (!req.session) return res.redirect("/?auth_error=session");
    req.session.userId = req.user?.userId;
    res.redirect("/");
  }

  if (oauthProviders.github) {
    app.get("/auth/github", passport.authenticate("github", { scope: ["user:email"] }));
    app.get("/auth/github/callback", passport.authenticate("github", { failureRedirect: "/?auth_error=1" }), oauthCallback);
  }
  if (oauthProviders.google) {
    app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
    app.get("/auth/google/callback", passport.authenticate("google", { failureRedirect: "/?auth_error=1" }), oauthCallback);
  }
  app.get("/auth/logout", (req, res) => {
    req.session?.destroy?.();
    res.redirect("/");
  });
  app.get("/auth/me", (req, res) => {
    if (req.session?.userId) {
      const provider = req.user?.provider || (req.session.userId?.startsWith("github-") ? "github" : req.session.userId?.startsWith("google-") ? "google" : null);
      return res.json({ userId: req.session.userId, provider });
    }
    return res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
  });
}
