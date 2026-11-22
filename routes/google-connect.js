/**
 * Per-user Google Workspace OAuth.
 * GET    /api/v1/google/workspace/status
 * POST   /api/v1/google/workspace/connection   — store a token for the signed-in user
 * DELETE /api/v1/google/workspace/connection
 * GET    /api/v1/google/workspace/connect      — redirect to Google
 * GET    /api/v1/google/workspace/callback     — Google redirect; state binds the user
 */
import {
  googleOauthClientConfigured,
  googleConnectionStatus,
  saveUserGoogleConnection,
  deleteUserGoogleConnection,
  createConnectState,
  buildGoogleAuthorizeUrl,
  completeOauthCallback,
  userScopeId,
} from "../lib/google-user-connection.js";

function signedInUser(req) {
  const id = userScopeId(req.userId);
  return id;
}

export function mountGoogleConnectRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth } = deps;
  const auth = userAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  apiRoute("get", "/google/workspace/status", log, auth, async (req, res) => {
    try {
      const status = await googleConnectionStatus(req.userId);
      res.json(status);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/google/workspace/connection", log, auth, async (req, res) => {
    try {
      if (!signedInUser(req)) {
        return apiError(res, 401, "AUTH_REQUIRED", "Sign in before connecting Google Workspace");
      }
      const body = req.body || {};
      const saved = await saveUserGoogleConnection(req.userId, {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAt: body.expiresAt,
        email: body.email,
        scope: body.scope,
      });
      res.status(201).json(saved);
    } catch (err) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 400;
      return apiError(res, status, err.code || "INVALID_INPUT", err.message);
    }
  });

  apiRoute("delete", "/google/workspace/connection", log, auth, async (req, res) => {
    try {
      if (!signedInUser(req)) {
        return apiError(res, 401, "AUTH_REQUIRED", "Sign in before disconnecting Google Workspace");
      }
      const result = await deleteUserGoogleConnection(req.userId);
      res.json({ ok: true, deleted: Boolean(result.deleted) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/google/workspace/connect", log, auth, async (req, res) => {
    try {
      if (!signedInUser(req)) {
        return apiError(res, 401, "AUTH_REQUIRED", "Sign in before connecting Google Workspace");
      }
      if (!googleOauthClientConfigured()) {
        return apiError(
          res,
          503,
          "GOOGLE_OAUTH_NOT_CONFIGURED",
          "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect a Google account",
        );
      }
      const state = await createConnectState(req.userId);
      res.redirect(buildGoogleAuthorizeUrl(state));
    } catch (err) {
      const status = err.code === "AUTH_REQUIRED" ? 401 : 500;
      return apiError(res, status, err.code || "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/google/workspace/callback", log, async (req, res) => {
    const fail = (reason) => {
      const q = new URLSearchParams({ google: "error", reason: String(reason || "oauth_failed").slice(0, 180) });
      res.redirect(`/advice.html?${q}`);
    };
    try {
      const code = typeof req.query?.code === "string" ? req.query.code : "";
      const state = typeof req.query?.state === "string" ? req.query.state : "";
      if (!code || !state) return fail("missing_code");
      await completeOauthCallback({ code, state });
      res.redirect("/advice.html?google=connected");
    } catch (err) {
      return fail(err.code || "oauth_failed");
    }
  });
}
