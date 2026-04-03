import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  registry,
  validateManifest,
  loadManifest,
  verifyManifest,
  signManifest,
  installPack,
  uninstallPack,
  listAvailable,
  listInstalled,
  discoverPacks,
} from "../lib/plugin-marketplace.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, "..", "data", "_test_marketplace");
const TMP_PACKS = join(TMP_DIR, "packs");

function cleanTmp() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
}

// --- Validation tests ---

test("validateManifest accepts valid manifest", () => {
  const m = {
    id: "test-pack",
    name: "Test Pack",
    version: "1.0.0",
    description: "A test pack",
    author: "Tester",
    actions: [{ name: "do-thing", type: "builtin", config: { target: "build" } }],
  };
  const result = validateManifest(m);
  assert.equal(result.valid, true);
});

test("validateManifest rejects missing fields", () => {
  const result = validateManifest({ id: "x" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("validateManifest rejects invalid id pattern", () => {
  const m = {
    id: "INVALID ID!",
    name: "X",
    version: "1.0.0",
    description: "X",
    author: "X",
    actions: [{ name: "a", type: "builtin" }],
  };
  const result = validateManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("validateManifest rejects invalid version", () => {
  const m = {
    id: "ok",
    name: "X",
    version: "v1",
    description: "X",
    author: "X",
    actions: [{ name: "a", type: "builtin" }],
  };
  const result = validateManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("validateManifest rejects empty actions", () => {
  const m = {
    id: "ok",
    name: "X",
    version: "1.0.0",
    description: "X",
    author: "X",
    actions: [],
  };
  const result = validateManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("at least one")));
});

test("validateManifest rejects invalid action type", () => {
  const m = {
    id: "ok",
    name: "X",
    version: "1.0.0",
    description: "X",
    author: "X",
    actions: [{ name: "a", type: "invalid" }],
  };
  const result = validateManifest(m);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("type")));
});

test("validateManifest rejects null input", () => {
  const result = validateManifest(null);
  assert.equal(result.valid, false);
});

// --- loadManifest tests ---

test("loadManifest loads valid file", () => {
  cleanTmp();
  const dir = join(TMP_DIR, "load-test");
  const manifest = {
    id: "load-test",
    name: "Load Test",
    version: "1.0.0",
    description: "Testing load",
    author: "Test",
    actions: [{ name: "act", type: "builtin" }],
  };
  writeManifest(dir, manifest);
  const result = loadManifest(join(dir, "manifest.json"));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "load-test");
  assert.ok(registry.has("load-test"));
  registry.delete("load-test");
  cleanTmp();
});

test("loadManifest returns error for missing file", () => {
  const result = loadManifest("/nonexistent/manifest.json");
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("not found"));
});

test("loadManifest returns error for invalid JSON", () => {
  cleanTmp();
  const dir = join(TMP_DIR, "bad-json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{bad json!", "utf8");
  const result = loadManifest(join(dir, "manifest.json"));
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("Invalid JSON"));
  cleanTmp();
});

test("loadManifest returns error for invalid manifest", () => {
  cleanTmp();
  const dir = join(TMP_DIR, "invalid-manifest");
  writeManifest(dir, { id: "x" });
  const result = loadManifest(join(dir, "manifest.json"));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  cleanTmp();
});

// --- Signature tests ---

test("verifyManifest skips when no PLUGIN_SIGNING_KEY", () => {
  const origKey = process.env.PLUGIN_SIGNING_KEY;
  delete process.env.PLUGIN_SIGNING_KEY;
  const result = verifyManifest({ id: "x" }, "abc");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  if (origKey) process.env.PLUGIN_SIGNING_KEY = origKey;
});

test("verifyManifest rejects missing signature when key is set", () => {
  const origKey = process.env.PLUGIN_SIGNING_KEY;
  process.env.PLUGIN_SIGNING_KEY = "test-secret-key";
  const result = verifyManifest({ id: "x" }, "");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Missing"));
  process.env.PLUGIN_SIGNING_KEY = origKey || "";
  if (!origKey) delete process.env.PLUGIN_SIGNING_KEY;
});

test("signManifest + verifyManifest round-trip", () => {
  const origKey = process.env.PLUGIN_SIGNING_KEY;
  const key = "test-round-trip-key";
  process.env.PLUGIN_SIGNING_KEY = key;
  const manifest = {
    id: "signed-pack",
    name: "Signed",
    version: "1.0.0",
    description: "Signed pack",
    author: "Test",
    actions: [{ name: "a", type: "builtin" }],
  };
  const sig = signManifest(manifest, key);
  assert.equal(typeof sig, "string");
  assert.ok(sig.length > 0);
  const result = verifyManifest(manifest, sig);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  process.env.PLUGIN_SIGNING_KEY = origKey || "";
  if (!origKey) delete process.env.PLUGIN_SIGNING_KEY;
});

test("verifyManifest rejects wrong signature", () => {
  const origKey = process.env.PLUGIN_SIGNING_KEY;
  process.env.PLUGIN_SIGNING_KEY = "test-reject-key";
  const manifest = { id: "x", name: "X" };
  const result = verifyManifest(manifest, "deadbeef");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("mismatch"));
  process.env.PLUGIN_SIGNING_KEY = origKey || "";
  if (!origKey) delete process.env.PLUGIN_SIGNING_KEY;
});

