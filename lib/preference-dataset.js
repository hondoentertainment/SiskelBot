/**
 * Preference dataset builder for RLHF/DPO training.
 * Extracts (prompt, chosen, rejected) triples from user feedback,
 * conversation edits/regenerations, and explicit pairwise rankings.
 *
 * Storage layout (via json-path-store):
 *   data/preference-datasets/{workspaceId}/_index.json       — workspace index of datasets
 *   data/preference-datasets/{workspaceId}/{datasetId}.json  — dataset record with pairs
 *   data/preference-datasets/_global-index.json              — global datasetId → workspaceId map
 *   data/preference-comparisons/{workspaceId}/{comparisonId}.json — pending pairwise comparisons
 */
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { listFeedback } from "./feedback.js";

// ─── path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function datasetPath(workspaceId, datasetId) {
  return join(
    getDataDir(),
    "preference-datasets",
    sanitize(workspaceId),
    `${sanitize(datasetId)}.json`,
  );
}

function indexPath(workspaceId) {
  return join(getDataDir(), "preference-datasets", sanitize(workspaceId), "_index.json");
}

function globalIndexPath() {
  return join(getDataDir(), "preference-datasets", "_global-index.json");
}

function comparisonPath(workspaceId, comparisonId) {
  return join(
    getDataDir(),
    "preference-comparisons",
    sanitize(workspaceId),
    `${sanitize(comparisonId)}.json`,
  );
}

// ─── internal helpers ───────────────────────────────────────────────────────

async function registerGlobal(datasetId, workspaceId) {
  const path = globalIndexPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { map: {} });
    const map = data.map && typeof data.map === "object" ? data.map : {};
    map[datasetId] = workspaceId || "default";
    await writeJsonPath(path, { map });
  });
}

async function unregisterGlobal(datasetId) {
  const path = globalIndexPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { map: {} });
    const map = data.map && typeof data.map === "object" ? data.map : {};
    delete map[datasetId];
    await writeJsonPath(path, { map });
  });
}

async function resolveWorkspace(datasetId) {
  const data = await readJsonPath(globalIndexPath(), { map: {} });
  const map = data.map && typeof data.map === "object" ? data.map : {};
  return map[datasetId] || null;
}

async function updateIndex(workspaceId, entry, remove = false) {
  const path = indexPath(workspaceId);
  await withPathLock(path, async () => {
    const idx = await readJsonPath(path, { datasets: [] });
    const list = Array.isArray(idx.datasets) ? idx.datasets : [];
    const filtered = list.filter((d) => d.id !== (entry?.id || entry));
    if (!remove && entry && typeof entry === "object") filtered.push(entry);
    await writeJsonPath(path, { datasets: filtered });
  });
}

async function readDataset(workspaceId, datasetId) {
  const data = await readJsonPath(datasetPath(workspaceId, datasetId), null);
  if (!data || data._deleted || !data.id) return null;
  return data;
}

async function writeDataset(workspaceId, datasetId, data) {
  await writeJsonPath(datasetPath(workspaceId, datasetId), data);
}

