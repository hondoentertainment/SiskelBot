/**
 * Phase 58.3: Prompt compression routes.
 *
 * POST /api/v1/prompt-compression/compress     -- body { text, ratio?, minSentences?, persist?, label? }
 * POST /api/v1/prompt-compression/decompress   -- body { compressed }
 * POST /api/v1/prompt-compression/rank         -- body { text }
 * GET  /api/v1/prompt-compression/history
 */
import {
  compressPrompt,
  decompressPrompt,
  computeCompressionRatio,
  rankSentences,
  listCompressionHistory,
} from "../lib/prompt-compression.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "prompt-compression error");
}

export function mountPromptCompressionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/prompt-compression/compress
  apiRoute("post", "/prompt-compression/compress", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const out = await compressPrompt(body.text, {
        ratio: Number.isFinite(body.ratio) ? Number(body.ratio) : undefined,
        minSentences: Number.isFinite(body.minSentences) ? Number(body.minSentences) : undefined,
        persist: Boolean(body.persist),
        label: typeof body.label === "string" ? body.label : undefined,
      });
      return res.status(201).json({
        _version: 1,
        compressed: out,
        compressionRatio: computeCompressionRatio(out.originalLength, out.compressedLength),
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/prompt-compression/decompress
  apiRoute("post", "/prompt-compression/decompress", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.compressed || typeof body.compressed !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "compressed payload is required");
      }
      const text = decompressPrompt(body.compressed);
      return res.json({ _version: 1, text });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/prompt-compression/rank
  apiRoute("post", "/prompt-compression/rank", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const ranked = rankSentences(body.text);
      return res.json({ _version: 1, ranked, count: ranked.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/prompt-compression/history
  apiRoute("get", "/prompt-compression/history", log, auth, scope("read"), async (_req, res) => {
    try {
      const entries = await listCompressionHistory();
      return res.json({ _version: 1, entries, count: entries.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountPromptCompressionRoutes;
