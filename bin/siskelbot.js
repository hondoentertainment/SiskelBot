#!/usr/bin/env node
/**
 * Phase 38: CLI Client for SiskelBot
 * Usage: npx . chat "Hello" | npm run cli -- chat "Hello"
 * Commands: chat, context list, context add, recipes list, recipes run <name>, config
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env if dotenv available (project has it)
try {
  const dotenv = (await import("dotenv")).default;
  dotenv.config();
} catch {
  // dotenv not available, rely on env
}

const BASE_URL = process.env.SISKELBOT_URL || "http://localhost:3000";
const API_KEY = process.env.SISKELBOT_API_KEY || process.env.API_KEY;

function getUrl(flagIndex) {
  const idx = process.argv.indexOf("--url");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].replace(/\/$/, "");
  return BASE_URL.replace(/\/$/, "");
}

function getApiKey(flagIndex) {
  const idx = process.argv.indexOf("--api-key");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return API_KEY;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function getFlag(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

function getWorkspace() {
  return getFlag("--workspace") || "default";
}

function parseArgs() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const json = hasFlag("--json");
  return { args, json };
}

function headers(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, redirect: "follow" });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers) };
}

function err(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function help() {
  console.log(`SiskelBot CLI (Phase 38)

Usage:
  npx . <command> [options]
  npm run cli -- <command> [options]

Commands:
  chat "message"              Send message, stream response
    --no-stream               Wait for full response
    --model <name>            Model (e.g. gpt-4)
    --agent                   Set agentMode (tool loop on server)
    --swarm                   Set swarmMode (requires ENABLE_AGENT_SWARM on server)
    --allow-execution         agentOptions.allowExecution (recipe steps; server must allow)
    --max-iterations <n>      agentOptions.maxIterations
    --url <url>               Base URL (default: SISKELBOT_URL or http://localhost:3000)
    --api-key <key>           API key (default: SISKELBOT_API_KEY or API_KEY)
    --workspace <id>          Workspace (default: default)
    --json                    Machine-readable output

  context list                List context documents
  context add [--file <path>] Add context from file or stdin (pipe)
    --title <title>           Required when not from file (filename used)
    --url, --api-key, --workspace, --json

  recipes list                List recipes
  recipes run <name>          Run a recipe by name
    --url, --api-key, --workspace, --json

  config                      Show current config (backend, url, auth status)
    --url, --api-key, --json

Environment:
  SISKELBOT_URL               Base URL (default: http://localhost:3000)
  SISKELBOT_API_KEY           API key (also API_KEY)
  .env                        Loaded from project root if dotenv available
`);
}

async function cmdConfig(baseUrl, apiKey, json) {
  try {
    const r = await fetchJson(`${baseUrl}/config`);
    if (!r.ok) {
      if (r.status === 0 || r.body?.message?.includes("ECONNREFUSED")) err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
      err(r.body?.error || `GET /config failed: ${r.status}`);
    }
    const cfg = r.body;
    if (json) {
      console.log(JSON.stringify({ baseUrl, apiKey: apiKey ? "***" : null, config: cfg }, null, 2));
      return;
    }
    console.log("Base URL:", baseUrl);
    console.log("Auth:", apiKey ? "configured" : "none (API_KEY may be required)");
    console.log("Backend:", cfg.backend || "unknown");
    console.log("Requires API key:", cfg.requiresApiKey || false);
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdChat(baseUrl, apiKey, args, json, noStream, model, workspace) {
  const msg = args[0];
  if (!msg) err('Usage: siskelbot chat "Your message"');

  const agentMode = hasFlag("--agent");
  const swarmMode = hasFlag("--swarm");
  const allowExecution = hasFlag("--allow-execution");
  const maxIterRaw = getFlag("--max-iterations");

  const body = {
    model: model || undefined,
    messages: [{ role: "user", content: msg }],
    stream: !noStream,
  };
  if (agentMode) body.agentMode = true;
  if (swarmMode) body.swarmMode = true;

  const needAgentOpts =
    workspace !== "default" ||
    allowExecution ||
    agentMode ||
    swarmMode ||
    (maxIterRaw != null && String(maxIterRaw).trim() !== "");
  if (needAgentOpts) {
    body.agentOptions = { workspace };
    if (allowExecution) body.agentOptions.allowExecution = true;
    if (maxIterRaw != null && String(maxIterRaw).trim() !== "") {
      const n = Number(maxIterRaw);
      if (Number.isFinite(n) && n >= 1) body.agentOptions.maxIterations = Math.floor(n);
    }
  }

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      if (res.status === 401) err(errBody.error || "Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
      if (res.status === 403) err(errBody.error || "Forbidden.");
      err(errBody.error || `Request failed: ${res.status}`);
    }

    if (noStream) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      if (json) console.log(JSON.stringify(data, null, 2));
      else console.log(content || "(no content)");
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";
      if (json) console.log(JSON.stringify(data, null, 2));
      else console.log(content || "(no content)");
      return;
    }

    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              if (!json) process.stdout.write(delta);
            }
          } catch {}
        }
      }
    }
    if (json && full) console.log("\n" + JSON.stringify({ content: full }));
    else if (!full && !json) console.log();
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function apiGet(baseUrl, apiKey, path, workspace) {
  const url = `${baseUrl}${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}`;
  const r = await fetchJson(url, { headers: headers(apiKey) });
  if (!r.ok) {
    if (r.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
    if (r.status === 0) err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    throw new Error(r.body?.error || `Request failed: ${r.status}`);
  }
  return r.body;
}

async function apiPost(baseUrl, apiKey, path, body) {
  const r = await fetchJson(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) {
    if (r.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
    if (r.status === 0) err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    throw new Error(r.body?.error || `Request failed: ${r.status}`);
  }
  return r.body;
}

async function cmdContextList(baseUrl, apiKey, workspace, json) {
  try {
    const data = await apiGet(baseUrl, apiKey, "/api/context", workspace);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data?.items || [];
    if (items.length === 0) {
      console.log("No context documents.");
      return;
    }
    for (const it of items) {
      console.log(`- ${it.title} (${it.id})`);
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdContextAdd(baseUrl, apiKey, args, json, workspace) {
  const filePath = getFlag("--file");
  const titleFlag = getFlag("--title");

  let title, content;
  if (filePath) {
    try {
      content = readFileSync(resolve(process.cwd(), filePath), "utf8");
      title = titleFlag || filePath.split(/[/\\]/).pop() || "untitled";
    } catch (e) {
      err(`Cannot read file: ${filePath}`);
    }
  } else {
    title = titleFlag || args[0];
    if (!title) err('Usage: siskelbot context add --title "Title" or --file <path> or pipe content');
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      content = Buffer.concat(chunks).toString("utf8");
    } else {
      content = args.slice(1).join(" ") || "";
    }
    if (!title) err("--title required when not using --file");
  }

  try {
    const created = await apiPost(baseUrl, apiKey, "/api/context", {
      title,
      content: content || "",
      workspace,
    });
    if (json) {
      console.log(JSON.stringify(created, null, 2));
      return;
    }
    console.log("Added:", created.title, "(" + created.id + ")");
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    if (e.message?.includes("title required")) err("title required. Use --title or --file.");
    err(e.message || String(e), 1);
  }
}

async function cmdRecipesList(baseUrl, apiKey, workspace, json) {
  try {
    const data = await apiGet(baseUrl, apiKey, "/api/recipes", workspace);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data?.items || [];
    if (items.length === 0) {
      console.log("No recipes.");
      return;
    }
    for (const it of items) {
      console.log(`- ${it.name} (${it.id})`);
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdRecipesRun(baseUrl, apiKey, name, workspace, json) {
  if (!name) err("Usage: siskelbot recipes run <name>");

  try {
    const data = await apiGet(baseUrl, apiKey, "/api/recipes", workspace);
    const items = data?.items || [];
    const recipe = items.find((r) => r.name.toLowerCase() === name.toLowerCase()) || items.find((r) => r.id === name);
    if (!recipe) err(`Recipe not found: ${name}`);

    const r = await fetchJson(`${baseUrl}/api/schedules/run-now/${recipe.id}`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ workspace }),
    });

    if (!r.ok) {
      if (r.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
      if (r.status === 400) err(r.body?.error || r.body?.hint || "Run failed.");
      err(r.body?.error || `Request failed: ${r.status}`);
    }

    if (json) console.log(JSON.stringify(r.body, null, 2));
    else console.log("Recipe run completed.");
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function main() {
  const { args, json } = parseArgs();
  const baseUrl = getUrl();
  const apiKey = getApiKey();
  const workspace = getWorkspace();

  if (args.length === 0 || args[0] === "help" || hasFlag("--help") || hasFlag("-h")) {
    help();
    process.exit(0);
  }

  const cmd = args[0];
  const sub = args[1];

  try {
    if (cmd === "config") {
      await cmdConfig(baseUrl, apiKey, json);
    } else if (cmd === "chat") {
      await cmdChat(baseUrl, apiKey, args.slice(1), json, hasFlag("--no-stream"), getFlag("--model") || null, workspace);
    } else if (cmd === "context") {
      if (sub === "list") await cmdContextList(baseUrl, apiKey, workspace, json);
      else if (sub === "add") await cmdContextAdd(baseUrl, apiKey, args.slice(2), json, workspace);
      else err('Usage: siskelbot context list | context add [--file <path>] [--title "Title"]');
    } else if (cmd === "recipes") {
      if (sub === "list") await cmdRecipesList(baseUrl, apiKey, workspace, json);
      else if (sub === "run") await cmdRecipesRun(baseUrl, apiKey, args[2], workspace, json);
      else err('Usage: siskelbot recipes list | recipes run <name>');
    } else {
      err(`Unknown command: ${cmd}. Run with --help for usage.`);
    }
    process.exit(0);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

main();
