import crypto from "node:crypto";
import {
  handleGithubIssueWebhook,
  handleLinearIssueWebhook,
  handleJiraIssueWebhook,
  listPickedUpIssues,
  updateIssuePickupRecord,
} from "../lib/issue-pickup.js";

function verifyGithubSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const sig = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function mountIssuePickupRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/issue-pickup/github", log, async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers["x-hub-signature-256"] || "";
      const rawBody = req.rawBody || JSON.stringify(req.body);
      if (!verifyGithubSignature(rawBody, signature, secret)) {
        return apiError(res, 401, "UNAUTHORIZED", "Invalid webhook signature");
      }
    }
    const workspaceId = req.query.workspaceId || req.body?.workspaceId || "default";
    try {
      const result = await handleGithubIssueWebhook(req.body, workspaceId, {
        triggerLabel: process.env.ISSUE_PICKUP_LABEL || "devin",
        botUser: process.env.GITHUB_BOT_USER,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Webhook processing failed");
    }
  });

  apiRoute("post", "/issue-pickup/linear", log, async (req, res) => {
    const workspaceId = req.query.workspaceId || req.body?.workspaceId || "default";
    try {
      const result = await handleLinearIssueWebhook(req.body, workspaceId, {
        triggerLabel: process.env.ISSUE_PICKUP_LABEL || "devin",
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Webhook processing failed");
    }
  });

  apiRoute("post", "/issue-pickup/jira", log, async (req, res) => {
    const workspaceId = req.query.workspaceId || req.body?.workspaceId || "default";
    try {
      const result = await handleJiraIssueWebhook(req.body, workspaceId, {
        triggerLabel: process.env.ISSUE_PICKUP_LABEL || "devin",
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Webhook processing failed");
    }
  });

  apiRoute(
    "get",
    "/workspaces/:workspaceId/issue-pickup",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId } = req.params;
      try {
        const records = await listPickedUpIssues(workspaceId);
        res.json({ records });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed");
      }
    },
  );

  apiRoute(
    "put",
    "/workspaces/:workspaceId/issue-pickup/:pickupId",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, pickupId } = req.params;
      const { status, sessionId } = req.body || {};
      const allowed = ["pending", "spawned", "completed", "failed"];
      if (status && !allowed.includes(status)) {
        return apiError(res, 400, "INVALID_INPUT", `status must be one of: ${allowed.join(", ")}`);
      }
      try {
        const updates = {};
        if (status !== undefined) updates.status = status;
        if (sessionId !== undefined) updates.sessionId = sessionId;
        const updated = await updateIssuePickupRecord(workspaceId, pickupId, updates);
        if (!updated) {
          return apiError(res, 404, "NOT_FOUND", "Issue pickup record not found");
        }
        res.json(updated);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Update failed");
      }
    },
  );
}
