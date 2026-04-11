// @ts-check
/**
 * Phase 51.4: Constitutional AI rule engine.
 *
 * A per-workspace "constitution" is a list of safety rules the model's
 * output must follow. Each rule has a unique id, a human-readable
 * principle, a priority (higher is stricter), and an action to take
 * when the rule is violated: "block", "revise", or "warn".
 *
 * Rules are evaluated deterministically using registered evaluator
 * functions (no LLM required) so the engine is fast, predictable, and
 * usable inside streaming hot paths. Each evaluator returns a violation
 * descriptor with a severity ("high", "medium", or "low") and an
 * optional reason string; `revise()` uses the descriptor to redact or
 * rewrite the offending content.
 *
 * Storage: JSON-backed via `json-path-store.js` so the module works
 * across file, SQLite, or Postgres KV backends without code changes.
 *
 * @module constitutional-ai
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { detectPII } from "./prompt-guard.js";

const STORE_VERSION = 1;
const DEFAULT_MAX_ITERATIONS = 3;

const VALID_ACTIONS = new Set(["block", "revise", "warn"]);
const VALID_SEVERITIES = new Set(["low", "medium", "high"]);

/**
 * Default constitution shipped with every new workspace. Rules are
 * ordered roughly by priority; callers may reorder, remove, or extend
 * as needed via `updateConstitution`, `addRule`, or `removeRule`.
 * @type {Array<{id: string, principle: string, critique_prompt?: string, revision_prompt?: string, priority: number, action: "block"|"revise"|"warn"}>}
 */
export const DEFAULT_CONSTITUTION = Object.freeze([
  {
    id: "no_harm",
    principle: "Do not help with harmful actions",
    critique_prompt: "Does this output provide instructions for harmful, illegal, or dangerous activity?",
    revision_prompt: "Rewrite the response refusing to help with the harmful request.",
    priority: 10,
    action: "block",
  },
  {
    id: "no_pii",
    principle: "Do not leak personally identifiable info",
    critique_prompt: "Does this output contain email addresses, phone numbers, SSNs, or credit-card numbers?",
    revision_prompt: "Redact any detected personally identifiable information from the response.",
    priority: 9,
    action: "revise",
  },
  {
    id: "no_bias",
    principle: "Treat all groups fairly",
    critique_prompt: "Does this output contain biased or discriminatory language toward any group?",
    revision_prompt: "Rewrite the response removing biased or discriminatory language.",
    priority: 8,
    action: "revise",
  },
  {
    id: "no_hallucination",
    principle: "Acknowledge uncertainty",
    critique_prompt: "Does this output make confident claims that lack grounding or evidence?",
    revision_prompt: "Rewrite the response to acknowledge uncertainty where claims lack grounding.",
    priority: 7,
    action: "revise",
  },
  {
    id: "transparency",
    principle: "Be honest about being an AI",
    critique_prompt: "Does this output claim to be human or deny being an AI?",
    revision_prompt: "Add a clarification that the responder is an AI model.",
    priority: 6,
    action: "warn",
  },
  {
    id: "no_profanity",
    principle: "Avoid profane or offensive language",
    critique_prompt: "Does this output contain profanity or slurs?",
    revision_prompt: "Redact profane or offensive language from the response.",
    priority: 5,
    action: "revise",
  },
]);

// ---- Store helpers ----

function storePath() {
  return join(getDataDir(), "constitutional-ai.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    constitutions: base.constitutions && typeof base.constitutions === "object" ? base.constitutions : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, constitutions: {} }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

async function mutate(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

// ---- Rule validation ----

function assertValidRule(rule) {
  if (!rule || typeof rule !== "object") {
    throw new Error("rule must be an object");
  }
  if (!rule.id || typeof rule.id !== "string") {
    throw new Error("rule.id is required");
  }
  if (!rule.principle || typeof rule.principle !== "string") {
    throw new Error("rule.principle is required");
  }
  const priority = Number(rule.priority);
  if (!Number.isFinite(priority)) {
    throw new Error("rule.priority must be numeric");
  }
  const action = rule.action || "warn";
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`rule.action must be one of ${[...VALID_ACTIONS].join(", ")}`);
  }
}

function cloneRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => ({ ...r }));
}

