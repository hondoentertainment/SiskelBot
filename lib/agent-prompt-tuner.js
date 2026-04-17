/**
 * Offline auto prompt-tuner: synthesizes a durable per-workspace system-prompt
 * PATCH from the accumulated stats in:
 *   - agent-failure-store  (terminal failures by (tool, category))
 *   - agent-genealogy      (per-tool success rates)
 *   - swarm-conflict-store (specialist disagreements)
 *   - tool-cooldown-store  (tools currently cooling down)
 *
 * The synthesizer is deterministic given the store state (no LLM calls); the
 * output patch is a short text block persisted to
 *   data/agent-prompts/<ws>/patches.json
 *
 * Admins review patches (pending → applied / rejected). Applied patches are
 * injected alongside buildReliabilityHint() by the agent-loop integrator.
 *
 * @module agent-prompt-tuner
 */

import { join } from "path";
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { loadFailureStats, rankChronicFailures } from "./agent-failure-store.js";
import { loadToolOutcomes, rankByReliability, getToolReliability } from "./agent-genealogy.js";
import { listConflicts } from "./swarm-conflict-store.js";
import { listActiveCooldowns } from "./tool-cooldown-store.js";

const MAX_PATCHES_PER_WORKSPACE = 50;
const MAX_PATCH_CHARS = 1500;
const MIN_TOOL_SAMPLES = 10;
const MIN_FAILURES = 5;
const MIN_CONFLICTS = 3;

const CHRONIC_SCORE_THRESHOLD = 8;
const AVOID_RATE_CEILING = 0.4;
const PREFER_RATE_FLOOR = 0.8;
const MIN_SAMPLES_FOR_FLAG = 5;
const CONFLICT_SIMILARITY_MEDIAN_CEILING = 0.3;

/**
 * @typedef {object} PromptPatchBasis
 * @property {number} failureCount
 * @property {number} genealogyCount
 * @property {number} conflictCount
 * @property {string[]} toolsFlagged
 * @property {string[]} toolsPreferred
 */

/**
 * @typedef {object} PromptPatch
 * @property {string} workspace
 * @property {number} generatedAt
 * @property {string} version
 * @property {string} content
 * @property {PromptPatchBasis} basis
 * @property {"pending" | "applied" | "rejected"} status
 * @property {string} [appliedBy]
 * @property {number} [appliedAt]
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  return join(getDataDir(), "agent-prompts", sanitizeSegment(workspace), "patches.json");
}

function emptyStore() {
  return { version: 1, updatedAt: 0, patches: [] };
}

async function loadStore(workspace) {
  const raw = await readJsonPath(storePath(workspace), emptyStore());
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.patches)) return emptyStore();
  return raw;
}

function todayYmd(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Compute the same chronic-failure score used in agent-failure-store.
 * Reimplemented here to avoid depending on a non-exported helper.
 */
function chronicScoreFor(toolStats) {
  const weights = {
    permission: 5,
    not_allowed: 5,
    unknown_tool: 5,
    validation: 3,
    backend_error: 2,
    timeout: 1,
    rate_limit: 1,
    network: 1,
    not_found: 1,
    semantic: 2,
    cancelled: 0,
    unknown: 1,
  };
  let score = 0;
  for (const [cat, count] of Object.entries(toolStats?.byCategory || {})) {
    score += (weights[cat] ?? 1) * count;
  }
  return score;
}

function median(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function topFailureCategories(byCategory, limit = 3) {
  return Object.entries(byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cat, count]) => ({ cat, count }));
}

/**
 * Pull most common noun-ish tokens out of a set of conflict summaries to
 * describe the disagreement topic.
 */
function extractConflictTopic(events) {
  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "these", "those",
    "what", "when", "where", "which", "how", "why", "who", "can", "you",
    "about", "into", "onto", "over", "out", "are", "was", "were", "been",
    "being", "not", "but", "all", "any", "just", "then", "than", "too",
    "has", "had", "does", "did", "have", "will", "would", "should", "could",
    "agent", "agents", "specialist", "specialists", "tool", "tools",
    "answer", "response", "output", "disagree", "disagreement", "conflict",
  ]);
  const counts = new Map();
  for (const ev of events) {
    const text = typeof ev?.summary === "string" ? ev.summary : "";
    const toks = text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
    for (const t of toks) {
      if (stop.has(t)) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3).map(([w]) => w);
}

/**
 * Synthesize a fresh prompt patch from the live stores. Deterministic given
 * store state. Returns null if there's not enough signal.
 *
 * @param {string} workspace
 * @returns {Promise<PromptPatch | null>}
 */
