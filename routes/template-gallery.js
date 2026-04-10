/**
 * Phase 34.2: Template Gallery routes — public, ratable, shareable workspace templates.
 *
 * Endpoints:
 *   GET    /api/v1/gallery/templates                       — list with filters
 *   GET    /api/v1/gallery/templates/search?q=...          — search
 *   GET    /api/v1/gallery/stats                           — aggregate stats
 *   GET    /api/v1/gallery/templates/:galleryId            — single template detail
 *   POST   /api/v1/gallery/templates                       — publish a template
 *   DELETE /api/v1/gallery/templates/:galleryId            — unpublish (publisher only)
 *   POST   /api/v1/gallery/templates/:galleryId/install    — install to a workspace
 *   POST   /api/v1/gallery/templates/:galleryId/rate       — submit a rating
 *   GET    /api/v1/gallery/templates/:galleryId/ratings    — fetch ratings
 */
import {
  publishTemplate,
  unpublishTemplate,
  getGalleryTemplate,
  listGalleryTemplates,
  searchGalleryTemplates,
  installFromGallery,
  rateTemplate,
  getRatings,
  getGalleryStats,
} from "../lib/template-gallery.js";

export function mountTemplateGalleryRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    storageRateLimiter,
    sanitizeWorkspace,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/gallery/templates — list with filters
  apiRoute("get", "/gallery/templates", limiter, async (req, res) => {
    try {
      const category = req.query?.category ? String(req.query.category) : undefined;
      const tag = req.query?.tag ? String(req.query.tag) : undefined;
      const sortBy = req.query?.sortBy ? String(req.query.sortBy) : undefined;
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const offset = req.query?.offset ? Number(req.query.offset) : undefined;
      const result = await listGalleryTemplates({ category, tag, sortBy, limit, offset });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/gallery/templates/search — search
  apiRoute("get", "/gallery/templates/search", limiter, async (req, res) => {
    try {
      const q = req.query?.q ? String(req.query.q) : "";
      const sortBy = req.query?.sortBy ? String(req.query.sortBy) : undefined;
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const offset = req.query?.offset ? Number(req.query.offset) : undefined;
      const result = await searchGalleryTemplates(q, { sortBy, limit, offset });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/gallery/stats — aggregate stats
  apiRoute("get", "/gallery/stats", limiter, async (req, res) => {
    try {
      const stats = await getGalleryStats();
      res.json({ _version: 1, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/gallery/templates/:galleryId — single template
  apiRoute("get", "/gallery/templates/:galleryId", limiter, async (req, res) => {
    try {
      const entry = await getGalleryTemplate(req.params.galleryId);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      res.json(entry);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/gallery/templates — publish
  apiRoute("post", "/gallery/templates", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const body = req.body || {};
      const workspaceId = body.workspaceId ? sanitizeWorkspace(body.workspaceId) : null;
      const templateData = {
        name: body.name,
        description: body.description,
        category: body.category,
        tags: body.tags,
        content: body.content,
      };
      const publisher = {
        userId,
        displayName: body.displayName || userId,
      };
      if (!templateData.name || typeof templateData.name !== "string" || !templateData.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required", "Send { name, description?, category?, tags?, content }.");
      }
      const result = await publishTemplate(workspaceId, templateData, publisher);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // DELETE /api/v1/gallery/templates/:galleryId — unpublish (publisher only)
  apiRoute("delete", "/gallery/templates/:galleryId", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const result = await unpublishTemplate(req.params.galleryId, userId);
      if (!result.ok) {
        if (result.error === "not found") {
          return apiError(res, 404, "NOT_FOUND", "Template not found", null);
        }
        if (result.error === "forbidden") {
          return apiError(res, 403, "FORBIDDEN", "Only the publisher may unpublish this template", null);
        }
        return apiError(res, 400, "INVALID_INPUT", result.error || "unable to unpublish");
      }
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/gallery/templates/:galleryId/install — install to workspace
  apiRoute("post", "/gallery/templates/:galleryId/install", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const targetWorkspaceId = sanitizeWorkspace(req.body?.workspaceId);
      if (!targetWorkspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      }
      const result = await installFromGallery(req.params.galleryId, targetWorkspaceId, userId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (err.message === "template not found") {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      if (/required|invalid/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/gallery/templates/:galleryId/rate — submit a rating
  apiRoute("post", "/gallery/templates/:galleryId/rate", limiter, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const rating = Number(req.body?.rating);
      const review = typeof req.body?.review === "string" ? req.body.review : "";
      const result = await rateTemplate(req.params.galleryId, userId, rating, review);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (err.message === "template not found") {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      if (/rating must be|required|invalid/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/gallery/templates/:galleryId/ratings — fetch ratings
  apiRoute("get", "/gallery/templates/:galleryId/ratings", limiter, async (req, res) => {
    try {
      const result = await getRatings(req.params.galleryId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountTemplateGalleryRoutes;
