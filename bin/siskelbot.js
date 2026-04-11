#!/usr/bin/env node
/**
 * Phase 38: CLI Client for SiskelBot
 * Usage: npx . chat "Hello" | npm run cli -- chat "Hello"
 * Commands: chat, context list, context add, recipes list, recipes run <name>, config
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

// Load .env if dotenv available (project has it)
try {
  const dotenv = (await import("dotenv")).default;
  dotenv.config();
} catch {
  // dotenv not available, rely on env
}

const BASE_URL = process.env.SISKELBOT_URL || "http://localhost:3000";
const API_KEY = process.env.SISKELBOT_API_KEY || process.env.API_KEY;

function getUrl(_flagIndex) {
  const idx = process.argv.indexOf("--url");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1].replace(/\/$/, "");
  return BASE_URL.replace(/\/$/, "");
}

function getApiKey(_flagIndex) {
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
  init                         Scaffold a new SiskelBot project (.env, data/, sample recipe)

  migrate                      Migrate data between storage backends
    --from=<backend>          Source backend (json, sqlite, postgres)
    --to=<backend>            Target backend (json, sqlite, postgres)
    --dry-run                 Show what would be migrated without writing
    --verbose                 Show detailed progress
  migrate db                   Run pending PostgreSQL schema migrations
    --status                  Show migration status instead of running
    --rollback <id>           Roll back a specific migration

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

  plugin create <name>        Scaffold a new plugin in plugins/packs/<name>/

  workspace list              List workspaces
  workspace create <name>     Create a new workspace
    --url, --api-key, --json

  search "query"              Search conversations
    --url, --api-key, --workspace, --json

  export <conversationId>     Export a conversation
    --format <fmt>            Format: markdown, json, or html (default: markdown)
    --output <file>           Write to file instead of stdout
    --url, --api-key, --workspace, --json

  config                      Show current config (backend, url, auth status)
    --url, --api-key, --json

  fine-tune export            Export conversations to JSONL for fine-tuning
    --format <fmt>            Format: openai (default), alpaca, sharegpt
    --min-rating <n>          Only include conversations with feedback >= n (1-5)
    --date-from <iso>         Only include conversations created on/after date
    --date-to <iso>           Only include conversations created on/before date
    --max-examples <n>        Maximum examples to export
    --output <file>           Write to file instead of stdout
    --url, --api-key, --workspace, --json
  fine-tune create            Create a fine-tune job
    --file <path>             JSONL training file path (required)
    --model <name>            Base model (e.g. gpt-4o-mini) (required)
    --suffix <s>              Optional suffix for the fine-tuned model
    --validation-file <path>  Optional validation JSONL file path
    --provider <p>            Provider: openai (default) or local
    --url, --api-key, --workspace, --json
  fine-tune list              List fine-tune jobs in the workspace
    --url, --api-key, --workspace, --json
  fine-tune status <jobId>    Show status of a fine-tune job
    --url, --api-key, --workspace, --json

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

async function cmdMigrate() {
  const { spawn } = await import("child_process");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(__dirname, "..", "scripts", "migrate-storage.mjs");

  // Forward all args after "migrate" to the script
  const args = process.argv.slice(process.argv.indexOf("migrate") + 1);
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  return new Promise((_resolveP) => {
    child.on("close", (code) => {
      process.exit(code || 0);
    });
    child.on("error", (e) => {
      console.error("Failed to run migration script:", e.message);
      process.exit(1);
    });
  });
}

async function cmdMigrateDb(json) {
  if (!process.env.DATABASE_URL) {
    err("DATABASE_URL is required for database migrations. Set it in your environment or .env file.");
  }

  const pg = (await import("pg")).default;
  const { runMigrations, getMigrationStatus, rollbackMigration } = await import("../lib/migrations.js");

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10_000,
  });

  try {
    if (hasFlag("--status")) {
      const status = await getMigrationStatus(pool);
      if (json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log("Applied migrations:");
        if (status.applied.length === 0) console.log("  (none)");
        for (const m of status.applied) {
          console.log(`  - ${m.id}: ${m.description} (applied ${new Date(m.applied_at).toISOString()})`);
        }
        console.log("\nPending migrations:");
        if (status.pending.length === 0) console.log("  (none)");
        for (const id of status.pending) {
          console.log(`  - ${id}`);
        }
      }
      return;
    }

    const rollbackId = getFlag("--rollback");
    if (rollbackId) {
      const result = await rollbackMigration(pool, rollbackId);
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.success) {
        console.log(`Rolled back: ${rollbackId}`);
      } else {
        err(`Rollback failed: ${result.error}`);
      }
      return;
    }

    // Run pending migrations
    const result = await runMigrations(pool);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.applied.length > 0) {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const id of result.applied) console.log(`  - ${id}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} already-applied migration(s).`);
      }
      if (result.errors.length > 0) {
        console.error("Errors:");
        for (const e of result.errors) console.error(`  - ${e.id}: ${e.error}`);
      }
      if (result.applied.length === 0 && result.errors.length === 0) {
        console.log("Database is up to date.");
      }
    }
  } finally {
    await pool.end();
  }
}

async function cmdInit(json) {
  const created = [];
  if (!existsSync(".env")) {
    writeFileSync(
      ".env",
      `# SiskelBot Configuration\n# Backend: ollama, vllm, or openai\nBACKEND=ollama\n# OPENAI_API_KEY=sk-...\n# API_KEY=your-secret-key\nPORT=3000\n`
    );
    created.push(".env");
  }
  mkdirSync("data/users/anonymous/workspaces/default", { recursive: true });
  created.push("data/");

  const recipesPath = "data/users/anonymous/workspaces/default/recipes.json";
  if (!existsSync(recipesPath)) {
    writeFileSync(
      recipesPath,
      JSON.stringify(
        [
          {
            id: "sample-recipe",
            name: "hello-world",
            description: "A sample recipe to get started",
            steps: [
              {
                action: "prompt",
                config: { message: "Say hello and introduce yourself briefly." },
              },
            ],
          },
        ],
        null,
        2
      )
    );
    created.push("sample recipe");
  }

  const contextPath = "data/users/anonymous/workspaces/default/context.json";
  if (!existsSync(contextPath)) {
    writeFileSync(
      contextPath,
      JSON.stringify(
        [
          {
            id: "sample-context",
            title: "Getting Started",
            content: "Welcome to SiskelBot! Add your own context documents to help the assistant understand your project.",
          },
        ],
        null,
        2
      )
    );
    created.push("sample context");
  }

  if (json) {
    console.log(JSON.stringify({ initialized: true, created }));
  } else {
    for (const item of created) console.log(`Created ${item}`);
    console.log("\nSiskelBot initialized! Run `npm start` to begin.");
  }
}

async function cmdPluginCreate(name, json) {
  if (!name) err("Usage: siskelbot plugin create <name>");
  const dir = join("plugins", "packs", name);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  const manifest = {
    id: name,
    name: displayName,
    version: "1.0.0",
    description: "A custom SiskelBot plugin",
    author: "you",
    actions: [
      {
        name: "example_action",
        type: "webhook",
        config: {
          url: "https://example.com/hook",
          method: "POST",
        },
      },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (json) {
    console.log(JSON.stringify({ created: manifestPath, manifest }));
  } else {
    console.log(`Plugin created at ${manifestPath}`);
  }
}

async function cmdWorkspaceList(baseUrl, apiKey, json) {
  try {
    const data = await apiGet(baseUrl, apiKey, "/api/v1/workspaces", "default");
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data?.items || data?.workspaces || (Array.isArray(data) ? data : []);
    if (items.length === 0) {
      console.log("No workspaces.");
      return;
    }
    for (const ws of items) {
      const type = ws.type || "personal";
      console.log(`- ${ws.name || ws.id} (${ws.id}) [${type}]`);
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdWorkspaceCreate(baseUrl, apiKey, name, json) {
  if (!name) err("Usage: siskelbot workspace create <name>");
  try {
    const data = await apiPost(baseUrl, apiKey, "/api/v1/workspaces", { name });
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const ws = data?.workspace || data;
    console.log(`Workspace created: ${ws.name || name} (${ws.id || "unknown"})`);
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdSearch(baseUrl, apiKey, query, workspace, json) {
  if (!query) err('Usage: siskelbot search "query"');
  try {
    const encoded = encodeURIComponent(query);
    const data = await apiGet(baseUrl, apiKey, `/api/v1/conversations/search?q=${encoded}`, workspace);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data?.items || data?.results || (Array.isArray(data) ? data : []);
    if (items.length === 0) {
      console.log("No results.");
      return;
    }
    for (const item of items) {
      const title = item.title || item.id || "untitled";
      const snippet = item.snippet || item.preview || "";
      console.log(`- ${title}${snippet ? ": " + snippet.slice(0, 80) : ""}`);
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdExport(baseUrl, apiKey, conversationId, workspace, json) {
  if (!conversationId) err("Usage: siskelbot export <conversationId> [--format markdown|json|html] [--output file]");
  const format = getFlag("--format") || "markdown";
  const output = getFlag("--output");
  try {
    const encoded = encodeURIComponent(format);
    const url = `${baseUrl}/api/v1/conversations/${encodeURIComponent(conversationId)}/export?format=${encoded}&workspace=${encodeURIComponent(workspace)}`;
    const res = await fetch(url, { headers: headers(apiKey) });
    if (!res.ok) {
      if (res.status === 401) err("Unauthorized. Set SISKELBOT_API_KEY or --api-key.");
      if (res.status === 404) err(`Conversation not found: ${conversationId}`);
      const body = await res.json().catch(() => ({}));
      err(body?.error || `Export failed: ${res.status}`);
    }
    const content = await res.text();
    if (output) {
      writeFileSync(output, content);
      if (!json) console.log(`Exported to ${output}`);
      else console.log(JSON.stringify({ exported: output, format }));
    } else {
      process.stdout.write(content);
    }
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.cause?.code === "ECONNREFUSED") err(`Connection refused: ${baseUrl}. Is the server running?`, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdFineTuneExport(baseUrl, apiKey, workspace, json) {
  const format = getFlag("--format") || "openai";
  const minRating = getFlag("--min-rating");
  const dateFrom = getFlag("--date-from");
  const dateTo = getFlag("--date-to");
  const maxExamples = getFlag("--max-examples");
  const output = getFlag("--output");

  const body = { workspace, format };
  if (minRating != null) body.minRating = Number(minRating);
  if (dateFrom) body.dateFrom = dateFrom;
  if (dateTo) body.dateTo = dateTo;
  if (maxExamples != null) body.maxExamples = Number(maxExamples);

  try {
    const data = await apiPost(baseUrl, apiKey, "/api/v1/fine-tune/export", body);
    if (output) {
      writeFileSync(output, data.jsonl || "");
      if (json) {
        console.log(JSON.stringify({ exported: output, exampleCount: data.exampleCount, estimatedTokens: data.estimatedTokens, format: data.format }));
      } else {
        console.log(`Exported ${data.exampleCount} example(s) (~${data.estimatedTokens} tokens) to ${output}`);
      }
      return;
    }
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`Format: ${data.format}`);
    console.log(`Examples: ${data.exampleCount}`);
    console.log(`Estimated tokens: ${data.estimatedTokens}`);
    if (data.jsonl) {
      process.stdout.write(data.jsonl + "\n");
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdFineTuneCreate(baseUrl, apiKey, workspace, json) {
  const filePath = getFlag("--file");
  const model = getFlag("--model");
  const suffix = getFlag("--suffix");
  const provider = getFlag("--provider") || "openai";
  const validationPath = getFlag("--validation-file");
  if (!filePath) err("--file <path> is required (JSONL training file)");
  if (!model) err("--model <name> is required");

  let trainingContent;
  try {
    trainingContent = readFileSync(resolve(process.cwd(), filePath), "utf8");
  } catch {
    err(`Cannot read training file: ${filePath}`);
  }
  let validationContent;
  if (validationPath) {
    try {
      validationContent = readFileSync(resolve(process.cwd(), validationPath), "utf8");
    } catch {
      err(`Cannot read validation file: ${validationPath}`);
    }
  }

  const body = {
    workspace,
    model,
    provider,
    trainingFile: trainingContent,
  };
  if (validationContent) body.validationFile = validationContent;
  if (suffix) body.suffix = suffix;

  try {
    const data = await apiPost(baseUrl, apiKey, "/api/v1/fine-tune/jobs", body);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`Fine-tune job created: ${data.jobId} (status: ${data.status}, provider: ${data.provider})`);
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdFineTuneList(baseUrl, apiKey, workspace, json) {
  try {
    const data = await apiGet(baseUrl, apiKey, "/api/v1/fine-tune/jobs", workspace);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data?.items || [];
    if (items.length === 0) {
      console.log("No fine-tune jobs.");
      return;
    }
    for (const j of items) {
      console.log(`- ${j.jobId}  ${j.model}  ${j.status}  (${j.provider})  ${j.createdAt}`);
    }
  } catch (e) {
    if (e.message?.includes("Connection refused")) err(e.message, 1);
    err(e.message || String(e), 1);
  }
}

async function cmdFineTuneStatus(baseUrl, apiKey, jobId, workspace, json) {
  if (!jobId) err("Usage: siskelbot fine-tune status <jobId>");
  try {
    const data = await apiGet(baseUrl, apiKey, `/api/v1/fine-tune/jobs/${encodeURIComponent(jobId)}`, workspace);
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`Job: ${data.jobId}`);
    console.log(`Model: ${data.model}`);
    console.log(`Status: ${data.status}`);
    console.log(`Provider: ${data.provider}`);
    console.log(`Created: ${data.createdAt}`);
    if (data.fineTunedModel) console.log(`Fine-tuned model: ${data.fineTunedModel}`);
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
    if (cmd === "init") {
      await cmdInit(json);
    } else if (cmd === "migrate" && sub === "db") {
      await cmdMigrateDb(json);
    } else if (cmd === "migrate") {
      await cmdMigrate();
    } else if (cmd === "config") {
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
    } else if (cmd === "plugin") {
      if (sub === "create") await cmdPluginCreate(args[2], json);
      else err("Usage: siskelbot plugin create <name>");
    } else if (cmd === "workspace") {
      if (sub === "list") await cmdWorkspaceList(baseUrl, apiKey, json);
      else if (sub === "create") await cmdWorkspaceCreate(baseUrl, apiKey, args[2], json);
      else err("Usage: siskelbot workspace list | workspace create <name>");
    } else if (cmd === "search") {
      await cmdSearch(baseUrl, apiKey, args[1], workspace, json);
    } else if (cmd === "export") {
      await cmdExport(baseUrl, apiKey, args[1], workspace, json);
    } else if (cmd === "fine-tune") {
      if (sub === "export") await cmdFineTuneExport(baseUrl, apiKey, workspace, json);
      else if (sub === "create") await cmdFineTuneCreate(baseUrl, apiKey, workspace, json);
      else if (sub === "list") await cmdFineTuneList(baseUrl, apiKey, workspace, json);
      else if (sub === "status") await cmdFineTuneStatus(baseUrl, apiKey, args[2], workspace, json);
      else err("Usage: siskelbot fine-tune export|create|list|status <jobId>");
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
