/**
 * Phase 32.2: Prompt evolution.
 *
 * Track prompt versions, auto-generate improvement candidates from user feedback,
 * A/B test them against the active prompt, and promote winners automatically.
 *
 * Storage: data/prompt-versions/{workspaceId}.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { listFeedback } from "./feedback.js";
import { suggestPromptImprovements } from "./prompt-optimizer.js";

const DEFAULT_PROMPT_TEXT = "You are a helpful assistant.";

function versionsPath(workspaceId) {
  const ws = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : "default";
  return join(getDataDir(), "prompt-versions", `${ws}.json`);
}

async function loadStore(workspaceId) {
  const path = versionsPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, activeId: null, versions: [] });
  return {
    _version: data._version || 1,
    activeId: data.activeId || null,
    versions: Array.isArray(data.versions) ? data.versions : [],
  };
}

async function saveStore(workspaceId, store) {
  const path = versionsPath(workspaceId);
  await writeJsonPath(path, {
    _version: 1,
    activeId: store.activeId || null,
    versions: store.versions || [],
  });
}

function makeEmptyStats() {
  return { uses: 0, ratingSum: 0, avgRating: 0, samples: 0 };
}

/**
 * Save a new prompt version.
 * @param {string} workspaceId
 * @param {string} promptText
 * @param {object} [metadata] - arbitrary metadata (rationale, parentId, generatedBy, etc.)
 * @returns {Promise<object>} the saved version record
 */
export async function savePromptVersion(workspaceId, promptText, metadata = {}) {
  if (typeof promptText !== "string" || !promptText.trim()) {
    throw new Error("promptText is required");
  }
  const ws = workspaceId || "default";
  const path = versionsPath(ws);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    workspaceId: ws,
    text: promptText.trim(),
    createdAt,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    stats: makeEmptyStats(),
  };

  await withPathLock(path, async () => {
    const store = await loadStore(ws);
    store.versions.push(record);
    // If nothing is active yet, make this the active version.
    if (!store.activeId) {
      store.activeId = id;
    }
    await saveStore(ws, store);
  });

  return record;
}

/**
 * List all saved prompt versions for a workspace, newest last.
 * @param {string} workspaceId
 * @returns {Promise<Array<object>>}
 */
export async function listPromptVersions(workspaceId) {
  const store = await loadStore(workspaceId || "default");
  return store.versions;
}

/**
 * Get the currently active prompt for a workspace.
 * Returns a synthesized default if none has been created yet.
 * @param {string} workspaceId
 * @returns {Promise<object>}
 */
export async function getActivePrompt(workspaceId) {
  const ws = workspaceId || "default";
  const store = await loadStore(ws);
  if (store.activeId) {
    const found = store.versions.find((v) => v.id === store.activeId);
    if (found) return found;
  }
  // Fallback: if any version exists, return the most recent; otherwise return a default.
  if (store.versions.length > 0) {
    return store.versions[store.versions.length - 1];
  }
  return {
    id: null,
    workspaceId: ws,
    text: DEFAULT_PROMPT_TEXT,
    createdAt: null,
    metadata: { default: true },
    stats: makeEmptyStats(),
  };
}

/**
 * Set the active prompt version for a workspace.
 * @param {string} workspaceId
 * @param {string} versionId
 * @returns {Promise<object>} { ok, activeId }
 */
export async function setActivePrompt(workspaceId, versionId) {
  if (!versionId || typeof versionId !== "string") {
    throw new Error("versionId is required");
  }
  const ws = workspaceId || "default";
  const path = versionsPath(ws);
  let result;
  await withPathLock(path, async () => {
    const store = await loadStore(ws);
    const exists = store.versions.some((v) => v.id === versionId);
    if (!exists) {
      result = { ok: false, error: "version_not_found" };
      return;
    }
    store.activeId = versionId;
    await saveStore(ws, store);
    result = { ok: true, activeId: versionId };
  });
  return result;
}

/**
 * Record a use of a prompt version, optionally with a rating.
 * Updates running stats: uses, samples, avgRating.
 * @param {string} workspaceId
 * @param {string} versionId
 * @param {number|null} [rating] - integer 1..5 or null if no rating yet
 * @returns {Promise<object>} updated stats snapshot
 */