function sortRulesByPriority(rules) {
  return [...rules].sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    return pb - pa; // higher priority first
  });
}

// ---- Constitution CRUD ----

/**
 * Create (or overwrite) the constitution for a workspace.
 * @param {string} workspaceId
 * @param {Array} [rules]
 * @returns {Promise<{workspaceId: string, rules: Array, createdAt: number, updatedAt: number}>}
 */
export async function createConstitution(workspaceId, rules = DEFAULT_CONSTITUTION) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  const copy = cloneRules(rules);
  copy.forEach(assertValidRule);
  return mutate(async (store) => {
    const ts = Date.now();
    const entry = {
      workspaceId,
      rules: copy,
      createdAt: store.constitutions[workspaceId]?.createdAt || ts,
      updatedAt: ts,
    };
    store.constitutions[workspaceId] = entry;
    return { ...entry, rules: cloneRules(entry.rules) };
  });
}

/**
 * Get the constitution for a workspace, or null if none exists.
 * @param {string} workspaceId
 * @returns {Promise<object|null>}
 */
export async function getConstitution(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  const store = await loadStore();
  const entry = store.constitutions[workspaceId];
  if (!entry) return null;
  return { ...entry, rules: cloneRules(entry.rules) };
}

/**
 * Replace the rule set of an existing workspace constitution.
 * @param {string} workspaceId
 * @param {Array} rules
 * @returns {Promise<object>}
 */
export async function updateConstitution(workspaceId, rules) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!Array.isArray(rules)) {
    throw new Error("rules must be an array");
  }
  const copy = cloneRules(rules);
  copy.forEach(assertValidRule);
  return mutate(async (store) => {
    const existing = store.constitutions[workspaceId];
    if (!existing) {
      throw new Error(`constitution for workspace ${workspaceId} not found`);
    }
    existing.rules = copy;
    existing.updatedAt = Date.now();
    return { ...existing, rules: cloneRules(existing.rules) };
  });
}

/**
 * Delete a workspace constitution.
 * @param {string} workspaceId
 * @returns {Promise<boolean>} true if deleted, false if it did not exist
 */
export async function deleteConstitution(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  return mutate(async (store) => {
    if (!store.constitutions[workspaceId]) return false;
    delete store.constitutions[workspaceId];
    return true;
  });
}

/**
 * Add a new rule to a constitution. If no constitution exists yet,
 * a new empty one is created first.
 * @param {string} workspaceId
 * @param {object} rule
 * @returns {Promise<object>}
 */
export async function addRule(workspaceId, rule) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  assertValidRule(rule);
  return mutate(async (store) => {
    let entry = store.constitutions[workspaceId];
    const ts = Date.now();
    if (!entry) {
      entry = { workspaceId, rules: [], createdAt: ts, updatedAt: ts };
      store.constitutions[workspaceId] = entry;
    }
    if (entry.rules.some((r) => r.id === rule.id)) {
      throw new Error(`rule ${rule.id} already exists`);
    }
    entry.rules.push({ ...rule });
    entry.updatedAt = ts;
    return { ...entry, rules: cloneRules(entry.rules) };
  });
}

/**
 * Remove a rule by id from a constitution.
 * @param {string} workspaceId
 * @param {string} ruleId
 * @returns {Promise<object>}
 */
export async function removeRule(workspaceId, ruleId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!ruleId || typeof ruleId !== "string") {
    throw new Error("ruleId is required");
  }
  return mutate(async (store) => {
    const entry = store.constitutions[workspaceId];
    if (!entry) {
      throw new Error(`constitution for workspace ${workspaceId} not found`);
    }
    const before = entry.rules.length;
    entry.rules = entry.rules.filter((r) => r.id !== ruleId);
    if (entry.rules.length === before) {
      throw new Error(`rule ${ruleId} not found`);
    }
    entry.updatedAt = Date.now();
    return { ...entry, rules: cloneRules(entry.rules) };
  });
}

