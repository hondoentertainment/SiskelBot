/**
 * Phase 45.3: Secure aggregation routes.
 *
 * Endpoints for the simplified Bonawitz-style secure aggregation protocol
 * used by federated learning rounds. Every stateful operation goes through
 * `lib/secure-aggregation.js`, which is responsible for persisting session
 * state under `data/secure-aggregation.json`.
 *
 * POST   /api/v1/secure-aggregation/sessions                      create a session
 * GET    /api/v1/secure-aggregation/sessions                      list sessions
 * GET    /api/v1/secure-aggregation/sessions/:id                  fetch one session
 * DELETE /api/v1/secure-aggregation/sessions/:id                  delete a session
 * POST   /api/v1/secure-aggregation/sessions/:id/shares           generateKeyShares
 * POST   /api/v1/secure-aggregation/sessions/:id/updates          submitMaskedUpdate
 * POST   /api/v1/secure-aggregation/sessions/:id/reveal           revealSeed (surviving client)
 * POST   /api/v1/secure-aggregation/sessions/:id/recover          recoverKeys (dropped client)
 * GET    /api/v1/secure-aggregation/sessions/:id/aggregate        aggregateMaskedUpdates
 */
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  generateKeyShares,
  submitMaskedUpdate,
  revealSeed,
  recoverKeys,
  aggregateMaskedUpdates,
} from "../lib/secure-aggregation.js";

export function mountSecureAggregationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  const BASE = "/secure-aggregation";

  // ---- Session CRUD ----

  apiRoute("post", `${BASE}/sessions`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const participants = Array.isArray(body.participants) ? body.participants : null;
      if (!participants || participants.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "participants must be a non-empty array");
      }
      const threshold = Number(body.threshold);
      if (!Number.isInteger(threshold) || threshold < 1) {
        return apiError(res, 400, "INVALID_INPUT", "threshold must be a positive integer");
      }
      const session = await createSession(participants, threshold);
      res.status(201).json({ _version: 1, session });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "failed to create session");
    }
  });

  apiRoute("get", `${BASE}/sessions`, log, auth, scope("read"), async (req, res) => {
    try {
      const limit = req.query?.limit ? Number(req.query.limit) : 50;
      const sessions = await listSessions({ limit });
      res.json({ _version: 1, sessions, count: sessions.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });

  apiRoute("get", `${BASE}/sessions/:id`, log, auth, scope("read"), async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      res.json({ _version: 1, session });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "fetch failed");
    }
  });

  apiRoute("delete", `${BASE}/sessions/:id`, log, auth, scope("write"), async (req, res) => {
    try {
      const ok = await deleteSession(req.params.id);
      if (!ok) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      res.json({ _version: 1, deleted: req.params.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "delete failed");
    }
  });

  // ---- Protocol phases ----

  apiRoute("post", `${BASE}/sessions/:id/shares`, log, auth, scope("write"), async (req, res) => {
    try {
      const clientId = (req.body?.clientId || "").toString().trim();
      if (!clientId) {
        return apiError(res, 400, "INVALID_INPUT", "clientId is required");
      }
      const result = await generateKeyShares(req.params.id, clientId);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      const msg = err?.message || "share generation failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", `${BASE}/sessions/:id/updates`, log, auth, scope("write"), async (req, res) => {
    try {
      const clientId = (req.body?.clientId || "").toString().trim();
      const maskedValue = req.body?.maskedValue;
      if (!clientId) {
        return apiError(res, 400, "INVALID_INPUT", "clientId is required");
      }
      if (maskedValue === undefined || maskedValue === null) {
        return apiError(res, 400, "INVALID_INPUT", "maskedValue is required");
      }
      const result = await submitMaskedUpdate(req.params.id, clientId, maskedValue);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      const msg = err?.message || "submit failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", `${BASE}/sessions/:id/reveal`, log, auth, scope("write"), async (req, res) => {
    try {
      const clientId = (req.body?.clientId || "").toString().trim();
      const seed = req.body?.seed;
      if (!clientId) {
        return apiError(res, 400, "INVALID_INPUT", "clientId is required");
      }
      if (seed === undefined || seed === null) {
        return apiError(res, 400, "INVALID_INPUT", "seed is required");
      }
      const result = await revealSeed(req.params.id, clientId, seed);
      res.json({ _version: 1, ...result });
    } catch (err) {
      const msg = err?.message || "reveal failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("post", `${BASE}/sessions/:id/recover`, log, auth, scope("write"), async (req, res) => {
    try {
      const clientId = (req.body?.clientId || "").toString().trim();
      const shares = req.body?.shares;
      if (!clientId) {
        return apiError(res, 400, "INVALID_INPUT", "clientId is required");
      }
      if (!Array.isArray(shares) || shares.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "shares must be a non-empty array");
      }
      const result = await recoverKeys(req.params.id, clientId, shares);
      res.json({ _version: 1, ...result });
    } catch (err) {
      const msg = err?.message || "recovery failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });

  apiRoute("get", `${BASE}/sessions/:id/aggregate`, log, auth, scope("read"), async (req, res) => {
    try {
      const result = await aggregateMaskedUpdates(req.params.id);
      res.json({ _version: 1, ...result });
    } catch (err) {
      const msg = err?.message || "aggregate failed";
      const code = /not found/i.test(msg) ? 404 : 400;
      return apiError(res, code, code === 404 ? "NOT_FOUND" : "INVALID_INPUT", msg);
    }
  });
}

export default mountSecureAggregationRoutes;
