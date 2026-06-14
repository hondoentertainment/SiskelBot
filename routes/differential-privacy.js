/**
 * Phase 45.2: Differential privacy routes.
 *
 *   GET  /api/v1/differential-privacy/budget          — cumulative (eps, delta) loss
 *   GET  /api/v1/differential-privacy/budget/:name    — loss for a named accountant
 *   GET  /api/v1/differential-privacy/accountants     — list accountants
 *   POST /api/v1/differential-privacy/budget/:name/reset — reset an accountant
 *   POST /api/v1/differential-privacy/configure       — configure + record a mechanism release
 *   POST /api/v1/differential-privacy/analyze         — analyze a sample query for leak
 *
 * The `configure` endpoint accepts a mechanism ("gaussian" or "laplace"),
 * its parameter (sigma or scale), an optional per-step (epsilon, delta), and
 * an accountant name. It records the step under the named accountant and
 * returns a fresh snapshot plus the composed budget for `iterations` steps.
 */
import {
  computePrivacyBudget,
  getPrivacyAccountant,
  listPrivacyAccountants,
  analyzePrivacyLeak,
} from "../lib/differential-privacy.js";

const ALLOWED_MECHANISMS = new Set(["gaussian", "laplace"]);
const MAX_ACCOUNTANT_NAME = 128;

function sanitizeName(raw) {
  if (typeof raw !== "string") return "default";
  const s = raw.trim().slice(0, MAX_ACCOUNTANT_NAME);
  return s || "default";
}

export function mountDifferentialPrivacyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps || {};

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  if (typeof apiRoute !== "function") {
    return;
  }

  // GET /api/v1/differential-privacy/budget — default accountant snapshot
  apiRoute("get", "/differential-privacy/budget", log, auth, scope("read"), async (_req, res) => {
    try {
      const acc = getPrivacyAccountant("default");
      const snap = await acc.snapshot();
      res.json({ _version: 1, ...snap });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "budget fetch failed");
    }
  });

  // GET /api/v1/differential-privacy/budget/:name
  apiRoute(
    "get",
    "/differential-privacy/budget/:name",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const name = sanitizeName(req.params?.name);
        const acc = getPrivacyAccountant(name);
        const snap = await acc.snapshot();
        res.json({ _version: 1, ...snap });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "budget fetch failed");
      }
    },
  );

  // GET /api/v1/differential-privacy/accountants
  apiRoute(
    "get",
    "/differential-privacy/accountants",
    log,
    auth,
    scope("read"),
    async (_req, res) => {
      try {
        const list = await listPrivacyAccountants();
        res.json({ _version: 1, accountants: list, count: list.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
      }
    },
  );

  // POST /api/v1/differential-privacy/budget/:name/reset
  apiRoute(
    "post",
    "/differential-privacy/budget/:name/reset",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const name = sanitizeName(req.params?.name);
        const acc = getPrivacyAccountant(name);
        const snap = await acc.reset();
        res.json({ _version: 1, ...snap, reset: true });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "reset failed");
      }
    },
  );

  // POST /api/v1/differential-privacy/configure
  // Body: {
  //   mechanism: "gaussian" | "laplace",
  //   sigma?: number,           // gaussian stddev
  //   scale?: number,           // laplace scale
  //   epsilon?: number,         // per-step privacy loss to record
  //   delta?: number,           // per-step delta to record
  //   iterations?: number,      // optional total for budget composition
  //   accountant?: string,      // name; default "default"
  // }
  apiRoute(
    "post",
    "/differential-privacy/configure",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const mechanism = typeof body.mechanism === "string" ? body.mechanism.toLowerCase() : "";
        if (!ALLOWED_MECHANISMS.has(mechanism)) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            `mechanism must be one of: ${[...ALLOWED_MECHANISMS].join(", ")}`,
          );
        }

        let sigma = 0;
        let scale = 0;
        if (mechanism === "gaussian") {
          sigma = Number(body.sigma);
          if (!Number.isFinite(sigma) || sigma < 0) {
            return apiError(res, 400, "INVALID_INPUT", "sigma must be a non-negative number");
          }
        } else {
          scale = Number(body.scale);
          if (!Number.isFinite(scale) || scale < 0) {
            return apiError(res, 400, "INVALID_INPUT", "scale must be a non-negative number");
          }
        }

        const epsilon = Number.isFinite(body.epsilon) && body.epsilon >= 0 ? Number(body.epsilon) : 0;
        const delta = Number.isFinite(body.delta) && body.delta >= 0 ? Number(body.delta) : 0;
        const iterations =
          Number.isFinite(body.iterations) && body.iterations > 0 ? Math.floor(body.iterations) : 1;
        const name = sanitizeName(body.accountant);

        const acc = getPrivacyAccountant(name);
        const snapshot = await acc.record(epsilon, delta, {
          mechanism,
          sigma: mechanism === "gaussian" ? sigma : undefined,
          scale: mechanism === "laplace" ? scale : undefined,
        });

        const budget = computePrivacyBudget(epsilon, delta, iterations);

        res.status(201).json({
          _version: 1,
          mechanism,
          sigma: mechanism === "gaussian" ? sigma : undefined,
          scale: mechanism === "laplace" ? scale : undefined,
          accountant: snapshot,
          budget,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "configure failed");
      }
    },
  );

  // POST /api/v1/differential-privacy/analyze
  // Accepts a small dataset and a "query" descriptor (sum|count|mean|max|min).
  // This is a safe built-in catalog — we never eval user code.
  apiRoute(
    "post",
    "/differential-privacy/analyze",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const dataset = Array.isArray(body.dataset) ? body.dataset : null;
        if (!dataset) {
          return apiError(res, 400, "INVALID_INPUT", "dataset must be an array");
        }
        if (dataset.length > 10_000) {
          return apiError(res, 400, "INVALID_INPUT", "dataset too large (max 10000 rows)");
        }
        const queryName = typeof body.query === "string" ? body.query.toLowerCase() : "";
        const field = typeof body.field === "string" ? body.field : null;

        const pick = (row) => {
          if (field && row && typeof row === "object") {
            const v = row[field];
            return Number.isFinite(Number(v)) ? Number(v) : 0;
          }
          const v = Number(row);
          return Number.isFinite(v) ? v : 0;
        };

        let queryFn = null;
        if (queryName === "sum") {
          queryFn = (rows) => rows.reduce((s, r) => s + pick(r), 0);
        } else if (queryName === "count") {
          queryFn = (rows) => rows.length;
        } else if (queryName === "mean") {
          queryFn = (rows) => (rows.length ? rows.reduce((s, r) => s + pick(r), 0) / rows.length : 0);
        } else if (queryName === "max") {
          queryFn = (rows) => rows.reduce((m, r) => Math.max(m, pick(r)), -Infinity);
        } else if (queryName === "min") {
          queryFn = (rows) => rows.reduce((m, r) => Math.min(m, pick(r)), Infinity);
        } else {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "query must be one of: sum, count, mean, max, min",
          );
        }

        const maxAllowedSensitivity = Number.isFinite(body.maxAllowedSensitivity)
          ? Number(body.maxAllowedSensitivity)
          : 1;

        const analysis = analyzePrivacyLeak(queryFn, dataset, { maxAllowedSensitivity });
        res.json({ _version: 1, query: queryName, field, ...analysis });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "analyze failed");
      }
    },
  );
}

export default mountDifferentialPrivacyRoutes;
