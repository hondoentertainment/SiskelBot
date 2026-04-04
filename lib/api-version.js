// API versioning utilities for v2 migration

/**
 * Register a route at /api/v2/path.
 * @param {import('express').Application} app - Express app
 * @param {string} method - HTTP method (get, post, put, delete, patch)
 * @param {string} path - Route path (e.g. "/conversations")
 * @param  {...Function} handlers - Express middleware/handlers
 */
export function apiV2Route(app, method, path, ...handlers) {
  app[method](`/api/v2${path}`, ...handlers);
}

/**
 * Middleware that adds Sunset and Deprecation headers to v1 routes.
 * @param {string} sunsetDate - ISO 8601 date string (e.g. "2027-01-01T00:00:00Z")
 * @returns {Function} Express middleware
 */
export function sunsetMiddleware(sunsetDate) {
  return (req, res, next) => {
    res.setHeader("Sunset", sunsetDate);
    res.setHeader("Deprecation", "true");
    next();
  };
}

/**
 * Detect API version from the request path.
 * @param {import('express').Request} req
 * @returns {'v1' | 'v2'}
 */
export function detectApiVersion(req) {
  if (req.path.startsWith("/api/v2/") || req.path === "/api/v2") {
    return "v2";
  }
  return "v1";
}

/**
 * Wrap response data in the appropriate format for the API version.
 * v1: data passed through unchanged.
 * v2: arrays wrapped in { items, cursor, hasMore }, objects passed through.
 * @param {*} data - Response data
 * @param {'v1' | 'v2'} version - API version
 * @param {{ cursor?: string, hasMore?: boolean }} [pagination] - Pagination info for v2 list responses
 * @returns {*} Formatted response
 */
export function formatResponse(data, version, pagination = {}) {
  if (version !== "v2") {
    return data;
  }
  if (Array.isArray(data)) {
    return {
      items: data,
      cursor: pagination.cursor || null,
      hasMore: pagination.hasMore || false,
    };
  }
  return data;
}
