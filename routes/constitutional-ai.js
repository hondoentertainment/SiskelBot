/**
 * Phase 51.4: Constitutional AI rule engine routes.
 *
 * GET    /api/v1/constitution/:workspaceId
 * POST   /api/v1/constitution/:workspaceId                 — admin
 * PUT    /api/v1/constitution/:workspaceId                 — admin
 * DELETE /api/v1/constitution/:workspaceId                 — admin
 * POST   /api/v1/constitution/:workspaceId/critique        — body: { output }
 * POST   /api/v1/constitution/:workspaceId/apply           — body: { output, maxIterations? }
 * POST   /api/v1/constitution/:workspaceId/rules           — admin, add rule
 * DELETE /api/v1/constitution/:workspaceId/rules/:ruleId   — admin
 */
import {
  DEFAULT_CONSTITUTION,
  createConstitution,
  getConstitution,
  updateConstitution,
  deleteConstitution,
  addRule,
  removeRule,
  critique,
  applyConstitution,
} from "../lib/constitutional-ai.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/already exists/i.test(m)) return 409;
  if (/required|must be|invalid/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code =
    status === 404
      ? "NOT_FOUND"
      : status === 409
        ? "CONFLICT"
        : status === 400
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "constitutional-ai error");
}

export function mountConstitutionalAiRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const admin = adminAuth || ((_req, _res, next) => next());

  // GET /api/v1/constitution/:workspaceId
  apiRoute("get", "/constitution/:workspaceId", limiter, async (req, res) => {
    try {
      const entry = await getConstitution(req.params.workspaceId);
      if (!entry) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          `constitution for workspace ${req.params.workspaceId} not found`,
        );
      }
      return res.json({ _version: 1, constitution: entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/constitution/:workspaceId (admin — create)
  apiRoute("post", "/constitution/:workspaceId", admin, limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const rules = Array.isArray(body.rules) ? body.rules : DEFAULT_CONSTITUTION;
      const entry = await createConstitution(req.params.workspaceId, rules);
      return res.status(201).json({ _version: 1, constitution: entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // PUT /api/v1/constitution/:workspaceId (admin — replace rules)
  apiRoute("put", "/constitution/:workspaceId", admin, limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.rules)) {
        return apiError(res, 400, "INVALID_INPUT", "rules must be an array");
      }
      const entry = await updateConstitution(req.params.workspaceId, body.rules);
      return res.json({ _version: 1, constitution: entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/constitution/:workspaceId (admin)
  apiRoute("delete", "/constitution/:workspaceId", admin, limiter, async (req, res) => {
    try {
      const deleted = await deleteConstitution(req.params.workspaceId);
      if (!deleted) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          `constitution for workspace ${req.params.workspaceId} not found`,
        );
      }
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/constitution/:workspaceId/critique
  apiRoute("post", "/constitution/:workspaceId/critique", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.output !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "output string is required");
      }
      const entry = await getConstitution(req.params.workspaceId);
      if (!entry) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          `constitution for workspace ${req.params.workspaceId} not found`,
        );
      }
      const violations = critique(body.output, entry);
      return res.json({
        _version: 1,
        violations,
        count: violations.length,
        safe: violations.length === 0,
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/constitution/:workspaceId/apply
  apiRoute("post", "/constitution/:workspaceId/apply", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.output !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "output string is required");
      }
      const entry = await getConstitution(req.params.workspaceId);
      if (!entry) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          `constitution for workspace ${req.params.workspaceId} not found`,
        );
      }
      const maxIterations = Number.isFinite(Number(body.maxIterations))
        ? Number(body.maxIterations)
        : undefined;
      const result = await applyConstitution(body.output, entry, { maxIterations });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/constitution/:workspaceId/rules (admin — add a rule)
  apiRoute("post", "/constitution/:workspaceId/rules", admin, limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.rule || typeof body.rule !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "rule object is required");
      }
      const entry = await addRule(req.params.workspaceId, body.rule);
      return res.status(201).json({ _version: 1, constitution: entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/constitution/:workspaceId/rules/:ruleId (admin)
  apiRoute(
    "delete",
    "/constitution/:workspaceId/rules/:ruleId",
    admin,
    limiter,
    async (req, res) => {
      try {
        const entry = await removeRule(req.params.workspaceId, req.params.ruleId);
        return res.json({ _version: 1, constitution: entry });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );
}

export default mountConstitutionalAiRoutes;
