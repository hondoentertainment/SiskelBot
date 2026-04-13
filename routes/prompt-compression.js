/**
 * Phase 58.3: Prompt compression routes.
 *
 * POST   /api/v1/prompt-compression/compress     — compress a prompt
 * POST   /api/v1/prompt-compression/estimate     — estimate savings (dry run)
 * GET    /api/v1/prompt-compression/modes        — list modes
 */
import {
  compressPrompt,
  estimateSavings,
  COMPRESSION_MODES,
} from "../lib/prompt-compression.js";

export function mountPromptCompressionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/prompt-compression/modes", adminAuth, logRequest, async (req, res) => {
    res.json({ modes: COMPRESSION_MODES, enabled: process.env.PROMPT_COMPRESSION === "1" });
  });

  apiRoute("post", "/prompt-compression/compress", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text must be a string");
      }
      const result = compressPrompt(body.text, {
        mode: body.mode,
        targetTokens: body.targetTokens,
        keywords: body.keywords,
        force: body.force === true,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/prompt-compression/estimate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text must be a string");
      }
      const result = estimateSavings(body.text, {
        mode: body.mode,
        targetTokens: body.targetTokens,
        keywords: body.keywords,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountPromptCompressionRoutes;
