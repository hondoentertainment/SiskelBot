/**
 * Phase 40.5: Offline model bundles — quantized models for disconnected use.
 *
 * Provides:
 *   - A static catalog of small, quantized GGUF models suitable for local
 *     inference (chat + embeddings).
 *   - Download with SHA-256 integrity verification and progress callbacks.
 *   - Listing of catalog entries and what is currently downloaded on disk.
 *   - Device-aware recommendations (RAM/storage/cpu architecture).
 *   - Bundle creation (tarball) for air-gapped distribution.
 *
 * Storage layout (under STORAGE_PATH/data):
 *   models/offline/{modelId}.gguf            — downloaded model file
 *   models/offline/{modelId}.json            — metadata sidecar (size, sha256)
 *
 * Note: this module never throws on a missing optional native dependency.
 * llama.cpp integration lives in lib/llama-cpp-backend.js and dynamically
 * imports `node-llama-cpp` only when present.
 */
import { createHash } from "crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, readdirSync, unlinkSync, createReadStream } from "fs";
import { join, dirname, resolve } from "path";
import { pipeline } from "stream/promises";
import { getDataDir } from "./json-path-store.js";

const OFFLINE_DIR_NAME = "models/offline";
const META_SUFFIX = ".json";
const MODEL_SUFFIX = ".gguf";

/**
 * Catalog of bundled offline models. SHA-256 placeholders are intentionally
 * marked so the verifier can opt into "lenient" mode for development; in
 * production deployments, replace with the real digest of the artifact.
 */
export const OFFLINE_MODELS = {
  "tinyllama-1.1b-q4": {
    id: "tinyllama-1.1b-q4",
    name: "TinyLlama 1.1B Q4",
    family: "tinyllama",
    sizeBytes: 650_000_000,
    parameters: 1_100_000_000,
    quantization: "q4",
    contextLength: 2048,
    capabilities: ["chat", "completion"],
    license: "Apache-2.0",
    description: "1.1B parameter chat model, Q4 quantization. Smallest viable LLM for laptops and SBCs.",
    downloadUrl: "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
    sha256: "PLACEHOLDER_TINYLLAMA_Q4_SHA256",
    minRamGB: 2,
    minStorageGB: 1,
  },
  "phi-2-q4": {
    id: "phi-2-q4",
    name: "Phi-2 2.7B Q4",
    family: "phi",
    sizeBytes: 1_600_000_000,
    parameters: 2_700_000_000,
    quantization: "q4",
    contextLength: 2048,
    capabilities: ["chat", "completion", "code"],
    license: "MIT",
    description: "Microsoft Phi-2 2.7B Q4. Strong reasoning + code for its size.",
    downloadUrl: "https://huggingface.co/TheBloke/phi-2-GGUF/resolve/main/phi-2.Q4_K_M.gguf",
    sha256: "PLACEHOLDER_PHI2_Q4_SHA256",
    minRamGB: 4,
    minStorageGB: 2,
  },
  "gemma-2b-q4": {
    id: "gemma-2b-q4",
    name: "Gemma 2B Q4",
    family: "gemma",
    sizeBytes: 1_500_000_000,
    parameters: 2_000_000_000,
    quantization: "q4",
    contextLength: 8192,
    capabilities: ["chat", "completion"],
    license: "Gemma-Terms-of-Use",
    description: "Google Gemma 2B Q4. Long context, broad capabilities.",
    downloadUrl: "https://huggingface.co/google/gemma-2b-GGUF/resolve/main/gemma-2b.q4_k_m.gguf",
    sha256: "PLACEHOLDER_GEMMA_2B_Q4_SHA256",
    minRamGB: 4,
    minStorageGB: 2,
  },
  "nomic-embed-text-q4": {
    id: "nomic-embed-text-q4",
    name: "Nomic Embed Text v1.5 Q4",
    family: "nomic",
    sizeBytes: 84_000_000,
    parameters: 137_000_000,
    quantization: "q4",
    contextLength: 8192,
    capabilities: ["embeddings"],
    license: "Apache-2.0",
    embeddingDimensions: 768,
    description: "Compact embedding model for semantic search. Pairs with any chat model.",
    downloadUrl: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf",
    sha256: "PLACEHOLDER_NOMIC_EMBED_Q4_SHA256",
    minRamGB: 1,
    minStorageGB: 1,
  },
};

