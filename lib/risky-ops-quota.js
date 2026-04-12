/**
 * Phase 51.5: Rate-limit tiers for risky operations.
 *
 * Per-category throttles applied on top of the global rate limiter. Each
 * agent tool (or arbitrary operation) is tagged with a `tier` from
 * RISKY_TIERS and enforced against a sliding window.
 *
 *   safe        — unbounded (or very large) default window
 *   costly      — moderate bound (e.g. LLM calls, embeddings)
 *   risky       — tight per-minute bound
 *   destructive — tight per-hour bound
 *
 * Tunable via env:
 *   QUOTA_TIER_SAFE_PER_MIN
 *   QUOTA_TIER_COSTLY_PER_MIN
 *   QUOTA_TIER_RISKY_PER_MIN
 *   QUOTA_TIER_DESTRUCTIVE_PER_HOUR
 *
 * Storage is in-memory (sliding-window counters) because quotas live on the
 * hot path and resetting at process restart is acceptable; for durable quotas
 * back this with Redis.
 */

export const RISKY_TIERS = Object.freeze(["safe", "costly", "risky", "destructive"]);

/**
 * Canonical tier assignment for known agent tools and operations. Callers may
 * extend this at runtime via `tagOperation`.
 */
const OPERATION_TIERS = new Map([
  // Safe read-only utilities
  ["search_context", "safe"],
  ["list_context", "safe"],
  ["get_context_document", "safe"],
  ["semantic_search_context", "safe"],
  ["list_recipes", "safe"],
  ["get_recipe", "safe"],
  ["list_workspace_memory", "safe"],
  ["search_knowledge_graph", "safe"],
  // Costly tools (external APIs or LLM usage)
  ["web_search", "costly"],
  ["fetch_allowed_url", "costly"],
  ["chain_tools", "costly"],
  ["create_document", "costly"],
  ["remember_workspace_fact", "costly"],
  // Risky tools (mutate state or touch user-visible systems)
  ["schedule_task", "risky"],
  ["send_notification", "risky"],
  ["update_agent_session_plan", "risky"],
  ["browser_agent_tools", "risky"],
  ["workspace_read_file", "risky"],
  ["execute_step", "risky"],
  // Destructive operations (can delete or modify production data)
  ["code_execute", "destructive"],
  ["query_database", "destructive"],
]);

/**
 * Declarative export — callers wiring a tool-exec loop can read this map
 * directly to attach tier info to tool descriptors.
 */
export const TOOL_TIERS = Object.freeze(Object.fromEntries(OPERATION_TIERS));

function tierLimits() {
  const env = process.env;
  return {
    safe: {
      windowMs: 60_000,
      max: Number(env.QUOTA_TIER_SAFE_PER_MIN) || 600,
    },
    costly: {
      windowMs: 60_000,
      max: Number(env.QUOTA_TIER_COSTLY_PER_MIN) || 60,
    },
    risky: {
      windowMs: 60_000,
      max: Number(env.QUOTA_TIER_RISKY_PER_MIN) || 10,
    },
    destructive: {
      windowMs: 60 * 60_000,
      max: Number(env.QUOTA_TIER_DESTRUCTIVE_PER_HOUR) || 5,
    },
  };
}

// counterKey -> array of timestamps within the current window.
const counters = new Map();

function counterKey(tier, subjectKey) {
  return `${tier}::${subjectKey || "__anon__"}`;
}

