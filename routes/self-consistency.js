/**
 * Phase 52.2: Self-consistency voting routes.
 *
 * POST /api/v1/reasoning/self-consistency/run     — run full pipeline with samples
 * POST /api/v1/reasoning/self-consistency/vote    — vote on pre-collected samples
 * POST /api/v1/reasoning/self-consistency/extract — extract answer from text
 * GET  /api/v1/reasoning/self-consistency/history — list past runs
 */
import {
  runSelfConsistency,
  voteAnswers,
  extractAnswer,
  getRunHistory,
  analyzeAgreement,
  computeUncertainty,
} from "../lib/self-consistency.js";

export function mountSelfConsistencyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/reasoning/self-consistency/run
  // Body: { task, n, format, samples?: [{ answer, reasoning }] }
  // If `samples` is provided, they are used directly (no LLM call).
  // Otherwise, synthesises answers via extractAnswer over provided
  // pre-generated reasoning texts in `responses` (strings).
  apiRoute(
    "post",
    "/reasoning/self-consistency/run",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const task = body.task;
        if (task == null) {
          return apiError(res, 400, "INVALID_INPUT", "task is required");
        }
        const n = Number(body.n) || 5;
        const format = body.format || "auto";
        const minConsensus = body.minConsensus;

        // Accept either:
        //   samples: [{ answer, reasoning }]    — already-executed samples
        //   responses: ["...text...", "..."]    — raw LLM outputs
        const samples = Array.isArray(body.samples) ? body.samples : null;
        const responses = Array.isArray(body.responses) ? body.responses : null;

        if (!samples && !responses) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "either samples or responses array is required (no LLM sampler is wired in this route)",
          );
        }

        const sourceSamples = samples
          ? samples
          : responses.map((r, i) => ({
              sampleId: `resp-${i}`,
              answer: null,
              reasoning: typeof r === "string" ? r : String(r || ""),
            }));

        let idx = 0;
        const sampler = async () => {
          const s = sourceSamples[idx++];
          return s || { answer: null, reasoning: "" };
        };

        const result = await runSelfConsistency(task, sampler, {
          n: sourceSamples.length || n,
          format,
          minConsensus,
          parallel: false,
          persist: body.persist !== false,
        });
        return res.json({ _version: 1, result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "self-consistency run failed");
      }
    },
  );

  // POST /api/v1/reasoning/self-consistency/vote
  // Body: { samples: [{ answer }], format?, weights? }
  apiRoute(
    "post",
    "/reasoning/self-consistency/vote",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!Array.isArray(body.samples)) {
          return apiError(res, 400, "INVALID_INPUT", "samples array is required");
        }
        const vote = voteAnswers(body.samples, {
          format: body.format || "auto",
          weights: Array.isArray(body.weights) ? body.weights : undefined,
        });
        const agreement = analyzeAgreement(body.samples);
        const uncertainty = computeUncertainty(body.samples);
        return res.json({ _version: 1, vote, agreement, uncertainty });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "vote failed");
      }
    },
  );

  // POST /api/v1/reasoning/self-consistency/extract
  // Body: { text, format? }
  apiRoute(
    "post",
    "/reasoning/self-consistency/extract",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const body = req.body || {};
        if (typeof body.text !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "text (string) is required");
        }
        const format = body.format || "auto";
        const answer = extractAnswer(body.text, format);
        return res.json({ _version: 1, answer, format });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "extract failed");
      }
    },
  );

  // GET /api/v1/reasoning/self-consistency/history?limit=&task=&since=
  apiRoute(
    "get",
    "/reasoning/self-consistency/history",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const limit = req.query?.limit ? Number(req.query.limit) : 50;
        const filter = {
          limit,
          task: req.query?.task,
          since: req.query?.since,
        };
        const runs = await getRunHistory(filter);
        return res.json({ _version: 1, runs, count: runs.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "history failed");
      }
    },
  );
}

export default mountSelfConsistencyRoutes;
