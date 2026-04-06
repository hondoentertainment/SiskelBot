// Eval, traces, and agent trajectory routes extracted from server.js
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

export function mountEvalRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    evalAuth,
    logRequest,
    evalRateLimiter,
    trajectoryApiEnabled,
    loadTrajectory,
    listTrajectories,
    listRecordedTraces,
    getRecordedTrace,
    recordTrace,
    replayTrace,
    deleteRecordedTrace,
    listEvalSets,
    loadEvalSet,
    runEvalSet,
    listStagingTraceSummaries,
  } = deps;

  // --- Agent trajectory ---
  apiRoute("get", "/agent/trajectory/:runId", logRequest, userAuth, async (req, res) => {
    if (!trajectoryApiEnabled()) {
      return apiError(
        res,
        503,
        "FEATURE_DISABLED",
        "Trajectory API disabled",
        "Unset AGENT_TRAJECTORY_API=0 to enable GET /api/agent/trajectory/:runId."
      );
    }
    const runId = String(req.params.runId || "").trim();
    const t = await loadTrajectory(runId);
    if (!t) {
      return apiError(
        res,
        404,
        "TRAJECTORY_NOT_FOUND",
        "Trajectory not found or expired",
        "IDs are short-lived; run agent mode again and use the X-Agent-Run-Id header."
      );
    }
    res.json(t);
  });

  apiRoute("get", "/agent/trajectories", logRequest, userAuth, async (req, res) => {
    if (!trajectoryApiEnabled()) {
      return apiError(
        res,
        503,
        "FEATURE_DISABLED",
        "Trajectory API disabled",
        "Unset AGENT_TRAJECTORY_API=0 to enable trajectory listing."
      );
    }
    const workspace = String(req.query.workspace || "default").trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    try {
      const data = await listTrajectories({ workspace, limit, offset });
      res.json(data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed", "See server logs.");
    }
  });

  // --- Trace Replay API ---
  apiRoute("get", "/traces", logRequest, evalAuth, async (req, res) => {
    try {
      const opts = {
        type: req.query.type || undefined,
        workspace: req.query.workspace || undefined,
        limit: Number(req.query.limit) || 50,
        offset: Number(req.query.offset) || 0,
      };
      const data = await listRecordedTraces(opts);
      res.json(data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List traces failed", "See server logs.");
    }
  });

  apiRoute("get", "/traces/:id", logRequest, evalAuth, async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
    const trace = await getRecordedTrace(id);
    if (!trace) return apiError(res, 404, "NOT_FOUND", "Trace not found", `No trace with id: ${id}`);
    res.json(trace);
  });

  apiRoute("post", "/traces/record", logRequest, evalAuth, async (req, res) => {
    try {
      const traceData = req.body;
      if (!traceData || typeof traceData !== "object") {
        return apiError(res, 400, "INVALID_BODY", "Request body must be a trace object", "Send JSON with steps, toolCalls, or goldenTrace.");
      }
      const result = await recordTrace(traceData);
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Record failed", "See server logs.");
    }
  });

  apiRoute("post", "/traces/:id/replay", logRequest, evalAuth, async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
    try {
      const expectations = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
        ? req.body
        : null;
      const result = await replayTrace(id, expectations);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Replay failed", "See server logs.");
    }
  });

  apiRoute("delete", "/traces/:id", logRequest, evalAuth, async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
    const deleted = await deleteRecordedTrace(id);
    if (!deleted) return apiError(res, 404, "NOT_FOUND", "Trace not found", `No trace with id: ${id}`);
    res.json({ ok: true, traceId: id });
  });

  apiRoute("get", "/eval/staging-traces", evalRateLimiter, evalAuth, logRequest, (req, res) => {
    try {
      const traces = listStagingTraceSummaries();
      res.json({ traces });
    } catch (err) {
      console.error("Eval staging-traces list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Eval harness ---
  apiRoute("get", "/eval/sets", evalRateLimiter, evalAuth, logRequest, async (req, res) => {
    try {
      const sets = await listEvalSets();
      res.json({ sets });
    } catch (err) {
      console.error("Eval sets list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/eval/run", evalRateLimiter, evalAuth, logRequest, async (req, res) => {
    try {
      const { evalSetId, evalSet, model } = req.body || {};
      let set = evalSet;
      if (!set && evalSetId) {
        set = await loadEvalSet(String(evalSetId).trim());
        if (!set) return apiError(res, 404, "NOT_FOUND", "Eval set not found", `No eval set with id: ${evalSetId}`);
      }
      if (!set || !Array.isArray(set.cases)) {
        return apiError(res, 400, "INVALID_BODY", "evalSetId, evalSet, or valid evalSet JSON required", "Send { evalSetId: string } or { evalSet: { id, name, cases } }.");
      }
      const baseUrl = `${req.protocol}://${req.get("host") || "localhost"}`;
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
      const apiKey = bearer || req.headers["x-api-key"] || req.headers["x-admin-api-key"];
      const result = await runEvalSet(set, {
        model: model || undefined,
        baseUrl,
        apiKey: apiKey || undefined,
      });
      res.json(result);
    } catch (err) {
      console.error("Eval run error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Eval UI page
  app.get("/eval", (req, res) => {
    res.sendFile(join(rootDir, "client", "eval.html"));
  });
}