function prune(arr, windowMs, now) {
  const cutoff = now - windowMs;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

/**
 * @param {string} operation — agent tool name or arbitrary op id
 * @returns {string} tier
 */
export function getOperationTier(operation) {
  if (!operation) return "safe";
  return OPERATION_TIERS.get(operation) || "safe";
}

/**
 * Tag (or re-tag) an operation at runtime.
 */
export function tagOperation(operation, tier) {
  if (!operation || typeof operation !== "string") {
    throw new Error("operation is required");
  }
  if (!RISKY_TIERS.includes(tier)) {
    throw new Error(`tier must be one of ${RISKY_TIERS.join(", ")}`);
  }
  OPERATION_TIERS.set(operation, tier);
}

/**
 * Check whether an operation is currently allowed for the subject. Does not
 * mutate state — use consume() to actually reserve a slot.
 *
 * @returns {{ allowed: boolean, tier: string, remaining: number, resetMs: number, limit: number }}
 */
export function checkQuota(operation, subjectKey, nowMs = Date.now()) {
  const tier = getOperationTier(operation);
  const cfg = tierLimits()[tier];
  const key = counterKey(tier, subjectKey);
  const arr = counters.get(key) || [];
  prune(arr, cfg.windowMs, nowMs);
  const used = arr.length;
  const remaining = Math.max(0, cfg.max - used);
  const resetMs = arr.length > 0 ? Math.max(0, arr[0] + cfg.windowMs - nowMs) : 0;
  return {
    allowed: used < cfg.max,
    tier,
    remaining,
    resetMs,
    limit: cfg.max,
    windowMs: cfg.windowMs,
  };
}

/**
 * Reserve a slot for the operation. Returns the updated quota snapshot.
 * If not allowed, the snapshot's `allowed` field is false and no slot is
 * consumed.
 */
export function consumeQuota(operation, subjectKey, nowMs = Date.now()) {
  const tier = getOperationTier(operation);
  const cfg = tierLimits()[tier];
  const key = counterKey(tier, subjectKey);
  const arr = counters.get(key) || [];
  prune(arr, cfg.windowMs, nowMs);
  if (arr.length >= cfg.max) {
    const resetMs = arr.length > 0 ? Math.max(0, arr[0] + cfg.windowMs - nowMs) : 0;
    return {
      allowed: false,
      tier,
      remaining: 0,
      resetMs,
      limit: cfg.max,
      windowMs: cfg.windowMs,
    };
  }
  arr.push(nowMs);
  counters.set(key, arr);
  return {
    allowed: true,
    tier,
    remaining: Math.max(0, cfg.max - arr.length),
    resetMs: Math.max(0, arr[0] + cfg.windowMs - nowMs),
    limit: cfg.max,
    windowMs: cfg.windowMs,
  };
}

/**
 * Express-style middleware factory. Extracts the operation from `req.body.tool`
 * or `req.params.operation`, and the subject from the api-key user id if
 * present. Sets X-RateLimit headers and returns 429 when exceeded.
 */
export function riskyOpsMiddleware(opts = {}) {
  const extract = typeof opts.extractOperation === "function"
    ? opts.extractOperation
    : (req) => req.body?.tool || req.body?.operation || req.params?.operation;
  const subjectFn = typeof opts.extractSubject === "function"
    ? opts.extractSubject
    : (req) => req.userId || req.apiUserId || req.headers?.["x-user-id"] || req.ip;
  return function riskyOps(req, res, next) {
    const operation = extract(req);
    if (!operation) return next();
    const subject = subjectFn(req);
    const q = consumeQuota(String(operation), String(subject || "anon"));
    res.setHeader("X-RiskTier", q.tier);
    res.setHeader("X-RateLimit-Limit", String(q.limit));
    res.setHeader("X-RateLimit-Remaining", String(q.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(q.resetMs / 1000)));
    if (!q.allowed) {
      return res.status(429).json({
        error: `Rate limit exceeded for ${q.tier} tier`,
        code: "RATE_LIMITED",
        tier: q.tier,
        limit: q.limit,
        windowMs: q.windowMs,
        hint: `Operations tagged '${q.tier}' are capped at ${q.limit} per ${q.windowMs}ms. Wait ${Math.ceil(q.resetMs / 1000)}s.`,
      });
    }
    return next();
  };
}

/**
 * Enumerate quota usage snapshots for observability.
 */
export function listCounters() {
  const now = Date.now();
  const snapshot = [];
  for (const [key, arr] of counters.entries()) {
    const [tier, subject] = key.split("::");
    const cfg = tierLimits()[tier];
    prune(arr, cfg.windowMs, now);
    snapshot.push({
      tier,
      subject,
      used: arr.length,
      limit: cfg.max,
      windowMs: cfg.windowMs,
    });
  }
  return snapshot;
}

/**
 * Reset all counters (test helper).
 */
export function _reset() {
  counters.clear();
}

export const _internals = { counters, tierLimits };