// ---- Built-in rule evaluators ----

const HARMFUL_PATTERNS = [
  /how to (make|build|create) (a |an )?(bomb|explosive|weapon|gun)/i,
  /instructions (for|to) (hack|exploit|break into|poison|kill)/i,
  /step[- ]by[- ]step .*(bomb|weapon|poison|exploit)/i,
  /\b(synthesize|manufacture) (meth|fentanyl|nerve agent)/i,
];

const BIAS_PATTERNS = [
  /\b(all|every|most) (women|men|blacks|whites|asians|jews|muslims|christians|hindus|gays|lesbians) are\b/i,
  /\b(women|men|blacks|whites|asians|jews|muslims|christians) can'?t\b/i,
  /\b(inferior|superior) race\b/i,
];

const PROFANITY_PATTERNS = [
  /\bfuck(?:ing|ed|er|s)?\b/i,
  /\bshit(?:ty|s)?\b/i,
  /\bbitch(?:es|ing)?\b/i,
  /\basshole(?:s)?\b/i,
  /\bcunt(?:s)?\b/i,
];

const HALLUCINATION_CONFIDENCE_PATTERNS = [
  /\b(i'?m (100% |absolutely |completely )?certain|it is (a |an )?(proven|established) fact|without (a )?doubt|definitely true|undeniably)\b/i,
];

const AI_DENIAL_PATTERNS = [
  /\bi'?m (a |an )?(real |actual )?human\b/i,
  /\bi am not an (ai|artificial intelligence|bot|machine|chatbot)\b/i,
  /\bi'?m not a (bot|robot|machine|program|ai)\b/i,
];

/**
 * Built-in evaluators for the default rule ids. Each evaluator takes
 * the output text and returns either null (no violation) or a violation
 * descriptor: { violated: true, severity, reason, matches?: string[] }.
 *
 * Custom evaluators can be added via `registerRuleEvaluator`.
 * @type {Object<string, (output: string) => ({violated: boolean, severity: string, reason: string, matches?: string[]}|null)>}
 */
export const RULE_EVALUATORS = {
  no_harm(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const matches = [];
    for (const re of HARMFUL_PATTERNS) {
      const m = output.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length === 0) return null;
    return {
      violated: true,
      severity: "high",
      reason: "output contains harmful instructions",
      matches,
    };
  },

  no_pii(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const pii = detectPII(output);
    if (!pii.hasPII) return null;
    const hasHighRisk = pii.types.some((t) => t === "ssn" || t === "credit_card");
    return {
      violated: true,
      severity: hasHighRisk ? "high" : "medium",
      reason: `output contains PII: ${pii.types.join(", ")}`,
      matches: pii.types,
      positions: pii.positions,
    };
  },

  no_hallucination(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const matches = [];
    for (const re of HALLUCINATION_CONFIDENCE_PATTERNS) {
      const m = output.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length === 0) return null;
    return {
      violated: true,
      severity: "low",
      reason: "output uses unsupported certainty language",
      matches,
    };
  },

  no_bias(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const matches = [];
    for (const re of BIAS_PATTERNS) {
      const m = output.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length === 0) return null;
    return {
      violated: true,
      severity: "medium",
      reason: "output contains biased or generalizing language",
      matches,
    };
  },

  transparency(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const matches = [];
    for (const re of AI_DENIAL_PATTERNS) {
      const m = output.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length === 0) return null;
    return {
      violated: true,
      severity: "medium",
      reason: "output denies AI identity",
      matches,
    };
  },

  no_profanity(output) {
    if (typeof output !== "string" || !output.trim()) return null;
    const matches = [];
    for (const re of PROFANITY_PATTERNS) {
      const m = output.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length === 0) return null;
    return {
      violated: true,
      severity: "low",
      reason: "output contains profanity",
      matches,
    };
  },
};

/**
 * Register (or replace) a custom rule evaluator for a rule id.
 * @param {string} ruleId
 * @param {(output: string) => (object|null)} evaluatorFn
 */
export function registerRuleEvaluator(ruleId, evaluatorFn) {
  if (!ruleId || typeof ruleId !== "string") {
    throw new Error("ruleId is required");
  }
  if (typeof evaluatorFn !== "function") {
    throw new Error("evaluatorFn must be a function");
  }
  RULE_EVALUATORS[ruleId] = evaluatorFn;
}

/**
 * Evaluate output against a constitution using the registered rule
 * evaluators. Rules are evaluated in priority order (highest first).
 *
 * @param {string} output
 * @param {object|Array} constitution - either a constitution entry or a bare rule array
 * @returns {Array<{ruleId: string, violated: boolean, severity: string, reason: string, action: string, priority: number, matches?: Array}>}
 */
export function critique(output, constitution) {
  const rules = Array.isArray(constitution)
    ? constitution
    : constitution && Array.isArray(constitution.rules)
      ? constitution.rules
      : [];
  if (rules.length === 0) return [];

  const sorted = sortRulesByPriority(rules);
  const violations = [];

  for (const rule of sorted) {
    const evaluator = RULE_EVALUATORS[rule.id];
    if (typeof evaluator !== "function") continue;
    let result = null;
    try {
      result = evaluator(output);
    } catch (err) {
      // Evaluators must never throw into the hot path; record as a low-severity warning.
      result = {
        violated: true,
        severity: "low",
        reason: `evaluator threw: ${err && err.message ? err.message : String(err)}`,
      };
    }
    if (result && result.violated) {
      violations.push({
        ruleId: rule.id,
        violated: true,
        severity: VALID_SEVERITIES.has(result.severity) ? result.severity : "low",
        reason: result.reason || "",
        action: rule.action || "warn",
        priority: Number(rule.priority) || 0,
        matches: Array.isArray(result.matches) ? [...result.matches] : undefined,
      });
    }
  }

  return violations;
}

// ---- Rule-based revision ----

function redactPatternMatches(text, patterns, replacement) {
  let revised = text;
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const global = new RegExp(re.source, flags);
    revised = revised.replace(global, replacement);
  }
  return revised;
}

