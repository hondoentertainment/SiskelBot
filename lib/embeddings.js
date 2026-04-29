/**
 * Phase 28: Embeddings API & Semantic Search.
 * Phase 35.2: Cache-aware embed() / embedBatch() to avoid re-computing identical text.
 * Uses OpenAI text-embedding-3-small (1536 dims) when OPENAI_API_KEY is set.
 */
import { globalEmbeddingCache } from "./embedding-cache.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

function getApiBase() {
  return process.env.OPENAI_EMBEDDINGS_BASE_URL || "https://api.openai.com";
}

export function isAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Embed a single text.
 * @param {string} text - Text to embed
 * @returns {Promise<number[] | null>} Embedding vector or null if unavailable/failed
 */
export async function embed(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  // Phase 35.2: Cache lookup on normalized text. Hit/miss counters are
  // tracked inside the cache itself (single source of truth).
  try {
    const cached = await globalEmbeddingCache.get(text, EMBEDDING_MODEL);
    if (cached) return cached;
  } catch (_) {
    // Cache failures never block the API path.
  }

  try {
    const base = getApiBase().replace(/\/$/, "");
    const r = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.trim().slice(0, 8191),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn("[embeddings] OpenAI API error:", r.status, err?.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return null;
    if (vec.length !== EMBEDDING_DIMS) {
      console.warn("[embeddings] unexpected embedding length:", vec.length, "expected", EMBEDDING_DIMS);
      return null;
    }
    // Phase 35.2: Populate cache with the freshly computed embedding.
    try {
      await globalEmbeddingCache.set(text, EMBEDDING_MODEL, vec);
    } catch (_) {}
    return vec;
  } catch (e) {
    console.warn("[embeddings] embed failed:", e.message);
    return null;
  }
}

/**
 * Embed multiple texts in a single batch call.
 * Uses the cache for already-computed vectors and only sends misses to the API.
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][] | null>} Array of embeddings in original order, or null if unavailable/failed
 */
export async function embedBatch(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const rawValid = Array.isArray(texts)
    ? texts.filter((t) => typeof t === "string" && t.trim())
    : [];
  if (rawValid.length === 0) return [];

  // Phase 35.2: Check cache for each text, accumulate misses for a single API call.
  /** @type {(number[]|null)[]} */
  const result = new Array(rawValid.length).fill(null);
  let cacheResult;
  try {
    cacheResult = await globalEmbeddingCache.getBatch(rawValid, EMBEDDING_MODEL);
  } catch (_) {
    cacheResult = { cached: {}, missing: rawValid.map((t, i) => ({ idx: i, text: t })) };
  }

  for (const idxStr of Object.keys(cacheResult.cached)) {
    const idx = Number(idxStr);
    result[idx] = cacheResult.cached[idx];
  }

  const missing = cacheResult.missing || [];

  if (missing.length === 0) {
    return result;
  }

  const apiInputs = missing.map((m) => m.text.trim().slice(0, 8191));
  try {
    const base = getApiBase().replace(/\/$/, "");
    const r = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: apiInputs,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn("[embeddings] OpenAI batch API error:", r.status, err?.slice(0, 200));
      return null;
    }
    const data = await r.json();
    const items = data?.data;
    if (!Array.isArray(items)) return null;
    const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const newVecs = [];
    const newTexts = [];
    for (let i = 0; i < sorted.length; i++) {
      const emb = sorted[i]?.embedding;
      if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIMS) {
        if (Array.isArray(emb) && emb.length !== EMBEDDING_DIMS) {
          console.warn("[embeddings] batch item unexpected embedding length:", emb.length);
        }
        continue;
      }
      const origIdx = missing[i]?.idx;
      if (typeof origIdx === "number") {
        result[origIdx] = emb;
        newVecs.push(emb);
        newTexts.push(missing[i].text);
      }
    }
    // Phase 35.2: Populate cache with the new embeddings.
    if (newVecs.length > 0) {
      try {
        await globalEmbeddingCache.setBatch(newTexts, EMBEDDING_MODEL, newVecs);
      } catch (_) {}
    }
    return result.filter(Boolean);
  } catch (e) {
    console.warn("[embeddings] embedBatch failed:", e.message);
    return null;
  }
}
