/**
 * Phase 72.2: Model card generator routes.
 */
import {
  generateCard,
  updateCardField,
  getCard,
  listCards,
  exportCardMarkdown,
} from "../lib/model-card-generator.js";

export function mountModelCardRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/model-cards", adminAuth, logRequest, async (req, res) => {
    try {
      const { modelId, metadata } = req.body || {};
      if (!modelId) return apiError(res, 400, "INVALID_INPUT", "modelId is required");
      const card = await generateCard({ modelId, metadata });
      res.status(201).json(card);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/model-cards", adminAuth, logRequest, async (req, res) => {
    try {
      const cards = await listCards();
      res.json({ cards });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/model-cards/:modelId", adminAuth, logRequest, async (req, res) => {
    try {
      const card = await getCard(req.params?.modelId);
      if (!card) return apiError(res, 404, "NOT_FOUND", "model card not found");
      res.json(card);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("patch", "/model-cards/:modelId", adminAuth, logRequest, async (req, res) => {
    try {
      const { field, value } = req.body || {};
      if (!field) return apiError(res, 400, "INVALID_INPUT", "field is required");
      const card = await updateCardField({ modelId: req.params?.modelId, field, value });
      res.json(card);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/model-cards/:modelId/markdown", adminAuth, logRequest, async (req, res) => {
    try {
      const md = await exportCardMarkdown(req.params?.modelId);
      if (md == null) return apiError(res, 404, "NOT_FOUND", "model card not found");
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      return res.send(md);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountModelCardRoutes;
