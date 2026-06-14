/**
 * Phase 61.4: Local dev environment tests.
 *
 * Covers: SEED_TEMPLATES catalogue, runSetup (minimal/demo/testing/full),
 * generateEnvFile, createTestUser/Workspace/ApiKey persistence, verification,
 * port check, resetDevEnvironment with confirmation, getDevStatus, force
 * flag, idempotent re-runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "siskel-dev-setup-"));
process.env.STORAGE_PATH = join(TMP_ROOT, "data");

const {
  SEED_TEMPLATES,
  runSetup,
  generateEnvFile,
  seedMinimal,
  seedDemo,
  seedTesting,
  seedFull,
  createTestUser,
  createTestWorkspace,
  createTestApiKey,
  verifyEnvironment,
  checkDependencies,
  checkPortAvailable,
  resetDevEnvironment,
  getDevStatus,
} = await import("../lib/dev-setup.js");

function freshDir(name) {
  const dir = join(TMP_ROOT, name + "-" + Math.random().toString(36).slice(2, 8));
  return dir;
}

test.after(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {}
});

// ─── SEED_TEMPLATES catalogue ──────────────────────────────────────────────

test("SEED_TEMPLATES exposes minimal, demo, testing, full", () => {
  assert.ok(SEED_TEMPLATES.minimal);
  assert.ok(SEED_TEMPLATES.demo);
  assert.ok(SEED_TEMPLATES.testing);
  assert.ok(SEED_TEMPLATES.full);
  for (const name of ["minimal", "demo", "testing", "full"]) {
    assert.equal(typeof SEED_TEMPLATES[name].description, "string");
  }
});

// ─── runSetup ──────────────────────────────────────────────────────────────

test("runSetup minimal creates .env.local and seed marker", async () => {
  const dir = freshDir("runsetup-minimal");
  const envPath = join(dir, ".env.local");
  const result = await runSetup({
    seed: "minimal",
    storagePath: join(dir, "data"),
    envPath,
  });
  assert.equal(result.success, true);
  assert.equal(result.seed, "minimal");
  assert.ok(existsSync(envPath));
  assert.ok(existsSync(join(dir, "data", ".dev-seed.json")));
  assert.ok(Array.isArray(result.nextSteps));
  assert.ok(result.nextSteps.length >= 1);
});

// ─── generateEnvFile ───────────────────────────────────────────────────────

test("generateEnvFile produces a valid .env file", async () => {
  const dir = freshDir("envfile");
  const envPath = join(dir, ".env.local");
  const res = await generateEnvFile({ envPath });
  assert.equal(res.written, true);
  const content = readFileSync(envPath, "utf8");
  assert.ok(content.includes("NODE_ENV=development"));
  assert.ok(content.includes("PORT=3000"));
  assert.ok(content.includes("STORAGE_PATH="));
  assert.ok(content.includes("SESSION_SECRET="));
  // session secret is auto-randomized
  const sessionLine = content.split("\n").find((l) => l.startsWith("SESSION_SECRET="));
  assert.ok(sessionLine && sessionLine.length > "SESSION_SECRET=".length + 8);
});

test("generateEnvFile refuses to overwrite without force", async () => {
  const dir = freshDir("envfile-force");
  const envPath = join(dir, ".env.local");
  await generateEnvFile({ envPath });
  const second = await generateEnvFile({ envPath });
  assert.equal(second.written, false);
  assert.equal(second.reason, "exists");
  const third = await generateEnvFile({ envPath, force: true });
  assert.equal(third.written, true);
});

// ─── Seed templates ────────────────────────────────────────────────────────

test("seedDemo creates a workspace and conversations", async () => {
  const dir = freshDir("seed-demo");
  const root = join(dir, "data");
  const result = await seedDemo(root);
  assert.equal(result.template, "demo");
  assert.ok(result.user.id);
  assert.ok(result.workspace.id);
  const usersFile = JSON.parse(readFileSync(join(root, "users.json"), "utf8"));
  assert.equal(usersFile.users.length, 1);
  assert.equal(usersFile.users[0].email, "demo@example.com");
});

test("seedTesting creates users, workspaces and API keys", async () => {
  const dir = freshDir("seed-testing");
  const root = join(dir, "data");
  const result = await seedTesting(root);
  assert.equal(result.users.length, 3);
  assert.equal(result.workspaces.length, 3);
  assert.equal(result.apiKeys.length, 3);
  // each api key record includes a raw key
  for (const k of result.apiKeys) assert.ok(k.key && k.key.startsWith("sk-test-"));
  const keysFile = JSON.parse(readFileSync(join(root, "api-keys.json"), "utf8"));
  assert.equal(keysFile.keys.length, 3);
});

test("seedFull creates team, plugins, eval sets, recipes", async () => {
  const dir = freshDir("seed-full");
  const root = join(dir, "data");
  const result = await seedFull(root);
  assert.equal(result.template, "full");
  assert.ok(result.users.length >= 4);
  assert.ok(result.workspaces.length >= 4);
  assert.ok(existsSync(join(root, "teams.json")));
  assert.ok(existsSync(join(root, "marketplace-installed.json")));
  assert.ok(existsSync(join(root, "eval-sets", "smoke.json")));
  const evalSet = JSON.parse(readFileSync(join(root, "eval-sets", "smoke.json"), "utf8"));
  assert.ok(Array.isArray(evalSet.cases));
});

// ─── Primitives ────────────────────────────────────────────────────────────

test("createTestUser persists to users.json", async () => {
  const dir = freshDir("user");
  const root = join(dir, "data");
  const user = await createTestUser({
    email: "u@example.com",
    role: "admin",
    storagePath: root,
  });
  assert.ok(user.id.startsWith("user_"));
  const data = JSON.parse(readFileSync(join(root, "users.json"), "utf8"));
  assert.equal(data.users.length, 1);
  assert.equal(data.users[0].role, "admin");
});

test("createTestWorkspace requires ownerId and writes index.json", async () => {
  const dir = freshDir("ws");
  const root = join(dir, "data");
  const user = await createTestUser({ email: "o@example.com", storagePath: root });
  const ws = await createTestWorkspace({
    name: "MyWS",
    ownerId: user.id,
    storagePath: root,
  });
  assert.ok(ws.id.startsWith("ws_"));
  const indexPath = join(root, "users", user.id, "workspaces", "index.json");
  const data = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(data.workspaces.length, 1);
  assert.equal(data.workspaces[0].name, "MyWS");
  await assert.rejects(() => createTestWorkspace({ name: "x", storagePath: root }));
});

test("createTestApiKey persists with scopes and masked key", async () => {
  const dir = freshDir("apikey");
  const root = join(dir, "data");
  const user = await createTestUser({ email: "k@example.com", storagePath: root });
  const key = await createTestApiKey({
    userId: user.id,
    scopes: ["read"],
    storagePath: root,
  });
  assert.ok(key.key.startsWith("sk-dev-"));
  assert.deepEqual(key.scopes, ["read"]);
  assert.ok(key.masked.includes("…"));
  const data = JSON.parse(readFileSync(join(root, "api-keys.json"), "utf8"));
  assert.equal(data.keys.length, 1);
  // Hashed, not stored in cleartext
  assert.equal(data.keys[0].keyHash.length, 64);
  assert.ok(!JSON.stringify(data).includes(key.key));
});

// ─── Verification ──────────────────────────────────────────────────────────

test("verifyEnvironment returns checks array with node_version", async () => {
  const dir = freshDir("verify");
  const root = join(dir, "data");
  const res = await verifyEnvironment({ storagePath: root, port: 0 });
  assert.ok(Array.isArray(res.checks));
  assert.ok(res.checks.find((c) => c.name === "node_version"));
  assert.ok(res.checks.find((c) => c.name === "data_writable"));
  const dataCheck = res.checks.find((c) => c.name === "data_writable");
  assert.equal(dataCheck.ok, true);
});

test("checkDependencies reports node_version and package.json presence", async () => {
  const res = await checkDependencies();
  assert.ok(Array.isArray(res.checks));
  const node = res.checks.find((c) => c.name === "node_version");
  assert.ok(node);
  assert.equal(typeof node.ok, "boolean");
});

test("checkPortAvailable returns a result for an ephemeral port", async () => {
  const res = await checkPortAvailable(0);
  assert.equal(typeof res.available, "boolean");
  // Port 0 = OS assigns free port, so should be available
  assert.equal(res.available, true);
});

// ─── Reset / status ────────────────────────────────────────────────────────

test("resetDevEnvironment requires confirm flag", async () => {
  const dir = freshDir("reset");
  const root = join(dir, "data");
  await seedMinimal(root);
  const envPath = join(dir, ".env.local");
  await generateEnvFile({ envPath });

  const denied = await resetDevEnvironment({ storagePath: root, envPath });
  assert.equal(denied.ok, false);
  assert.ok(existsSync(root));
  assert.ok(existsSync(envPath));

  const allowed = await resetDevEnvironment({
    confirm: true,
    storagePath: root,
    envPath,
  });
  assert.equal(allowed.ok, true);
  assert.ok(!existsSync(root));
  assert.ok(!existsSync(envPath));
});

test("getDevStatus reports current dev state", async () => {
  const dir = freshDir("status");
  const root = join(dir, "data");
  const envPath = join(dir, ".env.local");
  await runSetup({ seed: "demo", storagePath: root, envPath });
  const status = await getDevStatus({ storagePath: root, envPath });
  assert.equal(status.envFile.exists, true);
  assert.equal(status.storage.exists, true);
  assert.equal(status.storage.seed, "demo");
  assert.ok(status.counts.users >= 1);
  assert.ok(status.node.length > 0);
});

// ─── Force flag / idempotence ─────────────────────────────────────────────

test("runSetup --force overwrites existing .env.local", async () => {
  const dir = freshDir("force");
  const envPath = join(dir, ".env.local");
  const root = join(dir, "data");
  const first = await runSetup({ seed: "minimal", storagePath: root, envPath });
  assert.ok(first.env.written);
  const again = await runSetup({ seed: "minimal", storagePath: root, envPath });
  assert.equal(again.env.written, false);
  const forced = await runSetup({
    seed: "minimal",
    storagePath: root,
    envPath,
    force: true,
  });
  assert.equal(forced.env.written, true);
});

test("seeds are idempotent — re-running does not throw and data persists", async () => {
  const dir = freshDir("idempotent");
  const root = join(dir, "data");
  await seedDemo(root);
  // Second run must not throw
  const result = await seedDemo(root);
  assert.equal(result.template, "demo");
  // Counts of seeded users remain stable (dedup by email for _seed records)
  const users = JSON.parse(readFileSync(join(root, "users.json"), "utf8"));
  assert.equal(users.users.length, 1);
});

test("runSetup unknown seed throws", async () => {
  await assert.rejects(() => runSetup({ seed: "nope" }));
});