export async function recordPromptUsage(workspaceId, versionId, rating) {
  if (!versionId || typeof versionId !== "string") {
    throw new Error("versionId is required");
  }
  const ws = workspaceId || "default";
  const path = versionsPath(ws);
  let snapshot = null;

  await withPathLock(path, async () => {
    const store = await loadStore(ws);
    const version = store.versions.find((v) => v.id === versionId);
    if (!version) return;
    if (!version.stats) version.stats = makeEmptyStats();
    version.stats.uses = (version.stats.uses || 0) + 1;
    if (rating != null) {
      const r = Number(rating);
      if (Number.isInteger(r) && r >= 1 && r <= 5) {
        version.stats.ratingSum = (version.stats.ratingSum || 0) + r;
        version.stats.samples = (version.stats.samples || 0) + 1;
        version.stats.avgRating = Math.round(
          (version.stats.ratingSum / version.stats.samples) * 100
        ) / 100;
      }
    }
    snapshot = { ...version.stats };
    await saveStore(ws, store);
  });

  return snapshot || makeEmptyStats();
}

/**
 * Generate candidate prompt versions based on feedback signal.
 * Candidates are saved as versions with metadata.generatedBy = "auto"
 * and a human-readable rationale.
 *
 * Strategies:
 *  - Inject clarity/accuracy/completeness instructions for common complaint patterns
 *  - Adjust length preference based on rating vs response-length correlation
 *  - Add model-specific instructions if feedback shows a clear winning model
 *
 * @param {string} workspaceId
 * @param {number} [count=3]
 * @returns {Promise<Array<{ id: string, text: string, rationale: string }>>}
 */
export async function generateCandidateVersions(workspaceId, count = 3) {
  const ws = workspaceId || "default";
  const maxCount = Math.max(1, Math.min(10, Number(count) || 3));

  const active = await getActivePrompt(ws);
  const baseText = active.text || DEFAULT_PROMPT_TEXT;

  const items = await listFeedback(ws);
  const { suggestions } = await suggestPromptImprovements(ws);

  /** @type {Array<{ text: string, rationale: string }>} */
  const drafts = [];
  const used = new Set();

  const pushDraft = (text, rationale) => {
    const trimmed = text.trim();
    if (!trimmed || used.has(trimmed)) return;
    used.add(trimmed);
    drafts.push({ text: trimmed, rationale });
  };

  // Strategy A: incorporate each concrete suggestion from the optimizer.
  for (const s of suggestions || []) {
    if (!s || !s.suggested || s.area === "data" || s.area === "general") continue;
    const instruction = String(s.suggested).replace(/^Add instruction:\s*/i, "").trim();
    if (!instruction) continue;
    const text = `${baseText}\n\n${instruction}`;
    const rationale = `Suggested by prompt optimizer (${s.area}): ${s.reasoning || "derived from feedback"}`;
    pushDraft(text, rationale);
    if (drafts.length >= maxCount) break;
  }

  // Strategy B: length-preference heuristic directly from feedback.
  if (drafts.length < maxCount && items.length >= 3) {
    const lowResp = items.filter((i) => i.rating <= 2 && i.response);
    const highResp = items.filter((i) => i.rating >= 4 && i.response);
    if (lowResp.length >= 2 && highResp.length >= 2) {
      const avgLow = lowResp.reduce((s, i) => s + i.response.length, 0) / lowResp.length;
      const avgHigh = highResp.reduce((s, i) => s + i.response.length, 0) / highResp.length;
      if (avgHigh > avgLow * 1.25) {
        pushDraft(
          `${baseText}\n\nProvide thorough, well-structured answers with concrete examples when relevant.`,
          `High-rated responses average ${Math.round(avgHigh)} chars vs ${Math.round(avgLow)} for low-rated; users prefer detail.`
        );
      } else if (avgLow > avgHigh * 1.25) {
        pushDraft(
          `${baseText}\n\nBe concise and direct. Avoid unnecessary elaboration and get to the answer quickly.`,
          `Low-rated responses average ${Math.round(avgLow)} chars vs ${Math.round(avgHigh)} for high-rated; users prefer brevity.`
        );
      }
    }
  }

  // Strategy C: model-specific preference if one model clearly outperforms.
  if (drafts.length < maxCount && items.length >= 3) {
    const byModel = {};
    for (const i of items) {
      const m = i.model || "unknown";
      if (!byModel[m]) byModel[m] = { sum: 0, n: 0 };
      byModel[m].sum += i.rating;
      byModel[m].n += 1;
    }
    const ranked = Object.entries(byModel)
      .filter(([, s]) => s.n >= 2)
      .map(([m, s]) => ({ model: m, avg: s.sum / s.n, n: s.n }))
      .sort((a, b) => b.avg - a.avg);
    if (ranked.length >= 2) {
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      if (best.avg - worst.avg >= 0.5) {
        pushDraft(
          `${baseText}\n\nMatch the tone, structure, and depth of answers that work well with the "${best.model}" model.`,
          `Model "${best.model}" (avg ${best.avg.toFixed(2)}) outperforms "${worst.model}" (avg ${worst.avg.toFixed(2)}).`
        );
      }
    }
  }

  // Strategy D: generic clarity fallback when we still need more candidates.
  const fallbacks = [
    {
      text: `${baseText}\n\nWhen answering, first briefly restate the user's goal, then give a direct answer, then optional details.`,
      rationale: "Generic clarity fallback: restate goal, direct answer, then details.",
    },
    {
      text: `${baseText}\n\nIf the question is ambiguous, ask one clarifying question before answering.`,
      rationale: "Generic relevance fallback: ask for clarification on ambiguous requests.",
    },
    {
      text: `${baseText}\n\nPrefer concrete examples over abstract explanations.`,
      rationale: "Generic completeness fallback: favor concrete examples.",
    },
  ];
  for (const fb of fallbacks) {
    if (drafts.length >= maxCount) break;
    pushDraft(fb.text, fb.rationale);
  }

  // Persist drafts as new versions.
  const saved = [];
  for (const d of drafts.slice(0, maxCount)) {
    const record = await savePromptVersion(ws, d.text, {
      generatedBy: "auto",
      rationale: d.rationale,
      parentId: active.id || null,
    });
    saved.push({ id: record.id, text: record.text, rationale: d.rationale });
  }
  return saved;
}

