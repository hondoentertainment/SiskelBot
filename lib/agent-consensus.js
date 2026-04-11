// @ts-check
/**
 * Phase 47.4: Multi-agent consensus for high-confidence answers.
 *
 * Inspired by ensemble learning and Byzantine fault tolerance: query several
 * agents (typically backed by different models / system prompts) for the same
 * prompt, then aggregate their answers via a configurable strategy. The
 * resulting consensus carries an estimated confidence based on inter-agent
 * agreement, and the per-agent disagreement profile is persisted so callers
 * can later flag agents that consistently dissent from the majority
 * (`detectByzantineAgents`).
 *
 * Strategies:
 *   - majority_vote   group-by similarity, return the largest cluster
 *   - weighted        weighted vote by per-agent reputation
 *   - llm_judge       a separate LLM picks the best response
 *   - ranked_choice   each agent ranks the others; aggregate via Borda count
 *
 * All operations are best-effort and degrade gracefully when an embeddings
 * backend or judge model is unavailable.
 *
 * @module agent-consensus
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { groupSimilarResponses, computeTextSimilarity } from "./response-similarity.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_QUORUM = 2;
const DEFAULT_SIMILARITY_THRESHOLD = 0.78;
const STORE_VERSION = 1;
const MAX_PERSISTED_RUNS = Math.min(
  10_000,
  Math.max(50, Number(process.env.AGENT_CONSENSUS_MAX_RUNS) || 1000),
);

const STRATEGIES = new Set(["majority_vote", "weighted", "llm_judge", "ranked_choice"]);

function storePath() {
  return join(getDataDir(), "agent-consensus.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const runs = base.runs && typeof base.runs === "object" && !Array.isArray(base.runs) ? base.runs : {};
  const order = Array.isArray(base.order) ? base.order.filter((x) => typeof x === "string") : [];
  const byzantine =
    base.byzantine && typeof base.byzantine === "object" && !Array.isArray(base.byzantine)
      ? base.byzantine
      : {};
  return { _version: STORE_VERSION, runs, order, byzantine };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), { _version: STORE_VERSION, runs: {}, order: [], byzantine: {} }));
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

/**
 * Persist a completed consensus run and update Byzantine agreement counters.
 * @param {object} run
 * @returns {Promise<void>}
 */
async function persistRun(run) {
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.runs[run.id] = run;
    store.order.push(run.id);
    while (store.order.length > MAX_PERSISTED_RUNS) {
      const drop = store.order.shift();
      if (drop && drop !== run.id) delete store.runs[drop];
    }
    // Update Byzantine counters: every agent that produced a response gets a
    // (votes_with_majority, total_votes) entry. Agents whose response landed
    // outside the winning cluster are counted as dissenting.
    if (Array.isArray(run.responses)) {
      const winningSet = new Set(Array.isArray(run.winningMembers) ? run.winningMembers : []);
      for (let i = 0; i < run.responses.length; i++) {
        const r = run.responses[i];
        const agentId = (r && (r.agentId || r.id || r.model)) || `agent_${i}`;
        const entry =
          (store.byzantine[agentId] && typeof store.byzantine[agentId] === "object")
            ? store.byzantine[agentId]
            : { agentId, total: 0, agreed: 0, dissents: 0, lastRunId: null };
        entry.total += 1;
        if (winningSet.has(i)) entry.agreed += 1;
        else entry.dissents += 1;
        entry.lastRunId = run.id;
        store.byzantine[agentId] = entry;
      }
    }
    await saveStore(store);
  });
}

/**
 * Fetch a previously persisted consensus run by id.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getConsensusRun(id) {
  if (typeof id !== "string" || !id) return null;
  const store = await loadStore();
  return store.runs[id] || null;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listConsensusRuns({ limit = 50 } = {}) {
  const store = await loadStore();
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const ids = store.order.slice(-lim).reverse();
  return ids.map((id) => store.runs[id]).filter(Boolean);
}

// ---- Agent invocation ----

/**
 * Call a single agent and normalize the response shape. The agentConfig may
 * supply its own `invoke(prompt)` function (used by tests); otherwise the
 * provided `backendFetch` + `buildProxyConfig` are used to call a backend.
 *
 * @param {object} agentConfig
 * @param {string} prompt
 * @param {object} ctx
 * @param {number} timeoutMs
 * @returns {Promise<{ agentId: string, model: string, text: string, confidence: number, latencyMs: number, error?: string }>}
 */
