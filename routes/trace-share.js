/**
 * Trace-share routes.
 *
 * Admins can mint a signed, TTL-bound share URL for a trace. The public
 * GET endpoint is unauthenticated but rate-limited by IP (60 req / 5 min).
 * All trace data returned is anonymized + scrubbed by
 * lib/trace-share-store.js.
 *
 * Public URL format: `/trace-share.html?t=<token>`.
 *
 * NOTE: `req.ip` is only trustworthy when Express `trust proxy` is
 * configured. In the default setup the rate limiter effectively groups
 * all proxied requests under the proxy's IP.
 */

import {
  signShareToken,
  verifyShareToken,
  loadAnonymizedTrace,
  shouldRateLimitCreate,
  listMyTokens,
  revokeToken,
} from "../lib/trace-share-store.js";

const MAX_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const DEFAULT_TTL_SEC = 24 * 60 * 60; // 1 day

const PUBLIC_READ_WINDOW_MS = 5 * 60 * 1000;
const PUBLIC_READ_MAX = 60;

/** @type {Map<string, number[]>} */
const publicReadHits = new Map();

function publicRateLimit(ip) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const cutoff = now - PUBLIC_READ_WINDOW_MS;
  const arr = (publicReadHits.get(key) || []).filter((t) => t >= cutoff);
  arr.push(now);
  publicReadHits.set(key, arr);
  return arr.length > PUBLIC_READ_MAX;
}

function getIp(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown");
}

export default function mountTraceShareRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope } = deps;

  /** POST /api/admin/trace-share — create a new share token. Admin-authed. */
  app.post(
    "/api/admin/trace-share",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const runId = typeof body.runId === "string" ? body.runId.trim() : "";
        const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
        if (!runId) return apiError(res, 400, "INVALID_RUN_ID", "runId is required");
        if (!workspace) return apiError(res, 400, "INVALID_WORKSPACE", "workspace is required");

        let ttlSec = Number(body.ttlSec);
        if (!Number.isFinite(ttlSec) || ttlSec <= 0) ttlSec = DEFAULT_TTL_SEC;
        if (ttlSec > MAX_TTL_SEC) {
          return apiError(res, 400, "TTL_TOO_LARGE", "ttlSec exceeds maximum of 30 days (2592000)");
        }

        const redactFields = Array.isArray(body.redactFields)
          ? body.redactFields.filter((x) => typeof x === "string")
          : undefined;

        const ip = getIp(req);
        if (shouldRateLimitCreate(ip)) {
          return apiError(res, 429, "RATE_LIMITED", "Too many share tokens created. Slow down.");
        }

        const createdBy =
          (req.user && (req.user.id || req.user.userId || req.user.email)) ||
          (req.admin && req.admin.id) ||
          (typeof body.createdBy === "string" && body.createdBy) ||
          "admin";

        const expiresAt = Date.now() + Math.floor(ttlSec * 1000);
        const token = signShareToken({
          runId,
          workspace,
          expiresAt,
          createdBy: String(createdBy),
          ...(redactFields && redactFields.length ? { redactFields } : {}),
        });

        return res.json({
          token,
          shareUrl: `/trace-share.html?t=${encodeURIComponent(token)}`,
          expiresAt,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/trace-share/:token — PUBLIC viewer. Rate limited by IP. */
  app.get("/api/trace-share/:token", logRequest, async (req, res) => {
    try {
      const ip = getIp(req);
      if (publicRateLimit(ip)) {
        return apiError(res, 429, "RATE_LIMITED", "Too many trace-share requests. Try again later.");
      }
      const token = String(req.params?.token || "");
      const payload = verifyShareToken(token);
      if (!payload) {
        return apiError(res, 404, "NOT_FOUND", "Trace unavailable or expired");
      }
      const trace = await loadAnonymizedTrace(payload);
      if (!trace) {
        return apiError(res, 404, "NOT_FOUND", "Trace unavailable or expired");
      }
      return res.json(trace);
    } catch (err) {
      return apiError(res, 500, "INTERNAL", String(err?.message || err));
    }
  });

  /** POST /api/admin/trace-share/:token/revoke — admin revoke. */
  app.post(
    "/api/admin/trace-share/:token/revoke",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const token = String(req.params?.token || "");
        if (!token) return apiError(res, 400, "INVALID_TOKEN", "token is required");
        revokeToken(token);
        return res.json({ ok: true });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/trace-share/mine?createdBy=admin — list active tokens. */
  app.get(
    "/api/admin/trace-share/mine",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const createdBy =
          (typeof req.query?.createdBy === "string" && req.query.createdBy) ||
          (req.user && (req.user.id || req.user.userId || req.user.email)) ||
          "admin";
        const tokens = listMyTokens(String(createdBy));
        return res.json({ createdBy: String(createdBy), tokens });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
