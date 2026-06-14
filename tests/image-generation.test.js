/**
 * Phase 54.2: Image generation proxy tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate storage so tests don't touch the project data/ dir.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-image-gen-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  IMAGE_PROVIDERS,
  PROMPT_TEMPLATES,
  registerImageProvider,
  getImageProvider,
  generateImage,
  mockGenerator,
  applyTemplate,
  registerTemplate,
  listTemplates,
  sanitizePrompt,
  recordGeneration,
  getGenerationHistory,
  getGeneration,
  deleteGeneration,
  saveStylePreset,
  getStylePreset,
  listStylePresets,
  generateBatch,
  generateVariation,
  _resetImageProviders,
  _resetTemplates,
} = await import("../lib/image-generation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ─── providers ──────────────────────────────────────────────────────────────

test("IMAGE_PROVIDERS exposes all built-in providers", () => {
  assert.ok(IMAGE_PROVIDERS.dalle);
  assert.ok(IMAGE_PROVIDERS.stable_diffusion);
  assert.ok(IMAGE_PROVIDERS.flux);
  assert.ok(IMAGE_PROVIDERS.mock);
  assert.equal(
    IMAGE_PROVIDERS.dalle.endpoint,
    "https://api.openai.com/v1/images/generations",
  );
});

test("registerImageProvider adds a custom provider and getImageProvider returns it", () => {
  const fakeGen = async () => ({
    images: [{ id: "fake", url: "fake://image" }],
    metadata: { provider: "fake" },
  });
  registerImageProvider("fake", { endpoint: "fake://x" }, fakeGen);
  const p = getImageProvider("fake");
  assert.ok(p);
  assert.equal(p.config.endpoint, "fake://x");
  assert.equal(p.generator, fakeGen);
  _resetImageProviders();
  assert.equal(getImageProvider("fake"), null);
});

test("registerImageProvider rejects invalid arguments", () => {
  assert.throws(() => registerImageProvider("", {}, () => {}), /name/);
  assert.throws(() => registerImageProvider("x", {}, null), /generator/);
});

// ─── generateImage + mockGenerator ──────────────────────────────────────────

test("generateImage with mock provider returns expected shape", async () => {
  const result = await generateImage("a red apple", {
    provider: "mock",
    count: 2,
  });
  assert.match(result.id, /^img_/);
  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].url.startsWith("data:image/png;base64,"));
  assert.equal(result.metadata.provider, "mock");
  assert.equal(result.providerId, "mock");
  assert.equal(result.metadata.count, 2);
});

test("mockGenerator directly returns a valid structure", async () => {
  const raw = await mockGenerator("test", { count: 3 });
  assert.equal(raw.images.length, 3);
  for (const img of raw.images) {
    assert.ok(img.id);
    assert.ok(img.url);
    assert.ok(img.data);
  }
  assert.equal(raw.metadata.provider, "mock");
});

test("generateImage rejects invalid provider", async () => {
  await assert.rejects(
    () => generateImage("hello", { provider: "nope" }),
    /unknown provider/,
  );
});

test("generateImage rejects empty prompt", async () => {
  await assert.rejects(() => generateImage("", { provider: "mock" }), /required/);
  await assert.rejects(
    () => generateImage("   ", { provider: "mock" }),
    /required/,
  );
});

// ─── templates ──────────────────────────────────────────────────────────────

test("applyTemplate substitutes {prompt} into named templates", () => {
  const result = applyTemplate("a cat", "photo_realistic");
  assert.equal(result, "photorealistic, 8k, detailed, a cat");
  assert.equal(applyTemplate("a cat", "anime"), "anime style, studio quality, a cat");
});

test("applyTemplate passes through when template is unknown or missing", () => {
  assert.equal(applyTemplate("a cat", "bogus"), "a cat");
  assert.equal(applyTemplate("a cat", null), "a cat");
  assert.equal(applyTemplate("a cat"), "a cat");
});

test("registerTemplate + listTemplates round-trips", () => {
  registerTemplate("cyberpunk", "neon cyberpunk city, {prompt}");
  const listed = listTemplates();
  const names = listed.map((t) => t.name);
  assert.ok(names.includes("cyberpunk"));
  assert.ok(names.includes("photo_realistic"));
  assert.equal(applyTemplate("skyline", "cyberpunk"), "neon cyberpunk city, skyline");
  _resetTemplates();
  assert.ok(!listTemplates().some((t) => t.name === "cyberpunk"));
});

test("registerTemplate rejects templates missing {prompt}", () => {
  assert.throws(() => registerTemplate("bad", "no placeholder"), /placeholder/);
  assert.throws(() => registerTemplate("", "{prompt}"), /name/);
});

test("PROMPT_TEMPLATES has all documented built-ins", () => {
  for (const key of [
    "photo_realistic",
    "anime",
    "watercolor",
    "pixel_art",
    "schematic",
    "logo",
  ]) {
    assert.ok(PROMPT_TEMPLATES[key], `missing ${key}`);
    assert.ok(PROMPT_TEMPLATES[key].includes("{prompt}"));
  }
});

// ─── safety ─────────────────────────────────────────────────────────────────

test("sanitizePrompt removes disallowed phrases", () => {
  const r = sanitizePrompt("a cat and gore in the scene");
  assert.ok(r.modified);
  assert.ok(!r.sanitized.includes("gore"));
  assert.ok(r.removed.length > 0);
});

test("sanitizePrompt leaves safe prompts unchanged", () => {
  const r = sanitizePrompt("a field of sunflowers");
  assert.equal(r.modified, false);
  assert.equal(r.sanitized, "a field of sunflowers");
});

// ─── history ────────────────────────────────────────────────────────────────

test("recordGeneration persists and getGeneration retrieves", async () => {
  const fake = {
    id: "img_test_record_1",
    prompt: "test",
    images: [],
    metadata: { provider: "mock", userId: "u1", workspaceId: "ws1" },
    providerId: "mock",
  };
  await recordGeneration(fake);
  const loaded = await getGeneration("img_test_record_1");
  assert.ok(loaded);
  assert.equal(loaded.id, "img_test_record_1");
});

test("getGenerationHistory returns entries with filter", async () => {
  // Add several distinct records for filter coverage.
  await recordGeneration({
    id: "img_hist_a",
    prompt: "a",
    images: [],
    metadata: { provider: "mock", userId: "alice", workspaceId: "ws1" },
    providerId: "mock",
  });
  await recordGeneration({
    id: "img_hist_b",
    prompt: "b",
    images: [],
    metadata: { provider: "mock", userId: "bob", workspaceId: "ws2" },
    providerId: "mock",
  });

  const all = await getGenerationHistory();
  assert.ok(all.total >= 2);
  const alice = await getGenerationHistory({ userId: "alice" });
  assert.ok(alice.entries.every((e) => e.metadata.userId === "alice"));
  assert.ok(alice.entries.length >= 1);

  const ws2 = await getGenerationHistory({ workspaceId: "ws2" });
  assert.ok(ws2.entries.every((e) => e.metadata.workspaceId === "ws2"));
});

test("deleteGeneration removes the entry", async () => {
  await recordGeneration({
    id: "img_to_delete",
    prompt: "x",
    images: [],
    metadata: { provider: "mock" },
    providerId: "mock",
  });
  assert.ok(await getGeneration("img_to_delete"));
  const ok = await deleteGeneration("img_to_delete");
  assert.equal(ok, true);
  assert.equal(await getGeneration("img_to_delete"), null);
  const ok2 = await deleteGeneration("img_to_delete");
  assert.equal(ok2, false);
});

// ─── presets ────────────────────────────────────────────────────────────────

test("saveStylePreset + getStylePreset roundtrip", async () => {
  const stored = await saveStylePreset("anime_hd", {
    template: "anime",
    size: "1024x1024",
    negativePrompt: "blurry",
  });
  assert.equal(stored.name, "anime_hd");
  assert.equal(stored.preset.size, "1024x1024");
  const loaded = await getStylePreset("anime_hd");
  assert.ok(loaded);
  assert.equal(loaded.preset.template, "anime");
  assert.equal(await getStylePreset("missing"), null);
});

test("listStylePresets returns saved presets", async () => {
  await saveStylePreset("p1", { template: "logo" });
  await saveStylePreset("p2", { template: "watercolor" });
  const all = await listStylePresets();
  const names = all.map((p) => p.name);
  assert.ok(names.includes("p1"));
  assert.ok(names.includes("p2"));
});

// ─── batch + variation ─────────────────────────────────────────────────────

test("generateBatch processes all prompts", async () => {
  const batch = await generateBatch(["prompt 1", "prompt 2", "prompt 3"], {
    provider: "mock",
  });
  assert.equal(batch.total, 3);
  assert.equal(batch.successes, 3);
  assert.equal(batch.failures, 0);
  for (const r of batch.results) {
    assert.equal(r.ok, true);
    assert.ok(r.result.id);
  }
});

test("generateBatch rejects empty input", async () => {
  await assert.rejects(() => generateBatch([]), /non-empty/);
});

test("generateVariation re-generates from an existing image", async () => {
  const first = await generateImage("a mountain", { provider: "mock" });
  const variation = await generateVariation(first.id);
  assert.notEqual(variation.id, first.id);
  assert.equal(variation.metadata.variationOf, first.id);
  assert.equal(variation.prompt, "a mountain");
});

test("generateVariation fails when image is missing", async () => {
  await assert.rejects(() => generateVariation("img_nope"), /not found/);
});
