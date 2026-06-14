/**
 * Karpathy's 3-stage LLM training pipeline orchestrator.
 * Manages progression from base model -> SFT -> aligned model.
 *
 * Reference: Andrej Karpathy's "State of GPT" (Microsoft Build 2023) and
 * "Let's build GPT" talks. The canonical pipeline has three phases:
 *
 *   1. Pretraining              - raw text, next-token prediction, base LLM
 *   2. Supervised Fine-Tuning   - curated (prompt, ideal_response) pairs
 *   3. RLHF / DPO               - preference data (chosen vs. rejected)
 *
 * This module does NOT perform the actual gradient descent -- it orchestrates
 * the pipeline lifecycle, prepares datasets, evaluates quality at each stage,
 * and persists pipeline state so SiskelBot workspaces can track their own
 * fine-tuning programs.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

/**
 * Canonical stage names. Matches Karpathy's "State of GPT" slide deck.
 * Reward modeling is listed separately because RLHF typically requires a
 * trained reward model before policy optimization; DPO folds the two into
 * one closed-form step and so can be run directly after SFT.
 */
export const STAGES = {
  PRETRAIN: "pretrain",
  SFT: "sft",
  REWARD_MODELING: "reward_modeling",
  RLHF: "rlhf",
  DPO: "dpo",
};

const STAGE_ORDER = [
  STAGES.PRETRAIN,
  STAGES.SFT,
  STAGES.REWARD_MODELING,
  STAGES.RLHF,
  STAGES.DPO,
];

const STAGE_SET = new Set(STAGE_ORDER);

const PIPELINE_STATUS = {
  CREATED: "created",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
};

const WORKSPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !ws.trim()) return "default";
  const s = ws.trim().slice(0, 50);
  return WORKSPACE_PATTERN.test(s) ? s : "default";
}

function getPipelineDir() {
  return process.env.TRAINING_PIPELINE_DATA_DIR || join(getDataDir(), "training-pipelines");
}

function getPipelinePath(workspace) {
  return join(getPipelineDir(), `${sanitizeWorkspace(workspace)}.json`);
}

async function loadPipelines(workspace) {
  const path = getPipelinePath(workspace);
  const raw = await readJsonPath(path, { pipelines: [] });
  if (!raw || !Array.isArray(raw.pipelines)) return { pipelines: [] };
  return raw;
}

async function savePipelines(workspace, data) {
  const path = getPipelinePath(workspace);
  await writeJsonPath(path, data);
}

function normalizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return [STAGES.PRETRAIN, STAGES.SFT, STAGES.DPO];
  }
  const clean = [];
  for (const s of stages) {
    const name = String(s || "").trim().toLowerCase();
    if (STAGE_SET.has(name) && !clean.includes(name)) clean.push(name);
  }
  if (clean.length === 0) return [STAGES.PRETRAIN, STAGES.SFT, STAGES.DPO];
  // Keep Karpathy's canonical order
  clean.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
  return clean;
}

/**
 * Create a new training pipeline record.
 * @param {object} config
 * @param {string} config.name
 * @param {string} [config.baseModel]
 * @param {string[]} [config.stages]
 * @param {string} [config.workspaceId]
 * @param {object} [config.metadata]
 * @returns {Promise<object>}
 */
export async function createTrainingPipeline(config) {
  if (!config || typeof config !== "object") throw new Error("config required");
  const name = typeof config.name === "string" ? config.name.trim() : "";
  if (!name) throw new Error("config.name required");
  const workspace = sanitizeWorkspace(config.workspaceId);
  const stages = normalizeStages(config.stages);
  const id = randomUUID();
  const now = new Date().toISOString();
  const pipeline = {
    id,
    name,
    workspace,
    baseModel: typeof config.baseModel === "string" ? config.baseModel : "",
    stages,
    currentStage: stages[0],
    currentStageIndex: 0,
    status: PIPELINE_STATUS.CREATED,
    createdAt: now,
    updatedAt: now,
    metadata: (config.metadata && typeof config.metadata === "object") ? config.metadata : {},
    history: [],
    models: {}, // { stage: modelRef }
  };
  const path = getPipelinePath(workspace);
  await withPathLock(path, async () => {
    const data = await loadPipelines(workspace);
    data.pipelines = Array.isArray(data.pipelines) ? data.pipelines : [];
    data.pipelines.push(pipeline);
    await savePipelines(workspace, data);
  });
  return pipeline;
}

