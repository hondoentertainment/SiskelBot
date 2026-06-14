/**
 * Startup integration checks.
 * Verifies all configured optional integrations are reachable.
 * Each check returns { name, status: 'ok'|'fail'|'skip', message }.
 */

import { parseMcpServersEnv } from "./mcp-client.js";

const CHECK_TIMEOUT_MS = 5000;

let cachedResults = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms)),
  ]);
}

async function checkBackend() {
  const name = "backend";
  const backend = (process.env.BACKEND || "ollama").toLowerCase();
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const vllmUrl = process.env.VLLM_URL || "http://localhost:8000";
  const openaiKey = process.env.OPENAI_API_KEY;

  let url;
  const headers = {};
  if (backend === "ollama") {
    url = `${ollamaUrl}/api/tags`;
  } else if (backend === "vllm") {
    url = `${vllmUrl}/v1/models`;
  } else if (backend === "openai") {
    if (!openaiKey) return { name, status: "skip", message: "OPENAI_API_KEY not set" };
    url = "https://api.openai.com/v1/models";
    headers.Authorization = `Bearer ${openaiKey}`;
  } else {
    return { name, status: "skip", message: `Unknown backend: ${backend}` };
  }

  try {
    const r = await withTimeout(
      fetch(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }),
      CHECK_TIMEOUT_MS,
    );
    if (r.ok) return { name, status: "ok", message: `${backend} reachable` };
    return { name, status: "fail", message: `${backend} returned HTTP ${r.status}` };
  } catch (err) {
    return { name, status: "fail", message: `${backend} unreachable: ${err.message}` };
  }
}

async function checkStorage() {
  const name = "storage";
  const storageBackend = process.env.STORAGE_BACKEND || "json";
  try {
    const mod = await import("./storage.js");
    await withTimeout(mod.listWorkspaces("anonymous"), CHECK_TIMEOUT_MS);
    return { name, status: "ok", message: `${storageBackend} storage writable` };
  } catch (err) {
    return { name, status: "fail", message: `${storageBackend} storage error: ${err.message}` };
  }
}

async function checkSlack() {
  const name = "slack";
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { name, status: "skip", message: "SLACK_BOT_TOKEN not set" };

  try {
    const r = await withTimeout(
      fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
      CHECK_TIMEOUT_MS,
    );
    if (!r.ok) return { name, status: "fail", message: `Slack API returned HTTP ${r.status}` };
    const data = await r.json();
    if (data.ok) return { name, status: "ok", message: `Slack connected as ${data.user || "bot"}` };
    return { name, status: "fail", message: `Slack auth failed: ${data.error || "unknown"}` };
  } catch (err) {
    return { name, status: "fail", message: `Slack unreachable: ${err.message}` };
  }
}

async function checkDiscord() {
  const name = "discord";
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return { name, status: "skip", message: "DISCORD_BOT_TOKEN not set" };

  try {
    const r = await withTimeout(
      fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
      CHECK_TIMEOUT_MS,
    );
    if (!r.ok) return { name, status: "fail", message: `Discord API returned HTTP ${r.status}` };
    const data = await r.json();
    return { name, status: "ok", message: `Discord connected as ${data.username || "bot"}` };
  } catch (err) {
    return { name, status: "fail", message: `Discord unreachable: ${err.message}` };
  }
}

async function checkEmail() {
  const name = "email";
  const host = process.env.SMTP_HOST;
  if (!host) return { name, status: "skip", message: "SMTP_HOST not set" };

  try {
    const net = await import("net");
    const port = Number(process.env.SMTP_PORT) || 587;
    const connected = await withTimeout(
      new Promise((resolve, reject) => {
        const sock = net.default.createConnection({ host, port, timeout: CHECK_TIMEOUT_MS }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", (err) => {
          sock.destroy();
          reject(err);
        });
        sock.on("timeout", () => {
          sock.destroy();
          reject(new Error("Connection timeout"));
        });
      }),
      CHECK_TIMEOUT_MS,
    );
    if (connected) return { name, status: "ok", message: `SMTP ${host}:${port} reachable` };
    return { name, status: "fail", message: `SMTP ${host}:${port} not reachable` };
  } catch (err) {
    return { name, status: "fail", message: `SMTP error: ${err.message}` };
  }
}

