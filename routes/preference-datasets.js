/**
 * Route module: preference dataset builder for RLHF/DPO training.
 *
 * GET    /api/v1/preferences/datasets                      — list datasets
 * POST   /api/v1/preferences/datasets                      — create dataset
 * GET    /api/v1/preferences/datasets/:id                  — get dataset
 * DELETE /api/v1/preferences/datasets/:id                  — delete dataset
 * POST   /api/v1/preferences/datasets/:id/pairs            — add a preference pair
 * DELETE /api/v1/preferences/datasets/:id/pairs/:pairId    — remove a pair
 * POST   /api/v1/preferences/extract/feedback              — auto-extract from feedback
 * POST   /api/v1/preferences/comparisons                   — create pairwise comparison
 * POST   /api/v1/preferences/comparisons/:id/rank          — submit ranking → pairs
 * GET    /api/v1/preferences/datasets/:id/validate         — validate dataset quality
 * GET    /api/v1/preferences/datasets/:id/stats            — dataset statistics
 * GET    /api/v1/preferences/datasets/:id/export?format=   — export dpo/reward/openai
 */

import {
  createPreferenceDataset,
  listPreferenceDatasets,
  getPreferenceDataset,
  deletePreferenceDataset,
  addPreferencePair,
  removePreferencePair,
  extractFromFeedback,
  createComparison,
  submitRanking,
  validatePreferenceDataset,
  getDatasetStats,
  toDPOFormat,
  toRewardModelFormat,
  toOpenAIDistillation,
} from "../lib/preference-dataset.js";

export function mountPreferenceDatasetRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  const wsOf = (req) =>
    String(req.body?.workspace || req.query?.workspace || "default");

  // GET /api/v1/preferences/datasets
  apiRoute(
    "get",
    "/preferences/datasets",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const result = await listPreferenceDatasets(wsOf(req));
        res.json({ datasets: result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/preferences/datasets
  apiRoute(
    "post",
    "/preferences/datasets",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { name, description, sourceType, minRatingDiff, maxExamples, format } =
          req.body || {};
        if (!name || typeof name !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "name is required.");
        }
        const result = await createPreferenceDataset(name, wsOf(req), {
          description,
          sourceType,
          minRatingDiff,
          maxExamples,
          format,
        });
        if (result?.error) {
          return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
        }
        res.status(201).json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/preferences/datasets/:id
  apiRoute(
    "get",
    "/preferences/datasets/:id",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const result = await getPreferenceDataset(req.params.id, wsOf(req));
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /api/v1/preferences/datasets/:id
  apiRoute(
    "delete",
    "/preferences/datasets/:id",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await deletePreferenceDataset(req.params.id, wsOf(req));
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/preferences/datasets/:id/pairs
  apiRoute(
    "post",
    "/preferences/datasets/:id/pairs",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { prompt, chosen, rejected, confidence, source, metadata } = req.body || {};
        if (!prompt || !chosen || !rejected) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "prompt, chosen, and rejected are required.",
          );
        }
        const result = await addPreferencePair(
          req.params.id,
          { prompt, chosen, rejected, confidence, source, metadata },
          wsOf(req),
        );
        if (result?.error) {
          const status =
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "DUPLICATE"
                ? 409
                : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.status(201).json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /api/v1/preferences/datasets/:id/pairs/:pairId
  apiRoute(
    "delete",
    "/preferences/datasets/:id/pairs/:pairId",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await removePreferencePair(
          req.params.id,
          req.params.pairId,
          wsOf(req),
        );
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/preferences/extract/feedback
  apiRoute(
    "post",
    "/preferences/extract/feedback",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { minRatingDiff, maxPairs, datasetId } = req.body || {};
        const ws = wsOf(req);
        const pairs = await extractFromFeedback(ws, { minRatingDiff, maxPairs });

        // Optionally append to an existing dataset
        if (datasetId) {
          let added = 0;
          for (const p of pairs) {
            const r = await addPreferencePair(datasetId, p, ws);
            if (!r?.error) added += 1;
          }
          return res.json({ extracted: pairs.length, added, pairs });
        }
        return res.json({ extracted: pairs.length, pairs });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/preferences/comparisons
  apiRoute(
    "post",
    "/preferences/comparisons",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { prompt, responses } = req.body || {};
        if (!prompt || typeof prompt !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "prompt is required.");
        }
        if (!Array.isArray(responses) || responses.length < 2) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "responses must be an array of 2+ items.",
          );
        }
        const result = await createComparison(prompt, responses, wsOf(req));
        if (result?.error) {
          return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
        }
        res.status(201).json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/preferences/comparisons/:id/rank
  apiRoute(
    "post",
    "/preferences/comparisons/:id/rank",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { ranking, datasetId } = req.body || {};
        if (!Array.isArray(ranking) || ranking.length < 2) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "ranking must be an array of 2+ response ids.",
          );
        }
        const userId = req.userId || null;
        const ws = wsOf(req);
        const result = await submitRanking(req.params.id, ranking, userId, ws);
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        // Optionally flush into a dataset
        if (datasetId) {
          let added = 0;
          for (const p of result.pairs) {
            const r = await addPreferencePair(datasetId, p, ws);
            if (!r?.error) added += 1;
          }
          return res.json({ ...result, added });
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/preferences/datasets/:id/validate
  apiRoute(
    "get",
    "/preferences/datasets/:id/validate",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const result = await validatePreferenceDataset(req.params.id, wsOf(req));
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/preferences/datasets/:id/stats
  apiRoute(
    "get",
    "/preferences/datasets/:id/stats",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const result = await getDatasetStats(req.params.id, wsOf(req));
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/preferences/datasets/:id/export?format=dpo
  apiRoute(
    "get",
    "/preferences/datasets/:id/export",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const format = String(req.query?.format || "dpo").toLowerCase();
        if (!["dpo", "reward_model", "openai_jsonl"].includes(format)) {
          return apiError(
            res,
            400,
            "INVALID_FORMAT",
            "format must be one of: dpo, reward_model, openai_jsonl.",
          );
        }
        const dataset = await getPreferenceDataset(req.params.id, wsOf(req));
        if (dataset?.error) {
          const status = dataset.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, dataset.code, dataset.error);
        }
        const pairs = Array.isArray(dataset.pairs) ? dataset.pairs : [];
        let data;
        if (format === "dpo") data = toDPOFormat(pairs);
        else if (format === "reward_model") data = toRewardModelFormat(pairs);
        else data = toOpenAIDistillation(pairs);

        if (req.query?.download === "1") {
          const lines = data.map((row) => JSON.stringify(row)).join("\n");
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="preferences-${req.params.id}-${format}.jsonl"`,
          );
          return res.send(lines);
        }
        res.json({ format, count: data.length, data });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountPreferenceDatasetRoutes;
