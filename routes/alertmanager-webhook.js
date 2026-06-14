/**
 * Alertmanager webhook receiver.
 *
 * Prometheus Alertmanager `webhook_configs` POSTs alert payloads here. We
 * translate them into status-page incidents on the configured external
 * provider (Statuspage.io / cstate). See docs/STATUS_PAGE.md.
 *
 * Auth: optional shared secret in `Authorization: Bearer <secret>` header.
 * Configure via ALERTMANAGER_WEBHOOK_SECRET. If unset, the endpoint is open
 * (intended for cluster-internal Alertmanager only).
 *
 * Mounts at:
 *   POST /api/v1/alertmanager/webhook   (stable)
 *   POST /api/alertmanager/webhook      (legacy, deprecated header)
 */

import { processAlertmanagerPayload } from "../lib/status-page.js";

export function mountAlertmanagerWebhookRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  apiRoute("post", "/alertmanager/webhook", logRequest, async (req, res) => {
    const secret = process.env.ALERTMANAGER_WEBHOOK_SECRET;
    if (secret) {
      const authHeader = req.headers.authorization || "";
      const expected = `Bearer ${secret}`;
      if (authHeader !== expected) {
        return apiError(
          res,
          401,
          "UNAUTHORIZED",
          "invalid or missing bearer token",
          "Set Authorization: Bearer <ALERTMANAGER_WEBHOOK_SECRET>",
        );
      }
    }

    try {
      const result = await processAlertmanagerPayload(req.body || {});
      return res.json({ status: "ok", ...result });
    } catch (err) {
      console.error("[alertmanager-webhook] processing error:", err.message);
      return apiError(
        res,
        500,
        "PROCESSING_FAILED",
        err.message,
        "See docs/STATUS_PAGE.md for troubleshooting.",
      );
    }
  });
}

export default mountAlertmanagerWebhookRoutes;