async function checkJira() {
  const name = "jira";
  const jiraUrl = (process.env.JIRA_URL || "").replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!jiraUrl || !email || !token) return { name, status: "skip", message: "JIRA_URL/JIRA_EMAIL/JIRA_API_TOKEN not set" };

  try {
    const auth = Buffer.from(`${email}:${token}`).toString("base64");
    const r = await withTimeout(
      fetch(`${jiraUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
      CHECK_TIMEOUT_MS,
    );
    if (r.ok) return { name, status: "ok", message: "Jira API reachable" };
    return { name, status: "fail", message: `Jira returned HTTP ${r.status}` };
  } catch (err) {
    return { name, status: "fail", message: `Jira unreachable: ${err.message}` };
  }
}

async function checkLinear() {
  const name = "linear";
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return { name, status: "skip", message: "LINEAR_API_KEY not set" };

  try {
    const r = await withTimeout(
      fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { id } }" }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }),
      CHECK_TIMEOUT_MS,
    );
    if (r.ok) return { name, status: "ok", message: "Linear API reachable" };
    return { name, status: "fail", message: `Linear returned HTTP ${r.status}` };
  } catch (err) {
    return { name, status: "fail", message: `Linear unreachable: ${err.message}` };
  }
}

async function checkRedis() {
  const name = "redis";
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return { name, status: "skip", message: "REDIS_URL not set" };

  try {
    const url = new URL(redisUrl);
    const net = await import("net");
    const port = Number(url.port) || 6379;
    const host = url.hostname || "localhost";
    const connected = await withTimeout(
      new Promise((resolve, reject) => {
        const sock = net.default.createConnection({ host, port, timeout: CHECK_TIMEOUT_MS }, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", (err) => {
          sock.destroy();
          reject(err);
        });
        sock.on("timeout", () => {
          sock.destroy();
          reject(new Error("Connection timeout"));
        });
      }),
      CHECK_TIMEOUT_MS,
    );
    if (connected) return { name, status: "ok", message: `Redis ${host}:${port} reachable` };
    return { name, status: "fail", message: `Redis ${host}:${port} not reachable` };
  } catch (err) {
    return { name, status: "fail", message: `Redis error: ${err.message}` };
  }
}

async function checkMcpServers() {
  const name = "mcp-servers";
  const servers = parseMcpServersEnv();
  if (servers.length === 0) return { name, status: "skip", message: "MCP_SERVERS not set" };

  const results = [];
  for (const server of servers) {
    if (server.type === "http") {
      try {
        const r = await withTimeout(
          fetch(server.target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", params: {}, id: "startup-check" }),
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          }),
          CHECK_TIMEOUT_MS,
        );
        results.push(r.ok ? "ok" : "fail");
      } catch {
        results.push("fail");
      }
    } else {
      results.push("skip");
    }
  }

  const okCount = results.filter((r) => r === "ok").length;
  const failCount = results.filter((r) => r === "fail").length;
  if (failCount > 0) {
    return { name, status: "fail", message: `${failCount}/${servers.length} MCP server(s) unreachable` };
  }
  if (okCount > 0) {
    return { name, status: "ok", message: `${okCount}/${servers.length} MCP server(s) reachable` };
  }
  return { name, status: "skip", message: `${servers.length} MCP server(s) configured (stdio only)` };
}

export async function runStartupChecks({ log = true } = {}) {
  const results = [];

  results.push(await checkBackend());
  results.push(await checkStorage());
  results.push(await checkSlack());
  results.push(await checkDiscord());
  results.push(await checkEmail());
  results.push(await checkJira());
  results.push(await checkLinear());
  results.push(await checkRedis());
  results.push(await checkMcpServers());

  if (log) {
    for (const r of results) {
      const status = r.status === "ok" ? "ok" : r.status === "skip" ? "skip" : "fail";
      console.log(`  [${status}] ${r.name}: ${r.message}`);
    }
  }

  cachedResults = results;
  cachedAt = Date.now();

  return results;
}

export function getCachedResults() {
  if (cachedResults && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResults;
  }
  return null;
}