function redactPII(text) {
  let revised = text;
  revised = revised.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");
  revised = revised.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");
  revised = revised.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, "[REDACTED_CARD]");
  revised = revised.replace(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g, "[REDACTED_PHONE]");
  return revised;
}

/**
 * Apply rule-based revisions to an output. Revisions are deterministic
 * and do not require an LLM. The function walks violations in priority
 * order; if it encounters a "block" action it halts and returns a
 * refusal string with `blocked: true`.
 *
 * @param {string} output
 * @param {Array} violations - from `critique()`
 * @param {object|Array} [constitution]
 * @returns {{revised: string, appliedRules: Array<string>, blocked: boolean, blockReason?: string}}
 */
export function revise(output, violations, constitution) {
  if (typeof output !== "string") {
    return { revised: "", appliedRules: [], blocked: false };
  }
  if (!Array.isArray(violations) || violations.length === 0) {
    return { revised: output, appliedRules: [], blocked: false };
  }

  // Index rules by id for lookup (if caller passed a full constitution).
  const rulesById = new Map();
  if (constitution) {
    const rules = Array.isArray(constitution)
      ? constitution
      : Array.isArray(constitution.rules)
        ? constitution.rules
        : [];
    for (const r of rules) if (r && r.id) rulesById.set(r.id, r);
  }

  // Sort violations by priority (highest first). Blocks halt early.
  const sorted = [...violations].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const applied = [];
  let revised = output;

  for (const v of sorted) {
    const rule = rulesById.get(v.ruleId);
    const action = v.action || (rule && rule.action) || "warn";

    if (action === "block") {
      return {
        revised: `[BLOCKED by constitution rule "${v.ruleId}": ${v.reason || "policy violation"}]`,
        appliedRules: [v.ruleId],
        blocked: true,
        blockReason: v.reason || "policy violation",
      };
    }

    if (action === "warn") {
      // Warnings do not modify output; record that the rule fired.
      applied.push(v.ruleId);
      continue;
    }

    // action === "revise"
    switch (v.ruleId) {
      case "no_pii":
        revised = redactPII(revised);
        applied.push(v.ruleId);
        break;
      case "no_profanity":
        revised = redactPatternMatches(revised, PROFANITY_PATTERNS, "[REDACTED]");
        applied.push(v.ruleId);
        break;
      case "no_bias":
        revised = redactPatternMatches(revised, BIAS_PATTERNS, "[REDACTED_BIAS]");
        applied.push(v.ruleId);
        break;
      case "no_hallucination":
        revised = redactPatternMatches(
          revised,
          HALLUCINATION_CONFIDENCE_PATTERNS,
          "I believe",
        );
        applied.push(v.ruleId);
        break;
      case "no_harm":
        // Harm rules should be configured as "block"; if configured as
        // "revise" we still refuse politely.
        revised = "I can't help with that request.";
        applied.push(v.ruleId);
        break;
      case "transparency":
        revised = `${revised}\n\n(Note: this response was produced by an AI model.)`;
        applied.push(v.ruleId);
        break;
      default:
        // Unknown rule with revise action — append a warning comment.
        revised = `${revised}\n\n[Revised for ${v.ruleId}]`;
        applied.push(v.ruleId);
        break;
    }
  }

  return { revised, appliedRules: applied, blocked: false };
}

