/**
 * Phase 68.1: Web ingestion routes.
 *
 * POST /api/v1/web-ingestion/sources         -- register source { url, title?, tags?, intervalMs? }
 * GET  /api/v1/web-ingestion/sources         -- list sources (?tag=...)
 * POST /api/v1/web-ingestion/sources/:id/crawl -- trigger a crawl (fetch via injected impl server-side)
 * GET  /api/v1/web-ingestion/sources/:id/last -- last crawl
 * POST /api/v1/web-ingestion/schedules       -- schedule a crawl { sourceId, intervalMs }
 */
import {
  registerSource,
  listSources,
  crawlSource,
  getLastCrawl,
  scheduleCrawl,
} from "../lib/web-ingestion.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "web-ingestion error");
}

async function defaultFetchImpl(url) {
  try {
    const resp = await fetch(url);
    return {
      ok: resp.ok,
      status: resp.status,
      text: () => resp.text(),
    };
  } catch (err) {
    throw err;
  }
}

export function mountWebIngestionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/web-ingestion/sources", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await registerSource(body);
      return res.status(201).json({ _version: 1, source: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/web-ingestion/sources", log, auth, scope("read"), async (req, res) => {
    try {
      const tag = typeof req.query?.tag === "string" ? req.query.tag : undefined;
      const sources = await listSources({ tag });
      return res.json({ _version: 1, sources, count: sources.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/web-ingestion/sources/:id/crawl", log, auth, scope("write"), async (req, res) => {
    try {
      const crawl = await crawlSource(req.params.id, { fetchImpl: defaultFetchImpl });
      return res.status(201).json({ _version: 1, crawl });
    } catch (err) {
      const status = String(err?.message || "").startsWith("unknown source") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/web-ingestion/sources/:id/last", log, auth, scope("read"), async (req, res) => {
    try {
      const crawl = await getLastCrawl(req.params.id);
      if (!crawl) return apiError(res, 404, "NOT_FOUND", "no crawl recorded");
      return res.json({ _version: 1, crawl });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/web-ingestion/schedules", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await scheduleCrawl(body);
      return res.status(201).json({ _version: 1, schedule: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // Admin-only reschedule cleanup endpoint (noop placeholder for API symmetry).
  apiRoute("post", "/web-ingestion/admin/ping", log, admin, async (_req, res) => {
    return res.json({ _version: 1, ok: true });
  });
}

export default mountWebIngestionRoutes;
