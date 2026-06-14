#!/usr/bin/env node

/**
 * Interactive setup wizard for SiskelBot.
 *
 * Prompts the user for configuration choices (backend, storage, API keys,
 * integrations) and writes a .env file. Uses only the Node.js built-in
 * readline module — no external dependencies.
 *
 * Usage:
 *   node scripts/setup-wizard.mjs
 */

import { createInterface } from "node:readline";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function choose(question, options, defaultIndex = 0) {
  const labels = options
    .map((opt, i) => (i === defaultIndex ? `[${opt}]` : opt))
    .join(" / ");
  const raw = await ask(`${question} (${labels}): `);
  if (!raw) return options[defaultIndex];
  const match = options.find(
    (o) => o.toLowerCase() === raw.toLowerCase()
  );
  return match || options[defaultIndex];
}

async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const raw = await ask(`${question} ${hint}: `);
  if (!raw) return defaultYes;
  return raw.toLowerCase().startsWith("y");
}

function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log("===========================================");
  console.log("  Welcome to SiskelBot Setup!");
  console.log("===========================================");
  console.log("");

  if (existsSync(ENV_PATH)) {
    const overwrite = await confirm(
      "A .env file already exists. Overwrite it?"
    );
    if (!overwrite) {
      console.log("Setup cancelled. Existing .env left unchanged.");
      rl.close();
      process.exit(0);
    }
  }

  const env = {};

  // -- Backend ---------------------------------------------------------------

  console.log("");
  console.log("--- LLM Backend ---");
  console.log("");

  const backend = await choose(
    "Select your LLM backend",
    ["Ollama", "vLLM", "OpenAI"],
    0
  );
  env.BACKEND = backend.toLowerCase();

  if (env.BACKEND === "ollama") {
    const url = await ask(
      "Ollama server URL [http://localhost:11434]: "
    );
    env.OLLAMA_URL = url || "http://localhost:11434";
  } else if (env.BACKEND === "vllm") {
    const url = await ask("vLLM server URL [http://localhost:8000]: ");
    env.VLLM_URL = url || "http://localhost:8000";
  } else if (env.BACKEND === "openai") {
    let key = "";
    while (!key) {
      key = await ask("Enter your OpenAI API key: ");
      if (!key) {
        console.log("  An OpenAI API key is required when using the OpenAI backend.");
      }
    }
    env.OPENAI_API_KEY = key;
  }

  // -- Storage ---------------------------------------------------------------

  console.log("");
  console.log("--- Storage Backend ---");
  console.log("");

  const storage = await choose(
    "Select storage backend",
    ["JSON", "SQLite", "PostgreSQL"],
    0
  );

  if (storage === "JSON") {
    env.STORAGE_BACKEND = "json";
    const storagePath = await ask("Storage path [./data]: ");
    env.STORAGE_PATH = storagePath || "./data";
  } else if (storage === "SQLite") {
    env.STORAGE_BACKEND = "sqlite";
  } else if (storage === "PostgreSQL") {
    env.STORAGE_BACKEND = "postgres";
    let dbUrl = "";
    while (!dbUrl) {
      dbUrl = await ask(
        "Enter PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname): "
      );
      if (!dbUrl) {
        console.log("  A connection string is required for PostgreSQL.");
      }
    }
    env.DATABASE_URL = dbUrl;
  }

  // -- Server security -------------------------------------------------------

  console.log("");
  console.log("--- Server Security ---");
  console.log("");

  const apiKeyChoice = await choose(
    "Set an API key to protect your server",
    ["Auto-generate", "Custom", "None"],
    0
  );

  if (apiKeyChoice === "Auto-generate") {
    env.API_KEY = generateSecret(24);
    console.log(`  Generated API key: ${env.API_KEY}`);
  } else if (apiKeyChoice === "Custom") {
    let key = "";
    while (!key) {
      key = await ask("Enter your API key: ");
      if (!key) console.log("  API key cannot be empty.");
    }
    env.API_KEY = key;
  }

  const adminKeyChoice = await choose(
    "Set an admin API key",
    ["Auto-generate", "Custom", "None"],
    0
  );

  if (adminKeyChoice === "Auto-generate") {
    env.ADMIN_API_KEY = generateSecret(24);
    console.log(`  Generated admin API key: ${env.ADMIN_API_KEY}`);
  } else if (adminKeyChoice === "Custom") {
    let key = "";
    while (!key) {
      key = await ask("Enter your admin API key: ");
      if (!key) console.log("  Admin API key cannot be empty.");
    }
    env.ADMIN_API_KEY = key;
  }

  env.SESSION_SECRET = generateSecret(32);

  // -- Port ------------------------------------------------------------------

  const port = await ask("Server port [3000]: ");
  env.PORT = port || "3000";

  // -- Integrations ----------------------------------------------------------

  console.log("");
  console.log("--- Integrations (optional) ---");
  console.log("");

  const enableSlack = await confirm("Enable Slack integration?");
  if (enableSlack) {
    const token = await ask("Slack bot token (xoxb-...): ");
    if (token) env.SLACK_BOT_TOKEN = token;
    const signingSecret = await ask("Slack signing secret: ");
    if (signingSecret) env.SLACK_SIGNING_SECRET = signingSecret;
  }

  const enableDiscord = await confirm("Enable Discord integration?");
  if (enableDiscord) {
    const token = await ask("Discord bot token: ");
    if (token) env.DISCORD_BOT_TOKEN = token;
    const appId = await ask("Discord application ID: ");
    if (appId) env.DISCORD_APPLICATION_ID = appId;
    const pubKey = await ask("Discord public key: ");
    if (pubKey) env.DISCORD_PUBLIC_KEY = pubKey;
  }

  const enableEmail = await confirm("Enable email notifications (SMTP)?");
  if (enableEmail) {
    const host = await ask("SMTP host: ");
    if (host) env.SMTP_HOST = host;
    const smtpPort = await ask("SMTP port [587]: ");
    env.SMTP_PORT = smtpPort || "587";
    const user = await ask("SMTP username: ");
    if (user) env.SMTP_USER = user;
    const pass = await ask("SMTP password: ");
    if (pass) env.SMTP_PASS = pass;
    const from = await ask("Sender email address: ");
    if (from) env.SMTP_FROM = from;
  }

  // -- Redis -----------------------------------------------------------------

  const enableRedis = await confirm("Enable Redis (for caching and pubsub)?");
  if (enableRedis) {
    const redisUrl = await ask(
      "Redis URL [redis://localhost:6379]: "
    );
    env.REDIS_URL = redisUrl || "redis://localhost:6379";
  }

  // -- Production defaults ---------------------------------------------------

  env.NODE_ENV = "production";

  // -- Write .env ------------------------------------------------------------

  console.log("");
  console.log("--- Writing Configuration ---");
  console.log("");

  const lines = [
    "# =============================================================================",
    "# SiskelBot — Generated by setup-wizard.mjs",
    `# Generated on ${new Date().toISOString()}`,
    "# =============================================================================",
    "",
  ];

  for (const [key, value] of Object.entries(env)) {
    // Quote values that contain spaces or special characters
    const needsQuotes = /[\s#"'\\$]/.test(value);
    lines.push(needsQuotes ? `${key}="${value}"` : `${key}=${value}`);
  }

  lines.push(""); // trailing newline

  writeFileSync(ENV_PATH, lines.join("\n"), "utf8");

  console.log(`Configuration saved to ${ENV_PATH}`);
  console.log("");

  // -- Summary ---------------------------------------------------------------

  console.log("===========================================");
  console.log("  Setup Complete!");
  console.log("===========================================");
  console.log("");
  console.log(`  Backend:     ${env.BACKEND}`);
  console.log(`  Storage:     ${env.STORAGE_BACKEND}`);
  console.log(`  Port:        ${env.PORT}`);
  if (env.API_KEY) {
    console.log(`  API Key:     ${env.API_KEY}`);
  }
  if (env.ADMIN_API_KEY) {
    console.log(`  Admin Key:   ${env.ADMIN_API_KEY}`);
  }
  console.log("");
  console.log("Run `npm start` to launch SiskelBot!");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("Setup wizard failed:", err.message);
  rl.close();
  process.exit(1);
});
