/**
 * Phase 64.2: Paper summary routes.
 */
import {
  summarizePaper,
  recordSummary,
  listSummaries,
  getSummary,
} from "../lib/paper-summary.js";

export function mountPaperSummaryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/paper-summary/summarize", adminAuth, logRequest, async (req, res) => {
    try {
      const { title, abstract, authors, year } = req.body || {};
      if (typeof abstract !== "string" || !abstract.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "abstract is required");
      }
      const summary = summarizePaper({ title, abstract, authors, year });
      res.status(200).json(summary);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/paper-summary/record", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, paperId, title, summary, abstract, authors, year } = req.body || {};
      let finalSummary = summary;
      if (!finalSummary && typeof abstract === "string" && abstract.trim()) {
        finalSummary = summarizePaper({ title, abstract, authors, year });
      }
      if (!finalSummary || typeof finalSummary !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "summary or abstract is required");
      }
      const record = await recordSummary({ workspaceId, paperId, title, summary: finalSummary });
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/paper-summary/summaries", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await listSummaries(req.query?.workspaceId);
      res.json({ summaries: entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/paper-summary/summaries/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const record = await getSummary(req.params.id);
      if (!record) return apiError(res, 404, "NOT_FOUND", `summary ${req.params.id} not found`);
      res.json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPaperSummaryRoutes;
