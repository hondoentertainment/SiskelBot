/**
 * Phase 61.4: Local dev environment routes.
 *
 * Admin-only AND dev-only (NODE_ENV !== "production"). Intended for local
 * workflows — never expose these endpoints in a production deployment.
 *
 * POST /api/v1/dev/setup    — body: { seed, options }
 * GET  /api/v1/dev/status
 * POST /api/v1/dev/verify
 * POST /api/v1/dev/reset    — body: { confirm }
 * GET  /api/v1/dev/seeds
 */

import {
  SEED_TEMPLATES,
  runSetup,
  getDevStatus,
  verifyEnvironment,
  resetDevEnvironment,
} from "../lib/dev-setup.js";

export function mountDevSetupRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, requireScope } = deps;

  // Dev-only guard
  function devOnly(req, res, next) {
    if (process.env.NODE_ENV === "production") {
      return apiError(
        res,
        403,
        "DEV_ONLY",
        "Dev setup endpoints are disabled in production.",
      );
    }
    next();
  }

  // GET /api/v1/dev/seeds
  apiRoute(
    "get",
    "/dev/seeds",
    devOnly,
    adminAuth,
    requireScope("admin"),
    logRequest,
    (_req, res) => {
      try {
        const seeds = Object.entries(SEED_TEMPLATES).map(([name, meta]) => ({
          name,
          description: meta.description,
          users: meta.users ?? 0,
          workspaces: meta.workspaces ?? 0,
          apiKeys: meta.apiKeys ?? 0,
          conversations: meta.conversations ?? 0,
          plugins: Boolean(meta.plugins),
        }));
        res.json({ _version: 1, seeds });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list seeds.");
      }
    },
  );

  // GET /api/v1/dev/status
  apiRoute(
    "get",
    "/dev/status",
    devOnly,
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const status = await getDevStatus({
          storagePath: typeof req.query?.storagePath === "string" ? req.query.storagePath : undefined,
          envPath: typeof req.query?.envPath === "string" ? req.query.envPath : undefined,
        });
        res.json({ _version: 1, ...status });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to get dev status.");
      }
    },
  );

  // POST /api/v1/dev/setup
  apiRoute(
    "post",
    "/dev/setup",
    devOnly,
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const seed = typeof body.seed === "string" ? body.seed : "minimal";
        if (!SEED_TEMPLATES[seed]) {
          return apiError(
            res,
            400,
            "INVALID_SEED",
            `Unknown seed '${seed}'.`,
            `Valid: ${Object.keys(SEED_TEMPLATES).join(", ")}`,
          );
        }
        const opts = body.options && typeof body.options === "object" ? body.options : {};
        const result = await runSetup({
          seed,
          force: Boolean(opts.force),
          writeEnv: opts.writeEnv !== false,
          storagePath: typeof opts.storagePath === "string" ? opts.storagePath : undefined,
          envPath: typeof opts.envPath === "string" ? opts.envPath : undefined,
        });
        // Never leak raw API keys over the wire
        if (result?.data?.apiKeys) {
          result.data.apiKeys = result.data.apiKeys.map((k) => ({
            id: k.id,
            userId: k.userId,
            scopes: k.scopes,
            masked: k.masked,
          }));
        }
        res.json({ _version: 1, ...result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "runSetup failed.");
      }
    },
  );

  // POST /api/v1/dev/verify
  apiRoute(
    "post",
    "/dev/verify",
    devOnly,
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const result = await verifyEnvironment({
          storagePath: typeof body.storagePath === "string" ? body.storagePath : undefined,
          port: Number.isFinite(Number(body.port)) ? Number(body.port) : undefined,
        });
        res.json({ _version: 1, ...result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "verifyEnvironment failed.");
      }
    },
  );

  // POST /api/v1/dev/reset
  apiRoute(
    "post",
    "/dev/reset",
    devOnly,
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!body.confirm) {
          return apiError(
            res,
            400,
            "CONFIRM_REQUIRED",
            "Reset requires { confirm: true }.",
          );
        }
        const result = await resetDevEnvironment({
          confirm: true,
          storagePath: typeof body.storagePath === "string" ? body.storagePath : undefined,
          envPath: typeof body.envPath === "string" ? body.envPath : undefined,
        });
        if (!result.ok) {
          return apiError(res, 500, "RESET_FAILED", result.error || "reset failed");
        }
        res.json({ _version: 1, ...result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "resetDevEnvironment failed.");
      }
    },
  );
}

export default mountDevSetupRoutes;
