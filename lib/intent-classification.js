// @ts-check
/**
 * Phase 62.1: Intent classification for customer support tickets.
 *
 * Few-shot keyword + TF-IDF classifier. Supports:
 *   - Training example management (`addTrainingExample`)
 *   - Training a classifier (`trainIntentClassifier`) from examples
 *   - Classifying a ticket (`classifyTicket`) to the best intent
 *   - Listing intents and evaluating the classifier against a held-out set
 *
 * Persistence via `json-path-store.js`. No external dependencies.
 *
 * @module intent-classification
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "of", "on", "or", "that", "the",
  "to", "was", "were", "will", "with", "i", "me", "my", "you", "your",
  "we", "us", "our", "they", "them", "their", "this", "these", "those",
  "am", "do", "does", "did", "can", "could", "would", "should", "if",
  "then", "so", "but", "not", "no", "yes", "please", "help", "hi", "hello",
]);

function examplesPath() {
  return join(getDataDir(), "intent-classification-examples.json");
}

function modelPath() {
  return join(getDataDir(), "intent-classification-model.json");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  const cleaned = s.replace(/[^a-z0-9_]+/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts.filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

/**
 * @param {string[]} tokens
 * @returns {Record<string, number>}
 */
function tf(tokens) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const t of tokens) out[t] = (out[t] || 0) + 1;
  return out;
}

/**
 * @param {string[][]} docs
 * @returns {Record<string, number>}
 */
