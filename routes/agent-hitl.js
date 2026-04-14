// Human-in-the-loop approval round-trip for agent sessions.
// Resolves the pause created by lib/agent-loop-execute-tools.js (saveHitlState)
// so the 4-pane Agent Run hero UI can clear its Approvals card and the agent
// loop can either proceed (approve) or bail out (deny).
//
// Follows the same deps/apiRoute/userAuth/requireScope pattern as
// routes/agent-sessions.js.
//
// POST /api/v1/agent/hitl/:approvalId
//   body: { decision: "approve" | "deny", edits? }
//   200 → { ok: true, approvalId, decision }
//   400 → INVALID / INVALID_DECISION
//   404 → NOT_FOUND            (no approval for this id)
//   409 → CONFLICT              (state present but already resolved / inconsistent)

import { peekHitlState, takeHitlState } from "../lib/agent-hitl-store.js";

const VALID_DECISIONS = new Set(["approve", "deny"]);

export function mountAgentHitlRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  apiRoute(
    "post",
    "/agent/hitl/:approvalId",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      const approvalId = String(req.params?.approvalId || "").trim();
      if (!approvalId) {
        return apiError(res, 400, "INVALID", "approvalId required", "");
      }
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const decision = typeof body.decision === "string" ? body.decision.trim() : "";
      if (!VALID_DECISIONS.has(decision)) {
        return apiError(
          res,
          400,
          "INVALID_DECISION",
          "decision must be 'approve' or 'deny'",
          "Pass { decision: 'approve' } or { decision: 'deny' } in the body.",
        );
      }

      // Peek first so we can distinguish "never existed" (404) from
      // "race with a concurrent consumer" (409).
      const snapshot = peekHitlState(approvalId);
      if (!snapshot) {
        return apiError(
          res,
          404,
          "NOT_FOUND",
          "Approval not found",
          "The approval id may have expired or been resolved already.",
        );
      }

      const taken = takeHitlState(approvalId, { decision });
      if (!taken) {
        return apiError(
          res,
          409,
          "CONFLICT",
          "Approval already resolved",
          "Another request consumed this approval id.",
        );
      }

      return res.status(200).json({ ok: true, approvalId, decision });
    },
  );
}

export default mountAgentHitlRoutes;
