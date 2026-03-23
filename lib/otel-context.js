/**
 * Phase 69: Request-scoped trace attributes (workspace, hashed user id) for OpenTelemetry.
 * Uses the HTTP server span captured when middleware runs (safe on res.finish).
 */
import { createHash } from "crypto";
import { trace } from "@opentelemetry/api";

/**
 * SHA-256 prefix of userId for traces (no raw PII).
 * @param {string | undefined} userId
 * @returns {string | undefined}
 */
export function hashUserIdForTrace(userId) {
  if (!userId || typeof userId !== "string") return undefined;
  const t = userId.trim();
  if (!t || t === "anonymous") return undefined;
  return createHash("sha256").update(t, "utf8").digest("hex").slice(0, 16);
}

/**
 * Best-effort workspace id from query, JSON body, or agent options.
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
export function extractWorkspaceIdFromRequest(req) {
  try {
    const q = req.query?.workspace;
    if (q != null && String(q).trim()) return String(q).trim().slice(0, 64);
    const b = req.body;
    if (b && typeof b === "object") {
      if (b.agentOptions && typeof b.agentOptions.workspace === "string" && b.agentOptions.workspace.trim()) {
        return b.agentOptions.workspace.trim().slice(0, 64);
      }
      if (typeof b.workspace === "string" && b.workspace.trim()) {
        return b.workspace.trim().slice(0, 64);
      }
    }
  } catch (_) {}
  return undefined;
}

/**
 * Express middleware: on response finish, enrich the **current request** HTTP span
 * (reference captured at middleware entry) with low-cardinality attributes.
 */
export function otelHttpEnrichmentMiddleware() {
  return (req, res, next) => {
    if (process.env.OTEL_ENABLED !== "1") return next();

    const span = trace.getActiveSpan();
    if (!span) return next();

    let enriched = false;
    const onFinish = () => {
      if (enriched) return;
      enriched = true;
      try {
        if (typeof span.isRecording === "function" && !span.isRecording()) return;
        const h = hashUserIdForTrace(req.userId);
        if (h) span.setAttribute("siskel.user_id_hash", h);
        const ws = extractWorkspaceIdFromRequest(req);
        if (ws) span.setAttribute("siskel.workspace_id", ws);
      } catch (_) {}
    };

    res.on("finish", onFinish);
    res.on("close", onFinish);
    next();
  };
}
