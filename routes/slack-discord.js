/**
 * Slack and Discord integration routes.
 *
 * Slack: POST /api/integrations/slack/events
 * Discord: POST /api/integrations/discord/interactions
 * Status: GET /api/integrations/bots/status
 */
import {
  verifySlackSignature,
  handleSlackEvent,
  isSlackConfigured,
} from "../lib/slack-bot.js";
import {
  verifyDiscordSignature,
  handleDiscordInteraction,
  isDiscordConfigured,
} from "../lib/discord-bot.js";

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || "";

export function mountSlackDiscordRoutes(app, deps) {
  const { apiRoute, apiError, integrationRateLimiter } = deps;

  // ─── Slack Events API ──────────────────────────────────────────────────────

  apiRoute("post", "/integrations/slack/events", integrationRateLimiter, async (req, res) => {
    // Slack sends raw body — we need it for signature verification.
    // Express json() middleware already parsed it, but we stored rawBody via middleware.
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const timestamp = req.headers["x-slack-request-timestamp"];
    const signature = req.headers["x-slack-signature"];

    // Verify signature if signing secret is configured
    if (SLACK_SIGNING_SECRET) {
      const result = verifySlackSignature(SLACK_SIGNING_SECRET, timestamp, rawBody, signature);
      if (!result.valid) {
        return apiError(res, 401, "INVALID_SIGNATURE", result.reason, "Check SLACK_SIGNING_SECRET configuration.");
      }
    }

    try {
      const { status, body } = await handleSlackEvent(req.body);
      return res.status(status).json(body);
    } catch (err) {
      console.error("[slack] Event handler error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Slack event processing failed");
    }
  });

  // ─── Discord Interactions endpoint ─────────────────────────────────────────

  apiRoute("post", "/integrations/discord/interactions", integrationRateLimiter, async (req, res) => {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const timestamp = req.headers["x-signature-timestamp"];
    const signature = req.headers["x-signature-ed25519"];

    // Verify signature if public key is configured
    if (DISCORD_PUBLIC_KEY) {
      const result = verifyDiscordSignature(DISCORD_PUBLIC_KEY, timestamp, rawBody, signature);
      if (!result.valid) {
        return apiError(res, 401, "INVALID_SIGNATURE", result.reason, "Check DISCORD_PUBLIC_KEY configuration.");
      }
    }

    try {
      const { status, body } = await handleDiscordInteraction(req.body);
      return res.status(status).json(body);
    } catch (err) {
      console.error("[discord] Interaction handler error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Discord interaction processing failed");
    }
  });

  // ─── Bot integration status ────────────────────────────────────────────────

  apiRoute("get", "/integrations/bots/status", (req, res) => {
    res.json({
      slack: {
        configured: isSlackConfigured(),
        hasToken: Boolean(process.env.SLACK_BOT_TOKEN),
        hasWebhook: Boolean(process.env.SLACK_WEBHOOK_URL),
        hasSigningSecret: Boolean(SLACK_SIGNING_SECRET),
      },
      discord: {
        configured: isDiscordConfigured(),
        hasToken: Boolean(process.env.DISCORD_BOT_TOKEN),
        hasWebhook: Boolean(process.env.DISCORD_WEBHOOK_URL),
        hasPublicKey: Boolean(DISCORD_PUBLIC_KEY),
        hasApplicationId: Boolean(process.env.DISCORD_APPLICATION_ID),
      },
    });
  });
}