async function invokeAgent(agentConfig, prompt, ctx, timeoutMs) {
  const started = Date.now();
  const agentId = agentConfig.agentId || agentConfig.id || agentConfig.model || `agent_${randomUUID().slice(0, 8)}`;
  const model = agentConfig.model || "default";

  // Allow direct injection of an `invoke` for tests.
  if (typeof agentConfig.invoke === "function") {
    try {
      const out = await Promise.race([
        Promise.resolve(agentConfig.invoke(prompt)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), Math.max(1, timeoutMs))),
      ]);
      const text = typeof out === "string" ? out : out?.text || "";
      const confidence =
        typeof out?.confidence === "number" && Number.isFinite(out.confidence)
          ? Math.max(0, Math.min(1, out.confidence))
          : 0.7;
      return { agentId, model, text, confidence, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        agentId,
        model,
        text: "",
        confidence: 0,
        latencyMs: Date.now() - started,
        error: String(err?.message || err),
      };
    }
  }

  if (typeof ctx?.backendFetch !== "function" || typeof ctx?.buildProxyConfig !== "function") {
    return {
      agentId,
      model,
      text: `[dry-run] agent ${agentId} would answer: ${String(prompt).slice(0, 120)}`,
      confidence: 0.5,
      latencyMs: Date.now() - started,
    };
  }

  const config = ctx.buildProxyConfig(model);
  const url = `${config.baseUrl}${config.path}`;
  const messages = [];
  if (typeof agentConfig.systemPrompt === "string" && agentConfig.systemPrompt.trim()) {
    messages.push({ role: "system", content: agentConfig.systemPrompt });
  }
  messages.push({ role: "user", content: String(prompt) });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (_) {}
  }, Math.max(1, timeoutMs));
  try {
    const resp = await ctx.backendFetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: typeof agentConfig.temperature === "number" ? agentConfig.temperature : 0.2,
      }),
      signal: controller.signal,
    });
    if (!resp || !resp.ok) {
      return {
        agentId,
        model,
        text: "",
        confidence: 0,
        latencyMs: Date.now() - started,
        error: `backend ${resp ? resp.status : "no_response"}`,
      };
    }
    const data = await resp.json().catch(() => ({}));
    const text = data?.choices?.[0]?.message?.content || "";
    return { agentId, model, text: typeof text === "string" ? text : "", confidence: 0.7, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      agentId,
      model,
      text: "",
      confidence: 0,
      latencyMs: Date.now() - started,
      error: String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Strategies ----

/**
 * Group similar responses and return the largest cluster as the winner.
 *
 * @param {Array<{text: string}>} responses
 * @param {{ threshold?: number }} [options]
 * @returns {Promise<{ consensus: string, agreement: number, winningMembers: number[], clusters: object[] }>}
 */
export async function majorityVote(responses, options = {}) {
  const safe = Array.isArray(responses) ? responses.filter((r) => r && typeof r.text === "string") : [];
  if (safe.length === 0) {
    return { consensus: "", agreement: 0, winningMembers: [], clusters: [] };
  }
  const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : DEFAULT_SIMILARITY_THRESHOLD;
  const clusters = await groupSimilarResponses(safe, threshold);
  if (clusters.length === 0) {
    return { consensus: safe[0].text, agreement: 1 / safe.length, winningMembers: [0], clusters: [] };
  }
  const winner = clusters[0];
  const agreement = winner.count / safe.length;
  return {
    consensus: winner.representative,
    agreement,
    winningMembers: winner.members.slice(),
    clusters,
  };
}

/**
 * Weighted vote: similar to majority vote but each member contributes its
 * weight (from the matching `weights` array) instead of 1. Falls back to a
 * weight of 1 for any agent that has no entry in the weights array.
 *
 * @param {Array<{text: string, agentId?: string}>} responses
 * @param {Array<number>|Record<string,number>} weights
 * @param {{ threshold?: number }} [options]
 * @returns {Promise<{ consensus: string, agreement: number, winningMembers: number[], clusters: object[], totalWeight: number, winningWeight: number }>}
 */
export async function weightedVote(responses, weights, options = {}) {
  const safe = Array.isArray(responses) ? responses.filter((r) => r && typeof r.text === "string") : [];
  if (safe.length === 0) {
    return { consensus: "", agreement: 0, winningMembers: [], clusters: [], totalWeight: 0, winningWeight: 0 };
  }
  const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : DEFAULT_SIMILARITY_THRESHOLD;
  const clusters = await groupSimilarResponses(safe, threshold);

  const weightFor = (idx) => {
    if (Array.isArray(weights)) {
      const w = Number(weights[idx]);
      return Number.isFinite(w) && w > 0 ? w : 1;
    }
    if (weights && typeof weights === "object") {
      const id = safe[idx]?.agentId || `agent_${idx}`;
      const w = Number(weights[id]);
      return Number.isFinite(w) && w > 0 ? w : 1;
    }
    return 1;
  };

  const totalWeight = safe.reduce((sum, _, i) => sum + weightFor(i), 0) || 1;

  let bestIdx = -1;
  let bestWeight = -1;
  const clusterWeights = clusters.map((c, idx) => {
    const w = c.members.reduce((sum, m) => sum + weightFor(m), 0);
    if (w > bestWeight) {
      bestWeight = w;
      bestIdx = idx;
    }
    return w;
  });

  if (bestIdx === -1) {
    return {
      consensus: safe[0].text,
      agreement: weightFor(0) / totalWeight,
      winningMembers: [0],
      clusters: [],
      totalWeight,
      winningWeight: weightFor(0),
    };
  }

  const winner = clusters[bestIdx];
  return {
    consensus: winner.representative,
    agreement: bestWeight / totalWeight,
    winningMembers: winner.members.slice(),
    clusters: clusters.map((c, i) => ({ ...c, weight: clusterWeights[i] })),
    totalWeight,
    winningWeight: bestWeight,
  };
}

/**
 * Use a separate LLM to judge which response is best. Returns the index of
 * the selected response within the original `responses` array along with
 * judge reasoning. The judge is invoked via `judgeFn(prompt)` (test-friendly)
 * or via the supplied backendFetch / buildProxyConfig pair.
 *
 * @param {Array<{text: string}>} responses
 * @param {string} judgeModel
 * @param {{ judgeFn?: Function, backendFetch?: Function, buildProxyConfig?: Function, prompt?: string, timeoutMs?: number }} [ctx]
 * @returns {Promise<{ selectedIndex: number, reasoning: string, error?: string }>}
 */
export async function llmJudge(responses, judgeModel, ctx = {}) {
  const safe = Array.isArray(responses) ? responses : [];
  if (safe.length === 0) return { selectedIndex: -1, reasoning: "no responses" };
  if (safe.length === 1) return { selectedIndex: 0, reasoning: "only one response" };

  const numbered = safe
    .map((r, i) => `(${i}) ${typeof r?.text === "string" ? r.text : ""}`)
    .join("\n---\n");
  const prompt =
    `You are an impartial judge selecting the best answer to a question.\n` +
    `Question: ${ctx.prompt || "(not provided)"}\n\n` +
    `Candidate answers:\n${numbered}\n\n` +
    `Reply with strict JSON: {"selectedIndex": <integer>, "reasoning": "<short explanation>"}.`;

  let raw = "";
  try {
    if (typeof ctx.judgeFn === "function") {
      raw = await ctx.judgeFn(prompt);
    } else if (typeof ctx.backendFetch === "function" && typeof ctx.buildProxyConfig === "function") {
      const config = ctx.buildProxyConfig(judgeModel || "default");
      const url = `${config.baseUrl}${config.path}`;
      const controller = new AbortController();
      const t = setTimeout(() => {
        try {
          controller.abort();
        } catch (_) {}
      }, Math.max(1, ctx.timeoutMs || DEFAULT_TIMEOUT_MS));
      try {
        const resp = await ctx.backendFetch(url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify({
            model: judgeModel || "default",
            messages: [
              { role: "system", content: "You are a strict JSON-only judge." },
              { role: "user", content: prompt },
            ],
            stream: false,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        if (!resp || !resp.ok) {
          return { selectedIndex: 0, reasoning: "", error: `judge backend ${resp ? resp.status : "no_response"}` };
        }
        const data = await resp.json().catch(() => ({}));
        raw = data?.choices?.[0]?.message?.content || "";
      } finally {
        clearTimeout(t);
      }
    } else {
      // No judge available — fall back to the longest response.
      const idx = safe.reduce((bestI, r, i, arr) => (typeof r?.text === "string" && r.text.length > (arr[bestI]?.text?.length || 0) ? i : bestI), 0);
      return { selectedIndex: idx, reasoning: "no judge available; selected longest response" };
    }
  } catch (err) {
    return { selectedIndex: 0, reasoning: "", error: String(err?.message || err) };
  }

  // Parse the judge's JSON response defensively.
  let parsed;
  try {
    let s = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    parsed = JSON.parse(s);
  } catch {
    const start = String(raw || "").indexOf("{");
    const end = String(raw || "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(String(raw).slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  let selectedIndex = Number(parsed?.selectedIndex);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= safe.length) {
    selectedIndex = 0;
  }
  const reasoning = typeof parsed?.reasoning === "string" ? parsed.reasoning : "";
  return { selectedIndex, reasoning };
}

/**
 * Ranked-choice consensus via Borda count. Each response is ranked against
 * the others by similarity to itself (a self-ranking proxy when no per-agent
 * preference list is provided). Each candidate receives `(N - rank)` points
 * from each voter; the highest-scoring candidate wins.
 *
 * The function also accepts an optional `rankings` matrix where
 * `rankings[i][k]` is the index of the k-th preferred candidate from voter i.
 *
 * @param {Array<{text: string}>} responses
 * @param {{ rankings?: number[][] }} [options]
 * @returns {Promise<{ consensus: string, winningIndex: number, scores: number[], agreement: number }>}
 */
export async function rankedChoice(responses, options = {}) {
  const safe = Array.isArray(responses) ? responses.filter((r) => r && typeof r.text === "string") : [];
  const n = safe.length;
  if (n === 0) return { consensus: "", winningIndex: -1, scores: [], agreement: 0 };
  if (n === 1) return { consensus: safe[0].text, winningIndex: 0, scores: [1], agreement: 1 };

  const scores = new Array(n).fill(0);

  if (Array.isArray(options.rankings) && options.rankings.length === n) {
    for (const ranking of options.rankings) {
      if (!Array.isArray(ranking)) continue;
      for (let pos = 0; pos < ranking.length; pos++) {
        const candidate = Number(ranking[pos]);
        if (Number.isInteger(candidate) && candidate >= 0 && candidate < n) {
          scores[candidate] += n - pos;
        }
      }
    }
  } else {
    // Derive each voter's ranking by similarity of every candidate to that voter.
    for (let voter = 0; voter < n; voter++) {
      const sims = safe.map((r, j) => ({
        idx: j,
        sim: j === voter ? 1 : computeTextSimilarity(safe[voter].text, r.text),
      }));
      sims.sort((a, b) => b.sim - a.sim);
      for (let pos = 0; pos < sims.length; pos++) {
        scores[sims[pos].idx] += n - pos;
      }
    }
  }

  let winningIndex = 0;
  for (let i = 1; i < n; i++) {
    if (scores[i] > scores[winningIndex]) winningIndex = i;
  }
  const totalScore = scores.reduce((s, v) => s + v, 0) || 1;
  const agreement = scores[winningIndex] / totalScore;
  return { consensus: safe[winningIndex].text, winningIndex, scores, agreement };
}

/**
 * Compute an aggregate confidence score from agreement and per-agent
 * confidences. Returns a value in [0, 1].
 *
 * @param {Array<{ confidence?: number }>} responses
 * @param {number} agreement - fraction of agents in the winning cluster
 * @returns {number}
 */
export function calculateConsensusConfidence(responses, agreement) {
  const safe = Array.isArray(responses) ? responses : [];
  if (safe.length === 0) return 0;
  const a = Number.isFinite(agreement) ? Math.max(0, Math.min(1, Number(agreement))) : 0;
  let sum = 0;
  let count = 0;
  for (const r of safe) {
    const c = Number(r?.confidence);
    if (Number.isFinite(c)) {
      sum += Math.max(0, Math.min(1, c));
      count++;
    }
  }
  const avgConf = count > 0 ? sum / count : 0.5;
  const score = a * avgConf;
  return Math.max(0, Math.min(1, score));
}

/**
 * Identify agents that have historically dissented from the majority above
 * a configurable threshold. The optional `groundTruth` map (agentId -> bool)
 * lets callers force-mark agents as Byzantine for adversarial testing.
 *
 * @param {Array<{ agentId: string }>} [responses] optional latest run responses for context
 * @param {Record<string, boolean>} [groundTruth]
 * @returns {Promise<Array<{ agentId: string, total: number, agreed: number, dissents: number, dissentRate: number, byzantine: boolean }>>}
 */
export async function detectByzantineAgents(responses, groundTruth) {
  const store = await loadStore();
  const dissentThreshold = Math.max(0, Math.min(1, Number(process.env.AGENT_BYZANTINE_THRESHOLD) || 0.5));
  const minSamples = Math.max(1, Number(process.env.AGENT_BYZANTINE_MIN_SAMPLES) || 3);
  const out = [];
  const seen = new Set();

  const entries = Object.values(store.byzantine || {});
  for (const e of entries) {
    if (!e || typeof e.agentId !== "string") continue;
    seen.add(e.agentId);
    const dissentRate = e.total > 0 ? e.dissents / e.total : 0;
    const enoughSamples = e.total >= minSamples;
    let byzantine = enoughSamples && dissentRate >= dissentThreshold;
    if (groundTruth && Object.prototype.hasOwnProperty.call(groundTruth, e.agentId)) {
      byzantine = Boolean(groundTruth[e.agentId]);
    }
    out.push({
      agentId: e.agentId,
      total: e.total,
      agreed: e.agreed,
      dissents: e.dissents,
      dissentRate,
      byzantine,
    });
  }

  if (Array.isArray(responses)) {
    for (const r of responses) {
      const id = r?.agentId;
      if (typeof id === "string" && !seen.has(id)) {
        out.push({ agentId: id, total: 0, agreed: 0, dissents: 0, dissentRate: 0, byzantine: false });
      }
    }
  }
  out.sort((a, b) => b.dissentRate - a.dissentRate);
  return out;
}

/**
 * Lookup raw Byzantine stats for a single agent (used by the API endpoint).
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
export async function getByzantineStats(agentId) {
  if (typeof agentId !== "string" || !agentId) return null;
  const store = await loadStore();
  const e = store.byzantine?.[agentId];
  if (!e) return null;
  const dissentThreshold = Math.max(0, Math.min(1, Number(process.env.AGENT_BYZANTINE_THRESHOLD) || 0.5));
  const minSamples = Math.max(1, Number(process.env.AGENT_BYZANTINE_MIN_SAMPLES) || 3);
  const dissentRate = e.total > 0 ? e.dissents / e.total : 0;
  return {
    agentId,
    total: e.total,
    agreed: e.agreed,
    dissents: e.dissents,
    dissentRate,
    byzantine: e.total >= minSamples && dissentRate >= dissentThreshold,
    lastRunId: e.lastRunId || null,
  };
}

// ---- Public driver ----

/**
 * Run a multi-agent consensus query.
 *
 * @param {string} prompt
 * @param {{
 *   agents?: object[],
 *   strategy?: 'majority_vote' | 'weighted' | 'llm_judge' | 'ranked_choice',
 *   quorum?: number,
 *   timeout?: number,
 *   weights?: number[]|Record<string, number>,
 *   judgeModel?: string,
 *   threshold?: number,
 *   backendFetch?: Function,
 *   buildProxyConfig?: Function,
 *   judgeFn?: Function,
 *   persist?: boolean,
 * }} options
 * @returns {Promise<{ id: string, consensus: string, confidence: number, responses: object[], strategy: string, agreement: number, quorumMet: boolean, error?: string }>}
 */
export async function executeConsensus(prompt, options = {}) {
  const id = randomUUID();
  const startedAt = Date.now();
  const strategy = STRATEGIES.has(options.strategy) ? options.strategy : "majority_vote";
  const quorum = Number.isFinite(options.quorum) ? Math.max(1, Number(options.quorum)) : DEFAULT_QUORUM;
  const timeoutMs = Number.isFinite(options.timeout) ? Math.max(1, Number(options.timeout)) : DEFAULT_TIMEOUT_MS;
  const agents = Array.isArray(options.agents) ? options.agents.filter((a) => a && typeof a === "object") : [];

  if (agents.length === 0) {
    return {
      id,
      consensus: "",
      confidence: 0,
      responses: [],
      strategy,
      agreement: 0,
      quorumMet: false,
      error: "no agents supplied",
    };
  }

  // Run all agents in parallel; each invocation is wrapped with its own timeout.
  const responses = await Promise.all(
    agents.map((agent) =>
      invokeAgent(
        agent,
        prompt,
        { backendFetch: options.backendFetch, buildProxyConfig: options.buildProxyConfig },
        timeoutMs,
      ),
    ),
  );

  const successful = responses.filter((r) => r && !r.error && r.text && r.text.trim());
  if (successful.length < quorum) {
    const failureRun = {
      id,
      prompt,
      strategy,
      consensus: "",
      confidence: 0,
      agreement: 0,
      quorumMet: false,
      responses,
      winningMembers: [],
      startedAt,
      durationMs: Date.now() - startedAt,
      error: `quorum not met: ${successful.length}/${quorum}`,
    };
    if (options.persist !== false) {
      try {
        await persistRun(failureRun);
      } catch (_) {}
    }
    return failureRun;
  }

  let consensus = "";
  let agreement = 0;
  let winningMembers = [];
  let extra = {};

  if (strategy === "majority_vote") {
    const r = await majorityVote(responses, { threshold: options.threshold });
    consensus = r.consensus;
    agreement = r.agreement;
    winningMembers = r.winningMembers;
    extra = { clusters: r.clusters };
  } else if (strategy === "weighted") {
    const r = await weightedVote(responses, options.weights || [], { threshold: options.threshold });
    consensus = r.consensus;
    agreement = r.agreement;
    winningMembers = r.winningMembers;
    extra = { clusters: r.clusters, totalWeight: r.totalWeight, winningWeight: r.winningWeight };
  } else if (strategy === "llm_judge") {
    const r = await llmJudge(responses, options.judgeModel || "default", {
      backendFetch: options.backendFetch,
      buildProxyConfig: options.buildProxyConfig,
      judgeFn: options.judgeFn,
      prompt,
      timeoutMs,
    });
    if (r.selectedIndex >= 0 && responses[r.selectedIndex]) {
      consensus = responses[r.selectedIndex].text || "";
      winningMembers = [r.selectedIndex];
      // Approximate agreement: how similar is the picked response to the others?
      const sims = responses.map((other, i) =>
        i === r.selectedIndex ? 1 : computeTextSimilarity(consensus, other?.text || ""),
      );
      const avg = sims.reduce((s, v) => s + v, 0) / Math.max(1, sims.length);
      agreement = Math.max(0, Math.min(1, avg));
    }
    extra = { judge: { selectedIndex: r.selectedIndex, reasoning: r.reasoning, error: r.error } };
  } else if (strategy === "ranked_choice") {
    const r = await rankedChoice(responses, { rankings: options.rankings });
    consensus = r.consensus;
    agreement = r.agreement;
    winningMembers = r.winningIndex >= 0 ? [r.winningIndex] : [];
    extra = { scores: r.scores, winningIndex: r.winningIndex };
  }

  const confidence = calculateConsensusConfidence(responses, agreement);
  const run = {
    id,
    prompt,
    strategy,
    consensus,
    confidence,
    agreement,
    quorumMet: true,
    responses,
    winningMembers,
    startedAt,
    durationMs: Date.now() - startedAt,
    ...extra,
  };

  if (options.persist !== false) {
    try {
      await persistRun(run);
    } catch (_) {}
  }
  return run;
}

export const _internals = {
  storePath,
  normalizeStore,
  STRATEGIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_QUORUM,
  DEFAULT_SIMILARITY_THRESHOLD,
};