function idf(docs) {
  /** @type {Record<string, number>} */
  const df = {};
  const N = docs.length;
  for (const doc of docs) {
    const seen = new Set();
    for (const t of doc) {
      if (seen.has(t)) continue;
      seen.add(t);
      df[t] = (df[t] || 0) + 1;
    }
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [term, freq] of Object.entries(df)) {
    out[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Training examples                                                          */
/* -------------------------------------------------------------------------- */

async function loadExamples() {
  const data = await readJsonPath(examplesPath(), { version: STORE_VERSION, examples: [] });
  if (!Array.isArray(data.examples)) data.examples = [];
  return data;
}

async function saveExamples(data) {
  await writeJsonPath(examplesPath(), {
    version: STORE_VERSION,
    examples: data.examples || [],
  });
}

/**
 * Append a labelled training example.
 *
 * @param {string} intent
 * @param {string} text
 * @param {object} [extras]
 * @returns {Promise<object>}
 */
export async function addTrainingExample(intent, text, extras = {}) {
  if (!intent || typeof intent !== "string") throw new Error("intent is required");
  if (!text || typeof text !== "string") throw new Error("text is required");
  const path = examplesPath();
  return withPathLock(path, async () => {
    const data = await loadExamples();
    const now = new Date().toISOString();
    const rec = {
      id: `ex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      intent: String(intent),
      text: String(text),
      ...extras,
      createdAt: now,
    };
    data.examples.push(rec);
    await saveExamples(data);
    return rec;
  });
}

/** List all intents seen in training examples. */
export async function listIntents() {
  const data = await loadExamples();
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ex of data.examples) {
    counts.set(ex.intent, (counts.get(ex.intent) || 0) + 1);
  }
  return [...counts.entries()].map(([intent, count]) => ({ intent, count }));
}

/** List raw examples (filterable by intent). */
export async function listExamples(intent = null) {
  const data = await loadExamples();
  if (!intent) return data.examples;
  return data.examples.filter((e) => e.intent === intent);
}

/* -------------------------------------------------------------------------- */
/* Model training                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a TF-IDF centroid per intent and persist it as the "model".
 *
 * @param {object} [opts]
 * @param {Array<{intent: string, text: string}>} [opts.examples] Override the persisted set.
 * @returns {Promise<object>}
 */
export async function trainIntentClassifier(opts = {}) {
  const examples = Array.isArray(opts.examples)
    ? opts.examples
    : (await loadExamples()).examples;
  if (!examples || examples.length === 0) {
    throw new Error("no training examples available");
  }
  const tokenized = examples.map((ex) => tokenize(ex.text || ""));
  const idfs = idf(tokenized);
  /** @type {Record<string, Record<string, number>>} */
  const centroids = {};
  /** @type {Record<string, number>} */
  const counts = {};
  for (let i = 0; i < examples.length; i += 1) {
    const intent = examples[i].intent;
    const docTf = tf(tokenized[i]);
    const docLen = tokenized[i].length || 1;
    if (!centroids[intent]) centroids[intent] = {};
    counts[intent] = (counts[intent] || 0) + 1;
    for (const [term, freq] of Object.entries(docTf)) {
      const w = (idfs[term] || 1) * (freq / docLen);
      centroids[intent][term] = (centroids[intent][term] || 0) + w;
    }
  }
  // Normalize centroids by count
  for (const intent of Object.keys(centroids)) {
    const n = counts[intent] || 1;
    for (const term of Object.keys(centroids[intent])) {
      centroids[intent][term] = centroids[intent][term] / n;
    }
  }
  const model = {
    version: STORE_VERSION,
    idf: idfs,
    centroids,
    intents: Object.keys(centroids),
    trainedAt: new Date().toISOString(),
    exampleCount: examples.length,
  };
  await withPathLock(modelPath(), async () => {
    await writeJsonPath(modelPath(), model);
  });
  return model;
}

/**
 * Load the persisted model (or train on demand).
 *
 * @returns {Promise<object | null>}
 */
async function loadModel() {
  const data = await readJsonPath(modelPath(), null);
  if (!data || !data.centroids) return null;
  return data;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 * @returns {number}
 */
function dot(a, b) {
  let s = 0;
  for (const [term, w] of Object.entries(a)) {
    const bw = b[term];
    if (bw) s += w * bw;
  }
  return s;
}

/**
 * @param {Record<string, number>} a
 * @returns {number}
 */
function norm(a) {
  let s = 0;
  for (const w of Object.values(a)) s += w * w;
  return Math.sqrt(s);
}

/**
 * Score a ticket against each intent using cosine similarity.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.model] Override model (else loads persisted).
 * @returns {Promise<{ intent: string | null, confidence: number, scores: Array<{intent: string, score: number}> }>}
 */
export async function classifyTicket(text, opts = {}) {
  if (!text || typeof text !== "string") {
    return { intent: null, confidence: 0, scores: [] };
  }
  const model = opts.model || (await loadModel());
  if (!model || !model.centroids) {
    return { intent: null, confidence: 0, scores: [] };
  }
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return { intent: null, confidence: 0, scores: [] };
  }
  const docTf = tf(tokens);
  /** @type {Record<string, number>} */
  const vec = {};
  const docLen = tokens.length;
  for (const [term, freq] of Object.entries(docTf)) {
    const w = (model.idf[term] || 1) * (freq / docLen);
    vec[term] = w;
  }
  const vecNorm = norm(vec);
  /** @type {Array<{intent: string, score: number}>} */
  const scores = [];
  for (const [intent, centroid] of Object.entries(model.centroids)) {
    const cn = norm(/** @type {any} */ (centroid));
    const denom = vecNorm * cn;
    const cos = denom > 0 ? dot(vec, /** @type {any} */ (centroid)) / denom : 0;
    scores.push({ intent, score: Math.round(cos * 10000) / 10000 });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  return {
    intent: best && best.score > 0 ? best.intent : null,
    confidence: best ? best.score : 0,
    scores,
  };
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate the classifier against a labelled test set.
 *
 * @param {Array<{intent: string, text: string}>} testSet
 * @param {object} [opts]
 * @returns {Promise<{accuracy: number, correct: number, total: number, perIntent: Record<string, {correct: number, total: number}>}>}
 */
export async function evaluateClassifier(testSet, opts = {}) {
  if (!Array.isArray(testSet) || testSet.length === 0) {
    return { accuracy: 0, correct: 0, total: 0, perIntent: {} };
  }
  const model = opts.model || (await loadModel());
  if (!model) return { accuracy: 0, correct: 0, total: 0, perIntent: {} };
  /** @type {Record<string, {correct: number, total: number}>} */
  const perIntent = {};
  let correct = 0;
  for (const item of testSet) {
    const expected = item.intent;
    const result = await classifyTicket(item.text, { model });
    if (!perIntent[expected]) perIntent[expected] = { correct: 0, total: 0 };
    perIntent[expected].total += 1;
    if (result.intent === expected) {
      perIntent[expected].correct += 1;
      correct += 1;
    }
  }
  return {
    accuracy: Math.round((correct / testSet.length) * 10000) / 10000,
    correct,
    total: testSet.length,
    perIntent,
  };
}
