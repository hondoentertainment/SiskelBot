/**
 * Phase 62.4: Escalation rules routes.
 *
 * POST   /api/v1/escalation-rules                  — create / replace rule
 * GET    /api/v1/escalation-rules                  — list rules
 * GET    /api/v1/escalation-rules/:id              — fetch rule
 * DELETE /api/v1/escalation-rules/:id              — delete rule
 * POST   /api/v1/escalation-rules/evaluate         — evaluate against a ticket
 * POST   /api/v1/escalation-rules/handoffs         — record a handoff
 * GET    /api/v1/escalation-rules/handoffs         — list handoffs
 */
import {
  createRule,
  getRule,
  listRules,
  deleteRule,
  evaluateRules,
  triggerHandoff,
  listHandoffs,
} from "../lib/escalation-rules.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountEscalationRulesRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /escalation-rules/handoffs (register before :id)
  apiRoute("get", "/escalation-rules/handoffs", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listHandoffs(Number(req.query?.limit) || 100);
      res.json({ handoffs: items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /escalation-rules/handoffs
  apiRoute("post", "/escalation-rules/handoffs", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const entry = await triggerHandoff({
        ticketId: body.ticketId,
        ruleId: body.ruleId,
        target: body.target,
        reason: body.reason,
      });
      res.status(201).json(entry);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /escalation-rules/evaluate
  apiRoute("post", "/escalation-rules/evaluate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.ticket) return apiError(res, 400, "INVALID_INPUT", "ticket is required");
      const matches = await evaluateRules(body.ticket);
      res.json({ matches });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /escalation-rules
  apiRoute("post", "/escalation-rules", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await createRule(body);
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /escalation-rules
  apiRoute("get", "/escalation-rules", adminAuth, logRequest, async (_req, res) => {
    try {
      const rules = await listRules();
      res.json({ rules });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /escalation-rules/:id
  apiRoute("get", "/escalation-rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getRule(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "rule not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /escalation-rules/:id
  apiRoute("delete", "/escalation-rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteRule(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "rule not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountEscalationRulesRoutes;
