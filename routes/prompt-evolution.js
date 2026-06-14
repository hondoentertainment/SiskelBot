/**
 * Phase 32.2: Prompt evolution routes.
 *
 * GET  /api/v1/prompts/versions?workspace=X     — list versions
 * POST /api/v1/prompts/versions                 — save version (body: { text, metadata?, workspace? })
 * GET  /api/v1/prompts/active?workspace=X       — get active
 * PUT  /api/v1/prompts/active                   — set active (body: { versionId, workspace? })
 * POST /api/v1/prompts/generate?workspace=X&count=3 — generate candidates from feedback
 * POST /api/v1/prompts/ab-test                  — run A/B test (body: { versionIds, workspace?, minSamples? })
 * POST /api/v1/prompts/auto-promote?workspace=X — trigger auto-promotion
 */
import {
  savePromptVersion,
  listPromptVersions,
  getActivePrompt,
  setActivePrompt,
  generateCandidateVersions,
  runPromptABTest,
  autoPromotePrompts,
} from "../lib/prompt-evolution.js";

export function mountPromptEvolutionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/prompts/versions
  apiRoute("get", "/prompts/versions", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const versions = await listPromptVersions(workspace);
      res.json({ versions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/prompts/versions
  apiRoute("post", "/prompts/versions", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const text = typeof body.text === "string" ? body.text : body.promptText;
      if (typeof text !== "string" || !text.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "text is required.");
      }
      const workspace = body.workspace || req.query?.workspace || "default";
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      const record = await savePromptVersion(workspace, text, metadata);
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/prompts/active
  apiRoute("get", "/prompts/active", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const active = await getActivePrompt(workspace);
      res.json(active);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/prompts/active
  apiRoute("put", "/prompts/active", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const versionId = body.versionId || body.id;
      if (!versionId || typeof versionId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "versionId is required.");
      }
      const workspace = body.workspace || req.query?.workspace || "default";
      const result = await setActivePrompt(workspace, versionId);
      if (!result.ok) {
        return apiError(res, 404, "NOT_FOUND", result.error || "version not found");
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/prompts/generate
  apiRoute("post", "/prompts/generate", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const count = Number(req.query?.count || req.body?.count || 3);
      const candidates = await generateCandidateVersions(workspace, count);
      res.json({ candidates });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/prompts/ab-test
  apiRoute("post", "/prompts/ab-test", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const versionIds = Array.isArray(body.versionIds) ? body.versionIds : null;
      if (!versionIds || versionIds.length < 2) {
        return apiError(res, 400, "INVALID_INPUT", "versionIds must be an array with at least two ids.");
      }
      const workspace = body.workspace || req.query?.workspace || "default";
      const minSamples = Number.isFinite(body.minSamples) ? body.minSamples : 5;
      const result = await runPromptABTest(workspace, versionIds, minSamples);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/prompts/auto-promote
  apiRoute("post", "/prompts/auto-promote", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const threshold = Number.isFinite(req.body?.threshold) ? req.body.threshold : undefined;
      const minSamples = Number.isFinite(req.body?.minSamples) ? req.body.minSamples : undefined;
      const result = await autoPromotePrompts(workspace, { threshold, minSamples });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPromptEvolutionRoutes;
