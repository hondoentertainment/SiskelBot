/**
 * Admin routes for eval history time-series observability.
 *
 * Exposes the per-workspace samples recorded via lib/eval-history-store.js.
 * All endpoints require admin auth + "admin" scope.
 *
 * Mounted at /api/admin/eval-history.
 */

import {
  recordSample,
  listSamples,
  getSeries,
  latest,
  clearHistory,
} from "../lib/eval-history-store.js";

const VALID_KINDS = new Set(["benchmark", "safety", "feedback", "genealogy", "custom"]);
const VALID_BUCKETS = new Set(["hour", "day", "week", "raw"]);

function parseNum(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export default function mountAdminEvalHistoryRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/eval-history?workspace=X&kind=&suite=&sinceTs=&untilTs=&limit= */
  app.get(
    "/api/admin/eval-history",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const kind = req.query?.kind ? String(req.query.kind) : undefined;
        if (kind && !VALID_KINDS.has(kind)) {
          return apiError(res, 400, "INVALID_KIND", `kind must be one of ${[...VALID_KINDS].join(",")}`);
        }
        const suite = req.query?.suite ? String(req.query.suite) : undefined;
        const sinceTs = parseNum(req.query?.sinceTs);
        const untilTs = parseNum(req.query?.untilTs);
        const limit = parseNum(req.query?.limit);
        const samples = await listSamples(workspace, { kind, suite, sinceTs, untilTs, limit });
        return res.json({ workspace, samples });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/eval-history/series?workspace=X&kind=&metric=&suite=&bucket=&sinceTs=&untilTs= */
  app.get(
    "/api/admin/eval-history/series",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const kind = req.query?.kind ? String(req.query.kind) : "";
        const metric = req.query?.metric ? String(req.query.metric) : "";
        if (!kind || !VALID_KINDS.has(kind)) {
          return apiError(res, 400, "INVALID_KIND", `kind must be one of ${[...VALID_KINDS].join(",")}`);
        }
        if (!metric) {
          return apiError(res, 400, "INVALID_METRIC", "metric is required");
        }
        const suite = req.query?.suite ? String(req.query.suite) : undefined;
        const bucketRaw = req.query?.bucket ? String(req.query.bucket) : "raw";
        if (!VALID_BUCKETS.has(bucketRaw)) {
          return apiError(res, 400, "INVALID_BUCKET", `bucket must be one of ${[...VALID_BUCKETS].join(",")}`);
        }
        const sinceTs = parseNum(req.query?.sinceTs);
        const untilTs = parseNum(req.query?.untilTs);
        const series = await getSeries(workspace, {
          kind,
          metric,
          suite,
          bucket: bucketRaw,
          sinceTs,
          untilTs,
        });
        return res.json({ workspace, kind, metric, bucket: bucketRaw, series });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/eval-history/latest?workspace=X&kind=&suite= */
  app.get(
    "/api/admin/eval-history/latest",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const kind = req.query?.kind ? String(req.query.kind) : "";
        if (!kind || !VALID_KINDS.has(kind)) {
          return apiError(res, 400, "INVALID_KIND", `kind must be one of ${[...VALID_KINDS].join(",")}`);
        }
        const suite = req.query?.suite ? String(req.query.suite) : undefined;
        const sample = await latest(workspace, { kind, suite });
        return res.json({ workspace, sample });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/eval-history?workspace=X  body: {kind, suite?, metrics, ts?, commit?, tags?} */
  app.post(
    "/api/admin/eval-history",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const sample = {
          ts: Number.isFinite(body.ts) ? Number(body.ts) : Date.now(),
          kind: body.kind,
          suite: body.suite,
          metrics: body.metrics,
          commit: body.commit,
          tags: body.tags,
        };
        const saved = await recordSample(workspace, sample);
        return res.status(201).json({ sample: saved });
      } catch (err) {
        return apiError(res, 400, "INVALID_SAMPLE", String(err?.message || err));
      }
    },
  );

  /** DELETE /api/admin/eval-history?workspace=X */
  app.delete(
    "/api/admin/eval-history",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        await clearHistory(workspace);
        return res.json({ ok: true, workspace });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
