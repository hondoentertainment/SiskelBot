/**
 * Slack and Discord integration routes.
 *
 * Slack events: POST /api/integrations/slack/events
 * Slack interactivity (buttons): POST /api/integrations/slack/interactions
 * Discord: POST /api/integrations/discord/interactions
 * Status: GET /api/integrations/bots/status
 */
import express from "express";
import {
  verifySlackSignature,
  handleSlackEvent,
  handleSlackInteraction,
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
  const { apiRoute, apiError, rateLimit } = deps;

  const slackDiscordRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many webhook requests", "Slack/Discord webhooks are limited to 60 per minute.");
    },
  });

  // ─── Slack Events API ──────────────────────────────────────────────────────

  apiRoute("post", "/integrations/slack/events", slackDiscordRateLimiter, async (req, res) => {
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

  // ─── Slack interactive components (button clicks) ──────────────────────────
  // Slack posts these as application/x-www-form-urlencoded with a `payload`
  // field, which the global express.json() does not parse — so we attach a
  // scoped urlencoded parser that also captures the raw body for signing.
  const slackFormParser = express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  });

  apiRoute("post", "/integrations/slack/interactions", slackDiscordRateLimiter, slackFormParser, async (req, res) => {
    const rawBody = req.rawBody || "";
    const timestamp = req.headers["x-slack-request-timestamp"];
    const signature = req.headers["x-slack-signature"];

    if (SLACK_SIGNING_SECRET) {
      const result = verifySlackSignature(SLACK_SIGNING_SECRET, timestamp, rawBody, signature);
      if (!result.valid) {
        return apiError(res, 401, "INVALID_SIGNATURE", result.reason, "Check SLACK_SIGNING_SECRET configuration.");
      }
    }

    let payload;
    try {
      const payloadStr = req.body?.payload || new URLSearchParams(rawBody).get("payload");
      payload = JSON.parse(payloadStr || "{}");
    } catch {
      return apiError(res, 400, "INVALID_INPUT", "Malformed interaction payload");
    }

    try {
      const { status, body } = await handleSlackInteraction(payload);
      return res.status(status).json(body);
    } catch (err) {
      console.error("[slack] Interaction handler error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", "Slack interaction processing failed");
    }
  });

  // ─── Discord Interactions endpoint ─────────────────────────────────────────

  apiRoute("post", "/integrations/discord/interactions", slackDiscordRateLimiter, async (req, res) => {
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
