/**
 * Global request timeout middleware.
 * Enforces maximum request duration and returns 504 if exceeded.
 *
 * Configuration via env:
 *   REQUEST_TIMEOUT_MS     — default 30000 (30s)
 *   STREAMING_TIMEOUT_MS   — default 300000 (5min) for streaming endpoints
 *   AGENT_MAX_WALL_MS      — if set, used for agent/swarm endpoints instead of STREAMING_TIMEOUT_MS
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30_000;
const STREAMING_TIMEOUT_MS = Number(process.env.STREAMING_TIMEOUT_MS) || 300_000;
const AGENT_MAX_WALL_MS = Number(process.env.AGENT_MAX_WALL_MS) || 0;

export { DEFAULT_TIMEOUT_MS, STREAMING_TIMEOUT_MS, AGENT_MAX_WALL_MS };

export function requestTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          error: "Request timeout",
          code: "TIMEOUT",
          hint: `Request exceeded ${timeoutMs}ms. For long-running operations, use streaming endpoints.`,
          requestId: req.requestId,
        });
      }
    }, timeoutMs);

    // Clean up timer when response finishes
    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };
}

export function streamingTimeout() {
  const ms = AGENT_MAX_WALL_MS || STREAMING_TIMEOUT_MS;
  return requestTimeout(ms);
}
