/**
 * Phase 62.1: Intent classifier routes.
 *
 * POST   /api/v1/intents             — train (create/update) an intent
 * GET    /api/v1/intents             — list intents
 * GET    /api/v1/intents/:name       — get one intent
 * DELETE /api/v1/intents/:name       — delete intent
 * POST   /api/v1/intents/classify    — classify a text
 */
import {
  trainIntent,
  getIntent,
  listIntents,
  deleteIntent,
  classifyIntent,
} from "../lib/intent-classifier.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountIntentClassifierRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /intents
  apiRoute("post", "/intents", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await trainIntent({
        name: body.name,
        keywords: body.keywords,
        examples: body.examples,
        description: body.description,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /intents
  apiRoute("get", "/intents", adminAuth, logRequest, async (_req, res) => {
    try {
      const intents = await listIntents();
      res.json({ intents });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /intents/:name
  apiRoute("get", "/intents/:name", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getIntent(req.params.name);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "intent not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /intents/:name
  apiRoute("delete", "/intents/:name", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteIntent(req.params.name);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "intent not found");
      res.json({ deleted: true, name: req.params.name });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /intents/classify
  apiRoute("post", "/intents/classify", adminAuth, logRequest, async (req, res) => {
    try {
      const { text, useEmbeddings } = req.body || {};
      if (!text || typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const result = await classifyIntent(text, { useEmbeddings });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountIntentClassifierRoutes;
