// @ts-check
/**
 * Phase 32.5: Explainability layer — capture WHY the agent made each decision
 * and present it in human-readable form.
 *
 * Decisions are recorded at key branching points in the agent loop and swarm
 * coordinator (tool selection, model selection, specialist delegation,
 * termination, retry, skip, reflection). Each record includes the chosen
 * option, alternatives considered, contributing factors (with weights),
 * confidence, and free-form reasoning text.
 *
 * @module explainability
 */

/**
 * @typedef {Object} DecisionFactor
 * @property {string} name   - Factor name (e.g. "keyword_match", "latency")
 * @property {number} weight - Weight of this factor in the decision (0..1)
 * @property {*}      value  - Observed value of the factor
 */

/**
 * @typedef {Object} Decision
 * @property {string}           runId         - Associated agent run id
 * @property {number}           turnIndex     - Iteration / turn when the decision was made
 * @property {string}           decisionType  - 'tool_selection' | 'model_selection' | 'specialist_delegation' | 'termination' | 'retry' | 'skip' | 'reflection'
 * @property {string}           chosen        - The option that was chosen
 * @property {string[]}         [alternatives]- Other options that were considered
 * @property {string}           [reasoning]   - Free-form reasoning text
 * @property {number}           [confidence]  - Confidence value in [0..1]
 * @property {DecisionFactor[]} [factors]     - Contributing factors
 * @property {string}           [workspaceId] - Workspace that owns the run
 * @property {number}           timestamp     - Epoch ms at record time
 */

const VALID_TYPES = new Set([
  "tool_selection",
  "model_selection",
  "specialist_delegation",
  "termination",
  "retry",
  "skip",
  "reflection",
]);

/** Maximum decisions kept in memory per-log (prevents unbounded growth). */
const MAX_DECISIONS = Number(process.env.EXPLAINABILITY_MAX_DECISIONS) || 5000;

/**
 * Create a new decision log. A process-wide singleton is exposed as
 * `globalDecisionLog`, but tests may create isolated logs.
 *
 * @returns {{
 *   recordDecision: (d: Partial<Decision>) => Decision,
 *   getDecisionsForRun: (runId: string) => Decision[],
 *   getDecision: (runId: string, index: number) => Decision|null,
 *   explainDecision: (runId: string, index: number) => string|null,
 *   generateRunExplanation: (runId: string) => ({ runId: string, summary: string, keyDecisions: Decision[], alternatives: string[], confidence: number }|null),
 *   getDecisionStats: (workspaceId?: string|null, periodMs?: number) => object,
 *   listRuns: (workspaceId?: string|null, limit?: number) => Array<{ runId: string, workspaceId: string|null, firstDecisionAt: number, lastDecisionAt: number, decisionCount: number }>,
 *   clear: () => void,
 *   _all: () => Decision[]
 * }}
 */
