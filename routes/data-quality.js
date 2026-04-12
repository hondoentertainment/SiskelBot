/**
 * Phase 57.2: Data quality monitor routes.
 *
 * POST   /api/v1/data-quality/monitors                   — create a monitor
 * GET    /api/v1/data-quality/monitors                   — list monitors
 * GET    /api/v1/data-quality/monitors/:name             — get a monitor
 * POST   /api/v1/data-quality/monitors/:name/samples     — record a sample
 * POST   /api/v1/data-quality/monitors/:name/reference   — freeze current as baseline
 * GET    /api/v1/data-quality/monitors/:name/drift       — run drift check
 */
import {
  MONITOR_TYPES,
  createMonitor,
  getMonitor,
  listMonitors,
  recordSample,
  setReference,
  checkDrift,
} from "../lib/data-quality.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be|not found/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountDataQualityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/data-quality/types", adminAuth, logRequest, async (req, res) => {
    res.json({ types: MONITOR_TYPES });
  });

  apiRoute("post", "/data-quality/monitors", adminAuth, logRequest, async (req, res) => {
    try {
      const { name, type, bufferSize } = req.body || {};
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const rec = await createMonitor(name, type || "numeric", { bufferSize });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/data-quality/monitors", adminAuth, logRequest, async (req, res) => {
    res.json({ monitors: await listMonitors() });
  });

  apiRoute("get", "/data-quality/monitors/:name", adminAuth, logRequest, async (req, res) => {
    const rec = await getMonitor(req.params.name);
    if (!rec || !rec.name) return apiError(res, 404, "NOT_FOUND", "monitor not found");
    res.json(rec);
  });

  apiRoute("post", "/data-quality/monitors/:name/samples", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!("value" in body)) return apiError(res, 400, "INVALID_INPUT", "value is required");
      await recordSample(req.params.name, body.value, {
        type: body.type,
        bufferSize: body.bufferSize,
        asReference: !!body.asReference,
      });
      res.json({ ok: true });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/data-quality/monitors/:name/reference", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await setReference(req.params.name);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/data-quality/monitors/:name/drift", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await checkDrift(req.params.name, {
        minSamples: req.query?.minSamples ? Number(req.query.minSamples) : undefined,
        significance: req.query?.significance ? Number(req.query.significance) : undefined,
      });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountDataQualityRoutes;