/**
 * Orchestrate the critique/revise loop: critique → revise → critique …
 * until either no violations remain or the maximum iteration count is
 * reached. A "block" action halts the loop immediately.
 *
 * @param {string} output
 * @param {object|Array} constitution
 * @param {{maxIterations?: number}} [options]
 * @returns {Promise<{output: string, violations: Array, revisions: Array, iterations: number, blocked: boolean}>}
 */
export async function applyConstitution(output, constitution, options = {}) {
  const maxIterations = Math.max(
    1,
    Number.isFinite(Number(options.maxIterations))
      ? Number(options.maxIterations)
      : DEFAULT_MAX_ITERATIONS,
  );

  let current = typeof output === "string" ? output : String(output ?? "");
  const revisions = [];
  let lastViolations = [];
  let iterations = 0;
  let blocked = false;

  const rules = Array.isArray(constitution)
    ? constitution
    : constitution && Array.isArray(constitution.rules)
      ? constitution.rules
      : [];

  if (rules.length === 0) {
    return { output: current, violations: [], revisions: [], iterations: 0, blocked: false };
  }

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const violations = critique(current, rules);
    lastViolations = violations;
    if (violations.length === 0) break;

    const revision = revise(current, violations, rules);
    revisions.push({
      iteration: iterations,
      violations: violations.map((v) => ({ ruleId: v.ruleId, severity: v.severity, action: v.action })),
      appliedRules: revision.appliedRules,
      blocked: revision.blocked,
    });

    if (revision.blocked) {
      current = revision.revised;
      blocked = true;
      // Re-run critique once more to reflect final state for the caller.
      lastViolations = critique(current, rules);
      break;
    }

    // If nothing changed, stop to avoid infinite loops.
    if (revision.revised === current) break;
    current = revision.revised;
  }

  return {
    output: current,
    violations: lastViolations,
    revisions,
    iterations,
    blocked,
  };
}

// Exposed for tests.
export const _internals = {
  storePath,
  normalizeStore,
  sortRulesByPriority,
  HARMFUL_PATTERNS,
  BIAS_PATTERNS,
  PROFANITY_PATTERNS,
  HALLUCINATION_CONFIDENCE_PATTERNS,
  AI_DENIAL_PATTERNS,
};