/**
 * Advance the pipeline to the next stage. Records the previous stage's output
 * and becomes the input for the next.
 * @param {string} pipelineId
 * @param {object} stageResult - { outputModel, metrics?, notes? }
 * @param {string} [workspaceId]
 */
export async function advanceStage(pipelineId, stageResult, workspaceId) {
  if (!pipelineId) throw new Error("pipelineId required");
  const workspace = sanitizeWorkspace(workspaceId);
  const path = getPipelinePath(workspace);
  return withPathLock(path, async () => {
    const data = await loadPipelines(workspace);
    const idx = data.pipelines.findIndex((p) => p.id === pipelineId);
    if (idx < 0) throw new Error("pipeline not found");
    const p = data.pipelines[idx];
    const now = new Date().toISOString();
    const completedStage = p.currentStage;
    const result = stageResult && typeof stageResult === "object" ? stageResult : {};
    p.history.push({
      stage: completedStage,
      completedAt: now,
      outputModel: result.outputModel || null,
      metrics: result.metrics || null,
      notes: result.notes || "",
    });
    if (result.outputModel) p.models[completedStage] = result.outputModel;
    const nextIndex = p.currentStageIndex + 1;
    if (nextIndex >= p.stages.length) {
      p.status = PIPELINE_STATUS.COMPLETED;
      p.currentStageIndex = p.stages.length - 1;
      p.currentStage = p.stages[p.stages.length - 1];
    } else {
      p.currentStageIndex = nextIndex;
      p.currentStage = p.stages[nextIndex];
      p.status = PIPELINE_STATUS.RUNNING;
    }
    p.updatedAt = now;
    data.pipelines[idx] = p;
    await savePipelines(workspace, data);
    return p;
  });
}

/**
 * Get pipeline status by id (searches across workspace).
 */
export async function getPipelineStatus(pipelineId, workspaceId) {
  if (!pipelineId) return null;
  const workspace = sanitizeWorkspace(workspaceId);
  const data = await loadPipelines(workspace);
  return data.pipelines.find((p) => p.id === pipelineId) || null;
}

/**
 * List all pipelines in a workspace.
 */
export async function listPipelines(workspaceId) {
  const workspace = sanitizeWorkspace(workspaceId);
  const data = await loadPipelines(workspace);
  return Array.isArray(data.pipelines) ? [...data.pipelines] : [];
}

// ── Data preparation ────────────────────────────────────────────────────────

/**
 * Prepare pretraining data. Cleans, deduplicates, and approximates token count.
 * The actual tokenization would be done by the training framework; here we
 * return a normalized character-level stream plus stats. No vocab required.
 *
 * @param {Array<{text?: string, content?: string}>} sourceDocuments
 * @param {object} [options]
 * @param {number} [options.minChars]
 * @param {boolean} [options.lowercase]
 * @param {boolean} [options.dedupe]
 * @returns {Promise<{tokens: string[], stats: object}>}
 */
export async function preparePretrainingData(sourceDocuments, options = {}) {
  const docs = Array.isArray(sourceDocuments) ? sourceDocuments : [];
  const minChars = Number.isFinite(options.minChars) ? options.minChars : 32;
  const lowercase = options.lowercase === true;
  const dedupe = options.dedupe !== false; // default true

  const seen = new Set();
  const clean = [];
  let skippedShort = 0;
  let skippedDup = 0;
  let skippedEmpty = 0;
  let totalChars = 0;

  for (const doc of docs) {
    let text = "";
    if (typeof doc === "string") text = doc;
    else if (doc && typeof doc === "object") text = String(doc.text || doc.content || "");
    text = text.replace(/\s+/g, " ").trim();
    if (!text) { skippedEmpty++; continue; }
    if (lowercase) text = text.toLowerCase();
    if (text.length < minChars) { skippedShort++; continue; }
    if (dedupe) {
      if (seen.has(text)) { skippedDup++; continue; }
      seen.add(text);
    }
    clean.push(text);
    totalChars += text.length;
  }

  // Whitespace-split "tokens" -- approximation. Real training uses BPE/Unigram.
  const tokens = [];
  for (const doc of clean) {
    const parts = doc.split(/\s+/).filter(Boolean);
    tokens.push(...parts);
  }

  const avgDocChars = clean.length ? totalChars / clean.length : 0;
  const approxTokens = tokens.length;
  const approxBpeTokens = Math.round(totalChars / 4); // ~4 chars per BPE token

  return {
    tokens,
    stats: {
      inputDocs: docs.length,
      keptDocs: clean.length,
      skippedEmpty,
      skippedShort,
      skippedDup,
      totalChars,
      avgDocChars,
      approxWhitespaceTokens: approxTokens,
      approxBpeTokens,
      uniqueTokens: new Set(tokens).size,
    },
  };
}