export async function synthesizePatch(workspace) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";

  const [failureStats, genealogy, conflicts, cooldowns] = await Promise.all([
    loadFailureStats(ws),
    loadToolOutcomes(ws),
    listConflicts(ws, { limit: 200 }),
    Promise.resolve(listActiveCooldowns(ws)),
  ]);

  const totalFailures = Object.values(failureStats.tools || {})
    .reduce((acc, t) => acc + (t.total || 0), 0);
  const totalGenealogySamples = Object.values(genealogy.tools || {})
    .reduce((acc, t) => acc + (t.successes || 0) + (t.failures || 0), 0);
  const conflictCount = conflicts.length;

  const signalOk =
    totalGenealogySamples >= MIN_TOOL_SAMPLES
    || totalFailures >= MIN_FAILURES
    || conflictCount >= MIN_CONFLICTS
    || cooldowns.length > 0;
  if (!signalOk) return null;

  const cooldownTools = new Set(cooldowns.map((c) => c.tool));

  // Flagged tools: chronic score threshold, or in cooldown, or low success rate.
  const flagged = new Map(); // tool -> reason
  const chronic = await rankChronicFailures(ws, 50);
  for (const entry of chronic) {
    if (entry.score >= CHRONIC_SCORE_THRESHOLD) {
      flagged.set(entry.tool, "chronic_failures");
    }
  }
  for (const tool of cooldownTools) {
    if (!flagged.has(tool)) flagged.set(tool, "cooldown");
  }
  for (const [tool, stats] of Object.entries(genealogy.tools || {})) {
    const n = (stats.successes || 0) + (stats.failures || 0);
    if (n < MIN_SAMPLES_FOR_FLAG) continue;
    const rel = getToolReliability(genealogy, tool);
    if (rel.successRate < AVOID_RATE_CEILING) {
      if (!flagged.has(tool)) flagged.set(tool, "low_success_rate");
    }
  }

  // Preferred tools: high success rate with enough samples.
  const ranked = rankByReliability(genealogy, { minSamples: MIN_SAMPLES_FOR_FLAG });
  const preferred = ranked
    .filter((r) => r.successRate >= PREFER_RATE_FLOOR && !flagged.has(r.tool))
    .slice(0, 5)
    .map((r) => r.tool);

  const flaggedList = [...flagged.keys()].sort().slice(0, 5);
  const preferredList = preferred.slice().sort();

  // Top failure patterns: top-3 tools by total failure count; top-3 categories each.
  const topFailTools = Object.entries(failureStats.tools || {})
    .map(([tool, s]) => ({ tool, score: chronicScoreFor(s), byCategory: s.byCategory || {}, total: s.total || 0 }))
    .filter((t) => t.total >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const sections = [];

  if (flaggedList.length > 0) {
    sections.push(
      `Known-bad tools in this workspace: ${flaggedList.join(", ")} — avoid unless no alternative.`,
    );
  }

  if (preferredList.length > 0) {
    sections.push(
      `Reliable tools in this workspace: ${preferredList.join(", ")} — prefer when multiple tools could satisfy the task.`,
    );
  }

  if (topFailTools.length > 0) {
    const patternLines = [];
    for (const t of topFailTools) {
      const cats = topFailureCategories(t.byCategory, 3);
      if (cats.length === 0) continue;
      const catStr = cats.map((c) => `${c.cat}(${c.count})`).join(", ");
      patternLines.push(`when calling ${t.tool}, watch for ${catStr}`);
    }
    if (patternLines.length > 0) {
      sections.push(`Common failure patterns: ${patternLines.join("; ")}.`);
    }
  }

  if (conflicts.length >= MIN_CONFLICTS) {
    const sims = conflicts
      .map((e) => Number(e.similarity))
      .filter((n) => Number.isFinite(n));
    const med = median(sims);
    if (med != null && med < CONFLICT_SIMILARITY_MEDIAN_CEILING) {
      const topic = extractConflictTopic(conflicts);
      if (topic.length > 0) {
        sections.push(
          `Specialist disagreements have clustered around: ${topic.join(", ")}.`,
        );
      } else {
        sections.push(
          `Specialist disagreements have clustered across ${conflicts.length} recent events; double-check reconciliation.`,
        );
      }
    }
  }

  if (sections.length === 0) return null;

  let content = sections.join("\n");
  if (content.length > MAX_PATCH_CHARS) {
    content = content.slice(0, MAX_PATCH_CHARS - 1) + "…";
  }

  const generatedAt = Date.now();
  const hashInput = `${ws}|${content}`;
  const version = `v1-${todayYmd(generatedAt)}-${hashContent(hashInput)}`;

  /** @type {PromptPatch} */
  const patch = {
    workspace: ws,
    generatedAt,
    version,
    content,
    basis: {
      failureCount: totalFailures,
      genealogyCount: totalGenealogySamples,
      conflictCount,
      toolsFlagged: flaggedList,
      toolsPreferred: preferredList,
    },
    status: "pending",
  };
  return patch;
}

