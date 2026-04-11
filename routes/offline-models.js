/**
 * Phase 40.5: Offline model bundles routes.
 *
 * Endpoints:
 *   GET    /api/v1/models/offline/available        — list catalog entries
 *   GET    /api/v1/models/offline/downloaded       — list models present on disk
 *   GET    /api/v1/models/offline/recommendations  — recommend models for device
 *   POST   /api/v1/models/offline/:id/download     — start a download (SSE progress)
 *   GET    /api/v1/models/offline/:id/verify       — re-hash and verify integrity
 *   DELETE /api/v1/models/offline/:id              — delete a downloaded model
 */
import {
  listAvailableModels,
  listDownloadedModels,
  downloadModel,
  deleteDownloadedModel,
  verifyModelIntegrity,
  getModelRecommendations,
  OFFLINE_MODELS,
} from "../lib/offline-models.js";

export function mountOfflineModelsRoutes(app, deps) {
  const { apiRoute, apiError } = deps;
  const limiter = deps.storageRateLimiter || ((_req, _res, next) => next());

  // GET /api/v1/models/offline/available
  apiRoute("get", "/models/offline/available", limiter, async (_req, res) => {
    try {
      const items = await listAvailableModels();
      res.json({ _version: 1, items, total: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/OFFLINE_MODELS.md.");
    }
  });

  // GET /api/v1/models/offline/downloaded
  apiRoute("get", "/models/offline/downloaded", limiter, async (_req, res) => {
    try {
      const items = await listDownloadedModels();
      const totalBytes = items.reduce((sum, m) => sum + (m.sizeBytes || 0), 0);
      res.json({ _version: 1, items, total: items.length, totalBytes });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/OFFLINE_MODELS.md.");
    }
  });

  // GET /api/v1/models/offline/recommendations?ramGB=8&storageGB=20&cpuArch=x64
  apiRoute("get", "/models/offline/recommendations", limiter, async (req, res) => {
    try {
      const ramGB = req.query?.ramGB != null ? Number(req.query.ramGB) : undefined;
      const storageGB = req.query?.storageGB != null ? Number(req.query.storageGB) : undefined;
      const cpuArch = req.query?.cpuArch ? String(req.query.cpuArch) : undefined;
      const result = await getModelRecommendations({ ramGB, storageGB, cpuArch });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/OFFLINE_MODELS.md.");
    }
  });

  // POST /api/v1/models/offline/:id/download
  // Streams progress as Server-Sent Events when Accept: text/event-stream.
  apiRoute("post", "/models/offline/:id/download", limiter, async (req, res) => {
    const id = req.params.id;
    if (!OFFLINE_MODELS[id]) {
      return apiError(res, 404, "NOT_FOUND", `unknown model: ${id}`);
    }
    const wantsSse =
      typeof req.headers?.accept === "string" && req.headers.accept.includes("text/event-stream");

    if (!wantsSse) {
      // Fire-and-await: download fully then return JSON.
      try {
        const result = await downloadModel(id);
        return res.json({ _version: 1, ...result });
      } catch (err) {
        if (/checksum/i.test(err.message)) {
          return apiError(res, 422, "CHECKSUM_MISMATCH", err.message);
        }
        return apiError(res, 500, "DOWNLOAD_FAILED", err.message, "See docs/OFFLINE_MODELS.md.");
      }
    }

    // SSE progress stream
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    send("start", { id, startedAt: new Date().toISOString() });

    let lastPercent = -1;
    try {
      const result = await downloadModel(id, {
        onProgress: ({ received, total, percent }) => {
          if (percent !== lastPercent) {
            lastPercent = percent;
            send("progress", { id, received, total, percent });
          }
        },
      });
      send("done", { id, ...result });
    } catch (err) {
      send("error", { id, error: err.message });
    } finally {
      try {
        res.end();
      } catch {}
    }
  });

  // GET /api/v1/models/offline/:id/verify
  apiRoute("get", "/models/offline/:id/verify", limiter, async (req, res) => {
    try {
      const result = await verifyModelIntegrity(req.params.id);
      res.json({ _version: 1, id: req.params.id, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/OFFLINE_MODELS.md.");
    }
  });

  // DELETE /api/v1/models/offline/:id
  apiRoute("delete", "/models/offline/:id", limiter, async (req, res) => {
    try {
      const result = await deleteDownloadedModel(req.params.id);
      res.json({ _version: 1, id: req.params.id, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/OFFLINE_MODELS.md.");
    }
  });
}

export default mountOfflineModelsRoutes;
