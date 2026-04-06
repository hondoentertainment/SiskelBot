/**
 * Discord bot integration — webhook/interactions-based (no gateway WebSocket).
 *
 * Inbound: receives Discord Interactions endpoint payloads, handles slash commands.
 * Outbound: sendDiscordMessage / sendDiscordWebhook helpers for notifications.
 */
import { createPublicKey, verify } from "crypto";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DISCORD_API_BASE = "https://discord.com/api/v10";

// Ed25519 DER SPKI prefix for 32-byte public keys
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const INTERACTION_MESSAGE_COMPONENT = 3;

// Interaction response types
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

/**
 * Verify Discord interaction signature using Ed25519.
 * Returns { valid, reason }.
 */
export function verifyDiscordSignature(publicKey, timestamp, body, signature) {
  if (!publicKey) return { valid: false, reason: "DISCORD_PUBLIC_KEY not configured" };
  if (!timestamp || !signature) return { valid: false, reason: "Missing signature headers" };

  try {
    const message = Buffer.from(timestamp + body);
    const sig = Buffer.from(signature, "hex");
    const key = Buffer.from(publicKey, "hex");

    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_DER_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    const valid = verify(null, message, keyObject, sig);
    return valid ? { valid: true } : { valid: false, reason: "Invalid signature" };
  } catch (err) {
    return { valid: false, reason: `Signature verification error: ${err.message}` };
  }
}

/**
 * Post a message to a Discord channel using the Bot Token.
 */
