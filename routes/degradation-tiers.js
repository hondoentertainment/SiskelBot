/**
 * Phase 59.3: Degradation tiers routes.
 *
 * POST   /api/v1/degradation/features                     — admin register a feature
 * GET    /api/v1/degradation/features/:name               — fetch a single feature
 * GET    /api/v1/degradation/features                     — list features (?tier=P0|P1|P2|P3)
 * DELETE /api/v1/degradation/features/:name               — admin unregister
 * PUT    /api/v1/degradation/features/:name/tier          — admin update tier
 * GET    /api/v1/degradation/brownout-level               — current brown-out level
 * POST   /api/v1/degradation/brownout-level               — admin set brown-out level
 * POST   /api/v1/degradation/auto-adjust                  — admin submit signals, auto-compute level
 * GET    /api/v1/degradation/disabled                     — list currently-disabled features
 * GET    /api/v1/degradation/history                      — brown-out event history
 * POST   /api/v1/degradation/features/:name/override      — admin set policy override
 * DELETE /api/v1/degradation/features/:name/override      — admin clear policy override
 */

import {
  TIERS,
  BROWNOUT_LEVELS,
  registerFeature,
  unregisterFeature,
  getFeature,
  listFeatures,
  updateFeatureTier,
  getBrownoutLevel,
  setBrownoutLevel,
  autoAdjustBrownoutLevel,
  getDisabledFeatures,
  getBrownoutHistory,
  setPolicyOverride,
  clearPolicyOverride,
} from "../lib/degradation-tiers.js";

export function mountDegradationTiersRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : (_req, _res, next) => next();

  // POST /degradation/features — admin register
  apiRoute("post", "/degradation/features", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const tier = typeof body.tier === "string" ? body.tier.trim() : "";
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `tier must be one of ${Object.keys(TIERS).join(", ")}`,
        );
      }
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      const entry = await registerFeature(name, tier, metadata);
      return res.status(201).json(entry);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /degradation/features/:name
  apiRoute("get", "/degradation/features/:name", admin, log, async (req, res) => {
    try {
      const entry = await getFeature(req.params.name);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", `feature '${req.params.name}' not found`);
      }
      return res.json(entry);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /degradation/features
  apiRoute("get", "/degradation/features", admin, log, async (req, res) => {
    try {
      const tier = typeof req.query?.tier === "string" ? req.query.tier : undefined;
      const filter = tier ? { tier } : {};
      const items = await listFeatures(filter);
      return res.json({ items, count: items.length, tiers: TIERS });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /degradation/features/:name — admin
  apiRoute("delete", "/degradation/features/:name", admin, log, async (req, res) => {
    try {
      const ok = await unregisterFeature(req.params.name);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `feature '${req.params.name}' not found`);
      return res.json({ ok: true, name: req.params.name });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /degradation/features/:name/tier — admin
  apiRoute("put", "/degradation/features/:name/tier", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const tier = typeof body.tier === "string" ? body.tier.trim() : "";
      if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `tier must be one of ${Object.keys(TIERS).join(", ")}`,
        );
      }
      const updated = await updateFeatureTier(req.params.name, tier);
      return res.json(updated);
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      const code = status === 404 ? "NOT_FOUND" : "INVALID_INPUT";
      return apiError(res, status, code, err.message);
    }
  });

  // GET /degradation/brownout-level
  apiRoute("get", "/degradation/brownout-level", admin, log, async (_req, res) => {
    try {
      const state = await getBrownoutLevel();
      return res.json({ ...state, levels: BROWNOUT_LEVELS });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /degradation/brownout-level — admin
  apiRoute("post", "/degradation/brownout-level", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const level = typeof body.level === "string" ? body.level.trim() : "";
      if (!Object.prototype.hasOwnProperty.call(BROWNOUT_LEVELS, level)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `level must be one of ${Object.keys(BROWNOUT_LEVELS).join(", ")}`,
        );
      }
      const reason = typeof body.reason === "string" ? body.reason : null;
      const state = await setBrownoutLevel(level, reason);
      return res.json(state);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /degradation/auto-adjust — admin submit signals
  apiRoute("post", "/degradation/auto-adjust", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const signals = body.signals && typeof body.signals === "object" ? body.signals : body;
      const state = await autoAdjustBrownoutLevel(signals);
      return res.json(state);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /degradation/disabled
  apiRoute("get", "/degradation/disabled", admin, log, async (_req, res) => {
    try {
      const items = await getDisabledFeatures();
      const state = await getBrownoutLevel();
      return res.json({ items, count: items.length, brownoutLevel: state.level });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /degradation/history
  apiRoute("get", "/degradation/history", admin, log, async (req, res) => {
    try {
      const since = Number(req.query?.since);
      const until = Number(req.query?.until);
      const limit = Number(req.query?.limit);
      const range = {};
      if (Number.isFinite(since)) range.since = since;
      if (Number.isFinite(until)) range.until = until;
      if (Number.isFinite(limit)) range.limit = limit;
      const history = await getBrownoutHistory(range);
      return res.json({ items: history, count: history.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /degradation/features/:name/override — admin
  apiRoute("post", "/degradation/features/:name/override", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const override = {
        forceEnabled: !!body.forceEnabled,
        forceDisabled: !!body.forceDisabled,
        reason: typeof body.reason === "string" ? body.reason : null,
      };
      if (!override.forceEnabled && !override.forceDisabled) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "override must set forceEnabled or forceDisabled to true",
        );
      }
      const entry = await setPolicyOverride(req.params.name, override);
      return res.status(201).json({ name: req.params.name, override: entry });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /degradation/features/:name/override — admin
  apiRoute("delete", "/degradation/features/:name/override", admin, log, async (req, res) => {
    try {
      const cleared = await clearPolicyOverride(req.params.name);
      return res.json({ ok: true, cleared, name: req.params.name });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountDegradationTiersRoutes;
