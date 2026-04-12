/**
 * Phase 62.3: Response drafter routes.
 *
 * POST /api/v1/response-drafts          — draft and persist
 * POST /api/v1/response-drafts/preview  — preview without persisting
 * GET  /api/v1/response-drafts          — list recent drafts
 * GET  /api/v1/response-drafts/:id      — fetch a draft
 * GET  /api/v1/response-drafts/tones    — list tones
 */
import {
  draftResponse,
  previewDraft,
  listTones,
  listDrafts,
  getDraft,
} from "../lib/response-drafter.js";

function mapErr(err) {
  if (err?.code === "INVALID_TONE") return { status: 400, code: "INVALID_TONE" };
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountResponseDrafterRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /response-drafts/tones (register before :id so it doesn't get captured)
  apiRoute("get", "/response-drafts/tones", adminAuth, logRequest, async (_req, res) => {
    try {
      res.json({ tones: listTones() });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /response-drafts
  apiRoute("post", "/response-drafts", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const draft = await draftResponse({
        tone: body.tone,
        subject: body.subject,
        body: body.body,
        context: body.context,
        ticketId: body.ticketId,
      });
      res.status(201).json(draft);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /response-drafts/preview
  apiRoute("post", "/response-drafts/preview", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const preview = await previewDraft({
        tone: body.tone,
        subject: body.subject,
        body: body.body,
        context: body.context,
      });
      res.json(preview);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /response-drafts
  apiRoute("get", "/response-drafts", adminAuth, logRequest, async (req, res) => {
    try {
      const drafts = await listDrafts(Number(req.query?.limit) || 50);
      res.json({ drafts });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /response-drafts/:id
  apiRoute("get", "/response-drafts/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const draft = await getDraft(req.params.id);
      if (!draft) return apiError(res, 404, "NOT_FOUND", "draft not found");
      res.json(draft);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountResponseDrafterRoutes;
