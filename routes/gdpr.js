/**
 * Wave 19B: GDPR / DPIA endpoints.
 *
 *   POST /api/v1/gdpr/pii-scan             — scan workspace for PII (auth required)
 *   GET  /api/v1/gdpr/dpia                 — generate DPIA template for workspace (auth required)
 *   POST /api/v1/gdpr/data-export          — queue a data-export job for the authenticated user
 *   POST /api/v1/gdpr/data-deletion        — queue a data-deletion job (requires confirmation)
 *   GET  /api/v1/gdpr/data-deletion/status — check deletion request status
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { scanWorkspaceForPii } from "../lib/pii-scanner.js";
import { generateDpiaTemplate } from "../lib/dpia.js";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "../lib/json-path-store.js";

function jobsStorePath() {
  return join(getDataDir(), "gdpr-jobs.json");
}

async function saveJob(job) {
  const path = jobsStorePath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, jobs: [] });
    if (!Array.isArray(data.jobs)) data.jobs = [];
    data.jobs.push(job);
    await writeJsonPath(path, data);
  });
}

async function findJob(userId, type) {
  const data = await readJsonPath(jobsStorePath(), { _version: 1, jobs: [] });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const matching = jobs.filter((j) => j.userId === userId && j.type === type);
  return matching.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))[0] || null;
}

function estimatedReadyAt(minutesFromNow = 60) {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString();
}

export function mountGdprRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  apiRoute(
    "post",
    "/gdpr/pii-scan",
    limiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(
          req.body?.workspaceId || req.query?.workspaceId || "default",
        );
        const sampleSize = Math.min(
          500,
          Math.max(1, parseInt(req.body?.sampleSize || "100", 10) || 100),
        );
        const result = await scanWorkspaceForPii(workspaceId, { sampleSize });
        res.json({ _version: 1, ...result });
      } catch (err) {
        console.error("GDPR PII scan error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "PII scan failed.");
      }
    },
  );

  apiRoute(
    "get",
    "/gdpr/dpia",
    limiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.query?.workspaceId || "default");
        const markdown = generateDpiaTemplate({ description: req.query?.description });
        const accept = req.headers?.accept || "";
        if (accept.includes("text/markdown") || req.query?.format === "markdown") {
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="dpia-${workspaceId}.md"`);
          return res.send(markdown);
        }
        res.json({ _version: 1, workspaceId, markdown, generatedAt: new Date().toISOString() });
      } catch (err) {
        console.error("GDPR DPIA error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "DPIA generation failed.");
      }
    },
  );

  apiRoute(
    "post",
    "/gdpr/data-export",
    limiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = req.userId || "anonymous";
        const jobId = randomUUID();
        const job = {
          jobId,
          userId,
          type: "data-export",
          status: "pending",
          createdAt: new Date().toISOString(),
          estimatedReadyAt: estimatedReadyAt(60),
        };
        await saveJob(job);
        res.status(202).json({
          _version: 1,
          jobId,
          status: "pending",
          estimatedReadyAt: job.estimatedReadyAt,
          message:
            "Your data export request has been queued. Operators will complete it within 30 days as required by GDPR Article 12.",
        });
      } catch (err) {
        console.error("GDPR data-export error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Data export request failed.");
      }
    },
  );

  apiRoute(
    "post",
    "/gdpr/data-deletion",
    limiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const { confirmation } = req.body || {};
        if (confirmation !== "DELETE_MY_DATA") {
          return apiError(
            res,
            400,
            "CONFIRMATION_REQUIRED",
            'Body must include { "confirmation": "DELETE_MY_DATA" }',
            "Provide the exact confirmation string to proceed.",
          );
        }
        const userId = req.userId || "anonymous";
        const jobId = randomUUID();
        const job = {
          jobId,
          userId,
          type: "data-deletion",
          status: "pending",
          createdAt: new Date().toISOString(),
          estimatedReadyAt: estimatedReadyAt(24 * 60),
        };
        await saveJob(job);
        res.status(202).json({
          _version: 1,
          jobId,
          status: "pending",
          estimatedReadyAt: job.estimatedReadyAt,
          message:
            "Your data deletion request has been queued. Operators will complete it within 30 days as required by GDPR Article 17.",
        });
      } catch (err) {
        console.error("GDPR data-deletion error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Data deletion request failed.");
      }
    },
  );

  apiRoute(
    "get",
    "/gdpr/data-deletion/status",
    limiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = req.userId || "anonymous";
        const job = await findJob(userId, "data-deletion");
        if (!job) {
          return res.json({
            _version: 1,
            status: "not_requested",
            message: "No data deletion request found for this user.",
          });
        }
        res.json({
          _version: 1,
          jobId: job.jobId,
          status: job.status,
          createdAt: job.createdAt,
          estimatedReadyAt: job.estimatedReadyAt,
        });
      } catch (err) {
        console.error("GDPR deletion status error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Could not retrieve deletion status.");
      }
    },
  );
}