/**
 * Run an A/B test across two or more version ids.
 * Uses each version's rolling stats (avgRating + samples).
 *
 * @param {string} workspaceId
 * @param {string[]} versionIds
 * @param {number} [minSamples=5] - a version must have at least this many samples to be eligible
 * @returns {Promise<{ winner: string|null, scores: Record<string, number>, samples: Record<string, number>, confidence: number }>}
 */
export async function runPromptABTest(workspaceId, versionIds, minSamples = 5) {
  if (!Array.isArray(versionIds) || versionIds.length < 2) {
    throw new Error("at least two versionIds are required");
  }
  const min = Math.max(1, Number(minSamples) || 5);
  const store = await loadStore(workspaceId || "default");
  const scores = {};
  const samples = {};
  const eligible = [];
  for (const id of versionIds) {
    const v = store.versions.find((x) => x.id === id);
    if (!v) {
      scores[id] = 0;
      samples[id] = 0;
      continue;
    }
    const s = v.stats || makeEmptyStats();
    scores[id] = s.avgRating || 0;
    samples[id] = s.samples || 0;
    if ((s.samples || 0) >= min) eligible.push({ id, avg: s.avgRating || 0, n: s.samples || 0 });
  }

  if (eligible.length < 2) {
    return { winner: null, scores, samples, confidence: 0 };
  }
  eligible.sort((a, b) => b.avg - a.avg);
  const best = eligible[0];
  const next = eligible[1];
  const diff = best.avg - next.avg;
  // Confidence grows with both sample size and gap.
  const confidence = Math.max(
    0,
    Math.min(1, 0.5 * Math.min(1, Math.min(best.n, next.n) / 20) + 0.5 * Math.min(1, diff / 1.0))
  );
  const winner = diff >= 0.2 ? best.id : null;
  return { winner, scores, samples, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Auto-promote the best candidate version over the active prompt when it beats it
 * by a rating threshold with at least minSamples samples.
 *
 * @param {string} workspaceId
 * @param {{ threshold?: number, minSamples?: number }} [options]
 * @returns {Promise<object>}
 */
export async function autoPromotePrompts(workspaceId, options = {}) {
  const ws = workspaceId || "default";
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.3;
  const minSamples = Number.isFinite(options.minSamples) ? options.minSamples : 20;

  const store = await loadStore(ws);
  if (!store.versions.length) {
    return { promoted: false, reason: "no_versions" };
  }
  if (!store.activeId) {
    return { promoted: false, reason: "no_active" };
  }
  const active = store.versions.find((v) => v.id === store.activeId);
  if (!active) {
    return { promoted: false, reason: "active_missing" };
  }
  const activeStats = active.stats || makeEmptyStats();

  // Find the best candidate (non-active) meeting minSamples.
  let best = null;
  for (const v of store.versions) {
    if (v.id === active.id) continue;
    const s = v.stats || makeEmptyStats();
    if ((s.samples || 0) < minSamples) continue;
    if (!best || (s.avgRating || 0) > (best.stats.avgRating || 0)) {
      best = { version: v, stats: s };
    }
  }
  if (!best) {
    return { promoted: false, reason: "no_candidate_with_samples", minSamples };
  }
  if ((activeStats.samples || 0) < minSamples) {
    return { promoted: false, reason: "active_not_enough_samples", minSamples };
  }
  const improvement = (best.stats.avgRating || 0) - (activeStats.avgRating || 0);
  if (improvement < threshold) {
    return {
      promoted: false,
      reason: "below_threshold",
      threshold,
      improvement: Math.round(improvement * 100) / 100,
      activeAvg: activeStats.avgRating || 0,
      candidateAvg: best.stats.avgRating || 0,
    };
  }

  // Promote
  const path = versionsPath(ws);
  await withPathLock(path, async () => {
    const fresh = await loadStore(ws);
    fresh.activeId = best.version.id;
    await saveStore(ws, fresh);
  });

  return {
    promoted: true,
    fromVersion: active.id,
    toVersion: best.version.id,
    improvement: Math.round(improvement * 100) / 100,
    activeAvg: activeStats.avgRating || 0,
    candidateAvg: best.stats.avgRating || 0,
    threshold,
    minSamples,
  };
}

// ─── hourly scheduler ─────────────────────────────────────────────────────────

let evolutionTimer = null;

/**
 * Run auto-promotion across all known prompt-version workspaces.
 * Discovers workspaces by scanning data/prompt-versions/ when running on the
 * file backend; otherwise callers should pass an explicit list.
 *
 * @param {Array<string>} [workspaceIds]
 * @returns {Promise<Array<object>>}
 */
export async function autoPromoteAllWorkspaces(workspaceIds) {
  const list = Array.isArray(workspaceIds) && workspaceIds.length
    ? workspaceIds
    : await discoverWorkspaceIdsFromDisk();
  const results = [];
  for (const ws of list) {
    try {
      const r = await autoPromotePrompts(ws);
      results.push({ workspaceId: ws, ...r });
    } catch (e) {
      results.push({ workspaceId: ws, promoted: false, reason: "error", error: e.message });
    }
  }
  return results;
}

async function discoverWorkspaceIdsFromDisk() {
  try {
    const { readdirSync, existsSync } = await import("fs");
    const dir = join(getDataDir(), "prompt-versions");
    if (!existsSync(dir)) return ["default"];
    const files = readdirSync(dir);
    const ids = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    if (!ids.length) return ["default"];
    return ids;
  } catch {
    return ["default"];
  }
}

/**
 * Start the hourly prompt-evolution auto-promotion scheduler.
 * No-op unless ENABLE_PROMPT_EVOLUTION=1.
 * @param {{ intervalMs?: number }} [options]
 */
export function startPromptEvolutionScheduler(options = {}) {
  if (process.env.ENABLE_PROMPT_EVOLUTION !== "1") return null;
  if (evolutionTimer) return evolutionTimer;
  const intervalMs = Number(options.intervalMs) || 60 * 60 * 1000;
  evolutionTimer = setInterval(() => {
    autoPromoteAllWorkspaces().catch((e) => {
      console.warn("[prompt-evolution] auto-promote tick failed:", e.message);
    });
  }, intervalMs);
  if (typeof evolutionTimer.unref === "function") evolutionTimer.unref();
  return evolutionTimer;
}

/** Stop the hourly prompt-evolution scheduler. */
export function stopPromptEvolutionScheduler() {
  if (evolutionTimer) {
    clearInterval(evolutionTimer);
    evolutionTimer = null;
  }
}
