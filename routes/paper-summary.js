/**
 * Phase 64.2: Paper summarization routes.
 */
import {
  summarizePaper,
  extractSections,
  listSummaries,
  getSummary,
  rankBySalience,
  splitSentences,
} from "../lib/paper-summary.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "paper-summary error");
}

export function mountPaperSummaryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/research/summary/summarize", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.paper || typeof body.paper !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "paper required");
      }
      const out = await summarizePaper(body.paper);
      return res.status(201).json({ _version: 1, summary: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/summary/sections", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") return apiError(res, 400, "INVALID_INPUT", "text required");
      return res.json({ _version: 1, sections: extractSections(body.text) });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/summary/rank", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const sents = Array.isArray(body.sentences)
        ? body.sentences
        : typeof body.text === "string"
          ? splitSentences(body.text)
          : null;
      if (!sents) return apiError(res, 400, "INVALID_INPUT", "sentences or text required");
      const ranked = rankBySalience(sents, body.query || "");
      return res.json({ _version: 1, ranked });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/summary/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listSummaries();
      return res.json({ _version: 1, summaries: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/summary/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const s = await getSummary(req.params.id);
      if (!s) return apiError(res, 404, "NOT_FOUND", "summary not found");
      return res.json({ _version: 1, summary: s });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountPaperSummaryRoutes;
