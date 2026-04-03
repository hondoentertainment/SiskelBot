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

function getAdminKey() {
  const idx = process.argv.indexOf("--admin-key");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.SISKELBOT_ADMIN_KEY || process.env.ADMIN_API_KEY || null;
}

function getBackupKey() {
  const idx = process.argv.indexOf("--backup-key");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.SISKELBOT_BACKUP_KEY || process.env.BACKUP_ADMIN_KEY || null;
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

  health                      Quick health check (colored status)
    --url, --json

  admin summary               Show admin dashboard summary
    --admin-key <key>         Admin key (default: SISKELBOT_ADMIN_KEY or ADMIN_API_KEY)
    --url, --json

  admin keys list             List API keys
    --admin-key <key>         Admin key
    --url, --json

  backup create               Trigger a backup
    --backup-key <key>        Backup key (default: SISKELBOT_BACKUP_KEY or BACKUP_ADMIN_KEY)
    --url, --json

  backup list                 List available backups
    --backup-key <key>        Backup key
    --url, --json

  schedules list              List scheduled recipes
    --url, --api-key, --json

  webhooks list               List registered webhooks
    --url, --api-key, --json

Environment:
  SISKELBOT_URL               Base URL (default: http://localhost:3000)
  SISKELBOT_API_KEY           API key (also API_KEY)
  SISKELBOT_ADMIN_KEY         Admin API key (also ADMIN_API_KEY)
  SISKELBOT_BACKUP_KEY        Backup admin key (also BACKUP_ADMIN_KEY)
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

function adminHeaders(adminKey) {
  const h = { "Content-Type": "application/json" };
  if (adminKey) h["x-admin-key"] = adminKey;
  return h;
}

function backupHeaders(backupKey) {
  const h = { "Content-Type": "application/json" };
  if (backupKey) h["x-admin-key"] = backupKey;
  return h;
}

async function cmdAdminSummary(baseUrl, json) {
  const adminKey = getAdminKey();
  if (!adminKey) err("Admin key required. Set SISKELBOT_ADMIN_KEY, ADMIN_API_KEY, or use --admin-key.");
  try {
    const r = await fetchJson(`${baseUrl}/api/admin/summary`, { headers: adminHeaders(adminKey) });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) err("Unauthorized. Check your admin key.");
      err(r.body?.error || `GET /api/admin/summary failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log("Admin Dashboard Summary");
    console.log("-----------------------");
    console.log("Users:", data.userCount ?? data.users ?? "N/A");
    console.log("Workspaces:", data.workspaceCount ?? data.workspaces ?? "N/A");
    const audits = data.recentAudit || data.recentAuditEntries || [];
    if (audits.length > 0) {
      console.log("\nRecent Audit Entries:");
      for (const entry of audits) {
        console.log(`  - ${entry.action || entry.type || "unknown"} ${entry.timestamp || entry.createdAt || ""}`);
      }
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdAdminKeysList(baseUrl, json) {
  const adminKey = getAdminKey();
  if (!adminKey) err("Admin key required. Set SISKELBOT_ADMIN_KEY, ADMIN_API_KEY, or use --admin-key.");
  try {
    const r = await fetchJson(`${baseUrl}/api/admin/keys`, { headers: adminHeaders(adminKey) });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) err("Unauthorized. Check your admin key.");
      err(r.body?.error || `GET /api/admin/keys failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const keys = data.keys || data.items || (Array.isArray(data) ? data : []);
    if (keys.length === 0) {
      console.log("No API keys found.");
      return;
    }
    for (const k of keys) {
      const scopes = Array.isArray(k.scopes) ? k.scopes.join(", ") : k.scopes || "all";
      const created = k.createdAt || k.created || "unknown";
      console.log(`- ${k.id || k.keyId}: scopes=[${scopes}] created=${created}`);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdBackupCreate(baseUrl, json) {
  const backupKey = getBackupKey();
  if (!backupKey) err("Backup key required. Set SISKELBOT_BACKUP_KEY, BACKUP_ADMIN_KEY, or use --backup-key.");
  try {
    const r = await fetchJson(`${baseUrl}/api/backup`, {
      method: "POST",
      headers: backupHeaders(backupKey),
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) err("Unauthorized. Check your backup key.");
      err(r.body?.error || `POST /api/backup failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log("Backup created:", data.filename || data.file || data.name || "success");
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdBackupList(baseUrl, json) {
  const backupKey = getBackupKey();
  if (!backupKey) err("Backup key required. Set SISKELBOT_BACKUP_KEY, BACKUP_ADMIN_KEY, or use --backup-key.");
  try {
    const r = await fetchJson(`${baseUrl}/api/backup/list`, { headers: backupHeaders(backupKey) });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) err("Unauthorized. Check your backup key.");
      err(r.body?.error || `GET /api/backup/list failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const backups = data.backups || data.items || (Array.isArray(data) ? data : []);
    if (backups.length === 0) {
      console.log("No backups found.");
      return;
    }
    for (const b of backups) {
      const name = b.filename || b.file || b.name || "unknown";
      const size = b.size != null ? ` (${b.size} bytes)` : "";
      console.log(`- ${name}${size}`);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdHealth(baseUrl, json) {
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  try {
    const r = await fetchJson(`${baseUrl}/health/ready`);
    if (json) {
      console.log(JSON.stringify({ status: r.status, ...r.body }, null, 2));
      return;
    }
    if (!r.ok) {
      console.log(`${RED}Health check failed: ${r.status}${RESET}`);
      process.exit(1);
    }
    const data = r.body || {};
    const status = data.status || "ok";
    const color = status === "ok" || status === "ready" || status === "healthy" ? GREEN : RED;
    console.log(`Status: ${color}${status}${RESET}`);
    if (data.backend != null) {
      const bColor = data.backend === "ok" || data.backend === "connected" || data.backend === true ? GREEN : RED;
      console.log(`Backend: ${bColor}${data.backend}${RESET}`);
    }
    if (data.storage != null) {
      const sColor = data.storage === "ok" || data.storage === "connected" || data.storage === true ? GREEN : RED;
      console.log(`Storage: ${sColor}${data.storage}${RESET}`);
    }
    // Show any additional fields
    for (const [key, val] of Object.entries(data)) {
      if (key === "status" || key === "backend" || key === "storage") continue;
      console.log(`${key}: ${val}`);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") {
      console.log(`${RED}Connection refused: ${baseUrl}. Is the server running?${RESET}`);
      process.exit(1);
    }
    err(e.message || String(e), 1);
  }
}

async function cmdSchedulesList(baseUrl, apiKey, json) {
  try {
    const r = await fetchJson(`${baseUrl}/api/schedules`, { headers: headers(apiKey) });
    if (!r.ok) {
      if (r.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
      err(r.body?.error || `GET /api/schedules failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data.schedules || data.items || (Array.isArray(data) ? data : []);
    if (items.length === 0) {
      console.log("No schedules found.");
      return;
    }
    for (const s of items) {
      const name = s.name || s.recipeName || s.id || "unnamed";
      const cron = s.cron || s.cronExpression || "N/A";
      const next = s.nextRun || s.nextRunAt || "N/A";
      const enabled = s.enabled != null ? (s.enabled ? "enabled" : "disabled") : "unknown";
      console.log(`- ${name}: cron="${cron}" next=${next} [${enabled}]`);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdWebhooksList(baseUrl, apiKey, json) {
  try {
    const r = await fetchJson(`${baseUrl}/api/webhooks`, { headers: headers(apiKey) });
    if (!r.ok) {
      if (r.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
      err(r.body?.error || `GET /api/webhooks failed: ${r.status}`);
    }
    const data = r.body;
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data.webhooks || data.items || (Array.isArray(data) ? data : []);
    if (items.length === 0) {
      console.log("No webhooks found.");
      return;
    }
    for (const w of items) {
      const url = w.url || w.endpoint || "unknown";
      const events = Array.isArray(w.events) ? w.events.join(", ") : w.events || "all";
      const active = w.active != null ? (w.active ? "active" : "inactive") : "unknown";
      console.log(`- ${url}: events=[${events}] [${active}]`);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
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
    } else if (cmd === "health") {
      await cmdHealth(baseUrl, json);
    } else if (cmd === "admin") {
      if (sub === "summary") await cmdAdminSummary(baseUrl, json);
      else if (sub === "keys" && args[2] === "list") await cmdAdminKeysList(baseUrl, json);
      else err("Usage: siskelbot admin summary | admin keys list");
    } else if (cmd === "backup") {
      if (sub === "create") await cmdBackupCreate(baseUrl, json);
      else if (sub === "list") await cmdBackupList(baseUrl, json);
      else err("Usage: siskelbot backup create | backup list");
    } else if (cmd === "schedules") {
      if (sub === "list") await cmdSchedulesList(baseUrl, apiKey, json);
      else err("Usage: siskelbot schedules list");
    } else if (cmd === "webhooks") {
      if (sub === "list") await cmdWebhooksList(baseUrl, apiKey, json);
      else err("Usage: siskelbot webhooks list");
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
