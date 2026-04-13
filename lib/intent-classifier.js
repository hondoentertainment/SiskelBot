/**
 * Phase 62.1: Intent classification — few-shot tuned classifier for tickets.
 *
 * Combines keyword matching with embedding-based similarity (when
 * OPENAI_API_KEY is set). Falls back to pure lexical matching offline so
 * tests are deterministic without network access.
 *
 * Storage layout (via json-path-store):
 *   data/intents/{intent}.json         — intent record (keywords, examples, vectors)
 *   data/intents/_index.json           — list of intent names
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import * as embeddings from "./embeddings.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "default";
}

function intentPath(name) {
  return join(getDataDir(), "intents", `${sanitize(name)}.json`);
}

function indexPath() {
  return join(getDataDir(), "intents", "_index.json");
}

// ─── Token / scoring helpers ───────────────────────────────────────────────

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function keywordScore(tokens, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0 || tokens.length === 0) return 0;
  const set = new Set(tokens);
  let hits = 0;
  for (const kw of keywords) {
    const ks = tokenize(kw);
    if (ks.length === 0) continue;
    if (ks.length === 1) {
      if (set.has(ks[0])) hits += 1;
    } else {
      const joined = tokens.join(" ");
      if (joined.includes(ks.join(" "))) hits += 1;
    }
  }
  return hits / keywords.length;
}

function exampleLexicalScore(tokens, examples) {
  if (!Array.isArray(examples) || examples.length === 0 || tokens.length === 0) return 0;
  let best = 0;
  for (const ex of examples) {
    const exTokens = tokenize(ex);
    if (exTokens.length === 0) continue;
    const overlap = tokens.filter((t) => exTokens.includes(t)).length;
    const union = new Set([...tokens, ...exTokens]).size;
    const jaccard = union === 0 ? 0 : overlap / union;
    if (jaccard > best) best = jaccard;
  }
  return best;
}

// ─── Index helpers ─────────────────────────────────────────────────────────

async function updateIndex(name, remove = false) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { intents: [] });
    const list = Array.isArray(idx.intents) ? idx.intents : [];
    const filtered = list.filter((n) => n !== sanitize(name));
    if (!remove) filtered.push(sanitize(name));
    await writeJsonPath(indexPath(), { intents: filtered });
  });
}

// ─── CRUD / training ──────────────────────────────────────────────────────

/**
 * Train (register or update) an intent definition.
 *
 * @param {{name: string, keywords?: string[], examples?: string[], description?: string}} opts
 */
export async function trainIntent(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  const name = opts.name;
  if (!name || typeof name !== "string") throw new Error("name is required");
  const keywords = Array.isArray(opts.keywords)
    ? opts.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : [];
  const examples = Array.isArray(opts.examples)
    ? opts.examples.map((e) => String(e)).filter(Boolean)
    : [];

  // Try to compute example embeddings when available. Ignore failures.
  let vectors = [];
  if (embeddings.isAvailable && embeddings.isAvailable() && examples.length > 0) {
    try {
      const vecs = await embeddings.embedBatch(examples);
      if (Array.isArray(vecs)) {
        vectors = vecs.filter((v) => Array.isArray(v));
      }
    } catch (_) {
      vectors = [];
    }
  }

  const rec = {
    name,
    description: opts.description || "",
    keywords,
    examples,
    vectors,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(intentPath(name), rec);
  await updateIndex(name);
  return rec;
}

export async function getIntent(name) {
  if (!name) return null;
  const rec = await readJsonPath(intentPath(name), null);
  if (!rec || !rec.name) return null;
  return rec;
}

export async function listIntents() {
  const idx = await readJsonPath(indexPath(), { intents: [] });
  const names = Array.isArray(idx.intents) ? idx.intents : [];
  const out = [];
  for (const n of names) {
    const rec = await getIntent(n);
    if (rec) out.push(rec);
  }
  return out;
}

export async function deleteIntent(name) {
  if (!name) return { ok: false, code: "NOT_FOUND" };
  const rec = await getIntent(name);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(intentPath(name), { _deleted: true });
  await updateIndex(name, true);
  return { ok: true };
}

// ─── Classification ────────────────────────────────────────────────────────

/**
 * Classify a raw text against all trained intents. Returns scores sorted
 * descending plus the top intent.
 *
 * @param {string} text
 * @param {{useEmbeddings?: boolean}} [opts]
 */
export async function classifyIntent(text, opts = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return { topIntent: null, confidence: 0, scores: [] };
  }
  const intents = await listIntents();
  if (intents.length === 0) {
    return { topIntent: null, confidence: 0, scores: [] };
  }
  const tokens = tokenize(text);

  // Try a batch embed for input text only if at least one intent has vectors.
  let inputVector = null;
  const wantEmbeddings = opts.useEmbeddings !== false
    && embeddings.isAvailable && embeddings.isAvailable()
    && intents.some((i) => Array.isArray(i.vectors) && i.vectors.length > 0);
  if (wantEmbeddings) {
    try {
      inputVector = await embeddings.embed(text);
    } catch (_) {
      inputVector = null;
    }
  }

  const scores = intents.map((intent) => {
    const kw = keywordScore(tokens, intent.keywords);
    const lex = exampleLexicalScore(tokens, intent.examples);
    let emb = 0;
    if (inputVector && Array.isArray(intent.vectors) && intent.vectors.length > 0) {
      let best = 0;
      for (const v of intent.vectors) {
        const sim = cosine(inputVector, v);
        if (sim > best) best = sim;
      }
      emb = best;
    }
    // Weighted sum. Keywords dominate for precision; examples add recall.
    const score = (0.5 * kw) + (0.3 * lex) + (0.2 * emb);
    return {
      intent: intent.name,
      score,
      components: { keyword: kw, lexical: lex, embedding: emb },
    };
  });

  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const confidence = top.score;
  return {
    topIntent: confidence > 0 ? top.intent : null,
    confidence,
    scores,
  };
}

export const _internals = {
  tokenize,
  cosine,
  keywordScore,
  exampleLexicalScore,
  intentPath,
  indexPath,
};
