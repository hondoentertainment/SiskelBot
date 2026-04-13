/**
 * Phase 51.2: Jailbreak / prompt-injection detection.
 *
 * Rule-based + heuristic detector for incoming prompts. No ML dependencies —
 * uses regular expressions, keyword lookups, and simple scoring to classify
 * risk, apply policies, and log detections. Results feed into per-workspace
 * policy actions (allow, warn, sanitize, block, quarantine).
 *
 * Storage (via lib/json-path-store.js):
 *   data/safety/policies/{workspaceId}.json   — per-workspace policy
 *   data/safety/detections.json               — detection audit log
 */
import { join } from "path";
import { randomUUID } from "crypto";
import {
  getDataDir,
  readJsonPath,
  writeJsonPath,
  withPathLock,
} from "./json-path-store.js";
// Phase 51.4: mirror every detection into the unified policy-audit trail.
import { recordDecision as _recordPolicyDecision } from "./policy-audit.js";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/**
 * Categorized regex patterns used by the detector. Each category maps to a
 * base severity weight; the strongest matching category wins.
 */
export const JAILBREAK_PATTERNS = {
  dan_variants: [
    /\bDAN\b/i,
    /\bdo anything now\b/i,
    /\bignore.*previous.*instructions?\b/i,
    /\bdeveloper mode\b/i,
    /\bjailbreak(ed|ing)?\b/i,
    /\bSTAN\b/,
    /\bAIM\b/,
  ],
  role_reset: [
    /\bforget\s+(everything|all|prior|previous)\b/i,
    /\bnew\s+(role|persona|identity|instructions?)\b/i,
    /\bsystem\s*[:;]\s*you\s+are\b/i,
    /\byou\s+are\s+no\s+longer\b/i,
    /\breset\s+(your|all)\s+(rules?|instructions?)\b/i,
  ],
  instruction_override: [
    /\bdisregard\s+(the\s+)?above\b/i,
    /\bthe\s+above\s+is\s+(wrong|fake|a\s+test)\b/i,
    /\bpretend\s+(to\s+be|you\s+are|you're)\b/i,
    /\bignore\s+(your|the|all)\s+(rules?|guidelines?|restrictions?|policies)\b/i,
    /\boverride\s+(your|the)\s+(rules?|instructions?)\b/i,
  ],
  leak_system: [
    /\bsystem\s+prompt\b/i,
    /\bprint\s+(your|the)\s+instructions?\b/i,
    /\brepeat\s+.*\bverbatim\b/i,
    /\bshow\s+me\s+(your|the)\s+(prompt|instructions?|system\s+message)\b/i,
    /\breveal\s+(your|the)\s+(prompt|instructions?|rules?)\b/i,
    /\bwhat\s+(are|were)\s+your\s+(initial\s+)?instructions?\b/i,
  ],
  bypass_safety: [
    /\bwithout\s+(any\s+)?(restrictions?|limits?|filters?|safety)\b/i,
    /\bunsafe\s+mode\b/i,
    /\buncensored\b/i,
    /\bno\s+(filter|restriction|limit|rule)s?\b/i,
    /\bbypass\s+(your|the|all)\s+(filters?|safety|guardrails?|checks?)\b/i,
    /\b(turn|switch)\s+off\s+(your|the)\s+(filter|safety|rules?)\b/i,
  ],
};

/**
 * Category weights (0-100). The highest matching category's weight is used as
 * the base risk score for classification.
 */
const CATEGORY_WEIGHTS = {
  dan_variants: 90,
  role_reset: 80,
  instruction_override: 75,
  leak_system: 70,
  bypass_safety: 85,
};

/**
 * Human-readable policy action table.
 */
export const POLICY_ACTIONS = {
  allow: "Pass through unchanged",
  warn: "Prepend warning to response",
  sanitize: "Remove detected patterns",
  block: "Reject request",
  quarantine: "Log + review",
};

const DEFAULT_POLICY = Object.freeze({
  name: "default",
  blockAt: 80,
  warnAt: 50,
  sanitize: false,
  quarantineAt: 90,
  updatedAt: 0,
});

const MAX_SCAN_LEN = 32_000; // perf guard for very long prompts
const STREAM_BUFFER = 4_000;

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Scan a prompt against all jailbreak pattern categories.
 *
 * @param {string} prompt
 * @param {{ categories?: string[] }} [options]
 * @returns {{ detected: boolean, category?: string, confidence: number, matches: Array<{category:string, pattern:string, text:string}> }}
 */
export function detectJailbreak(prompt, options = {}) {
  const empty = { detected: false, confidence: 0, matches: [] };
  if (typeof prompt !== "string" || prompt.length === 0) return empty;

  const text = prompt.length > MAX_SCAN_LEN ? prompt.slice(0, MAX_SCAN_LEN) : prompt;
  const categories =
    Array.isArray(options.categories) && options.categories.length > 0
      ? options.categories
      : Object.keys(JAILBREAK_PATTERNS);

  const matches = [];
  let bestCategory = null;
  let bestWeight = 0;

  for (const cat of categories) {
    const patterns = JAILBREAK_PATTERNS[cat];
    if (!patterns) continue;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        matches.push({ category: cat, pattern: re.source, text: m[0] });
        const w = CATEGORY_WEIGHTS[cat] || 50;
        if (w > bestWeight) {
          bestWeight = w;
          bestCategory = cat;
        }
      }
    }
  }

  if (matches.length === 0) return empty;

  // Confidence scales with category weight and the number of unique categories hit.
  const uniqueCats = new Set(matches.map((m) => m.category));
  const boost = Math.min(10, (uniqueCats.size - 1) * 5);
  const confidence = Math.max(0, Math.min(1, (bestWeight + boost) / 100));

  return {
    detected: true,
    category: bestCategory,
    confidence,
    matches,
  };
}

