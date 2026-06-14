import { createHmac, timingSafeEqual } from "crypto";
import {
  startWorkflowFromIssue,
  listWorkflowRuns,
  getWorkflowRun,
  handlePrReviewWebhook,
} from "../lib/github-dev-workflow.js";

function verifyGithubSignature(rawBody, signatureHeader) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  const sig = signatureHeader || "";
  if (!sig.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(`sha256=${expected}`, "utf8");
  const sigBuf = Buffer.from(sig, "utf8");
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

export function mountGithubWorkflowRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest, isAuthConfigured } = deps;

  const handlers = [logRequest];
  if (isAuthConfigured()) handlers.push(userAuth);

  apiRoute("post", "/github-workflow/start", ...handlers, async (req, res) => {
    try {
      const {
        owner,
        repo,
        issueNumber,
        token,
        workspaceId,
        sandboxId,
        model,
        maxIterations,
      } = req.body || {};

      if (!owner || !repo) {
        return apiError(res, 400, "INVALID_INPUT", "owner and repo are required", null);
      }
      if (!issueNumber || isNaN(Number(issueNumber))) {
        return apiError(res, 400, "INVALID_INPUT", "issueNumber must be a number", null);
      }
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required", null);
      }

      const result = await startWorkflowFromIssue({
        owner,
        repo,
        issueNumber: Number(issueNumber),
        token,
        workspaceId,
        sandboxId,
        model,
        maxIterations,
      });
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/github-workflow/runs", ...handlers, async (req, res) => {
    try {
      const { workspaceId } = req.query;
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId required", null);
      }
      const runs = await listWorkflowRuns(workspaceId);
      res.json({ _version: 1, runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/github-workflow/runs/:runId", ...handlers, async (req, res) => {
    try {
      const { workspaceId } = req.query;
      const { runId } = req.params;
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId required", null);
      }
      if (!runId) {
        return apiError(res, 400, "INVALID_INPUT", "runId required", null);
      }
      const run = await getWorkflowRun(workspaceId, runId);
      if (!run) return apiError(res, 404, "NOT_FOUND", "Workflow run not found", null);
      res.json(run);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  app.post("/api/v1/github-workflow/webhook", async (req, res) => {
    try {
      const signature = req.headers["x-hub-signature-256"] || "";
      const rawBody = req.rawBody || JSON.stringify(req.body || {});
      if (process.env.GITHUB_WEBHOOK_SECRET) {
        if (!verifyGithubSignature(rawBody, signature)) {
          return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid webhook signature" });
        }
      }
      const workspaceId = req.query.workspaceId || req.body?.workspaceId || "default";
      const result = await handlePrReviewWebhook(req.body || {}, workspaceId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
    }
  });
}

export default mountGithubWorkflowRoutes;