/**
 * Persist a synthesized patch. Enforces a 50-patch ring buffer per workspace.
 * If a patch with the same version already exists, it is replaced in place
 * (preserving its array position / not duplicating).
 *
 * @param {PromptPatch} patch
 * @returns {Promise<void>}
 */
export async function savePatch(patch) {
  if (!patch || typeof patch !== "object" || typeof patch.workspace !== "string") {
    throw new Error("savePatch: invalid patch");
  }
  const path = storePath(patch.workspace);
  const store = await loadStore(patch.workspace);
  const now = Date.now();
  const existing = store.patches.findIndex((p) => p && p.version === patch.version);
  if (existing >= 0) {
    store.patches[existing] = { ...store.patches[existing], ...patch };
  } else {
    store.patches.push(patch);
  }
  // Ring buffer: keep most recent N (sort by generatedAt desc, truncate).
  store.patches.sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  if (store.patches.length > MAX_PATCHES_PER_WORKSPACE) {
    store.patches.length = MAX_PATCHES_PER_WORKSPACE;
  }
  store.updatedAt = now;
  await writeJsonPath(path, store);
}

/**
 * List patches for a workspace, newest-first.
 * @param {string} workspace
 * @param {{ limit?: number, status?: "pending" | "applied" | "rejected" }} [opts]
 * @returns {Promise<PromptPatch[]>}
 */
export async function listPatches(workspace, opts = {}) {
  const store = await loadStore(workspace);
  let patches = [...store.patches];
  patches.sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  if (opts && typeof opts.status === "string") {
    patches = patches.filter((p) => p.status === opts.status);
  }
  const limit = Number(opts?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    patches = patches.slice(0, Math.floor(limit));
  }
  return patches;
}

/**
 * Get the most-recently-applied patch for a workspace (or null).
 * @param {string} workspace
 * @returns {Promise<PromptPatch | null>}
 */
export async function getActivePatch(workspace) {
  const applied = await listPatches(workspace, { status: "applied" });
  if (applied.length === 0) return null;
  // Already newest-first.
  return applied[0];
}

/**
 * Change a patch's status. Records `appliedAt` + `appliedBy` when applied
 * or rejected.
 *
 * @param {string} workspace
 * @param {string} version
 * @param {"pending" | "applied" | "rejected"} status
 * @param {string} [adminId]
 * @returns {Promise<PromptPatch>}
 */
export async function setPatchStatus(workspace, version, status, adminId) {
  if (!["pending", "applied", "rejected"].includes(status)) {
    throw new Error(`setPatchStatus: invalid status "${status}"`);
  }
  const path = storePath(workspace);
  const store = await loadStore(workspace);
  const idx = store.patches.findIndex((p) => p && p.version === version);
  if (idx < 0) {
    throw new Error(`setPatchStatus: unknown patch version "${version}"`);
  }
  const patch = store.patches[idx];
  patch.status = status;
  if (status === "applied" || status === "rejected") {
    patch.appliedAt = Date.now();
    patch.appliedBy = typeof adminId === "string" && adminId.length > 0 ? adminId : "unknown";
  } else {
    delete patch.appliedAt;
    delete patch.appliedBy;
  }
  store.updatedAt = Date.now();
  await writeJsonPath(path, store);
  return patch;
}

/**
 * Synthesize + save in one call. If autoApply is true (or env opt-in), also
 * marks the patch applied immediately.
 *
 * @param {string} workspace
 * @param {{ autoApply?: boolean, adminId?: string }} [opts]
 * @returns {Promise<PromptPatch | null>}
 */
export async function autoTuneAndApply(workspace, opts = {}) {
  const envOptIn = process.env.AGENT_AUTO_TUNE_APPLY === "1";
  const autoApply = typeof opts.autoApply === "boolean" ? opts.autoApply : envOptIn;
  const adminId = typeof opts.adminId === "string" ? opts.adminId : "auto";

  const patch = await synthesizePatch(workspace);
  if (!patch) return null;
  if (autoApply) {
    patch.status = "applied";
    patch.appliedAt = Date.now();
    patch.appliedBy = adminId;
  }
  await savePatch(patch);
  return patch;
}

/**
 * Return the text content of the currently-active patch for injection into
 * the system prompt. Empty string if no applied patch exists.
 *
 * @param {string} workspace
 * @returns {Promise<string>}
 */
export async function getActivePatchContent(workspace) {
  const active = await getActivePatch(workspace);
  if (!active || typeof active.content !== "string") return "";
  return active.content;
}

/**
 * Exposed for tests: the configured maximum patch char budget.
 */
export const MAX_PATCH_CHARS_EXPORTED = MAX_PATCH_CHARS;
