/**
 * Phase 45.4: Federated learning consortium routes.
 *
 * POST   /api/v1/fl/consortia                                    — create a consortium
 * GET    /api/v1/fl/consortia                                    — list consortia
 * GET    /api/v1/fl/consortia/:id                                — get consortium detail
 * GET    /api/v1/fl/consortia/:id/members                        — list active members
 * GET    /api/v1/fl/consortia/:id/stats                          — aggregate stats
 * GET    /api/v1/fl/consortia/:id/audit                          — audit trail
 * POST   /api/v1/fl/consortia/:id/invites                        — invite an org
 * POST   /api/v1/fl/consortia/:id/invites/:orgId/accept          — accept invite
 * POST   /api/v1/fl/consortia/:id/invites/:orgId/reject          — reject invite
 * POST   /api/v1/fl/consortia/:id/members/:orgId/remove          — remove a member
 * POST   /api/v1/fl/consortia/:id/emergency-halt                 — founder emergency halt
 * POST   /api/v1/fl/consortia/:id/contributions                  — record a contribution
 * POST   /api/v1/fl/consortia/:id/proposals                      — propose a training round
 * GET    /api/v1/fl/proposals/:id                                — fetch a proposal
 * POST   /api/v1/fl/proposals/:id/vote                           — vote on a proposal
 */
import {
  createConsortium,
  inviteOrganization,
  acceptInvite,
  rejectInvite,
  listMembers,
  proposeTrainingRound,
  voteOnProposal,
  removeConsortiumMember,
  getConsortiumStats,
  auditLogForConsortium,
  emergencyHalt,
  recordContribution,
  getProposal,
  getConsortium,
  listConsortia,
} from "../lib/fl-consortium.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|is not active|already|expired|closed|cannot|only|disabled/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "fl-consortium error");
}

export function mountFlConsortiumRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/fl/consortia
  apiRoute("post", "/fl/consortia", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (!body.founderOrgId || typeof body.founderOrgId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "founderOrgId is required");
      }
      const consortium = await createConsortium(body.name, body.founderOrgId);
      return res.status(201).json({ _version: 1, consortium });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/consortia
  apiRoute("get", "/fl/consortia", log, auth, scope("read"), async (_req, res) => {
    try {
      const consortia = await listConsortia();
      return res.json({ _version: 1, consortia, count: consortia.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/consortia/:id
  apiRoute("get", "/fl/consortia/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const consortium = await getConsortium(req.params.id);
      if (!consortium) {
        return apiError(res, 404, "NOT_FOUND", `consortium ${req.params.id} not found`);
      }
      return res.json({ _version: 1, consortium });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/consortia/:id/members
  apiRoute("get", "/fl/consortia/:id/members", log, auth, scope("read"), async (req, res) => {
    try {
      const members = await listMembers(req.params.id);
      return res.json({ _version: 1, members, count: members.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/consortia/:id/stats
  apiRoute("get", "/fl/consortia/:id/stats", log, auth, scope("read"), async (req, res) => {
    try {
      const stats = await getConsortiumStats(req.params.id);
      if (!stats) {
        return apiError(res, 404, "NOT_FOUND", `consortium ${req.params.id} not found`);
      }
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/consortia/:id/audit
  apiRoute("get", "/fl/consortia/:id/audit", log, auth, scope("read"), async (req, res) => {
    try {
      const entries = await auditLogForConsortium(req.params.id);
      return res.json({ _version: 1, entries, count: entries.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/fl/consortia/:id/invites
  apiRoute("post", "/fl/consortia/:id/invites", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.orgId) {
        return apiError(res, 400, "INVALID_INPUT", "orgId is required");
      }
      if (!body.invitedBy) {
        return apiError(res, 400, "INVALID_INPUT", "invitedBy is required");
      }
      const invite = await inviteOrganization(req.params.id, body.orgId, body.invitedBy);
      return res.status(201).json({ _version: 1, invite });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/fl/consortia/:id/invites/:orgId/accept
  apiRoute(
    "post",
    "/fl/consortia/:id/invites/:orgId/accept",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const signature = req.body?.signature;
        if (!signature) {
          return apiError(res, 400, "INVALID_INPUT", "signature is required");
        }
        const member = await acceptInvite(req.params.id, req.params.orgId, signature);
        return res.status(201).json({ _version: 1, member });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/fl/consortia/:id/invites/:orgId/reject
  apiRoute(
    "post",
    "/fl/consortia/:id/invites/:orgId/reject",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const invite = await rejectInvite(req.params.id, req.params.orgId);
        return res.json({ _version: 1, invite });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/fl/consortia/:id/members/:orgId/remove
  apiRoute(
    "post",
    "/fl/consortia/:id/members/:orgId/remove",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const reason = req.body?.reason;
        if (!reason) {
          return apiError(res, 400, "INVALID_INPUT", "reason is required");
        }
        const member = await removeConsortiumMember(req.params.id, req.params.orgId, reason);
        return res.json({ _version: 1, member });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/fl/consortia/:id/emergency-halt
  apiRoute("post", "/fl/consortia/:id/emergency-halt", log, auth, scope("write"), async (req, res) => {
    try {
      const { invokerOrgId, reason } = req.body || {};
      if (!invokerOrgId) return apiError(res, 400, "INVALID_INPUT", "invokerOrgId is required");
      if (!reason) return apiError(res, 400, "INVALID_INPUT", "reason is required");
      const result = await emergencyHalt(req.params.id, invokerOrgId, reason);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/fl/consortia/:id/contributions
  apiRoute("post", "/fl/consortia/:id/contributions", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.orgId) return apiError(res, 400, "INVALID_INPUT", "orgId is required");
      const result = await recordContribution(req.params.id, body.orgId, body.amount);
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/fl/consortia/:id/proposals
  apiRoute("post", "/fl/consortia/:id/proposals", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.proposerOrgId) {
        return apiError(res, 400, "INVALID_INPUT", "proposerOrgId is required");
      }
      const proposal = await proposeTrainingRound(req.params.id, body);
      return res.status(201).json({ _version: 1, proposal });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/fl/proposals/:id
  apiRoute("get", "/fl/proposals/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const proposal = await getProposal(req.params.id);
      if (!proposal) {
        return apiError(res, 404, "NOT_FOUND", `proposal ${req.params.id} not found`);
      }
      return res.json({ _version: 1, proposal });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/fl/proposals/:id/vote
  apiRoute("post", "/fl/proposals/:id/vote", log, auth, scope("write"), async (req, res) => {
    try {
      const { orgId, vote } = req.body || {};
      if (!orgId) return apiError(res, 400, "INVALID_INPUT", "orgId is required");
      if (!vote) return apiError(res, 400, "INVALID_INPUT", "vote is required");
      const proposal = await voteOnProposal(req.params.id, orgId, vote);
      return res.json({ _version: 1, proposal });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountFlConsortiumRoutes;
