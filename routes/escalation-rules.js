/**
 * Phase 62.4: Escalation rules routes.
 */
import {
  addRule,
  listRules,
  removeRule,
  evaluateRules,
  triggerEscalation,
  listEscalations,
  getEscalationHistory,
} from "../lib/escalation-rules.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "escalation-rules error");
}

export function mountEscalationRulesRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/support/escalation/rules", log, auth, scope("write"), async (req, res) => {
    try {
      const rule = await addRule(req.body || {});
      return res.status(201).json({ _version: 1, rule });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/escalation/rules", log, auth, scope("read"), async (_req, res) => {
    try {
      const rules = await listRules();
      return res.json({ _version: 1, rules, count: rules.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/support/escalation/rules/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const ok = await removeRule(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "rule not found");
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/support/escalation/evaluate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.ticket || typeof body.ticket !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "ticket is required");
      }
      const matches = await evaluateRules(body.ticket);
      return res.json({ _version: 1, matches, count: matches.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/escalation/trigger", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.ticket || typeof body.ticket !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "ticket is required");
      }
      const rec = await triggerEscalation(body.ticket, body.rule || null);
      return res.status(201).json({ _version: 1, escalation: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/escalation/list", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 100;
      const list = await listEscalations(limit);
      return res.json({ _version: 1, escalations: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/escalation/history", log, auth, scope("read"), async (req, res) => {
    try {
      const ticketId = typeof req.query.ticketId === "string" ? req.query.ticketId : undefined;
      const history = await getEscalationHistory(ticketId);
      return res.json({ _version: 1, history, count: history.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountEscalationRulesRoutes;
