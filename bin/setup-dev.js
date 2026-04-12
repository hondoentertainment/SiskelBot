#!/usr/bin/env node
/**
 * Phase 61.4: One-command local dev environment setup.
 *
 * Usage:
 *   node bin/setup-dev.js [--seed=minimal|demo|testing|full] [--force] [--storage=./data] [--env=./.env.local] [--no-env] [--verify] [--status] [--reset]
 */

import {
  runSetup,
  verifyEnvironment,
  getDevStatus,
  resetDevEnvironment,
  SEED_TEMPLATES,
} from "../lib/dev-setup.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--")) {
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        args[raw.slice(2, eq)] = raw.slice(eq + 1);
      } else {
        args[raw.slice(2)] = true;
      }
    } else {
      args._.push(raw);
    }
  }
  return args;
}

function printHelp() {
  const seedList = Object.entries(SEED_TEMPLATES)
    .map(([k, v]) => `    ${k.padEnd(10)} ${v.description}`)
    .join("\n");
  process.stdout.write(
    [
      "SiskelBot dev-setup — Phase 61.4",
      "",
      "Usage:",
      "  node bin/setup-dev.js [options]",
      "",
      "Options:",
      "  --seed=NAME       Seed template to use (default: minimal)",
      "  --force           Overwrite existing .env.local",
      "  --storage=PATH    Storage root (default: ./data)",
      "  --env=PATH        Env file path (default: ./.env.local)",
      "  --no-env          Skip writing the env file",
      "  --verify          Run environment verification and exit",
      "  --status          Print current dev environment status and exit",
      "  --reset           Delete storage dir and .env.local (requires --confirm)",
      "  --confirm         Confirm destructive operations",
      "  --help            Show this help",
      "",
      "Seed templates:",
      seedList,
      "",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.verify) {
    const result = await verifyEnvironment({ storagePath: args.storage });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  if (args.status) {
    const status = await getDevStatus({ storagePath: args.storage, envPath: args.env });
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }

  if (args.reset) {
    if (!args.confirm) {
      process.stderr.write("Refusing to reset without --confirm.\n");
      return 2;
    }
    const result = await resetDevEnvironment({
      confirm: true,
      storagePath: args.storage,
      envPath: args.env,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  const seed = typeof args.seed === "string" ? args.seed : "minimal";
  if (!SEED_TEMPLATES[seed]) {
    process.stderr.write(
      `Unknown seed '${seed}'. Valid: ${Object.keys(SEED_TEMPLATES).join(", ")}\n`,
    );
    return 2;
  }

  const result = await runSetup({
    seed,
    force: Boolean(args.force),
    writeEnv: args["no-env"] ? false : true,
    storagePath: args.storage,
    envPath: args.env,
  });

  process.stdout.write("SiskelBot dev environment ready.\n");
  process.stdout.write(`  Seed:        ${result.seed}\n`);
  process.stdout.write(`  Storage:     ${result.storagePath}\n`);
  if (result.env) {
    process.stdout.write(
      `  Env file:    ${result.env.path}${result.env.written ? "" : " (kept existing)"}\n`,
    );
  }
  if (result.warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
  }
  process.stdout.write("\nNext steps:\n");
  for (const step of result.nextSteps) process.stdout.write(`  - ${step}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`dev-setup failed: ${err?.stack || err?.message || err}\n`);
    process.exit(1);
  });
