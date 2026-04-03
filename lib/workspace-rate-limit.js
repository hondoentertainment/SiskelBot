/**
 * Per-workspace rate limiting middleware.
 * Uses a sliding window counter stored in memory (or Postgres if available).
 * Configurable via WORKSPACE_RATE_LIMIT_WINDOW_MS and WORKSPACE_RATE_LIMIT_MAX env vars.
 */

const WINDOW_MS = parseInt(process.env.WORKSPACE_RATE_LIMIT_WINDOW_MS, 10) || 60_000;
const DEFAULT_MAX = parseInt(process.env.WORKSPACE_RATE_LIMIT_MAX, 10) || 300;

/**
 * Per-workspace request timestamps for sliding window.
 * Map<workspaceId, number[]> — sorted array of request timestamps.
 */
const windowStore = new Map();

/**
 * Per-workspace max overrides set via admin API.
 * Map<workspaceId, number>
 */
const overrides = new Map();

/**
 * Prune timestamps older than windowMs from the array (in-place).
 * Returns the pruned array.
 */
function pruneWindow(timestamps, now, windowMs) {
  const cutoff = now - windowMs;
  // Binary search for the first element >= cutoff
  let lo = 0;
  let hi = timestamps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) timestamps.splice(0, lo);
  return timestamps;
}

/**
 * Record a request and return { allowed, limit, remaining, resetEpochSeconds }.
 */
function checkWorkspaceRate(workspaceId) {
  const now = Date.now();
  const max = overrides.get(workspaceId) ?? DEFAULT_MAX;

  let timestamps = windowStore.get(workspaceId);
  if (!timestamps) {
    timestamps = [];
    windowStore.set(workspaceId, timestamps);
  }

  pruneWindow(timestamps, now, WINDOW_MS);

  const remaining = Math.max(0, max - timestamps.length);
  // Reset time = earliest request in window + windowMs, or now + windowMs if empty
  const resetMs = timestamps.length > 0 ? timestamps[0] + WINDOW_MS : now + WINDOW_MS;
  const resetEpochSeconds = Math.ceil(resetMs / 1000);

  if (timestamps.length >= max) {
    return { allowed: false, limit: max, remaining: 0, resetEpochSeconds };
  }

  timestamps.push(now);
  return { allowed: true, limit: max, remaining: remaining - 1, resetEpochSeconds };
}

/**
 * Extract workspaceId from the request. Looks at req.params.id (route param)
 * or req.query.workspace or req.body?.workspace.
 */
function extractWorkspaceId(req) {
  return req.params?.id || req.query?.workspace || req.body?.workspace || null;
}

/**
 * Express middleware factory for per-workspace rate limiting.
 */
export function workspaceRateLimiter() {
  return (req, res, next) => {
    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      // No workspace context — skip workspace rate limiting
      return next();
    }

    const result = checkWorkspaceRate(workspaceId);

    // Always set rate limit headers
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.remaining)));
    res.setHeader("X-RateLimit-Reset", String(result.resetEpochSeconds));

    if (!result.allowed) {
      res.status(429).json({
        error: {
          code: "WORKSPACE_RATE_LIMIT",
          message: `Workspace rate limit exceeded. Try again after ${new Date(result.resetEpochSeconds * 1000).toISOString()}.`,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Get current rate limit status for a workspace (admin introspection).
 */
export function getWorkspaceRateLimitStatus(workspaceId) {
  const now = Date.now();
  const max = overrides.get(workspaceId) ?? DEFAULT_MAX;
  let timestamps = windowStore.get(workspaceId);
  if (!timestamps) {
    return { workspaceId, limit: max, used: 0, remaining: max, resetEpochSeconds: Math.ceil((now + WINDOW_MS) / 1000) };
  }
  pruneWindow(timestamps, now, WINDOW_MS);
  const used = timestamps.length;
  const remaining = Math.max(0, max - used);
  const resetMs = timestamps.length > 0 ? timestamps[0] + WINDOW_MS : now + WINDOW_MS;
  return {
    workspaceId,
    limit: max,
    used,
    remaining,
    resetEpochSeconds: Math.ceil(resetMs / 1000),
  };
}

/**
 * Set per-workspace rate limit override (admin API).
 */
export function setWorkspaceRateLimit(workspaceId, max) {
  if (typeof max !== "number" || max < 1) {
    throw new Error("max must be a positive integer");
  }
  overrides.set(workspaceId, Math.floor(max));
}

/**
 * Clear all state — for testing only.
 */
export function _resetForTesting() {
  windowStore.clear();
  overrides.clear();
}
