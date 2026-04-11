/**
 * Phase 50.3: Hybrid TLS configuration routes. Admin-only.
 *
 *   GET  /api/v1/pq/tls/health        — aggregated PQ-readiness report
 *   GET  /api/v1/pq/tls/capabilities  — raw capability detection
 *   POST /api/v1/pq/tls/test          — connect to a TLS endpoint and
 *                                       report negotiated protocol/cipher
 */
import {
  detectPqCapabilities,
  getTlsHealthReport,
  testTlsEndpoint,
} from "../lib/pq-tls.js";

export function mountPqTlsRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, requireScope, logRequest } = deps;

  const noop = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : noop;
  const admin = typeof adminAuth === "function" ? adminAuth : noop;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/pq/tls/health
  apiRoute("get", "/pq/tls/health", log, admin, scope("admin"), async (_req, res) => {
    try {
      const report = getTlsHealthReport();
      return res.json({ _version: 1, ...report });
    } catch (err) {
      return apiError(res, 500, "PQ_TLS_ERROR", err?.message || "failed to build TLS health report");
    }
  });

  // GET /api/v1/pq/tls/capabilities
  apiRoute("get", "/pq/tls/capabilities", log, admin, scope("admin"), async (_req, res) => {
    try {
      const capabilities = detectPqCapabilities();
      return res.json({ _version: 1, capabilities });
    } catch (err) {
      return apiError(res, 500, "PQ_TLS_ERROR", err?.message || "failed to detect PQ capabilities");
    }
  });

  // POST /api/v1/pq/tls/test
  apiRoute("post", "/pq/tls/test", log, admin, scope("admin"), async (req, res) => {
    try {
      const body = req.body || {};
      const hostname = typeof body.hostname === "string" ? body.hostname.trim() : "";
      if (!hostname) {
        return apiError(res, 400, "INVALID_INPUT", "hostname is required");
      }
      const port = Number.isFinite(Number(body.port)) ? Number(body.port) : 443;
      if (port <= 0 || port > 65535) {
        return apiError(res, 400, "INVALID_INPUT", "port must be between 1 and 65535");
      }
      const timeoutMs = Number.isFinite(Number(body.timeoutMs))
        ? Math.max(100, Math.min(30000, Number(body.timeoutMs)))
        : 5000;
      const servername = typeof body.servername === "string" ? body.servername : undefined;

      const result = await testTlsEndpoint(hostname, port, { timeoutMs, servername });
      const status = result.ok ? 200 : 502;
      return res.status(status).json({ _version: 1, result });
    } catch (err) {
      return apiError(res, 500, "PQ_TLS_ERROR", err?.message || "failed to test TLS endpoint");
    }
  });
}

export default mountPqTlsRoutes;