function hashPair(prompt, chosen, rejected) {
  const payload = `${prompt || ""}\u0000${chosen || ""}\u0000${rejected || ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function normalizePair(pair) {
  const prompt = pair?.prompt != null ? String(pair.prompt) : "";
  const chosen = pair?.chosen != null ? String(pair.chosen) : "";
  const rejected = pair?.rejected != null ? String(pair.rejected) : "";
  const id = pair?.id || hashPair(prompt, chosen, rejected);
  const confidence = pair?.confidence != null ? Number(pair.confidence) : null;
  const source = typeof pair?.source === "string" ? pair.source : "manual";
  const metadata = pair?.metadata && typeof pair.metadata === "object" ? pair.metadata : {};
  const createdAt = pair?.createdAt || new Date().toISOString();
  return { id, prompt, chosen, rejected, confidence, source, metadata, createdAt };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new preference dataset.
 * @param {string} name
 * @param {string} workspaceId
 * @param {object} config - { sourceType, minRatingDiff, maxExamples, format, description }
 */
export async function createPreferenceDataset(name, workspaceId, config = {}) {
  if (!name || typeof name !== "string") {
    return { error: "name is required", code: "INVALID_INPUT" };
  }
  const sourceType = String(config.sourceType || "manual");
  if (!["feedback_ratings", "pairwise_comparisons", "manual"].includes(sourceType)) {
    return {
      error: "sourceType must be one of: feedback_ratings, pairwise_comparisons, manual",
      code: "INVALID_INPUT",
    };
  }
  const format = String(config.format || "dpo");
  if (!["dpo", "reward_model", "openai_jsonl"].includes(format)) {
    return {
      error: "format must be one of: dpo, reward_model, openai_jsonl",
      code: "INVALID_INPUT",
    };
  }
  const minRatingDiff = Number.isFinite(Number(config.minRatingDiff))
    ? Number(config.minRatingDiff)
    : 1;
  const maxExamples = Number.isFinite(Number(config.maxExamples))
    ? Number(config.maxExamples)
    : null;

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const ws = workspaceId || "default";
  const dataset = {
    id,
    name,
    description: typeof config.description === "string" ? config.description : "",
    workspaceId: ws,
    config: { sourceType, minRatingDiff, maxExamples, format },
    pairs: [],
    createdAt,
    updatedAt: createdAt,
  };
  await writeDataset(ws, id, dataset);
  await updateIndex(ws, {
    id,
    name,
    sourceType,
    format,
    pairCount: 0,
    createdAt,
  });
  await registerGlobal(id, ws);
  return dataset;
}

/**
 * List preference datasets in a workspace.
 */
export async function listPreferenceDatasets(workspaceId) {
  const idx = await readJsonPath(indexPath(workspaceId || "default"), { datasets: [] });
  return Array.isArray(idx.datasets) ? idx.datasets : [];
}

/**
 * Load a preference dataset by id.
 */
export async function getPreferenceDataset(datasetId, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  const ws = workspaceId || (await resolveWorkspace(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };
  const dataset = await readDataset(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };
  return dataset;
}

/**
 * Delete a preference dataset.
 */
export async function deletePreferenceDataset(datasetId, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  const ws = workspaceId || (await resolveWorkspace(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };
  const existing = await readDataset(ws, datasetId);
  if (!existing) return { error: "dataset not found", code: "NOT_FOUND" };

  await writeJsonPath(datasetPath(ws, datasetId), { _deleted: true, id: datasetId });
  await updateIndex(ws, { id: datasetId }, true);
  await unregisterGlobal(datasetId);
  return { deleted: true, datasetId };
}

/**
 * Add a preference pair.
 */
export async function addPreferencePair(datasetId, pair, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  if (!pair || typeof pair !== "object") {
    return { error: "pair is required", code: "INVALID_INPUT" };
  }
  if (!pair.prompt || !pair.chosen || !pair.rejected) {
    return { error: "pair must include prompt, chosen, and rejected", code: "INVALID_INPUT" };
  }

  const ws = workspaceId || (await resolveWorkspace(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = datasetPath(ws, datasetId);
  return withPathLock(path, async () => {
    const dataset = await readDataset(ws, datasetId);
    if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

    const normalized = normalizePair(pair);
    // Dedupe by id
    const existing = Array.isArray(dataset.pairs) ? dataset.pairs : [];
    if (existing.some((p) => p.id === normalized.id)) {
      return { error: "duplicate pair", code: "DUPLICATE", pairId: normalized.id };
    }
    existing.push(normalized);
    dataset.pairs = existing;
    dataset.updatedAt = new Date().toISOString();
    await writeDataset(ws, datasetId, dataset);
    await updateIndex(ws, {
      id: dataset.id,
      name: dataset.name,
      sourceType: dataset.config?.sourceType,
      format: dataset.config?.format,
      pairCount: existing.length,
      createdAt: dataset.createdAt,
    });
    return { pairId: normalized.id, pairCount: existing.length };
  });
}

/**
 * Remove a preference pair by id.
 */
export async function removePreferencePair(datasetId, pairId, workspaceId) {
  if (!datasetId || !pairId) {
    return { error: "datasetId and pairId are required", code: "INVALID_INPUT" };
  }
  const ws = workspaceId || (await resolveWorkspace(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = datasetPath(ws, datasetId);
  return withPathLock(path, async () => {
    const dataset = await readDataset(ws, datasetId);
    if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

    const existing = Array.isArray(dataset.pairs) ? dataset.pairs : [];
    const remaining = existing.filter((p) => p.id !== pairId);
    if (remaining.length === existing.length) {
      return { error: "pair not found", code: "NOT_FOUND" };
    }
    dataset.pairs = remaining;
    dataset.updatedAt = new Date().toISOString();
    await writeDataset(ws, datasetId, dataset);
    await updateIndex(ws, {
      id: dataset.id,
      name: dataset.name,
      sourceType: dataset.config?.sourceType,
      format: dataset.config?.format,
      pairCount: remaining.length,
      createdAt: dataset.createdAt,
    });
    return { removed: true, pairId, pairCount: remaining.length };
  });
}

// ─── extraction ─────────────────────────────────────────────────────────────

/**
 * Extract preference pairs from user feedback.
 * Finds feedback entries that share a prompt, then pairs highly-rated
 * responses with low-rated ones (where the rating diff meets the threshold).
 *
 * @param {string} workspaceId
 * @param {object} options - { minRatingDiff, maxPairs, feedbackItems (for tests) }
 * @returns {Promise<Array<{prompt, chosen, rejected, ratingDiff, source, metadata}>>}
 */
export async function extractFromFeedback(workspaceId, options = {}) {
  const minRatingDiff = Number.isFinite(Number(options.minRatingDiff))
    ? Number(options.minRatingDiff)
    : 2;
  const maxPairs = Number.isFinite(Number(options.maxPairs)) ? Number(options.maxPairs) : 1000;

  const items = Array.isArray(options.feedbackItems)
    ? options.feedbackItems
    : await listFeedback(workspaceId || "default");

  // Group by prompt (must have both prompt and response)
  const byPrompt = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const prompt = item.prompt;
    const response = item.response;
    const rating = Number(item.rating);
    if (!prompt || !response || !Number.isFinite(rating)) continue;

    if (!byPrompt.has(prompt)) byPrompt.set(prompt, []);
    byPrompt.get(prompt).push({ response, rating, model: item.model || null, id: item.id || null });
  }

  const pairs = [];
  for (const [prompt, responses] of byPrompt) {
    if (responses.length < 2) continue;
    // Sort descending by rating
    const sorted = [...responses].sort((a, b) => b.rating - a.rating);
    // Pair each high-rated response against each lower-rated response
    // that satisfies the minRatingDiff threshold and is a DIFFERENT response text.
    for (let i = 0; i < sorted.length; i++) {
      for (let j = sorted.length - 1; j > i; j--) {
        const hi = sorted[i];
        const lo = sorted[j];
        const diff = hi.rating - lo.rating;
        if (diff < minRatingDiff) continue;
        if (hi.response === lo.response) continue;
        pairs.push({
          prompt,
          chosen: hi.response,
          rejected: lo.response,
          ratingDiff: diff,
          source: "feedback_ratings",
          metadata: {
            chosenRating: hi.rating,
            rejectedRating: lo.rating,
            chosenModel: hi.model,
            rejectedModel: lo.model,
          },
        });
        if (pairs.length >= maxPairs) return pairs;
      }
    }
  }
  return pairs;
}

/**
 * Extract preference pairs from conversation tree edits/regenerations.
 * When a user regenerates or edits a response, the earlier version is "rejected"
 * and the final/retained version is "chosen".
 *
 * @param {string} workspaceId
 * @param {object} options - { conversations (array), maxPairs }
 */
export async function extractFromConversationTree(workspaceId, options = {}) {
  const maxPairs = Number.isFinite(Number(options.maxPairs)) ? Number(options.maxPairs) : 1000;
  const conversations = Array.isArray(options.conversations) ? options.conversations : [];

  const pairs = [];
  for (const conv of conversations) {
    if (!conv || typeof conv !== "object") continue;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== "assistant") continue;
      // Prompt is the most recent user message before this assistant message
      let prompt = "";
      for (let k = i - 1; k >= 0; k--) {
        if (messages[k]?.role === "user") {
          prompt = messages[k].content || "";
          break;
        }
      }
      if (!prompt) continue;

      // "alternatives" = earlier regenerated/edited candidates that were rejected
      const alternatives = Array.isArray(msg.alternatives) ? msg.alternatives : [];
      const chosen = msg.content || "";
      if (!chosen) continue;
      for (const alt of alternatives) {
        const rejected = typeof alt === "string" ? alt : alt?.content || "";
        if (!rejected || rejected === chosen) continue;
        pairs.push({
          prompt,
          chosen,
          rejected,
          source: "conversation_tree",
          metadata: {
            conversationId: conv.id || null,
            messageIndex: i,
          },
        });
        if (pairs.length >= maxPairs) return pairs;
      }
    }
  }
  return pairs;
}

// ─── pairwise comparisons ───────────────────────────────────────────────────

/**
 * Create a pairwise comparison task: multiple responses for the same prompt.
 * A human ranks them; the ranking is later submitted via submitRanking().
 *
 * @param {string} prompt
 * @param {Array<{id?: string, content: string, model?: string}>} responses
 * @param {string} [workspaceId]
 */
export async function createComparison(prompt, responses, workspaceId) {
  if (!prompt || typeof prompt !== "string") {
    return { error: "prompt is required", code: "INVALID_INPUT" };
  }
  if (!Array.isArray(responses) || responses.length < 2) {
    return { error: "responses must be an array of 2+ items", code: "INVALID_INPUT" };
  }
  const comparisonId = randomUUID();
  const ws = workspaceId || "default";
  const createdAt = new Date().toISOString();
  const normalized = responses.map((r, idx) => ({
    id: r?.id || `resp-${idx}`,
    content: r?.content != null ? String(r.content) : "",
    model: r?.model || null,
  }));
  const record = {
    comparisonId,
    workspaceId: ws,
    prompt,
    responses: normalized,
    awaitingRanking: true,
    createdAt,
  };
  await writeJsonPath(comparisonPath(ws, comparisonId), record);
  return record;
}

/**
 * Submit a ranking for a pairwise comparison.
 * Converts the ranking into preference pairs using the "rank-to-pairs" expansion:
 * for ranking [A, B, C], we emit pairs (A>B), (A>C), (B>C).
 *
 * @param {string} comparisonId
 * @param {string[]} ranking - ordered response IDs, best first
 * @param {string} userId
 * @param {string} [workspaceId]
 */
export async function submitRanking(comparisonId, ranking, userId, workspaceId) {
  if (!comparisonId) return { error: "comparisonId is required", code: "INVALID_INPUT" };
  if (!Array.isArray(ranking) || ranking.length < 2) {
    return { error: "ranking must be an array of 2+ response ids", code: "INVALID_INPUT" };
  }

  // Try the supplied workspace first, then scan via the default path.
  const ws = workspaceId || "default";
  const path = comparisonPath(ws, comparisonId);
  const record = await readJsonPath(path, null);
  if (!record || !record.comparisonId) {
    return { error: "comparison not found", code: "NOT_FOUND" };
  }

  const idSet = new Set(record.responses.map((r) => r.id));
  for (const id of ranking) {
    if (!idSet.has(id)) {
      return { error: `unknown response id: ${id}`, code: "INVALID_INPUT" };
    }
  }

  const byId = new Map(record.responses.map((r) => [r.id, r]));
  const pairs = [];
  // Generate all (higher > lower) pairs from the ranking.
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      const hi = byId.get(ranking[i]);
      const lo = byId.get(ranking[j]);
      if (!hi || !lo) continue;
      if (hi.content === lo.content) continue;
      pairs.push({
        prompt: record.prompt,
        chosen: hi.content,
        rejected: lo.content,
        source: "pairwise_comparison",
        metadata: {
          comparisonId,
          userId: userId || null,
          chosenModel: hi.model,
          rejectedModel: lo.model,
          rankDistance: j - i,
        },
      });
    }
  }

  record.awaitingRanking = false;
  record.ranking = ranking;
  record.rankedBy = userId || null;
  record.rankedAt = new Date().toISOString();
  record.generatedPairs = pairs.length;
  await writeJsonPath(path, record);

  return { comparisonId, pairs, pairCount: pairs.length };
}

// ─── validation and stats ───────────────────────────────────────────────────

/**
 * Validate a dataset for RLHF training readiness.
 * Checks: minimum count, duplicates, trivial preferences, length bias.
 */
export async function validatePreferenceDataset(datasetId, workspaceId) {
  const dataset = await getPreferenceDataset(datasetId, workspaceId);
  if (dataset?.error) return dataset;

  const issues = [];
  const pairs = Array.isArray(dataset.pairs) ? dataset.pairs : [];
  const total = pairs.length;

  if (total < 100) {
    issues.push({
      type: "INSUFFICIENT_EXAMPLES",
      severity: total < 10 ? "error" : "warning",
      message: `only ${total} pairs; 100+ recommended for RLHF/DPO`,
    });
  }

  // Duplicate prompts check (same prompt appearing in multiple pairs)
  const promptCounts = new Map();
  for (const p of pairs) {
    promptCounts.set(p.prompt, (promptCounts.get(p.prompt) || 0) + 1);
  }
  const dupPrompts = [...promptCounts.values()].filter((c) => c > 1).length;
  if (dupPrompts > total * 0.3) {
    issues.push({
      type: "HIGH_PROMPT_DUPLICATION",
      severity: "warning",
      message: `${dupPrompts} prompts repeat across pairs (>30% of total)`,
    });
  }

  // Trivial preferences: chosen == rejected
  const trivial = pairs.filter((p) => p.chosen === p.rejected).length;
  if (trivial > 0) {
    issues.push({
      type: "TRIVIAL_PREFERENCES",
      severity: "error",
      message: `${trivial} pairs have chosen == rejected`,
    });
  }

  // Rating-diff based triviality (when confidence/ratingDiff present)
  const lowConfidence = pairs.filter((p) => {
    const diff = p?.metadata?.ratingDiff ?? p?.ratingDiff ?? null;
    return diff != null && diff < 1;
  }).length;
  if (lowConfidence > 0) {
    issues.push({
      type: "LOW_CONFIDENCE_PREFERENCES",
      severity: "warning",
      message: `${lowConfidence} pairs have rating diff < 1`,
    });
  }

  // Length bias
  const bias = detectLengthBias(dataset);
  if (bias.biased) {
    issues.push({
      type: "LENGTH_BIAS",
      severity: "warning",
      message: `chosen responses are systematically ${bias.direction} (${bias.ratio.toFixed(2)}x)`,
    });
  }

  // Length balance (chosen vs rejected similar length)
  if (!bias.biased && total > 0) {
    // still report average length gap
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const valid = errorCount === 0;
  // Score: 100 - 25*errors - 5*warnings (floor 0)
  const score = Math.max(0, 100 - errorCount * 25 - warningCount * 5);
  return { valid, issues, score, total, errorCount, warningCount };
}

// ─── format converters ──────────────────────────────────────────────────────

/**
 * Standard DPO format: one JSON object per pair.
 */
export function toDPOFormat(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  return list.map((p) => ({
    prompt: p.prompt || "",
    chosen: p.chosen || "",
    rejected: p.rejected || "",
  }));
}

/**
 * Reward model format: pairs with numeric scores for chosen/rejected.
 * Uses confidence/ratingDiff when available; default chosen=1, rejected=0.
 */
export function toRewardModelFormat(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  return list.map((p) => {
    const diff = p?.metadata?.ratingDiff ?? p?.ratingDiff ?? null;
    const confidence = p?.confidence ?? (diff != null ? Math.min(1, diff / 4) : 1);
    return {
      prompt: p.prompt || "",
      chosen: p.chosen || "",
      rejected: p.rejected || "",
      chosen_score: 1,
      rejected_score: 0,
      confidence,
    };
  });
}

/**
 * OpenAI fine-tuning "distillation" format: messages + chosen completion.
 * OpenAI DPO fine-tuning expects {input: {messages}, preferred_output, non_preferred_output}.
 */
export function toOpenAIDistillation(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  return list.map((p) => ({
    input: {
      messages: [{ role: "user", content: p.prompt || "" }],
    },
    preferred_output: [{ role: "assistant", content: p.chosen || "" }],
    non_preferred_output: [{ role: "assistant", content: p.rejected || "" }],
  }));
}

// ─── stats / length bias ────────────────────────────────────────────────────

/**
 * Compute descriptive stats for a preference dataset.
 */
export async function getDatasetStats(datasetId, workspaceId) {
  const dataset = await getPreferenceDataset(datasetId, workspaceId);
  if (dataset?.error) return dataset;

  const pairs = Array.isArray(dataset.pairs) ? dataset.pairs : [];
  const total = pairs.length;

  let promptLen = 0;
  let chosenLen = 0;
  let rejectedLen = 0;
  let ratingDiffSum = 0;
  let ratingDiffCount = 0;
  const sources = {};

  for (const p of pairs) {
    promptLen += (p.prompt || "").length;
    chosenLen += (p.chosen || "").length;
    rejectedLen += (p.rejected || "").length;
    const diff = p?.metadata?.ratingDiff ?? p?.ratingDiff;
    if (Number.isFinite(Number(diff))) {
      ratingDiffSum += Number(diff);
      ratingDiffCount += 1;
    }
    const src = p.source || "unknown";
    sources[src] = (sources[src] || 0) + 1;
  }

  const avg = (sum) => (total ? sum / total : 0);
  const bias = detectLengthBias(dataset);

  return {
    total,
    avgPromptLen: avg(promptLen),
    avgChosenLen: avg(chosenLen),
    avgRejectedLen: avg(rejectedLen),
    avgRatingDiff: ratingDiffCount ? ratingDiffSum / ratingDiffCount : 0,
    sources,
    lengthBias: bias,
  };
}

/**
 * Detect whether chosen responses are systematically longer (or shorter) than rejected.
 * Karpathy noted that reward models tend to reward verbosity — a common RLHF failure mode.
 * Returns { biased, direction, ratio }.
 */
export function detectLengthBias(dataset) {
  const pairs = Array.isArray(dataset?.pairs) ? dataset.pairs : [];
  if (pairs.length === 0) {
    return { biased: false, direction: "none", ratio: 1, sampleCount: 0 };
  }
  let chosenSum = 0;
  let rejectedSum = 0;
  let longerChosen = 0;
  for (const p of pairs) {
    const cl = (p.chosen || "").length;
    const rl = (p.rejected || "").length;
    chosenSum += cl;
    rejectedSum += rl;
    if (cl > rl) longerChosen += 1;
  }
  const avgChosen = chosenSum / pairs.length;
  const avgRejected = rejectedSum / pairs.length;
  const ratio = avgRejected > 0 ? avgChosen / avgRejected : (avgChosen > 0 ? Infinity : 1);
  const longerFrac = longerChosen / pairs.length;

  // Biased if the chosen average length is >= 1.5x the rejected average, OR
  // if >80% of pairs have a longer chosen response (both with enough samples).
  const enoughSamples = pairs.length >= 5;
  const ratioBiased = ratio >= 1.5 || ratio <= 0.67;
  const fractionBiased = enoughSamples && (longerFrac >= 0.8 || longerFrac <= 0.2);
  const biased = ratioBiased || fractionBiased;
  let direction = "none";
  if (biased) {
    if (ratio >= 1.5 || (enoughSamples && longerFrac >= 0.8)) direction = "longer";
    else if (ratio <= 0.67 || (enoughSamples && longerFrac <= 0.2)) direction = "shorter";
  }
  return {
    biased,
    direction,
    ratio,
    avgChosenLen: avgChosen,
    avgRejectedLen: avgRejected,
    longerChosenFraction: longerFrac,
    sampleCount: pairs.length,
  };
}

/**
 * Load a comparison record (used by routes).
 */
export async function getComparison(comparisonId, workspaceId) {
  if (!comparisonId) return { error: "comparisonId is required", code: "INVALID_INPUT" };
  const ws = workspaceId || "default";
  const record = await readJsonPath(comparisonPath(ws, comparisonId), null);
  if (!record || !record.comparisonId) {
    return { error: "comparison not found", code: "NOT_FOUND" };
  }
  return record;
}
