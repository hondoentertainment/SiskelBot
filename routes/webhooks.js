// Webhooks, ws-token, ws-replay, and notifications routes extracted from server.js

export function mountWebhookRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    sanitizeWorkspace,
    webhooksHandlers,
    listWebhooks,
    addWebhook,
    removeWebhook,
    validateWebhookUrl,
    createToken,
    getEventsSince,
    listNotifications,
    markNotificationRead,
    markAllNotificationsRead,
  } = deps;

  apiRoute("get", "/webhooks", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const items = await listWebhooks(workspace);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
    }
  });

  apiRoute("post", "/webhooks", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { url, events, secret } = req.body || {};
      if (!url || typeof url !== "string" || !url.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "url required", "Send { url: string, events: string[], secret?: string }.");
      }
      const v = validateWebhookUrl(url.trim());
      if (!v.valid) {
        return apiError(res, 400, "INVALID_URL", v.reason, "Use HTTPS URL. Set ALLOW_WEBHOOK_LOCALHOST=1 for localhost.");
      }
      const ev = Array.isArray(events) ? events : [];
      if (ev.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "At least one event required", "Events: message_sent, plan_created, recipe_executed, schedule_completed.");
      }
      const webhook = await addWebhook({ url: url.trim(), events: ev, secret }, workspace);
      res.status(201).json(webhook);
    } catch (err) {
      if (err.message?.includes("At least one event") || err.message?.includes("URL")) {
        return apiError(res, 400, "INVALID_INPUT", err.message, "See docs/WEBHOOKS.md.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
    }
  });

  apiRoute("delete", "/webhooks/:id", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const removed = await removeWebhook(req.params.id, workspace);
      if (!removed) return res.status(404).json({ error: "Webhook not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
    }
  });

  apiRoute("get", "/ws-token", ...webhooksHandlers, (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId ?? "anonymous";
      const { token, url } = createToken(userId, workspace);
      res.json({ token, url });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/ws-replay", ...webhooksHandlers, (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const since = parseInt(req.query?.since, 10);
      if (!since || isNaN(since)) {
        return apiError(res, 400, "BAD_REQUEST", "Missing or invalid 'since' query parameter (Unix ms timestamp).", null);
      }
      const events = getEventsSince(workspace, since);
      res.json({ _version: 1, events });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/notifications", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId ?? "anonymous";
      const items = await listNotifications(workspace, userId);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("patch", "/notifications/mark-all-read", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace || req.body?.workspace);
      const userId = req.userId ?? "anonymous";
      await markAllNotificationsRead(workspace, userId);
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("patch", "/notifications/:id", ...webhooksHandlers, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId ?? "anonymous";
      const ok = await markNotificationRead(req.params.id, workspace, userId);
      if (!ok) return res.status(404).json({ error: "Notification not found", code: "NOT_FOUND" });
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
