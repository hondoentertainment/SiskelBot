/**
 * Authentication middleware factory for server.js.
 *
 * Each middleware is a stateful closure over API_KEY / API_KEY_PREVIOUS /
 * scopes (resolved from env) and the shared apiError / userAuth helpers.
 * server.js wires these into its Express app via createAuthMiddleware(deps).
 */
import { findDeveloperByRawKey } from "./developer-keys.js";

/**
 * @param {{
 *   API_KEY: string | undefined,
 *   API_KEY_PREVIOUS: string | null,
 *   API_KEY_SCOPES: string[],
 *   apiError: (res: object, status: number, code: string, message: string, hint?: string) => unknown,
 *   userAuth: (req: object, res: object, next: Function) => unknown,
 *   isAuthConfigured: () => boolean,
 *   isQuotaAdmin: (userId: string) => boolean,
 * }} deps
 */
export function createAuthMiddleware(deps) {
  const { API_KEY, API_KEY_PREVIOUS, API_KEY_SCOPES, apiError, userAuth, isAuthConfigured, isQuotaAdmin } = deps;

  function apiKeyAuth(req, res, next) {
    if (!API_KEY) return next();
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const xKey = req.headers["x-api-key"];
    const key = bearer || xKey;
    const matchesCurrent = key && key === API_KEY;
    const matchesPrevious = !matchesCurrent && API_KEY_PREVIOUS && key === API_KEY_PREVIOUS;
    if (!key || (!matchesCurrent && !matchesPrevious)) {
      return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key> or x-api-key header.");
    }
    if (matchesPrevious) {
      res.setHeader("X-API-Key-Deprecated", "true");
      console.warn("[auth] Request authenticated with API_KEY_PREVIOUS. Rotate clients to new key.");
    }
    req.authenticatedViaDeploymentKey = true;
    req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
    req.apiKeyId = "deployment";
    next();
  }

  function chatAuth(req, res, next) {
    if (!API_KEY) return userAuth(req, res, next);
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
    const xApiKey = req.headers["x-api-key"];
    const xUserKey = req.headers["x-user-api-key"];
    const key = xApiKey || xUserKey || bearer;
    if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key>, x-api-key, or x-user-api-key header.");
    if (key === API_KEY || (API_KEY_PREVIOUS && key === API_KEY_PREVIOUS)) {
      req.authenticatedViaDeploymentKey = true;
      req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
      req.apiKeyId = "deployment";
      req.userId = "anonymous";
      if (API_KEY_PREVIOUS && key === API_KEY_PREVIOUS) {
        res.setHeader("X-API-Key-Deprecated", "true");
        console.warn("[auth] Request authenticated with API_KEY_PREVIOUS. Rotate clients to new key.");
      }
      return next();
    }
    return userAuth(req, res, next);
  }

  function evalAuth(req, res, next) {
    const adminKey = process.env.ADMIN_API_KEY;
    const apiKey = API_KEY;
    if (!adminKey && !apiKey) return next();
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
    const xKey = req.headers["x-api-key"] || req.headers["x-admin-api-key"];
    const key = bearer || xKey;
    if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Eval endpoints require ADMIN_API_KEY or API_KEY", "Use Authorization: Bearer <key> or x-api-key header.");
    const adminKeyPrev = process.env.ADMIN_API_KEY_PREVIOUS;
    const apiKeyPrev = API_KEY_PREVIOUS;
    if ((adminKey && key === adminKey) || (apiKey && key === apiKey)) return next();
    if ((adminKeyPrev && key === adminKeyPrev) || (apiKeyPrev && key === apiKeyPrev)) {
      console.warn("[auth] Eval request authenticated with previous key. Rotate clients to new key.");
      return next();
    }
    return apiError(res, 401, "AUTH_REQUIRED", "Invalid key", "Use ADMIN_API_KEY or API_KEY.");
  }

  function backupAdminAuth(req, res, next) {
    const adminKey = process.env.ADMIN_API_KEY || process.env.BACKUP_ADMIN_KEY;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
    const xKey = req.headers["x-api-key"] || req.headers["x-backup-admin-key"];
    const key = bearer || xKey;
    if (adminKey && key && key === adminKey) return next();
    if (adminKey && !key) return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
    if (!isAuthConfigured() && !adminKey) return next();
    userAuth(req, res, () => {
      if (req.userId && isQuotaAdmin(req.userId)) return next();
      return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
    });
  }

  async function resolveDeveloperKey(req) {
    if (req.developerKeyId !== undefined) return;
    req.developerKeyId = null;
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : null;
    const xKey = req.headers["x-api-key"];
    const candidate = bearer || xKey;
    if (!candidate || typeof candidate !== "string" || !candidate.startsWith("skdev-")) return;
    try {
      const info = await findDeveloperByRawKey(candidate);
      if (info) {
        req.developerKeyId = info.keyId;
        req.developerId = info.developerId;
        req.developerTier = info.tier;
      }
    } catch (_) { /* ignore */ }
  }

  return { apiKeyAuth, chatAuth, evalAuth, backupAdminAuth, resolveDeveloperKey };
}
