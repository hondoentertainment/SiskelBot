/**
 * Tests for lib/offline-models.js — catalog listing, device recommendations,
 * download (with mocked fetch), integrity verification, deletion, and
 * bundle creation (mocked filesystem).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-offline-models-"));
process.env.STORAGE_PATH = tempDir;

const {
  OFFLINE_MODELS,
  listAvailableModels,
  listDownloadedModels,
  downloadModel,
  deleteDownloadedModel,
  verifyModelIntegrity,
  getModelRecommendations,
  createOfflineBundle,
} = await import("../lib/offline-models.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// ─── catalog listing ────────────────────────────────────────────────────────

test("listAvailableModels returns the full catalog", async () => {
  const items = await listAvailableModels();
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 4);
  const ids = items.map((m) => m.id);
  assert.ok(ids.includes("tinyllama-1.1b-q4"));
  assert.ok(ids.includes("phi-2-q4"));
  assert.ok(ids.includes("gemma-2b-q4"));
  assert.ok(ids.includes("nomic-embed-text-q4"));
});

test("each catalog entry has required fields", async () => {
  for (const m of Object.values(OFFLINE_MODELS)) {
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.name, "string");
    assert.equal(typeof m.sizeBytes, "number");
    assert.ok(Array.isArray(m.capabilities));
    assert.equal(typeof m.downloadUrl, "string");
    assert.equal(typeof m.sha256, "string");
  }
});

// ─── recommendations ────────────────────────────────────────────────────────

test("getModelRecommendations excludes models that exceed RAM", async () => {
  const result = await getModelRecommendations({ ramGB: 2, storageGB: 10 });
  const recommendedIds = result.recommended.map((m) => m.id);
  // TinyLlama and Nomic Embed need only 2GB / 1GB
  assert.ok(recommendedIds.includes("tinyllama-1.1b-q4"));
  assert.ok(recommendedIds.includes("nomic-embed-text-q4"));
  // Phi-2 and Gemma need 4GB
  assert.ok(!recommendedIds.includes("phi-2-q4"));
  assert.ok(!recommendedIds.includes("gemma-2b-q4"));
  const excludedIds = result.excluded.map((m) => m.id);
  assert.ok(excludedIds.includes("phi-2-q4"));
  assert.ok(excludedIds.includes("gemma-2b-q4"));
});

test("getModelRecommendations sorts by fit score", async () => {
  const result = await getModelRecommendations({ ramGB: 16, storageGB: 100 });
  // All models should be recommended
  assert.equal(result.recommended.length, Object.keys(OFFLINE_MODELS).length);
  // Larger models should rank above smaller ones when there's plenty of RAM
  const phi = result.recommended.find((m) => m.id === "phi-2-q4");
  const tiny = result.recommended.find((m) => m.id === "tinyllama-1.1b-q4");
  assert.ok(phi.fitScore >= tiny.fitScore);
});

test("getModelRecommendations excludes by storage budget", async () => {
  const result = await getModelRecommendations({ ramGB: 16, storageGB: 1 });
  const ids = result.recommended.map((m) => m.id);
  // Only models with minStorageGB <= 1 fit
  assert.ok(ids.includes("tinyllama-1.1b-q4"));
  assert.ok(ids.includes("nomic-embed-text-q4"));
  assert.ok(!ids.includes("phi-2-q4"));
});

test("getModelRecommendations returns empty device when no info", async () => {
  const result = await getModelRecommendations({});
  assert.equal(result.recommended.length, Object.keys(OFFLINE_MODELS).length);
  assert.deepEqual(result.device, { ramGB: 0, storageGB: 0, cpuArch: "unknown" });
});

// ─── download with mock fetch ──────────────────────────────────────────────

function makeMockFetch(payload, headers = {}) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return async () => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-length") return String(buf.length);
        return headers[name] || null;
      },
    },
    async arrayBuffer() {
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: buf };
          },
        };
      },
    },
  });
}

test("downloadModel writes file and computes checksum", async () => {
  const payload = Buffer.from("fake-gguf-bytes-for-test");
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  const progressEvents = [];
  const result = await downloadModel("tinyllama-1.1b-q4", {
    fetchImpl: makeMockFetch(payload),
    onProgress: (p) => progressEvents.push(p),
    skipChecksum: true,
  });
  assert.ok(existsSync(result.path));
  assert.equal(result.size, payload.length);
  assert.equal(result.checksum, expectedHash);
  assert.ok(progressEvents.length >= 1);
  const file = readFileSync(result.path);
  assert.equal(file.toString(), payload.toString());
});

test("downloadModel rejects unknown model id", async () => {
  await assert.rejects(
    () => downloadModel("nonexistent-model", { fetchImpl: makeMockFetch("x") }),
    /unknown offline model/
  );
});

test("downloadModel rejects when fetch returns non-OK", async () => {
  const failFetch = async () => ({ ok: false, status: 503, headers: { get: () => null } });
  await assert.rejects(
    () => downloadModel("tinyllama-1.1b-q4", { fetchImpl: failFetch }),
    /HTTP 503/
  );
});

// ─── verifyModelIntegrity ──────────────────────────────────────────────────

test("verifyModelIntegrity reports placeholder for synthetic catalog entry", async () => {
  // Make sure tinyllama is downloaded from the previous test
  const result = await verifyModelIntegrity("tinyllama-1.1b-q4");
  // Catalog ships with PLACEHOLDER_ sha256, so verify reports ok=true with note
  assert.equal(result.ok, true);
  assert.match(result.reason || "", /placeholder/);
  assert.equal(typeof result.checksum, "string");
});

test("verifyModelIntegrity returns not-downloaded when missing", async () => {
  const result = await verifyModelIntegrity("phi-2-q4");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not downloaded");
});

test("verifyModelIntegrity returns unknown for bad id", async () => {
  const result = await verifyModelIntegrity("not-a-real-model");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown model");
});

// ─── listDownloadedModels ───────────────────────────────────────────────────

test("listDownloadedModels finds downloaded files", async () => {
  const items = await listDownloadedModels();
  const ids = items.map((m) => m.id);
  assert.ok(ids.includes("tinyllama-1.1b-q4"));
  const tiny = items.find((m) => m.id === "tinyllama-1.1b-q4");
  assert.ok(tiny.sizeBytes > 0);
  assert.ok(tiny.path.endsWith(".gguf"));
});

// ─── createOfflineBundle ────────────────────────────────────────────────────

test("createOfflineBundle requires at least one model", async () => {
  await assert.rejects(
    () => createOfflineBundle([], join(tempDir, "empty.tar.gz")),
    /non-empty/
  );
});

test("createOfflineBundle requires output path", async () => {
  await assert.rejects(
    () => createOfflineBundle(["tinyllama-1.1b-q4"], ""),
    /outputPath is required/
  );
});

test("createOfflineBundle rejects unknown model", async () => {
  await assert.rejects(
    () => createOfflineBundle(["does-not-exist"], join(tempDir, "out.tar.gz")),
    /unknown offline model/
  );
});

test("createOfflineBundle rejects when model not on disk", async () => {
  await assert.rejects(
    () => createOfflineBundle(["phi-2-q4"], join(tempDir, "out.tar.gz")),
    /not downloaded/
  );
});

test("createOfflineBundle writes manifest (or tarball) for downloaded model", async () => {
  const out = join(tempDir, "bundle-out.tar.gz");
  const result = await createOfflineBundle(["tinyllama-1.1b-q4"], out);
  assert.equal(result.path, out);
  assert.deepEqual(result.models, ["tinyllama-1.1b-q4"]);
  assert.ok(result.totalBytes > 0);
  // Either the tarball exists, or a fallback manifest exists
  const tarballExists = existsSync(out);
  const manifestExists = result.manifestPath && existsSync(result.manifestPath);
  assert.ok(tarballExists || manifestExists, "expected tarball or manifest to be written");
  if (manifestExists) {
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.bundleVersion, 1);
    assert.equal(manifest.models.length, 1);
    assert.equal(manifest.models[0].id, "tinyllama-1.1b-q4");
  }
});

// ─── deleteDownloadedModel ─────────────────────────────────────────────────

test("deleteDownloadedModel removes file and metadata", async () => {
  const result = await deleteDownloadedModel("tinyllama-1.1b-q4");
  assert.equal(result.deleted, true);
  assert.ok(!existsSync(result.path));
  // Idempotent
  const result2 = await deleteDownloadedModel("tinyllama-1.1b-q4");
  assert.equal(result2.deleted, false);
});
