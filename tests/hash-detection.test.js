/**
 * Phase 67.1: Hash detection interface stub tests.
 *
 * Tests verify the provider registration interface + default behavior.
 * No real hash lists are used — tests install synthetic providers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-hash-detection-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerProvider,
  unregisterProvider,
  listProviders,
  checkHash,
  isValidHash,
  hashBuffer,
  SUPPORTED_ALGORITHMS,
  DEFAULT_PROVIDER,
} = await import("../lib/hash-detection.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("isValidHash validates hex of the correct length per algorithm", () => {
  const sha256 = "a".repeat(64);
  const sha1 = "b".repeat(40);
  const md5 = "c".repeat(32);
  assert.equal(isValidHash(sha256, "sha256"), true);
  assert.equal(isValidHash(sha1, "sha1"), true);
  assert.equal(isValidHash(md5, "md5"), true);
  assert.equal(isValidHash("xyz", "sha256"), false);
  assert.equal(isValidHash(sha1, "sha256"), false);
});

test("SUPPORTED_ALGORITHMS lists the algorithms", () => {
  assert.ok(SUPPORTED_ALGORITHMS.includes("sha256"));
});

test("hashBuffer computes stable hashes", () => {
  const a = hashBuffer(Buffer.from("hello"), "sha256");
  const b = hashBuffer(Buffer.from("hello"), "sha256");
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("DEFAULT_PROVIDER is a no-op that returns no match", async () => {
  const r = await DEFAULT_PROVIDER.check("a".repeat(64), "image", {});
  assert.equal(r.match, false);
  assert.equal(r.reason, "no_provider_configured");
});

test("checkHash returns default stub reason when no providers registered", async () => {
  const r = await checkHash("a".repeat(64), "image");
  assert.equal(r.match, false);
  assert.equal(r.reason, "no_provider_configured");
  assert.equal(r.providerId, "default");
});

test("checkHash rejects invalid hashes", async () => {
  await assert.rejects(() => checkHash("not-a-hash"), /invalid/);
});

test("registerProvider records metadata and becomes selectable by id", async () => {
  const calls = [];
  await registerProvider(
    "test-provider",
    {
      async check(h, kind) {
        calls.push({ h, kind });
        return { match: h === "f".repeat(64), confidence: 1.0 };
      },
    },
    { name: "Test Provider", kinds: ["image"], algorithms: ["sha256"] },
  );
  const providers = await listProviders();
  assert.ok(providers.find((p) => p.id === "test-provider" && p.active));
  const hit = await checkHash("f".repeat(64), "image", { providerId: "test-provider" });
  assert.equal(hit.match, true);
  assert.equal(hit.providerId, "test-provider");
  assert.equal(calls.length, 1);
});

test("checkHash returns provider_not_found when providerId doesn't exist", async () => {
  const r = await checkHash("a".repeat(64), "image", { providerId: "bogus" });
  assert.equal(r.match, false);
  assert.equal(r.reason, "provider_not_found");
});

test("checkHash without providerId iterates registered providers and returns first match", async () => {
  await registerProvider("p-miss", { async check() { return { match: false }; } });
  await registerProvider("p-hit", { async check(h) { return { match: h.startsWith("e") }; } });
  const r = await checkHash("e" + "0".repeat(63), "image");
  assert.equal(r.match, true);
  assert.equal(r.providerId, "p-hit");
  const miss = await checkHash("0".repeat(64), "image");
  assert.equal(miss.match, false);
  assert.equal(miss.reason, "no_provider_match");
  await unregisterProvider("p-miss");
  await unregisterProvider("p-hit");
});

test("registerProvider requires id and check function", async () => {
  await assert.rejects(() => registerProvider("", {}), /id/);
  await assert.rejects(() => registerProvider("x", {}), /check function/);
});