export async function sendDiscordMessage(channelId, content, options = {}) {
  const token = options.token || DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not configured");
  if (!channelId) throw new Error("No Discord channel ID specified");

  const payload = {
    content: typeof content === "string" ? content : undefined,
    ...(options.embeds ? { embeds: options.embeds } : {}),
    ...(options.components ? { components: options.components } : {}),
  };

  const res = await fetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API error: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Send a message via Discord Webhook URL.
 */
export async function sendDiscordWebhook(webhookUrl, payload) {
  const url = webhookUrl || DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("No Discord webhook URL configured");

  const body = typeof payload === "string" ? { content: payload } : payload;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook error: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  // Discord webhooks may return 204 No Content
  if (res.status === 204) return { ok: true };
  return res.json();
}

/**
 * Forward a user message to the internal chat completions endpoint.
 */
async function forwardToChat(text, discordUserId) {
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
      metadata: { source: "discord", discordUserId },
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
 * Edit the original interaction response (for deferred replies).
 */
async function editInteractionResponse(interactionToken, content) {
  const appId = DISCORD_APPLICATION_ID;
  if (!appId) return;

  const res = await fetch(`${DISCORD_API_BASE}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[discord-bot] Failed to edit interaction response:", text.slice(0, 200));
  }
}

/**
 * Handle an incoming Discord Interactions payload.
 * Returns { status, body } to send back to Discord.
 */
export async function handleDiscordInteraction(payload) {
  if (!payload || typeof payload !== "object") {
    return { status: 400, body: { error: "Invalid payload" } };
  }

  // PING — respond with PONG
  if (payload.type === INTERACTION_PING) {
    return { status: 200, body: { type: RESPONSE_PONG } };
  }

  // Application command (slash command)
  if (payload.type === INTERACTION_APPLICATION_COMMAND) {
    const commandName = payload.data?.name;
    const interactionToken = payload.token;

    if (commandName === "ask") {
      const message = payload.data?.options?.find((o) => o.name === "message")?.value || "";
      if (!message) {
        return {
          status: 200,
          body: { type: RESPONSE_CHANNEL_MESSAGE, data: { content: "Please provide a message to ask." } },
        };
      }

      // Defer the response (we need time to call the LLM)
      setImmediate(async () => {
        try {
          const reply = await forwardToChat(message, payload.member?.user?.id || payload.user?.id);
          await editInteractionResponse(interactionToken, reply);
        } catch (err) {
          console.error("[discord-bot] Error processing /ask:", err.message);
          await editInteractionResponse(interactionToken, `Error: ${err.message}`).catch(() => {});
        }
      });

      return {
        status: 200,
        body: { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE },
      };
    }

    if (commandName === "recipe") {
      const recipeName = payload.data?.options?.find((o) => o.name === "name")?.value || "";
      if (!recipeName) {
        return {
          status: 200,
          body: { type: RESPONSE_CHANNEL_MESSAGE, data: { content: "Please provide a recipe name." } },
        };
      }

      setImmediate(async () => {
        try {
          const reply = await forwardToChat(`Run the recipe: ${recipeName}`, payload.member?.user?.id || payload.user?.id);
          await editInteractionResponse(interactionToken, reply);
        } catch (err) {
          console.error("[discord-bot] Error processing /recipe:", err.message);
          await editInteractionResponse(interactionToken, `Error: ${err.message}`).catch(() => {});
        }
      });

      return {
        status: 200,
        body: { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE },
      };
    }

    if (commandName === "status") {
      const port = process.env.PORT || 3000;
      const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        const statusText = data.ok ? ":green_circle: SiskelBot is healthy" : ":red_circle: SiskelBot is unhealthy";
        return {
          status: 200,
          body: {
            type: RESPONSE_CHANNEL_MESSAGE,
            data: { content: `${statusText}\nBackend: ${data.backend || "unknown"}\nUptime: ${data.uptime || "unknown"}` },
          },
        };
      } catch (err) {
        return {
          status: 200,
          body: {
            type: RESPONSE_CHANNEL_MESSAGE,
            data: { content: `:red_circle: Could not reach SiskelBot: ${err.message}` },
          },
        };
      }
    }

    return {
      status: 200,
      body: { type: RESPONSE_CHANNEL_MESSAGE, data: { content: `Unknown command: ${commandName}` } },
    };
  }

  // Message component interactions (buttons, selects)
  if (payload.type === INTERACTION_MESSAGE_COMPONENT) {
    const customId = payload.data?.custom_id || "";
    return {
      status: 200,
      body: {
        type: RESPONSE_CHANNEL_MESSAGE,
        data: { content: `Received interaction: ${customId}` },
      },
    };
  }

  return { status: 200, body: { type: RESPONSE_PONG } };
}

/**
 * Register slash commands with Discord (call once at setup time).
 */
export async function registerDiscordCommands(options = {}) {
  const token = options.token || DISCORD_BOT_TOKEN;
  const appId = options.applicationId || DISCORD_APPLICATION_ID;
  if (!token || !appId) throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID required");

  const commands = [
    {
      name: "ask",
      description: "Ask SiskelBot a question",
      options: [
        {
          name: "message",
          description: "The question to ask",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "recipe",
      description: "Run a SiskelBot recipe",
      options: [
        {
          name: "name",
          description: "The recipe name",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "status",
      description: "Show SiskelBot health status",
    },
  ];

  const res = await fetch(`${DISCORD_API_BASE}/applications/${encodeURIComponent(appId)}/commands`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord command registration error: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Send a notification to Discord when a SiskelBot event fires.
 */
export async function notifyDiscord(eventName, data, options = {}) {
  const channelId = options.channelId;
  const useWebhook = !DISCORD_BOT_TOKEN && DISCORD_WEBHOOK_URL;

  const content = formatEventContent(eventName, data);

  if (useWebhook) {
    return sendDiscordWebhook(DISCORD_WEBHOOK_URL, { content });
  }
  if (DISCORD_BOT_TOKEN && channelId) {
    return sendDiscordMessage(channelId, content);
  }
  return null;
}

function formatEventContent(eventName, data) {
  switch (eventName) {
    case "recipe_executed":
      return `✅ Recipe executed: **${data.recipe || "unknown"}** — ${data.status || "done"}`;
    case "agent_complete":
      return `🤖 Agent completed task in workspace **${data.workspaceId || "default"}**`;
    case "swarm_completed":
      return `🐝 Swarm completed: ${data.summary || "(no summary)"}`;
    case "schedule_completed":
      return `🕐 Scheduled job completed: ${data.schedule || data.name || "unknown"}`;
    default:
      return `Event **${eventName}**: ${JSON.stringify(data).slice(0, 500)}`;
  }
}

export function isDiscordConfigured() {
  return Boolean(DISCORD_BOT_TOKEN || DISCORD_WEBHOOK_URL);
}