/**
 * Extract (prompt, ideal_response) pairs from high-rated conversations.
 * Input conversations follow SiskelBot's conversation shape:
 *   { id, messages: [{role, content, rating?}], rating?, ... }
 * Only (user -> assistant) pairs are emitted. Pairs can be filtered by
 * minimum rating, minimum length, and a required "positive" assistant signal.
 *
 * @param {Array<object>} conversations
 * @param {object} [options]
 * @param {number} [options.minRating] - filter conversations by rating
 * @param {number} [options.minResponseChars]
 * @param {string} [options.template] - instruction template with {prompt} and {response}
 * @returns {Promise<{pairs: Array<object>, jsonl: string, stats: object}>}
 */
export async function prepareSFTData(conversations, options = {}) {
  const convs = Array.isArray(conversations) ? conversations : [];
  const minRating = Number.isFinite(options.minRating) ? options.minRating : 0;
  const minResponseChars = Number.isFinite(options.minResponseChars) ? options.minResponseChars : 8;
  const template = typeof options.template === "string" ? options.template : null;

  const pairs = [];
  let skippedLowRating = 0;
  let skippedShortResponse = 0;
  let skippedNoPair = 0;

  for (const conv of convs) {
    if (!conv || typeof conv !== "object") continue;
    const convRating = Number(conv.rating);
    if (Number.isFinite(convRating) && convRating < minRating) { skippedLowRating++; continue; }
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    if (messages.length < 2) { skippedNoPair++; continue; }

    for (let i = 0; i < messages.length - 1; i++) {
      const a = messages[i];
      const b = messages[i + 1];
      if (!a || !b) continue;
      if (a.role !== "user" || b.role !== "assistant") continue;
      const prompt = String(a.content || "").trim();
      const response = String(b.content || "").trim();
      if (!prompt || !response) continue;
      if (response.length < minResponseChars) { skippedShortResponse++; continue; }
      const msgRating = Number(b.rating);
      if (Number.isFinite(msgRating) && msgRating < minRating) { skippedLowRating++; continue; }

      const formatted = template
        ? template.replace("{prompt}", prompt).replace("{response}", response)
        : null;

      pairs.push({
        prompt,
        response,
        conversationId: conv.id || null,
        messageIndex: i + 1,
        rating: Number.isFinite(msgRating) ? msgRating : (Number.isFinite(convRating) ? convRating : null),
        formatted,
      });
    }
  }

  const jsonl = pairs
    .map((p) => JSON.stringify({ prompt: p.prompt, response: p.response }))
    .join("\n");

  return {
    pairs,
    jsonl,
    stats: {
      inputConversations: convs.length,
      pairs: pairs.length,
      skippedLowRating,
      skippedShortResponse,
      skippedNoPair,
    },
  };
}

/**
 * Build (prompt, chosen, rejected) triples for DPO / reward modeling.
 * Two sources are supported:
 *   1. Messages with explicit `chosen`/`rejected` fields
 *   2. Two sibling assistant messages with differing ratings on the same prompt
 *
 * @param {Array<object>} conversations
 * @param {object} [options]
 * @param {number} [options.minRatingGap] - required difference between chosen and rejected
 * @param {number} [options.minResponseChars]
 * @returns {Promise<{triples: Array<object>, jsonl: string, stats: object}>}
 */