export function createDecisionLog() {
  /** @type {Decision[]} */
  const decisions = [];

  function recordDecision(input) {
    if (!input || typeof input !== "object") {
      throw new Error("decision must be an object");
    }
    const decisionType = String(input.decisionType || "");
    if (!VALID_TYPES.has(decisionType)) {
      throw new Error(
        `invalid decisionType: ${decisionType}. Must be one of ${[...VALID_TYPES].join(", ")}`
      );
    }
    if (!input.runId || typeof input.runId !== "string") {
      throw new Error("decision.runId is required");
    }
    if (input.chosen == null || String(input.chosen).length === 0) {
      throw new Error("decision.chosen is required");
    }

    const confidence =
      typeof input.confidence === "number" && Number.isFinite(input.confidence)
        ? Math.max(0, Math.min(1, input.confidence))
        : null;

    /** @type {Decision} */
    const record = {
      runId: input.runId,
      turnIndex: Number.isFinite(input.turnIndex) ? Number(input.turnIndex) : 0,
      decisionType,
      chosen: String(input.chosen),
      alternatives: Array.isArray(input.alternatives)
        ? input.alternatives.map((x) => String(x)).filter((x) => x && x !== input.chosen)
        : [],
      reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
      confidence: confidence == null ? null : confidence,
      factors: Array.isArray(input.factors)
        ? input.factors
            .filter((f) => f && typeof f === "object" && f.name)
            .map((f) => ({
              name: String(f.name),
              weight:
                typeof f.weight === "number" && Number.isFinite(f.weight)
                  ? Math.max(0, Math.min(1, f.weight))
                  : 0,
              value: f.value,
            }))
        : [],
      workspaceId: input.workspaceId ? String(input.workspaceId) : null,
      timestamp: Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now(),
    };

    decisions.push(record);
    // Trim oldest when exceeding cap.
    if (decisions.length > MAX_DECISIONS) {
      decisions.splice(0, decisions.length - MAX_DECISIONS);
    }
    return record;
  }

  function getDecisionsForRun(runId) {
    if (!runId) return [];
    return decisions.filter((d) => d.runId === runId);
  }

  function getDecision(runId, index) {
    const list = getDecisionsForRun(runId);
    if (!Number.isFinite(index) || index < 0 || index >= list.length) return null;
    return list[index];
  }

  function explainDecision(runId, index) {
    const decision = getDecision(runId, index);
    if (!decision) return null;
    return formatDecisionExplanation(decision);
  }

  function generateRunExplanation(runId) {
    const list = getDecisionsForRun(runId);
    if (list.length === 0) return null;
    const confidences = list
      .map((d) => d.confidence)
      .filter((c) => typeof c === "number");
    const avgConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;

    // Pick up to the 5 most impactful decisions by (confidence x factor count x alternatives).
    const ranked = [...list]
      .map((d) => ({
        d,
        score:
          (d.confidence || 0.5) *
          (1 + (d.factors?.length || 0)) *
          (1 + (d.alternatives?.length || 0)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.d);

    const typeCounts = {};
    for (const d of list) {
      typeCounts[d.decisionType] = (typeCounts[d.decisionType] || 0) + 1;
    }

    const allAlternatives = new Set();
    for (const d of list) {
      for (const a of d.alternatives || []) allAlternatives.add(a);
    }

    const typeSummary = Object.entries(typeCounts)
      .map(([t, c]) => `${c} ${t.replace(/_/g, " ")}`)
      .join(", ");
    const summary = `Run ${runId.slice(0, 8)} made ${list.length} decision${list.length === 1 ? "" : "s"} across ${Math.max(...list.map((d) => d.turnIndex), 0) + 1} turn${list.length === 1 ? "" : "s"}: ${typeSummary}. Average confidence ${(avgConfidence * 100).toFixed(0)}%.`;

    return {
      runId,
      summary,
      keyDecisions: ranked,
      alternatives: [...allAlternatives],
      confidence: Number(avgConfidence.toFixed(4)),
      decisionCount: list.length,
      typeCounts,
    };
  }

  function getDecisionStats(workspaceId = null, periodMs = 0) {
    const now = Date.now();
    const cutoff = periodMs > 0 ? now - periodMs : 0;
    const scoped = decisions.filter((d) => {
      if (workspaceId && d.workspaceId !== workspaceId) return false;
      if (cutoff && d.timestamp < cutoff) return false;
      return true;
    });

    const typeDistribution = {};
    let totalConfidence = 0;
    let confCount = 0;
    let totalAlternatives = 0;
    const runIds = new Set();
    const chosenByType = {};

    for (const d of scoped) {
      typeDistribution[d.decisionType] = (typeDistribution[d.decisionType] || 0) + 1;
      if (typeof d.confidence === "number") {
        totalConfidence += d.confidence;
        confCount++;
      }
      totalAlternatives += d.alternatives?.length || 0;
      runIds.add(d.runId);
      if (!chosenByType[d.decisionType]) chosenByType[d.decisionType] = {};
      chosenByType[d.decisionType][d.chosen] =
        (chosenByType[d.decisionType][d.chosen] || 0) + 1;
    }

    return {
      total: scoped.length,
      runCount: runIds.size,
      typeDistribution,
      avgConfidence: confCount > 0 ? Number((totalConfidence / confCount).toFixed(4)) : 0,
      avgAlternativesConsidered:
        scoped.length > 0 ? Number((totalAlternatives / scoped.length).toFixed(2)) : 0,
      chosenByType,
      periodMs,
      workspaceId,
    };
  }

  function listRuns(workspaceId = null, limit = 50) {
    /** @type {Map<string, { runId: string, workspaceId: string|null, firstDecisionAt: number, lastDecisionAt: number, decisionCount: number }>} */
    const byRun = new Map();
    for (const d of decisions) {
      if (workspaceId && d.workspaceId !== workspaceId) continue;
      const cur = byRun.get(d.runId);
      if (!cur) {
        byRun.set(d.runId, {
          runId: d.runId,
          workspaceId: d.workspaceId || null,
          firstDecisionAt: d.timestamp,
          lastDecisionAt: d.timestamp,
          decisionCount: 1,
        });
      } else {
        cur.decisionCount++;
        if (d.timestamp < cur.firstDecisionAt) cur.firstDecisionAt = d.timestamp;
        if (d.timestamp > cur.lastDecisionAt) cur.lastDecisionAt = d.timestamp;
      }
    }
    return [...byRun.values()]
      .sort((a, b) => b.lastDecisionAt - a.lastDecisionAt)
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  function clear() {
    decisions.length = 0;
  }

  function _all() {
    return [...decisions];
  }

  return {
    recordDecision,
    getDecisionsForRun,
    getDecision,
    explainDecision,
    generateRunExplanation,
    getDecisionStats,
    listRuns,
    clear,
    _all,
  };
}

/**
 * Human-readable explanation template for a single decision.
 *
 * Examples:
 *   Selected `search_context` over `semantic_search_context` because
 *   (1) keyword_match preferred (weight 0.60, value "exact"),
 *   (2) latency (weight 0.30, value "12ms");
 *   confidence 0.85.
 *
 * @param {Decision} decision
 * @returns {string}
 */
export function formatDecisionExplanation(decision) {
  if (!decision) return "";
  const verbByType = {
    tool_selection: "Selected tool",
    model_selection: "Selected model",
    specialist_delegation: "Delegated to specialist",
    termination: "Terminated run due to",
    retry: "Retried",
    skip: "Skipped",
    reflection: "Reflected with",
  };
  const verb = verbByType[decision.decisionType] || "Chose";

  let line = `${verb} \`${decision.chosen}\``;
  const alts = decision.alternatives || [];
  if (alts.length > 0) {
    const altsStr = alts.slice(0, 4).map((a) => `\`${a}\``).join(", ");
    const more = alts.length > 4 ? ` and ${alts.length - 4} other` : "";
    line += ` over ${altsStr}${more}`;
  }

  const factors = decision.factors || [];
  if (factors.length > 0) {
    const sorted = [...factors].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const factorStrs = sorted.map((f, i) => {
      const val = f.value == null ? "" : ` value ${formatFactorValue(f.value)}`;
      return `(${i + 1}) ${f.name} (weight ${Number(f.weight).toFixed(2)}${val})`;
    });
    line += ` because ${factorStrs.join(", ")}`;
  } else if (decision.reasoning) {
    line += ` because ${decision.reasoning}`;
  }

  if (typeof decision.confidence === "number") {
    line += `; confidence ${decision.confidence.toFixed(2)}`;
  }

  if (decision.reasoning && factors.length > 0) {
    // Append reasoning as supporting note when we already used factors for main line.
    line += `. ${decision.reasoning}`;
  }

  return line + ".";
}

function formatFactorValue(v) {
  if (v == null) return "";
  if (typeof v === "string") return `"${v.slice(0, 60)}"`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v).slice(0, 60);
  } catch {
    return String(v);
  }
}

/**
 * Convenience helper: parse a period string like "7d", "24h", "30m" to ms.
 * @param {string} period
 */
export function parsePeriod(period) {
  if (!period || typeof period !== "string") return 0;
  const m = period.trim().match(/^(\d+)\s*(ms|s|m|h|d|w)?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    case "d":  return n * 24 * 60 * 60 * 1000;
    case "w":  return n * 7 * 24 * 60 * 60 * 1000;
    default:   return 0;
  }
}

/** Process-wide singleton. */
export const globalDecisionLog = createDecisionLog();
