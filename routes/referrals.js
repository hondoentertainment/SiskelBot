/**
 * Phase 34.5: Referral / affiliate program routes.
 *
 * POST   /api/v1/referrals/codes            — create a new referral code
 * GET    /api/v1/referrals/codes            — list authenticated user's codes
 * DELETE /api/v1/referrals/codes/:code      — deactivate a code
 * GET    /api/v1/referrals/stats            — authenticated user's stats
 * GET    /api/v1/referrals/leaderboard      — leaderboard for a period
 * POST   /api/v1/referrals/convert          — record a conversion event (internal)
 * GET    /r/:code                           — public landing redirect
 */

import {
  createReferralCode,
  listUserReferralCodes,
  deactivateReferralCode,
  getReferralStats,
  getReferralLeaderboard,
  recordReferralConversion,
  getReferralCode,
} from "../lib/referrals.js";

export function mountReferralRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, internalAuth, logRequest } = deps;

  // POST /api/v1/referrals/codes
  apiRoute("post", "/referrals/codes", userAuth, logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) return apiError(res, 401, "AUTH_REQUIRED", "Login required to create referral codes.");
      const { name, expiresAt, maxUses } = req.body || {};
      const result = await createReferralCode(userId, {
        name: typeof name === "string" ? name : undefined,
        expiresAt: expiresAt || undefined,
        maxUses: typeof maxUses === "number" ? maxUses : undefined,
      });
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /api/v1/referrals/codes
  apiRoute("get", "/referrals/codes", userAuth, logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) return apiError(res, 401, "AUTH_REQUIRED", "Login required.");
      const codes = await listUserReferralCodes(userId);
      res.json({ codes });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/referrals/codes/:code
  apiRoute("delete", "/referrals/codes/:code", userAuth, logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) return apiError(res, 401, "AUTH_REQUIRED", "Login required.");
      const { code } = req.params || {};
      const result = await deactivateReferralCode(code, userId);
      res.json(result);
    } catch (err) {
      const msg = err.message || "Failed to deactivate";
      const status =
        msg.includes("not found") ? 404 :
        msg.includes("Not authorized") ? 403 :
        400;
      return apiError(res, status, "REFERRAL_ERROR", msg);
    }
  });

  // GET /api/v1/referrals/stats
  apiRoute("get", "/referrals/stats", userAuth, logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) return apiError(res, 401, "AUTH_REQUIRED", "Login required.");
      const stats = await getReferralStats(userId);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/referrals/leaderboard?period=30d
  apiRoute("get", "/referrals/leaderboard", logRequest, async (req, res) => {
    try {
      const period = req.query?.period || "30d";
      if (!["7d", "30d", "all"].includes(String(period))) {
        return apiError(res, 400, "INVALID_PERIOD", "period must be 7d, 30d, or all.");
      }
      const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 10));
      const board = await getReferralLeaderboard(period);
      res.json({ period, leaderboard: board.slice(0, limit) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/referrals/convert
  // Internal/webhook: record a conversion event for an existing referral.
  const convertAuth = internalAuth || userAuth;
  apiRoute("post", "/referrals/convert", convertAuth, logRequest, async (req, res) => {
    try {
      const { referralId, event, value } = req.body || {};
      if (!referralId || typeof referralId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "referralId is required.");
      }
      if (!event || typeof event !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "event is required.");
      }
      const entry = await recordReferralConversion(referralId, event, Number(value) || 0);
      res.status(201).json(entry);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /r/:code — public landing/redirect.
  // Sets a referral cookie (httpOnly false so client-side JS on r.html can also read it
  // for localStorage attribution) and redirects to the referral landing page.
  app.get("/r/:code", logRequest, async (req, res) => {
    try {
      const { code } = req.params || {};
      if (!code) {
        return res.redirect(302, "/");
      }
      const record = await getReferralCode(code);
      // Always set the cookie, even if the code is unknown — the landing page
      // will gracefully handle invalid/expired codes. This avoids leaking
      // existence of codes to scrapers.
      const maxAgeMs = 30 * 24 * 3_600_000; // 30 days
      res.cookie("siskelbot_ref", code, {
        maxAge: maxAgeMs,
        httpOnly: false,
        sameSite: "lax",
        path: "/",
      });
      res.redirect(302, `/r.html?code=${encodeURIComponent(code)}${record && record.active ? "" : "&invalid=1"}`);
    } catch (_) {
      res.redirect(302, "/");
    }
  });
}

export default mountReferralRoutes;
