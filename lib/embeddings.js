/**
 * Phase 28: Embeddings API & Semantic Search.
 * Uses OpenAI text-embedding-3-small (1536 dims) when OPENAI_API_KEY is set.
 */
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
    return Array.isArray(vec) ? vec : null;
  } catch (e) {
    console.warn("[embeddings] embed failed:", e.message);
    return null;
  }
}

/**
 * Embed multiple texts in a single batch call.
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][] | null>} Array of embeddings, or null if unavailable/failed
 */
export async function embedBatch(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const valid = Array.isArray(texts)
    ? texts
        .filter((t) => typeof t === "string" && t.trim())
        .map((t) => t.trim().slice(0, 8191))
    : [];
  if (valid.length === 0) return [];
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
        input: valid,
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
    return sorted.map((o) => (Array.isArray(o.embedding) ? o.embedding : null)).filter(Boolean);
  } catch (e) {
    console.warn("[embeddings] embedBatch failed:", e.message);
    return null;
  }
}
