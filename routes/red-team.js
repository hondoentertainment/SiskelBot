/**
 * Phase 51.1: Red-team framework routes.
 *
 * POST   /api/v1/red-team/prompts              -- body { category, prompt, tags?, severityWeight? }
 * GET    /api/v1/red-team/prompts              -- query ?category=&tag=
 * DELETE /api/v1/red-team/prompts/:id
 * POST   /api/v1/red-team/runs                 -- body { responses: [{promptId, response}], label?, targetName? }
 * GET    /api/v1/red-team/runs                 -- query ?limit=
 * GET    /api/v1/red-team/runs/:id
 * POST   /api/v1/red-team/schedule             -- body { targetName, category?, tag?, runAt, label? }
 * GET    /api/v1/red-team/schedule
 * DELETE /api/v1/red-team/schedule/:id
 * POST   /api/v1/red-team/score                -- body { prompt, response }
 */
import {
  getPromptLibrary,
  addAdversarialPrompt,
  removeAdversarialPrompt,
  runAttackBattery,
  listAttackRuns,
  getAttackRun,
  scheduleAttackRun,
  listScheduledAttackRuns,
  cancelScheduledAttackRun,
  scorePromptSeverity,
} from "../lib/red-team.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "red-team error");
}

export function mountRedTeamRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/red-team/prompts
  apiRoute("post", "/red-team/prompts", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.prompt || typeof body.prompt !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      if (!body.category || typeof body.category !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "category is required");
      }
      const rec = await addAdversarialPrompt({
        category: body.category,
        prompt: body.prompt,
        tags: Array.isArray(body.tags) ? body.tags : [],
        expectedBehavior: body.expectedBehavior,
        severityWeight: body.severityWeight,
      });
      return res.status(201).json({ _version: 1, prompt: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/red-team/prompts
  apiRoute("get", "/red-team/prompts", log, auth, scope("read"), async (req, res) => {
    try {
      const list = await getPromptLibrary({
        category: typeof req.query.category === "string" ? req.query.category : undefined,
        tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
      });
      return res.json({ _version: 1, prompts: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/red-team/prompts/:id
  apiRoute("delete", "/red-team/prompts/:id", log, admin, async (req, res) => {
    try {
      const ok = await removeAdversarialPrompt(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "prompt not found");
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/red-team/runs
  // Body is either:
  //   { responses: [{ promptId, response }], label?, targetName? }
  // or:
  //   { echoResponse: "..." } -- a debug mode that runs the library with a canned reply
  apiRoute("post", "/red-team/runs", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const lookup = new Map();
      if (Array.isArray(body.responses)) {
        for (const r of body.responses) {
          if (r && typeof r === "object" && r.promptId) {
            lookup.set(String(r.promptId), String(r.response || ""));
          }
        }
      }
      const echoResponse =
        typeof body.echoResponse === "string" ? body.echoResponse : null;
      const target = async (_prompt, record) => {
        if (lookup.has(record.id)) return lookup.get(record.id);
        if (echoResponse != null) return echoResponse;
        return "";
      };
      const run = await runAttackBattery(target, {
        category: typeof body.category === "string" ? body.category : undefined,
        tag: typeof body.tag === "string" ? body.tag : undefined,
        label: typeof body.label === "string" ? body.label : undefined,
        targetName: typeof body.targetName === "string" ? body.targetName : "api",
      });
      return res.status(201).json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/red-team/runs
  apiRoute("get", "/red-team/runs", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number.isFinite(Number(req.query.limit))
        ? Number(req.query.limit)
        : undefined;
      const list = await listAttackRuns({ limit });
      return res.json({ _version: 1, runs: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/red-team/runs/:id
  apiRoute("get", "/red-team/runs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const run = await getAttackRun(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/red-team/schedule
  apiRoute("post", "/red-team/schedule", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const item = await scheduleAttackRun({
        targetName: body.targetName,
        category: body.category,
        tag: body.tag,
        runAt: body.runAt,
        label: body.label,
      });
      return res.status(201).json({ _version: 1, scheduled: item });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/red-team/schedule
  apiRoute("get", "/red-team/schedule", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listScheduledAttackRuns();
      return res.json({ _version: 1, items: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/red-team/schedule/:id
  apiRoute("delete", "/red-team/schedule/:id", log, admin, async (req, res) => {
    try {
      const ok = await cancelScheduledAttackRun(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "scheduled item not found");
      return res.json({ _version: 1, cancelled: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/red-team/score
  apiRoute("post", "/red-team/score", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.response || typeof body.response !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "response is required");
      }
      const prompt =
        body.prompt && typeof body.prompt === "object"
          ? body.prompt
          : { category: "other", expectedBehavior: "refusal", severityWeight: 1 };
      const score = scorePromptSeverity(prompt, body.response);
      return res.json({ _version: 1, score });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountRedTeamRoutes;
