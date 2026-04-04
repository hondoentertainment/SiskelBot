/**
 * Slack bot integration — webhook-based (no persistent WebSocket).
 *
 * Inbound: receives Slack Events API payloads, forwards to chat completions,
 *          posts responses back via chat.postMessage.
 * Outbound: sendSlackMessage / sendSlackNotification helpers for notifications.
 */
import { createHmac, timingSafeEqual } from "crypto";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SLACK_API_BASE = "https://slack.com/api";
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verify the Slack request signature (x-slack-signature / x-slack-request-timestamp).
 * Returns { valid, reason }.
 */
export function verifySlackSignature(signingSecret, timestamp, body, signature) {
  if (!signingSecret) return { valid: false, reason: "SLACK_SIGNING_SECRET not configured" };
  if (!timestamp || !signature) return { valid: false, reason: "Missing signature headers" };

  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return { valid: false, reason: "Invalid timestamp" };
  const age = Math.abs(Date.now() - ts * 1000);
  if (age > SIGNATURE_MAX_AGE_MS) return { valid: false, reason: "Request too old" };

  const baseString = `v0:${timestamp}:${body}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(baseString).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "Invalid signature" };
  }
  return { valid: true };
}

/**
 * Post a message to a Slack channel using the Bot Token.
 */
export async function sendSlackMessage(channel, text, options = {}) {
  const token = options.token || SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");
  const ch = channel || SLACK_DEFAULT_CHANNEL;
  if (!ch) throw new Error("No Slack channel specified");

  const payload = {
    channel: ch,
    text,
    ...(options.thread_ts ? { thread_ts: options.thread_ts } : {}),
    ...(options.blocks ? { blocks: options.blocks } : {}),
  };

  const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || "unknown"}`);
  }
  return data;
}

/**
 * Send a message via Slack Incoming Webhook URL.
 */
export async function sendSlackNotification(webhookUrl, payload) {
  const url = webhookUrl || SLACK_WEBHOOK_URL;
  if (!url) throw new Error("No Slack webhook URL configured");

  const body = typeof payload === "string" ? { text: payload } : payload;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack webhook error: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

/**
 * Forward a user message to the internal chat completions endpoint and return the response text.
 */
async function forwardToChat(text, slackUserId) {
  const port = process.env.PORT || 3000;
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "";

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: text }],
      stream: false,
      metadata: { source: "slack", slackUserId },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Chat API error: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(no response)";
}

/**
 * Handle an incoming Slack Events API request.
 * Returns { status, body } to send back to Slack.
 */
export async function handleSlackEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return { status: 400, body: { error: "Invalid payload" } };
  }

  // URL verification challenge
  if (payload.type === "url_verification") {
    return { status: 200, body: { challenge: payload.challenge } };
  }

  // Event callback
  if (payload.type === "event_callback") {
    const event = payload.event;
    if (!event) return { status: 200, body: { ok: true } };

    const isAppMention = event.type === "app_mention";
    const isDirectMessage = event.type === "message" && event.channel_type === "im" && !event.bot_id && !event.subtype;

    if (isAppMention || isDirectMessage) {
      const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) return { status: 200, body: { ok: true } };

      // Process asynchronously — Slack expects a quick 200
      setImmediate(async () => {
        try {
          const reply = await forwardToChat(text, event.user);
          await sendSlackMessage(event.channel, reply, { thread_ts: event.ts });
        } catch (err) {
          console.error("[slack-bot] Error processing event:", err.message);
          try {
            await sendSlackMessage(event.channel, `Sorry, I encountered an error: ${err.message}`, { thread_ts: event.ts });
          } catch (_) { /* ignore */ }
        }
      });

      return { status: 200, body: { ok: true } };
    }

    return { status: 200, body: { ok: true } };
  }

  return { status: 200, body: { ok: true } };
}

/**
 * Send a notification to Slack when a SiskelBot event fires.
 * Designed to be called from the webhook/notification system.
 */
export async function notifySlack(eventName, data, options = {}) {
  const channel = options.channel || SLACK_DEFAULT_CHANNEL;
  const useWebhook = !SLACK_BOT_TOKEN && SLACK_WEBHOOK_URL;

  const text = formatEventText(eventName, data);

  if (useWebhook) {
    return sendSlackNotification(SLACK_WEBHOOK_URL, { text });
  }
  if (SLACK_BOT_TOKEN && channel) {
    return sendSlackMessage(channel, text);
  }
  // No Slack config — silently skip
  return null;
}

function formatEventText(eventName, data) {
  switch (eventName) {
    case "recipe_executed":
      return `:white_check_mark: Recipe executed: *${data.recipe || "unknown"}* — ${data.status || "done"}`;
    case "agent_complete":
      return `:robot_face: Agent completed task in workspace *${data.workspaceId || "default"}*`;
    case "swarm_completed":
      return `:bee: Swarm completed: ${data.summary || "(no summary)"}`;
    case "schedule_completed":
      return `:clock3: Scheduled job completed: ${data.schedule || data.name || "unknown"}`;
    default:
      return `Event *${eventName}*: ${JSON.stringify(data).slice(0, 500)}`;
  }
}

export function isSlackConfigured() {
  return Boolean(SLACK_BOT_TOKEN || SLACK_WEBHOOK_URL);
}