// --- Install / Uninstall tests ---

test("installPack requires packId and workspaceId", () => {
  assert.equal(installPack("", "ws").ok, false);
  assert.equal(installPack("pk", "").ok, false);
});

test("installPack rejects unknown pack", () => {
  const result = installPack("nonexistent-pack-xyz", "ws1");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("not found"));
});

test("install and uninstall round-trip", () => {
  // Register a temporary pack
  const manifest = {
    id: "test-install-pack",
    name: "Install Test",
    version: "1.0.0",
    description: "For testing install",
    author: "Test",
    actions: [{ name: "a", type: "builtin" }],
  };
  registry.set(manifest.id, manifest);

  const wsId = "_test_ws_" + Date.now();

  // Install
  const installResult = installPack("test-install-pack", wsId);
  assert.equal(installResult.ok, true);

  // Should be in installed list
  const installed = listInstalled(wsId);
  assert.ok(installed.some((p) => p.id === "test-install-pack"));

  // Install again - should say alreadyInstalled
  const again = installPack("test-install-pack", wsId);
  assert.equal(again.ok, true);
  assert.equal(again.alreadyInstalled, true);

  // Uninstall
  const uninstallResult = uninstallPack("test-install-pack", wsId);
  assert.equal(uninstallResult.ok, true);

  // Should no longer be installed
  const afterUninstall = listInstalled(wsId);
  assert.ok(!afterUninstall.some((p) => p.id === "test-install-pack"));

  // Uninstall again - should be ok (idempotent)
  const uninstallAgain = uninstallPack("test-install-pack", wsId);
  assert.equal(uninstallAgain.ok, true);

  registry.delete("test-install-pack");
});

test("uninstallPack requires valid params", () => {
  assert.equal(uninstallPack("", "ws").ok, false);
  assert.equal(uninstallPack("pk", "").ok, false);
});

// --- Listing tests ---

test("listAvailable returns all registered packs", () => {
  const m1 = {
    id: "list-test-a",
    name: "A",
    version: "1.0.0",
    description: "A",
    author: "X",
    category: "cat1",
    actions: [{ name: "x", type: "builtin" }],
  };
  const m2 = {
    id: "list-test-b",
    name: "B",
    version: "2.0.0",
    description: "B",
    author: "Y",
    actions: [{ name: "y", type: "webhook" }, { name: "z", type: "builtin" }],
  };
  registry.set(m1.id, m1);
  registry.set(m2.id, m2);

  const available = listAvailable();
  const a = available.find((p) => p.id === "list-test-a");
  const b = available.find((p) => p.id === "list-test-b");
  assert.ok(a);
  assert.equal(a.category, "cat1");
  assert.equal(a.actionCount, 1);
  assert.ok(b);
  assert.equal(b.category, "uncategorized");
  assert.equal(b.actionCount, 2);

  registry.delete("list-test-a");
  registry.delete("list-test-b");
});

test("listInstalled returns empty for unknown workspace", () => {
  const result = listInstalled("nonexistent-workspace-xyz");
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

// --- discoverPacks test ---

test("discoverPacks loads packs from plugins/packs/", () => {
  // Call discoverPacks explicitly (server.js calls it at startup, not the module itself)
  discoverPacks();
  const available = listAvailable();
  const devtools = available.find((p) => p.id === "devtools");
  const analytics = available.find((p) => p.id === "analytics");
  assert.ok(devtools, "devtools pack should be discovered");
  assert.equal(devtools.version, "1.0.0");
  assert.ok(analytics, "analytics pack should be discovered");
  assert.equal(analytics.version, "1.0.0");
});
