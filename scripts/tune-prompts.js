#!/usr/bin/env node
/**
 * CLI for the offline auto prompt-tuner.
 *
 *   node scripts/tune-prompts.js --workspace default
 *       → synthesize once for `default`, print the patch JSON to stdout; do
 *         NOT apply. Empty output if there's not enough signal.
 *
 *   node scripts/tune-prompts.js --all
 *       → synthesize for every workspace discovered under
 *         data/agent-genealogy/*. Prints one JSON object per workspace.
 *
 *   node scripts/tune-prompts.js --workspace X --apply
 *       → synthesize and mark applied in one step.
 *
 *   node scripts/tune-prompts.js --watch --interval 3600
 *       → loop forever, running every N seconds (default 3600 = 1h).
 *
 *   node scripts/tune-prompts.js --all --apply --watch
 *       → continuously auto-tune + apply for all workspaces.
 *
 * Logs to stderr (with ISO-8601 timestamps). Emits result JSON on stdout
 * suitable for piping to jq or a downstream consumer.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { getDataDir } from "../lib/json-path-store.js";
import {
  synthesizePatch,
  savePatch,
  autoTuneAndApply,
} from "../lib/agent-prompt-tuner.js";

function parseArgs(argv) {
  const out = {
    workspace: null,
    all: false,
    apply: false,
    watch: false,
    interval: 3600,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--workspace":
      case "-w":
        out.workspace = argv[++i];
        break;
      case "--all":
        out.all = true;
        break;
      case "--apply":
        out.apply = true;
        break;
      case "--watch":
        out.watch = true;
        break;
      case "--interval": {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) out.interval = Math.floor(n);
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (a && a.startsWith("--workspace=")) out.workspace = a.slice("--workspace=".length);
        else if (a && a.startsWith("--interval=")) {
          const n = Number(a.slice("--interval=".length));
          if (Number.isFinite(n) && n > 0) out.interval = Math.floor(n);
        } else if (a) {
          logErr(`warn: ignoring unknown arg "${a}"`);
        }
    }
  }
  return out;
}

function logErr(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function discoverWorkspaces() {
  const base = join(getDataDir(), "agent-genealogy");
  try {
    const entries = readdirSync(base);
    const out = [];
    for (const ent of entries) {
      const full = join(base, ent);
      try {
        const s = statSync(full);
        if (s.isDirectory()) out.push(ent);
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

async function runOnce(ws, opts) {
  try {
    let patch;
    if (opts.apply) {
      patch = await autoTuneAndApply(ws, { autoApply: true, adminId: "cli" });
    } else {
      patch = await synthesizePatch(ws);
      if (patch) await savePatch(patch);
    }
    if (!patch) {
      logErr(`${ws}: no signal — skipping`);
      process.stdout.write(JSON.stringify({ workspace: ws, patch: null }) + "\n");
      return { workspace: ws, patch: null };
    }
    logErr(`${ws}: synthesized ${patch.version} (${patch.status})`);
    process.stdout.write(JSON.stringify({ workspace: ws, patch }) + "\n");
    return { workspace: ws, patch };
  } catch (err) {
    logErr(`${ws}: ERROR ${err && err.message ? err.message : err}`);
    return { workspace: ws, error: String(err && err.message ? err.message : err) };
  }
}

async function runPass(opts) {
  const targets = opts.all ? discoverWorkspaces() : (opts.workspace ? [opts.workspace] : []);
  if (targets.length === 0) {
    if (opts.all) {
      logErr("no workspaces discovered under data/agent-genealogy/*");
    } else {
      logErr("no --workspace given and --all not set");
    }
    return [];
  }
  logErr(`pass: ${targets.length} workspace(s)${opts.apply ? " (auto-apply)" : ""}`);
  const results = [];
  for (const ws of targets) {
    results.push(await runOnce(ws, opts));
  }
  return results;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/tune-prompts.js [flags]

  --workspace <name>  Target a single workspace.
  --all               Target every workspace under data/agent-genealogy/.
  --apply             Mark synthesized patches as applied (default: pending).
  --watch             Run continuously.
  --interval <sec>    Watch loop interval in seconds (default 3600).
  -h, --help          Show this message.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.workspace && !opts.all) {
    logErr("error: pass --workspace <name> or --all");
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (!opts.watch) {
    await runPass(opts);
    return;
  }

  logErr(`watch: every ${opts.interval}s`);
  let stopped = false;
  const onSig = () => {
    logErr("shutdown signal — exiting");
    stopped = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  while (!stopped) {
    try {
      await runPass(opts);
    } catch (err) {
      logErr(`pass error: ${err && err.message ? err.message : err}`);
    }
    if (stopped) break;
    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }
}

main().catch((err) => {
  logErr(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
