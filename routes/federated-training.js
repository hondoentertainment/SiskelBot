/**
 * Phase 45.1: Federated training routes.
 *
 * POST   /api/v1/federated/rounds                  — create a new round
 * GET    /api/v1/federated/rounds                  — list rounds
 * GET    /api/v1/federated/rounds/:id              — fetch a round
 * DELETE /api/v1/federated/rounds/:id              — delete a round
 * POST   /api/v1/federated/rounds/:id/join         — client joins a round
 * POST   /api/v1/federated/rounds/:id/submit       — client submits gradients
 * POST   /api/v1/federated/rounds/:id/aggregate    — run FedAvg aggregation
 * GET    /api/v1/federated/rounds/:id/model/:cid   — fetch distributed model
 * POST   /api/v1/federated/rounds/:id/complete     — finalize round
 * POST   /api/v1/federated/rounds/:id/cancel       — cancel round
 */
import {
  createFederatedRound,
  joinRound,
  submitGradients,
  aggregateGradients,
  distributeModel,
  completeRound,
  cancelRound,
  getRound,
  listRounds,
  deleteRound,
} from "../lib/federated-training.js";

export function mountFederatedTrainingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/federated/rounds", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const round = await createFederatedRound({
        modelId: body.modelId,
        minClients: body.minClients,
        maxClients: body.maxClients,
        targetRoundMs: body.targetRoundMs,
        initialWeights: body.initialWeights,
        createdBy: req.user?.id || req.user?.userId || null,
      });
      res.status(201).json({ _version: 1, round });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "create failed");
    }
  });

  apiRoute("get", "/federated/rounds", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = req.query?.limit ? Number(req.query.limit) : 50;
      const state = req.query?.state ? String(req.query.state) : undefined;
      const rounds = await listRounds({ limit, state });
      res.json({ _version: 1, rounds, count: rounds.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });

  apiRoute("get", "/federated/rounds/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const round = await getRound(req.params.id);
      if (!round) return apiError(res, 404, "NOT_FOUND", `round ${req.params.id} not found`);
      res.json({ _version: 1, round });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "fetch failed");
    }
  });

  apiRoute("delete", "/federated/rounds/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const removed = await deleteRound(req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", `round ${req.params.id} not found`);
      res.json({ _version: 1, ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "delete failed");
    }
  });

  apiRoute("post", "/federated/rounds/:id/join", log, auth, scope("write"), async (req, res) => {
    try {
      const userId = req.user?.id || req.user?.userId || req.body?.userId || "anonymous";
      const caps = req.body?.capabilities || {};
      const result = await joinRound(req.params.id, userId, caps);
      res.status(201).json({ _version: 1, clientId: result.clientId, round: result.round });
    } catch (err) {
      const msg = err?.message || "join failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", "/federated/rounds/:id/submit", log, auth, scope("write"), async (req, res) => {
    try {
      const { clientId, gradients, metadata } = req.body || {};
      if (!clientId) return apiError(res, 400, "INVALID_INPUT", "clientId required");
      if (!gradients) return apiError(res, 400, "INVALID_INPUT", "gradients required");
      const round = await submitGradients(req.params.id, clientId, gradients, metadata || {});
      res.status(201).json({ _version: 1, round });
    } catch (err) {
      const msg = err?.message || "submit failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", "/federated/rounds/:id/aggregate", log, auth, scope("write"), async (req, res) => {
    try {
      const round = await aggregateGradients(req.params.id);
      res.json({ _version: 1, round });
    } catch (err) {
      const msg = err?.message || "aggregate failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute(
    "get",
    "/federated/rounds/:id/model/:clientId",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const payload = await distributeModel(req.params.id, req.params.clientId);
        res.json({ _version: 1, ...payload });
      } catch (err) {
        const msg = err?.message || "distribute failed";
        const code = /not found|has not joined/i.test(msg) ? 404 : 400;
        return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
      }
    },
  );

  apiRoute("post", "/federated/rounds/:id/complete", log, auth, scope("write"), async (req, res) => {
    try {
      const round = await completeRound(req.params.id);
      res.json({ _version: 1, round });
    } catch (err) {
      const msg = err?.message || "complete failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", "/federated/rounds/:id/cancel", log, auth, scope("write"), async (req, res) => {
    try {
      const round = await cancelRound(req.params.id);
      if (!round) return apiError(res, 404, "NOT_FOUND", `round ${req.params.id} not found`);
      res.json({ _version: 1, round });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "cancel failed");
    }
  });
}

export default mountFederatedTrainingRoutes;