export async function preparePreferenceData(conversations, options = {}) {
  const convs = Array.isArray(conversations) ? conversations : [];
  const minRatingGap = Number.isFinite(options.minRatingGap) ? options.minRatingGap : 1;
  const minResponseChars = Number.isFinite(options.minResponseChars) ? options.minResponseChars : 4;

  const triples = [];
  let skippedGap = 0;
  let skippedShort = 0;
  let skippedNoSibling = 0;

  for (const conv of convs) {
    if (!conv || typeof conv !== "object") continue;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];

    // Explicit chosen/rejected pairs
    const explicit = Array.isArray(conv.preferencePairs) ? conv.preferencePairs : [];
    for (const pp of explicit) {
      if (!pp) continue;
      const prompt = String(pp.prompt || "").trim();
      const chosen = String(pp.chosen || "").trim();
      const rejected = String(pp.rejected || "").trim();
      if (!prompt || !chosen || !rejected) continue;
      if (chosen.length < minResponseChars || rejected.length < minResponseChars) { skippedShort++; continue; }
      triples.push({ prompt, chosen, rejected, source: "explicit", conversationId: conv.id || null });
    }

    // Sibling-rating heuristic: user message followed by alt assistant replies
    for (let i = 0; i < messages.length - 1; i++) {
      const user = messages[i];
      if (!user || user.role !== "user") continue;
      const prompt = String(user.content || "").trim();
      if (!prompt) continue;
      const alts = [];
      for (let j = i + 1; j < messages.length; j++) {
        const m = messages[j];
        if (!m) break;
        if (m.role === "user") break;
        if (m.role === "assistant" && String(m.content || "").trim()) {
          alts.push(m);
        }
      }
      if (alts.length < 2) {
        if (alts.length === 0) skippedNoSibling++;
        continue;
      }
      // Find best-rated and worst-rated alternative
      let best = alts[0];
      let worst = alts[0];
      for (const a of alts) {
        if (Number(a.rating) > Number(best.rating || -Infinity)) best = a;
        if (Number(a.rating) < Number(worst.rating || Infinity)) worst = a;
      }
      const bestR = Number(best.rating);
      const worstR = Number(worst.rating);
      if (!Number.isFinite(bestR) || !Number.isFinite(worstR)) { skippedGap++; continue; }
      if (bestR - worstR < minRatingGap) { skippedGap++; continue; }
      const chosen = String(best.content || "").trim();
      const rejected = String(worst.content || "").trim();
      if (chosen.length < minResponseChars || rejected.length < minResponseChars) { skippedShort++; continue; }
      if (chosen === rejected) continue;
      triples.push({
        prompt,
        chosen,
        rejected,
        source: "siblings",
        conversationId: conv.id || null,
        chosenRating: bestR,
        rejectedRating: worstR,
      });
    }
  }

  const jsonl = triples
    .map((t) => JSON.stringify({ prompt: t.prompt, chosen: t.chosen, rejected: t.rejected }))
    .join("\n");

  return {
    triples,
    jsonl,
    stats: {
      inputConversations: convs.length,
      triples: triples.length,
      skippedGap,
      skippedShort,
      skippedNoSibling,
    },
  };
}

// ── Quality metrics per stage ───────────────────────────────────────────────

/**
 * Evaluate a pretrained model against a test set.
 * Accepts two forms of inputs:
 *   - model.scoreBatch(prompts): Promise<Array<{logLoss?: number, correct?: boolean}>>
 *   - model with no scoring: returns baseline metrics from provided `losses`
 *
 * Returns { perplexity, loss, accuracy }.
 */
export async function evaluatePretraining(model, testSet) {
  const items = Array.isArray(testSet) ? testSet : [];
  if (items.length === 0) {
    return { perplexity: 0, loss: 0, accuracy: 0, sampleCount: 0 };
  }

  let totalLoss = 0;
  let correct = 0;
  let counted = 0;

  if (model && typeof model.scoreBatch === "function") {
    const prompts = items.map((it) => it.prompt || it.text || "");
    const scores = await model.scoreBatch(prompts);
    const arr = Array.isArray(scores) ? scores : [];
    for (let i = 0; i < items.length; i++) {
      const s = arr[i] || {};
      const loss = Number(s.logLoss);
      if (Number.isFinite(loss)) {
        totalLoss += loss;
        counted++;
      }
      if (s.correct === true) correct++;
    }
  } else {
    // Fallback: read losses and correctness from the test set itself
    for (const it of items) {
      const loss = Number(it && it.loss);
      if (Number.isFinite(loss)) {
        totalLoss += loss;
        counted++;
      }
      if (it && it.correct === true) correct++;
    }
  }

  const avgLoss = counted > 0 ? totalLoss / counted : 0;
  const perplexity = counted > 0 ? Math.exp(avgLoss) : 0;
  const accuracy = items.length > 0 ? correct / items.length : 0;
  return { perplexity, loss: avgLoss, accuracy, sampleCount: items.length };
}