// ─── path helpers ───────────────────────────────────────────────────────────

function offlineDir() {
  const dir = join(getDataDir(), OFFLINE_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function modelFilePath(modelId) {
  return join(offlineDir(), `${modelId}${MODEL_SUFFIX}`);
}

function modelMetaPath(modelId) {
  return join(offlineDir(), `${modelId}${META_SUFFIX}`);
}

function getCatalogEntry(modelId) {
  return OFFLINE_MODELS[modelId] || null;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * List models from the static catalog.
 * @returns {Promise<object[]>}
 */
export async function listAvailableModels() {
  return Object.values(OFFLINE_MODELS).map((m) => ({ ...m }));
}

/**
 * List models that have actually been downloaded to disk.
 * @returns {Promise<object[]>}
 */
export async function listDownloadedModels() {
  const dir = offlineDir();
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(MODEL_SUFFIX)) continue;
    const id = f.slice(0, -MODEL_SUFFIX.length);
    const filePath = join(dir, f);
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      continue;
    }
    let meta = {};
    try {
      const metaPath = modelMetaPath(id);
      if (existsSync(metaPath)) {
        const fs = await import("fs");
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      }
    } catch {}
    const catalog = getCatalogEntry(id) || {};
    out.push({
      id,
      name: catalog.name || id,
      path: filePath,
      sizeBytes: size,
      checksum: meta.sha256 || null,
      downloadedAt: meta.downloadedAt || null,
      capabilities: catalog.capabilities || [],
    });
  }
  return out;
}

/**
 * Download a model from the catalog with integrity verification.
 *
 * @param {string} modelId
 * @param {{
 *   onProgress?: (p: { received: number, total: number, percent: number }) => void,
 *   destination?: string,
 *   fetchImpl?: typeof fetch,
 *   skipChecksum?: boolean,
 * }} [options]
 * @returns {Promise<{ path: string, size: number, checksum: string }>}
 */
export async function downloadModel(modelId, options = {}) {
  const entry = getCatalogEntry(modelId);
  if (!entry) {
    throw new Error(`unknown offline model: ${modelId}`);
  }
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime");
  }

  const dest = options.destination ? resolve(options.destination) : modelFilePath(modelId);
  mkdirSync(dirname(dest), { recursive: true });

  const res = await fetchImpl(entry.downloadUrl);
  if (!res || !res.ok) {
    const status = res ? res.status : "no-response";
    throw new Error(`download failed for ${modelId}: HTTP ${status}`);
  }

  const total = Number(res.headers?.get?.("content-length")) || entry.sizeBytes || 0;
  const hasher = createHash("sha256");
  let received = 0;

  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  const out = createWriteStream(dest);

  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        hasher.update(value);
        received += value.byteLength || value.length || 0;
        out.write(Buffer.from(value));
        if (typeof options.onProgress === "function") {
          const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
          try {
            options.onProgress({ received, total, percent });
          } catch {}
        }
      }
      await new Promise((resolveWrite, rejectWrite) => {
        out.end((err) => (err ? rejectWrite(err) : resolveWrite()));
      });
    } else if (res.body && typeof res.body.pipe === "function") {
      // Node stream fallback
      res.body.on("data", (chunk) => {
        hasher.update(chunk);
        received += chunk.length;
        if (typeof options.onProgress === "function") {
          const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
          try {
            options.onProgress({ received, total, percent });
          } catch {}
        }
      });
      await pipeline(res.body, out);
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      hasher.update(buf);
      received = buf.length;
      out.write(buf);
      await new Promise((resolveWrite, rejectWrite) => {
        out.end((err) => (err ? rejectWrite(err) : resolveWrite()));
      });
      if (typeof options.onProgress === "function") {
        try {
          options.onProgress({ received, total: received, percent: 100 });
        } catch {}
      }
    }
  } catch (e) {
    try {
      out.destroy();
      if (existsSync(dest)) unlinkSync(dest);
    } catch {}
    throw e;
  }

  const checksum = hasher.digest("hex");
  const expected = entry.sha256;
  const isPlaceholder = typeof expected === "string" && expected.startsWith("PLACEHOLDER_");
  if (!options.skipChecksum && expected && !isPlaceholder && checksum !== expected) {
    try {
      unlinkSync(dest);
    } catch {}
    throw new Error(`checksum mismatch for ${modelId}: expected ${expected}, got ${checksum}`);
  }

  // Sidecar metadata
  const metaPath = options.destination ? `${dest}${META_SUFFIX}` : modelMetaPath(modelId);
  const meta = {
    id: modelId,
    sha256: checksum,
    sizeBytes: received,
    downloadedAt: new Date().toISOString(),
    sourceUrl: entry.downloadUrl,
    integrityVerified: !!(expected && !isPlaceholder && checksum === expected),
  };
  try {
    const fs = await import("fs");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch {}

  return { path: dest, size: received, checksum };
}

