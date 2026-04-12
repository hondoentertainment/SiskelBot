/**
 * Phase 58.4: Model distillation routes.
 *
 * POST   /api/v1/distillation/runs                 — start a run
 * GET    /api/v1/distillation/runs                 — list runs
 * GET    /api/v1/distillation/runs/:id             — get run
 * GET    /api/v1/distillation/runs/:id/dataset     — get dataset pairs
 * POST   /api/v1/distillation/runs/:id/pairs       — record a pair
 * POST   /api/v1/distillation/runs/:id/finalize    — finalize dataset (+ optional evalReport)
 * POST   /api/v1/distillation/runs/:id/promote     — promote student model
 * POST   /api/v1/distillation/runs/:id/cancel      — cancel run
 */
import {
  RUN_STATUS,
  startDistillation,
  recordPair,
  finalizeDataset,
  promoteStudent,
  cancelRun,
  getRun,
  getDataset,
  listRuns,
} from "../lib/distillation.js";

function mapErr(err) {
  if (/not found/i.test(err?.message || "")) return { status: 404, code: "NOT_FOUND" };
  if (/cannot|required|requires/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountDistillationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/distillation/statuses", adminAuth, logRequest, async (req, res) => {
    res.json({ statuses: Object.values(RUN_STATUS) });
  });

  apiRoute("post", "/distillation/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await startDistillation(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/distillation/runs", adminAuth, logRequest, async (req, res) => {
    res.json({ runs: await listRuns() });
  });

  apiRoute("get", "/distillation/runs/:id", adminAuth, logRequest, async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
    res.json(run);
  });

  apiRoute("get", "/distillation/runs/:id/dataset", adminAuth, logRequest, async (req, res) => {
    const ds = await getDataset(req.params.id);
    res.json(ds);
  });

  apiRoute("post", "/distillation/runs/:id/pairs", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await recordPair(req.params.id, req.body || {});
      res.status(201).json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/distillation/runs/:id/finalize", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await finalizeDataset(req.params.id, req.body?.evalReport ?? null);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/distillation/runs/:id/promote", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await promoteStudent(req.params.id);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/distillation/runs/:id/cancel", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await cancelRun(req.params.id);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountDistillationRoutes;