/**
 * Evaluate an SFT model for helpfulness, toxicity, and coherence.
 * Uses a caller-supplied judge function if present, otherwise falls back to
 * lightweight heuristics on pre-labeled test items.
 */
export async function evaluateSFT(model, testSet) {
  const items = Array.isArray(testSet) ? testSet : [];
  if (items.length === 0) {
    return { avgHelpfulness: 0, toxicity: 0, coherence: 0, sampleCount: 0 };
  }

  let hSum = 0;
  let tHits = 0;
  let cSum = 0;
  let hCount = 0;
  let cCount = 0;

  for (const it of items) {
    if (!it) continue;
    let judged = null;
    if (model && typeof model.judge === "function") {
      try {
        judged = await model.judge(it);
      } catch {
        judged = null;
      }
    }
    const src = judged || it;
    const h = Number(src.helpfulness);
    if (Number.isFinite(h)) { hSum += h; hCount++; }
    if (src.toxic === true) tHits++;
    const c = Number(src.coherence);
    if (Number.isFinite(c)) { cSum += c; cCount++; }
  }

  return {
    avgHelpfulness: hCount > 0 ? hSum / hCount : 0,
    toxicity: items.length > 0 ? tHits / items.length : 0,
    coherence: cCount > 0 ? cSum / cCount : 0,
    sampleCount: items.length,
  };
}

/**
 * Evaluate a preference-aligned model against (prompt, chosen, rejected) pairs.
 * Returns preferenceAccuracy (fraction of pairs where the model prefers the
 * chosen response) and an estimated KL divergence from a reference model.
 *
 * Models may provide:
 *   - `preference(prompt, chosen, rejected)` => 'chosen' | 'rejected' | score > 0
 *   - `logProb(prompt, response)`             => number
 *
 * When `refLogProb` is supplied on the pair, KL is estimated as
 *   mean( logProb_policy - logProb_ref ).
 */
export async function evaluatePreferenceAlignment(model, preferencePairs) {
  const pairs = Array.isArray(preferencePairs) ? preferencePairs : [];
  if (pairs.length === 0) {
    return { preferenceAccuracy: 0, klDivergence: 0, sampleCount: 0 };
  }

  let correct = 0;
  let counted = 0;
  let klSum = 0;
  let klCount = 0;

  for (const pair of pairs) {
    if (!pair) continue;
    const prompt = String(pair.prompt || "");
    const chosen = String(pair.chosen || "");
    const rejected = String(pair.rejected || "");
    if (!prompt || !chosen || !rejected) continue;
    counted++;

    let prefersChosen = false;
    if (model && typeof model.preference === "function") {
      try {
        const out = await model.preference(prompt, chosen, rejected);
        if (out === "chosen") prefersChosen = true;
        else if (typeof out === "number") prefersChosen = out > 0;
      } catch {
        prefersChosen = false;
      }
    } else if (model && typeof model.logProb === "function") {
      try {
        const lpC = await model.logProb(prompt, chosen);
        const lpR = await model.logProb(prompt, rejected);
        prefersChosen = Number(lpC) > Number(lpR);
      } catch {
        prefersChosen = false;
      }
    } else {
      // Fallback: honor a pre-labeled correct flag on the pair
      prefersChosen = pair.modelPreferred === "chosen";
    }
    if (prefersChosen) correct++;

    if (Number.isFinite(Number(pair.policyLogProb)) && Number.isFinite(Number(pair.refLogProb))) {
      klSum += Number(pair.policyLogProb) - Number(pair.refLogProb);
      klCount++;
    }
  }

  return {
    preferenceAccuracy: counted > 0 ? correct / counted : 0,
    klDivergence: klCount > 0 ? klSum / klCount : 0,
    sampleCount: pairs.length,
  };
}

// ── Karpathy's "fundamental theorem" utilities ──────────────────────────────

