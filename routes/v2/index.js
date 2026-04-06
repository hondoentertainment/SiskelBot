// API v2 route index — mounts all v2 route modules.
import { mountV2ConversationRoutes } from "./conversations.js";
import { mountV2DocumentRoutes } from "./documents.js";
import { mountV2RecipeRoutes } from "./recipes.js";
import { mountV2WorkspaceRoutes } from "./workspaces.js";

const v2Mounts = [
  mountV2ConversationRoutes,
  mountV2DocumentRoutes,
  mountV2RecipeRoutes,
  mountV2WorkspaceRoutes,
];

/**
 * Middleware that adds standard RateLimit-* headers to v2 responses.
 */
function createV2RateHeaders() {
  return (req, res, next) => {
    const limit = 100;
    const remaining = Math.max(0, limit - (req.rateLimit?.current || 0));
    const resetTime = req.rateLimit?.resetTime
      ? Math.ceil(req.rateLimit.resetTime.getTime() / 1000)
      : Math.ceil(Date.now() / 1000) + 60;
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetTime));
    next();
  };
}

/**
 * Mount all v2 route modules on the Express app.
 * @param {import("express").Express} app
 * @param {object} deps - Shared middleware, helpers, config, and lib imports
 */
export function mountV2Routes(app, deps) {
  // Create v2-specific middleware and inject into deps
  const v2Deps = {
    ...deps,
    v2BearerAuth: createV2BearerAuthMiddleware(deps),
    v2RateHeaders: createV2RateHeaders(),
  };

  for (const mount of v2Mounts) {
    mount(app, v2Deps);
  }
}

/**
 * v2 Bearer-only auth middleware factory.
 * Rejects x-api-key; passes through to downstream auth for Bearer tokens.
 */
function createV2BearerAuthMiddleware(deps) {
  return (req, res, next) => {
    if (req.headers["x-api-key"]) {
      const requestId = req.requestId || "unknown";
      return res.status(401).json({
        error: {
          code: "INVALID_AUTH",
          message: "v2 endpoints require Authorization: Bearer token, x-api-key is not supported",
          details: null,
          requestId,
        },
      });
    }
    // Delegate to existing userAuth downstream for Bearer token validation
    next();
  };
}
