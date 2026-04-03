// Execute-step and automations/validate routes extracted from server.js

export function mountExecuteRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    apiKeyAuth,
    requireScope,
    logRequest,
    executeStepRateLimiter,
    integrationRateLimiter,
    sanitizeWorkspace,
    executeStep,
    appendAuditLog,
    emitEvent,
    ALLOW_RECIPE_STEP_EXECUTION,
    validateAutomationRecipe,
  } = deps;

  apiRoute("post", "/execute-step",
    executeStepRateLimiter,
    apiKeyAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      if (!ALLOW_RECIPE_STEP_EXECUTION) {
        return apiError(
          res,
          503,
          "EXECUTION_DISABLED",
          "Recipe step execution is disabled",
          "Set ALLOW_RECIPE_STEP_EXECUTION=1 to enable. See docs/RUNBOOK.md."
        );
      }

      const { step, allowExecution } = req.body || {};
      if (!allowExecution) {
        return apiError(
          res,
          403,
          "EXECUTION_NOT_ALLOWED",
          "Client must have Allow recipe step execution enabled",
          "Enable the toggle in Settings to run steps."
        );
      }

      if (!step || typeof step !== "object" || !step.action) {
        return apiError(res, 400, "INVALID_BODY", "step with action required", "Send { step: { action, payload? }, allowExecution: true }.");
      }

      const execWorkspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);

      try {
        const ctx = {
          projectDir: process.env.PROJECT_DIR || process.cwd(),
          vercelToken: process.env.VERCEL_TOKEN,
        };
        const result = await executeStep(step, ctx);

        appendAuditLog({
          action: step.action,
          payload: step.payload,
          ok: result.ok,
          error: result.error,
        });

        await emitEvent(
          "recipe_executed",
          { step: { action: step.action, payload: step.payload }, ok: result.ok, error: result.error },
          { workspaceId: execWorkspace, userId: req.userId }
        );

        if (result.ok) {
          return res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
        }
        return res.status(400).json({
          ok: false,
          error: result.error,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (err) {
        console.error("Execute step error:", err.message);
        appendAuditLog({
          action: step?.action,
          payload: step?.payload,
          ok: false,
          error: err.message,
        });
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute("post", "/automations/validate",
    integrationRateLimiter,
    logRequest,
    (req, res) => {
      try {
        const recipe = req.body;
        const result = validateAutomationRecipe(recipe);
        return res.json({ valid: result.valid, errors: result.errors });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );
}