/**
 * Detect training instability and loss spikes.
 * Returns a diagnostics object with:
 *   - trend:            'decreasing' | 'increasing' | 'flat'
 *   - avgDelta:         mean step-to-step change
 *   - maxSpike:         largest positive spike
 *   - spikeIndices:     indices where loss jumped > spikeThreshold above running mean
 *   - unstable:         true if too many spikes or trend is upward
 *
 * Karpathy's rule of thumb: if your loss curve has sudden jumps or stops
 * decreasing, lower the learning rate, add gradient clipping, or check data.
 */
export function computeLossGradient(lossHistory) {
  const hist = Array.isArray(lossHistory) ? lossHistory.filter((x) => Number.isFinite(Number(x))).map(Number) : [];
  if (hist.length < 2) {
    return {
      trend: "flat",
      avgDelta: 0,
      maxSpike: 0,
      spikeIndices: [],
      unstable: false,
      sampleCount: hist.length,
    };
  }
  const deltas = [];
  for (let i = 1; i < hist.length; i++) deltas.push(hist[i] - hist[i - 1]);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  // Spike detection: running mean + threshold
  const spikeThreshold = Math.max(0.1, Math.abs(avgDelta) * 3);
  let maxSpike = 0;
  const spikeIndices = [];
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (d > maxSpike) maxSpike = d;
    if (d > spikeThreshold) spikeIndices.push(i + 1);
  }
  let trend;
  if (avgDelta < -1e-4) trend = "decreasing";
  else if (avgDelta > 1e-4) trend = "increasing";
  else trend = "flat";
  const unstable = spikeIndices.length > Math.max(1, Math.floor(hist.length * 0.1)) || trend === "increasing";
  return {
    trend,
    avgDelta,
    maxSpike,
    spikeIndices,
    unstable,
    sampleCount: hist.length,
  };
}

/**
 * Recommend a learning rate based on Karpathy's rules of thumb.
 *
 * Heuristics used (from "State of GPT" / nanoGPT defaults):
 *   - Pretraining:  base ~6e-4 for small GPTs, scale by 1/sqrt(params / 1M)
 *   - SFT:          10x smaller than pretraining   -> ~6e-5
 *   - RLHF/DPO:     another 10x smaller            -> ~6e-6
 *   - Small datasets (<10k tokens): reduce further
 *   - Very large datasets (>1B tokens): bump up slightly
 *
 * @param {{stage?: string, params?: number}} model
 * @param {number} dataSize - approx number of training tokens
 */
export function recommendLearningRate(model, dataSize) {
  const stage = (model && typeof model.stage === "string" ? model.stage : STAGES.SFT).toLowerCase();
  const params = Number(model && model.params) || 1e6;
  const tokens = Number(dataSize) || 0;

  let base;
  if (stage === STAGES.PRETRAIN) base = 6e-4;
  else if (stage === STAGES.SFT) base = 6e-5;
  else if (stage === STAGES.REWARD_MODELING) base = 1e-5;
  else if (stage === STAGES.RLHF || stage === STAGES.DPO) base = 6e-6;
  else base = 3e-5;

  // Parameter scaling: divide by sqrt(params / 1M), Chinchilla-inspired
  const paramScale = 1 / Math.sqrt(Math.max(1, params / 1e6));
  let lr = base * paramScale;

  // Data size adjustments
  let adjustment = "none";
  if (tokens > 0 && tokens < 10_000) {
    lr *= 0.5;
    adjustment = "reduced_for_small_dataset";
  } else if (tokens > 1_000_000_000) {
    lr *= 1.5;
    adjustment = "boosted_for_large_dataset";
  }

  // Warmup length: Karpathy suggests ~1% of total steps, min 100
  const totalSteps = Math.max(1, Math.round(tokens / 1024));
  const warmupSteps = Math.max(100, Math.round(totalSteps * 0.01));

  return {
    stage,
    learningRate: Number(lr.toPrecision(3)),
    base,
    paramScale: Number(paramScale.toPrecision(3)),
    warmupSteps,
    adjustment,
    notes: [
      "Karpathy rule: SFT uses ~10x smaller LR than pretraining",
      "Karpathy rule: RLHF/DPO uses ~10x smaller LR than SFT",
      "Scale inversely with sqrt(params) for stability",
    ],
  };
}