/**
 * Delete a downloaded model and its metadata sidecar.
 * @param {string} modelId
 * @returns {Promise<{ deleted: boolean, path: string }>}
 */
export async function deleteDownloadedModel(modelId) {
  const filePath = modelFilePath(modelId);
  const metaPath = modelMetaPath(modelId);
  let deleted = false;
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      deleted = true;
    }
  } catch {}
  try {
    if (existsSync(metaPath)) {
      unlinkSync(metaPath);
    }
  } catch {}
  return { deleted, path: filePath };
}

/**
 * Re-hash a downloaded file and compare against the catalog SHA-256.
 * @param {string} modelId
 * @returns {Promise<{ ok: boolean, checksum: string|null, expected: string|null, reason?: string }>}
 */
export async function verifyModelIntegrity(modelId) {
  const entry = getCatalogEntry(modelId);
  if (!entry) {
    return { ok: false, checksum: null, expected: null, reason: "unknown model" };
  }
  const filePath = modelFilePath(modelId);
  if (!existsSync(filePath)) {
    return { ok: false, checksum: null, expected: entry.sha256 || null, reason: "not downloaded" };
  }
  const hasher = createHash("sha256");
  await pipeline(createReadStream(filePath), async function* (source) {
    for await (const chunk of source) {
      hasher.update(chunk);
      yield chunk;
    }
  });
  const checksum = hasher.digest("hex");
  const expected = entry.sha256 || null;
  const isPlaceholder = typeof expected === "string" && expected.startsWith("PLACEHOLDER_");
  if (!expected || isPlaceholder) {
    return { ok: true, checksum, expected, reason: "no canonical checksum (placeholder)" };
  }
  return { ok: checksum === expected, checksum, expected };
}

/**
 * Recommend models that fit a device's hardware budget.
 *
 * @param {{ ramGB?: number, storageGB?: number, cpuArch?: string }} [deviceInfo]
 * @returns {Promise<{ recommended: object[], excluded: object[], device: object }>}
 */
export async function getModelRecommendations(deviceInfo = {}) {
  const ramGB = Number(deviceInfo.ramGB) || 0;
  const storageGB = Number(deviceInfo.storageGB) || 0;
  const cpuArch = typeof deviceInfo.cpuArch === "string" ? deviceInfo.cpuArch : "unknown";

  const recommended = [];
  const excluded = [];
  for (const m of Object.values(OFFLINE_MODELS)) {
    const reasons = [];
    if (ramGB > 0 && (m.minRamGB || 0) > ramGB) reasons.push(`requires ${m.minRamGB}GB RAM`);
    if (storageGB > 0 && (m.minStorageGB || 0) > storageGB) reasons.push(`requires ${m.minStorageGB}GB storage`);
    if (reasons.length === 0) {
      recommended.push({ ...m, fitScore: scoreFit(m, ramGB) });
    } else {
      excluded.push({ id: m.id, name: m.name, reasons });
    }
  }
  recommended.sort((a, b) => b.fitScore - a.fitScore);

  return {
    device: { ramGB, storageGB, cpuArch },
    recommended,
    excluded,
  };
}

