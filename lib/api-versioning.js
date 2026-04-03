/**
 * API version negotiation and response serialization.
 * Ensures v1 clients get stable response schemas even as internal models evolve.
 */

/** @typedef {'v1' | 'v2'} ApiVersion */

/**
 * Schema registry: define response shapes per version per endpoint.
 * Each entry lists the allowed top-level field names for that endpoint.
 */
const RESPONSE_SCHEMAS = {
  v1: {
    "chat.completion": [
      "id", "object", "created", "model", "choices", "usage",
    ],
    "workspace.list": [
      "workspaces",
    ],
    "workspace.detail": [
      "id", "name", "createdAt", "updatedAt", "settings",
    ],
    "usage.summary": [
      "totalTokens", "totalRequests", "windowStart", "windowEnd",
    ],
    "error": [
      "error", "code", "hint",
    ],
  },
  v2: {
    "chat.completion": [
      "id", "object", "created", "model", "choices", "usage",
      "serverTiming", "traceId", "cached",
    ],
    "workspace.list": [
      "workspaces", "total", "cursor",
    ],
    "workspace.detail": [
      "id", "name", "createdAt", "updatedAt", "settings", "members", "quotaUsage",
    ],
    "usage.summary": [
      "totalTokens", "totalRequests", "windowStart", "windowEnd",
      "byModel", "byWorkspace",
    ],
    "error": [
      "error", "code", "hint", "traceId", "retryAfter",
    ],
  },
};

/**
 * Version changelog for OpenAPI spec generation.
 */
export const VERSION_CHANGELOG = {
  v1: {
    released: "2025-01-01",
    status: "stable",
    description: "Initial stable API version.",
  },
  v2: {
    released: "2026-03-01",
    status: "current",
    description: "Adds pagination cursors, per-model usage breakdown, trace IDs in errors, and new workspace detail fields.",
    addedFields: {
      "chat.completion": ["serverTiming", "traceId", "cached"],
      "workspace.list": ["total", "cursor"],
      "workspace.detail": ["members", "quotaUsage"],
      "usage.summary": ["byModel", "byWorkspace"],
      "error": ["traceId", "retryAfter"],
    },
  },
};

/**
 * Default sunset date for deprecated (legacy non-versioned) API paths.
 * Configurable via API_SUNSET_DATE env var (ISO 8601 date string).
 */
function getSunsetDate() {
  return process.env.API_SUNSET_DATE || "2026-12-31";
}

/**
 * Middleware that detects API version from path prefix or Accept header.
 * Sets req.apiVersion = 'v1' | 'v2'.
 *
 * Detection order:
 *   1. URL path prefix: /api/v2/ -> 'v2', /api/v1/ -> 'v1'
 *   2. Accept header: application/vnd.siskelbot.v2+json -> 'v2'
 *   3. Default: 'v1'
 */
export function versionDetection() {
  return (req, _res, next) => {
    // 1. Path-based detection
    if (req.path.startsWith("/api/v2/") || req.path === "/api/v2") {
      req.apiVersion = "v2";
    } else if (req.path.startsWith("/api/v1/") || req.path === "/api/v1") {
      req.apiVersion = "v1";
    } else {
      // 2. Accept header detection
      const accept = req.headers.accept || "";
      const vendorMatch = accept.match(/application\/vnd\.siskelbot\.v(\d+)\+json/);
      if (vendorMatch) {
        const ver = `v${vendorMatch[1]}`;
        req.apiVersion = (ver === "v1" || ver === "v2") ? ver : "v1";
      } else {
        // 3. Default
        req.apiVersion = "v1";
      }
    }
    next();
  };
}

/**
 * Filter response object to only include fields defined in the version schema.
 * If no schema is registered for the given key/version, returns data unmodified.
 *
 * @param {object} data - The response data object
 * @param {string} schemaKey - Key in RESPONSE_SCHEMAS (e.g. 'chat.completion')
 * @param {ApiVersion} version - 'v1' | 'v2'
 * @returns {object} Filtered data
 */
export function filterByVersion(data, schemaKey, version) {
  const schema = RESPONSE_SCHEMAS[version];
  if (!schema) return data;
  const allowedFields = schema[schemaKey];
  if (!allowedFields) return data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const filtered = {};
  for (const field of allowedFields) {
    if (field in data) {
      filtered[field] = data[field];
    }
  }
  return filtered;
}

/**
 * Response wrapper that serializes responses according to the requested API version.
 * v1 responses are frozen to the current schema.
 * v2 responses can include new fields.
 *
 * Sets appropriate version headers:
 *   - X-API-Version: the version used
 *   - Sunset: on legacy/deprecated paths
 *
 * @param {object} res - Express response object
 * @param {object} data - The response payload
 * @param {object} [options]
 * @param {string} [options.schemaKey] - Schema key for field filtering
 * @param {ApiVersion} [options.version] - Override version (defaults to req.apiVersion)
 * @param {boolean} [options.deprecated] - Whether this path is deprecated
 */
export function versionedResponse(res, data, options = {}) {
  const req = res.req;
  const version = options.version || req?.apiVersion || "v1";

  res.setHeader("X-API-Version", version);

  // Set Sunset header for deprecated paths
  if (options.deprecated) {
    res.setHeader("Sunset", getSunsetDate());
  }

  // Filter if schema key provided
  let payload = data;
  if (options.schemaKey) {
    payload = filterByVersion(data, options.schemaKey, version);
  }

  return res.json(payload);
}

export { RESPONSE_SCHEMAS };