/**
 * Detect user-prompt-injection attempts: heuristics that indicate a user is
 * trying to override or leak the system prompt, including patterns that
 * reference an impersonated "system" turn.
 *
 * @param {string} prompt
 * @param {string} [systemPrompt]
 * @returns {{ detected: boolean, technique?: string, confidence: number }}
 */
export function detectPromptInjection(prompt, systemPrompt) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { detected: false, confidence: 0 };
  }
  const text = prompt.length > MAX_SCAN_LEN ? prompt.slice(0, MAX_SCAN_LEN) : prompt;

  // Techniques worth classifying separately from raw jailbreak hits.
  const techniques = [
    {
      id: "system_impersonation",
      re: /(^|\n)\s*(system|assistant)\s*[:>]/i,
      weight: 0.9,
    },
    {
      id: "delimiter_injection",
      re: /```\s*system|<\|system\|>|\[\s*system\s*\]/i,
      weight: 0.85,
    },
    {
      id: "override_above",
      re: /\b(ignore|disregard|forget)\b.*\babove\b/i,
      weight: 0.8,
    },
    {
      id: "system_leak",
      re: /\b(print|show|reveal|repeat)\b.*\b(system\s+prompt|your\s+instructions?)\b/i,
      weight: 0.8,
    },
    {
      id: "role_reassignment",
      re: /\byou\s+are\s+now\s+(a|an|the)\b/i,
      weight: 0.75,
    },
  ];

  let best = null;
  for (const t of techniques) {
    if (t.re.test(text)) {
      if (!best || t.weight > best.weight) best = t;
    }
  }

  // If systemPrompt is provided, detect attempts that quote or reference it.
  if (typeof systemPrompt === "string" && systemPrompt.length > 20) {
    const snippet = systemPrompt.slice(0, 60).trim();
    if (snippet && text.toLowerCase().includes(snippet.toLowerCase())) {
      return { detected: true, technique: "system_prompt_echo", confidence: 0.95 };
    }
  }

  if (!best) return { detected: false, confidence: 0 };
  return { detected: true, technique: best.id, confidence: best.weight };
}

/**
 * Classify the overall risk of a prompt. Combines jailbreak and injection
 * signals into a single 0-100 risk score with a recommendation.
 *
 * @param {string} prompt
 * @returns {{ riskScore: number, categories: string[], recommendation: "allow"|"warn"|"block", matches: any[], injection?: any }}
 */
export function classifyRisk(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { riskScore: 0, categories: [], recommendation: "allow", matches: [] };
  }

  const jb = detectJailbreak(prompt);
  const inj = detectPromptInjection(prompt);

  const cats = new Set();
  if (jb.detected && jb.category) cats.add(jb.category);
  if (inj.detected && inj.technique) cats.add(inj.technique);

  // Blend the two signals. The strongest category wins and extra signals
  // provide a small additive boost.
  let baseScore = 0;
  if (jb.detected) {
    baseScore = Math.max(baseScore, (CATEGORY_WEIGHTS[jb.category] || 60));
    baseScore += Math.min(10, Math.max(0, jb.matches.length - 1) * 2);
  }
  if (inj.detected) {
    baseScore = Math.max(baseScore, Math.round(inj.confidence * 100));
  }

  const riskScore = Math.max(0, Math.min(100, baseScore));

  let recommendation = "allow";
  if (riskScore >= 80) recommendation = "block";
  else if (riskScore >= 50) recommendation = "warn";

  return {
    riskScore,
    categories: Array.from(cats),
    recommendation,
    matches: jb.matches,
    injection: inj.detected ? inj : undefined,
  };
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

function sanitizePrompt(prompt, matches) {
  if (!Array.isArray(matches) || matches.length === 0) return prompt;
  let out = prompt;
  for (const m of matches) {
    if (typeof m.text !== "string" || m.text.length === 0) continue;
    // Replace literal match text with a redaction placeholder.
    out = out.split(m.text).join("[REDACTED]");
  }
  return out;
}

/**
 * Apply a policy to a prompt given its risk classification.
 *
 * @param {string} prompt
 * @param {{ riskScore: number, categories: string[], recommendation: string, matches?: any[] }} riskResult
 * @param {string|object} [policyName] — policy name or an inline policy object
 * @param {{ workspaceId?: string }} [context]
 * @returns {Promise<{ action: string, prompt: string, blocked: boolean, reason?: string, warning?: string, policy: object }>}
 */
export async function applyPolicy(prompt, riskResult, policyName = "default", context = {}) {
  const risk = riskResult || { riskScore: 0, categories: [], recommendation: "allow", matches: [] };
  let policy;
  if (policyName && typeof policyName === "object") {
    policy = { ...DEFAULT_POLICY, ...policyName };
  } else if (context.workspaceId) {
    policy = await getWorkspacePolicy(context.workspaceId);
  } else {
    policy = { ...DEFAULT_POLICY };
  }

  const score = Number(risk.riskScore) || 0;
  const out = {
    action: "allow",
    prompt,
    blocked: false,
    policy,
  };

  if (score >= (policy.quarantineAt ?? 90)) {
    out.action = "quarantine";
    out.blocked = true;
    out.reason = `quarantined: risk ${score} >= ${policy.quarantineAt ?? 90}`;
    return out;
  }
  if (score >= (policy.blockAt ?? 80)) {
    out.action = "block";
    out.blocked = true;
    out.reason = `blocked: risk ${score} >= ${policy.blockAt ?? 80}`;
    return out;
  }
  if (score >= (policy.warnAt ?? 50)) {
    out.action = "warn";
    out.warning =
      "Warning: the prompt contained language that looked like a jailbreak or prompt-injection attempt.";
    if (policy.sanitize) {
      out.prompt = sanitizePrompt(prompt, risk.matches || []);
      out.action = "sanitize";
    }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function policiesFile(workspaceId) {
  const ws = sanitizeId(workspaceId, "default");
  return join(getDataDir(), "safety", "policies", `${ws}.json`);
}

function detectionsFile() {
  return join(getDataDir(), "safety", "detections.json");
}

function sanitizeId(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

/**
 * Store a per-workspace policy. Only known fields are persisted.
 *
 * @param {string} workspaceId
 * @param {object} policy
 * @returns {Promise<object>}
 */
export async function setWorkspacePolicy(workspaceId, policy) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!policy || typeof policy !== "object") {
    throw new Error("policy must be an object");
  }
  const merged = {
    name: String(policy.name || "default"),
    blockAt: clampInt(policy.blockAt, 0, 100, DEFAULT_POLICY.blockAt),
    warnAt: clampInt(policy.warnAt, 0, 100, DEFAULT_POLICY.warnAt),
    quarantineAt: clampInt(policy.quarantineAt, 0, 100, DEFAULT_POLICY.quarantineAt),
    sanitize: !!policy.sanitize,
    updatedAt: Date.now(),
    workspaceId,
  };
  const file = policiesFile(workspaceId);
  await withPathLock(file, async () => {
    await writeJsonPath(file, merged);
  });
  return merged;
}

/**
 * Load the per-workspace policy, falling back to defaults.
 *
 * @param {string} workspaceId
 * @returns {Promise<object>}
 */
export async function getWorkspacePolicy(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    return { ...DEFAULT_POLICY };
  }
  const file = policiesFile(workspaceId);
  const data = await readJsonPath(file, null);
  if (data && typeof data === "object" && data.name) {
    return { ...DEFAULT_POLICY, ...data };
  }
  return { ...DEFAULT_POLICY };
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Append a detection event to the audit log.
 *
 * @param {object} event
 * @returns {Promise<object>}
 */
export async function logDetection(event) {
  if (!event || typeof event !== "object") throw new Error("event must be an object");
  const record = {
    id: event.id || randomUUID(),
    ts: Number(event.ts) || Date.now(),
    workspaceId: event.workspaceId || "default",
    userId: event.userId || "anonymous",
    riskScore: Number(event.riskScore) || 0,
    categories: Array.isArray(event.categories) ? event.categories.slice(0, 20) : [],
    action: String(event.action || "allow"),
    prompt: typeof event.prompt === "string" ? event.prompt.slice(0, 2000) : "",
    reason: event.reason ? String(event.reason).slice(0, 500) : undefined,
  };
  const file = detectionsFile();
  await withPathLock(file, async () => {
    const state = await readJsonPath(file, { entries: [] });
    if (!Array.isArray(state.entries)) state.entries = [];
    state.entries.push(record);
    // Ring-buffer so the log never grows without bound.
    if (state.entries.length > 10_000) {
      state.entries = state.entries.slice(-10_000);
    }
    await writeJsonPath(file, state);
  });
  // Phase 51.4: mirror into the unified policy audit trail. Never throws.
  try {
    await _recordPolicyDecision({
      workspaceId: record.workspaceId,
      policyId: event.policyId || "jailbreak-default",
      source: "jailbreak-detector",
      action: record.action,
      reason: record.reason,
      severity: record.riskScore,
      userId: record.userId,
      metadata: { categories: record.categories },
    });
  } catch (_) { /* audit failures must never break detection */ }
  return record;
}

/**
 * List detection events matching a filter.
 *
 * @param {{ workspaceId?: string, since?: number, until?: number, minScore?: number, action?: string, limit?: number }} [filter]
 * @returns {Promise<object[]>}
 */
export async function getDetectionHistory(filter = {}) {
  const state = await readJsonPath(detectionsFile(), { entries: [] });
  let entries = Array.isArray(state.entries) ? state.entries.slice() : [];
  if (filter.workspaceId) {
    entries = entries.filter((e) => e.workspaceId === filter.workspaceId);
  }
  if (Number.isFinite(filter.since)) {
    entries = entries.filter((e) => e.ts >= filter.since);
  }
  if (Number.isFinite(filter.until)) {
    entries = entries.filter((e) => e.ts <= filter.until);
  }
  if (Number.isFinite(filter.minScore)) {
    entries = entries.filter((e) => e.riskScore >= filter.minScore);
  }
  if (filter.action) {
    entries = entries.filter((e) => e.action === filter.action);
  }
  entries.sort((a, b) => b.ts - a.ts);
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    entries = entries.slice(0, filter.limit);
  }
  return entries;
}

/**
 * Aggregate detection stats over a time range.
 *
 * @param {{ since?: number, until?: number, workspaceId?: string }} [timeRange]
 * @returns {Promise<object>}
 */
export async function getDetectionStats(timeRange = {}) {
  const entries = await getDetectionHistory({
    since: timeRange.since,
    until: timeRange.until,
    workspaceId: timeRange.workspaceId,
  });

  const byAction = {};
  const byCategory = {};
  let totalScore = 0;
  let blocked = 0;
  for (const e of entries) {
    byAction[e.action] = (byAction[e.action] || 0) + 1;
    for (const c of e.categories || []) {
      byCategory[c] = (byCategory[c] || 0) + 1;
    }
    totalScore += e.riskScore || 0;
    if (e.action === "block" || e.action === "quarantine") blocked += 1;
  }
  const total = entries.length;
  return {
    total,
    blocked,
    avgRiskScore: total > 0 ? Math.round((totalScore / total) * 100) / 100 : 0,
    byAction,
    byCategory,
    since: timeRange.since || null,
    until: timeRange.until || null,
  };
}

// ---------------------------------------------------------------------------
// Streaming detection
// ---------------------------------------------------------------------------

/**
 * Build an incremental detector for streaming output. Call `feed(chunk)` for
 * each chunk; returns `true` the first time a jailbreak pattern is detected.
 * `reset()` clears the buffer so the detector can be reused.
 *
 * @param {{ categories?: string[] }} [options]
 * @returns {{ feed: (chunk: string) => boolean, reset: () => void, result: () => any }}
 */
export function createStreamDetector(options = {}) {
  let buf = "";
  let triggered = false;
  let lastResult = null;

  return {
    feed(chunk) {
      if (triggered) return true;
      if (typeof chunk !== "string" || chunk.length === 0) return false;
      buf += chunk;
      if (buf.length > STREAM_BUFFER) {
        // Keep the tail so patterns that span chunks can still match.
        buf = buf.slice(-STREAM_BUFFER);
      }
      const r = detectJailbreak(buf, options);
      if (r.detected) {
        triggered = true;
        lastResult = r;
        return true;
      }
      return false;
    },
    reset() {
      buf = "";
      triggered = false;
      lastResult = null;
    },
    result() {
      return lastResult;
    },
  };
}

export const _internals = {
  DEFAULT_POLICY,
  CATEGORY_WEIGHTS,
  sanitizePrompt,
  policiesFile,
  detectionsFile,
};