function scoreFit(model, ramGB) {
  // Prefer the largest model that comfortably fits in RAM with headroom.
  const minRam = model.minRamGB || 1;
  if (ramGB <= 0) return minRam;
  if (minRam > ramGB) return -1;
  // Higher score for larger models that still fit (more capability),
  // but penalize models that nearly fill memory.
  const headroom = ramGB - minRam;
  const sizeBonus = Math.log10((model.parameters || 1) / 1e8);
  return sizeBonus + headroom * 0.1;
}

/**
 * Bundle one or more downloaded models into a single tarball with manifest.
 * Used for air-gapped distribution: produce on a connected machine, sneakernet
 * to the target, then extract into STORAGE_PATH/data/models/offline/.
 *
 * @param {string[]} modelIds
 * @param {string} outputPath - Absolute or relative path to the .tar.gz to write
 * @returns {Promise<{ path: string, models: string[], totalBytes: number, manifestPath?: string }>}
 */
export async function createOfflineBundle(modelIds, outputPath) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    throw new Error("modelIds must be a non-empty array");
  }
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new Error("outputPath is required");
  }

  // Verify all models exist on disk first
  const fs = await import("fs");
  const items = [];
  let totalBytes = 0;
  for (const id of modelIds) {
    const entry = getCatalogEntry(id);
    if (!entry) throw new Error(`unknown offline model: ${id}`);
    const filePath = modelFilePath(id);
    if (!existsSync(filePath)) {
      throw new Error(`model ${id} is not downloaded; download it first`);
    }
    const size = statSync(filePath).size;
    totalBytes += size;
    items.push({
      id,
      name: entry.name,
      file: `${id}${MODEL_SUFFIX}`,
      sizeBytes: size,
      sha256: entry.sha256,
      capabilities: entry.capabilities,
      quantization: entry.quantization,
    });
  }

  const manifest = {
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    models: items,
    totalBytes,
    instructions:
      "Extract this archive into <STORAGE_PATH>/data/models/offline/ on the target machine. " +
      "Then run `siskelbot models list` to verify.",
  };

  const dest = resolve(outputPath);
  mkdirSync(dirname(dest), { recursive: true });

  // Try to use the optional `tar` package; fall back to writing manifest only.
  let tarMod = null;
  try {
    tarMod = (await import("tar")).default || (await import("tar"));
  } catch {
    tarMod = null;
  }

  if (tarMod && typeof tarMod.create === "function") {
    // Write manifest to a temp file inside the offline dir, then bundle it
    // alongside the .gguf files.
    const manifestFile = join(offlineDir(), "_bundle_manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
    const fileNames = [
      "_bundle_manifest.json",
      ...items.flatMap((it) => {
        const meta = `${it.id}${META_SUFFIX}`;
        const sidecarExists = existsSync(join(offlineDir(), meta));
        return sidecarExists ? [it.file, meta] : [it.file];
      }),
    ];
    await tarMod.create(
      {
        gzip: true,
        file: dest,
        cwd: offlineDir(),
      },
      fileNames
    );
    try {
      unlinkSync(manifestFile);
    } catch {}
    return { path: dest, models: modelIds.slice(), totalBytes, manifestEmbedded: true };
  }

  // Fallback: emit a manifest-only JSON file next to the requested output.
  // The caller can use this to drive an external tar/zip command.
  const manifestPath = `${dest}.manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return {
    path: dest,
    models: modelIds.slice(),
    totalBytes,
    manifestPath,
    warning: "tar package not installed; wrote manifest only. Install `tar` to produce a tarball.",
  };
}

export default {
  OFFLINE_MODELS,
  listAvailableModels,
  listDownloadedModels,
  downloadModel,
  deleteDownloadedModel,
  verifyModelIntegrity,
  getModelRecommendations,
  createOfflineBundle,
};
