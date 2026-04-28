/**
 * Per-tenant rate limits and quotas.
 * Tracks request count, token usage, storage bytes per workspace.
 * Enforces against configurable limits stored in storage under `tenant_quotas/<workspaceId>`.
 *
 * Defaults are read from env at module load:
 *   DEFAULT_REQUESTS_PER_MINUTE, DEFAULT_TOKENS_PER_DAY, DEFAULT_STORAGE_BYTES_MAX.
 *
 * Per-workspace overrides are looked up via storage.get("tenant_quotas",
 * workspaceId, workspaceId, ownerId) when a storage instance is supplied.
 */

const TENANT_QUOTAS_TYPE = "tenant_quotas";

// In-memory counters (rolling windows). Persisted snapshots optional via storage.
const requestCounts = new Map(); // workspaceId -> { count, windowStart }
const tokenCounts = new Map(); // workspaceId -> { count, dayStart }
const storageBytes = new Map(); // workspaceId -> bytes

function readDefaults() {
  return {
    requestsPerMinute: parseInt(process.env.DEFAULT_REQUESTS_PER_MINUTE || "60", 10),
    tokensPerDay: parseInt(process.env.DEFAULT_TOKENS_PER_DAY || "1000000", 10),
    storageBytesMax: parseInt(
      process.env.DEFAULT_STORAGE_BYTES_MAX || String(1024 * 1024 * 1024),
      10
    ),
  };
}

/**
 * Look up per-workspace quota override (if any), merged with env defaults.
 * Falls back to defaults when storage is missing, throws, or has no entry.
 */
async function getQuotasForWorkspace(workspaceId, storage) {
  const defaults = readDefaults();
  if (!storage || typeof storage.get !== "function") return defaults;
  try {
    const item = await storage.get(TENANT_QUOTAS_TYPE, workspaceId, workspaceId);
    if (item && typeof item === "object") {
      const override = {};
      if (Number.isFinite(Number(item.requestsPerMinute)) && Number(item.requestsPerMinute) > 0) {
        override.requestsPerMinute = Math.floor(Number(item.requestsPerMinute));
      }
      if (Number.isFinite(Number(item.tokensPerDay)) && Number(item.tokensPerDay) > 0) {
        override.tokensPerDay = Math.floor(Number(item.tokensPerDay));
      }
      if (Number.isFinite(Number(item.storageBytesMax)) && Number(item.storageBytesMax) > 0) {
        override.storageBytesMax = Math.floor(Number(item.storageBytesMax));
      }
      return { ...defaults, ...override };
    }
  } catch {
    // Storage failure -> use defaults (fail open)
  }
  return defaults;
}

/**
 * Check if a request from workspaceId is allowed under current quotas.
 * Returns { allowed, reason?, retryAfter?, currentUsage, limits }.
 */
export async function checkQuota(workspaceId, { storage } = {}) {
  const ws = String(workspaceId || "default");
  const limits = await getQuotasForWorkspace(ws, storage);
  const now = Date.now();

  // Request count window (1 minute)
  let req = requestCounts.get(ws);
  if (!req || now - req.windowStart >= 60_000) {
    req = { count: 0, windowStart: now };
    requestCounts.set(ws, req);
  }

  if (req.count >= limits.requestsPerMinute) {
    return {
      allowed: false,
      reason: "requests_per_minute_exceeded",
      retryAfter: Math.max(1, Math.ceil((60_000 - (now - req.windowStart)) / 1000)),
      currentUsage: { requestsThisMinute: req.count },
      limits,
    };
  }

  // Token usage (daily window)
  let tok = tokenCounts.get(ws);
  if (!tok || now - tok.dayStart >= 24 * 60 * 60 * 1000) {
    tok = { count: 0, dayStart: now };
    tokenCounts.set(ws, tok);
  }

  if (tok.count >= limits.tokensPerDay) {
    return {
      allowed: false,
      reason: "tokens_per_day_exceeded",
      retryAfter: Math.max(1, Math.ceil((24 * 60 * 60 * 1000 - (now - tok.dayStart)) / 1000)),
      currentUsage: { tokensToday: tok.count },
      limits,
    };
  }

  return {
    allowed: true,
    currentUsage: {
      requestsThisMinute: req.count,
      tokensToday: tok.count,
      storageBytes: storageBytes.get(ws) || 0,
    },
    limits,
  };
}

/**
 * Record a request — increments the rolling per-minute counter.
 */
export function recordRequest(workspaceId) {
  const ws = String(workspaceId || "default");
  const now = Date.now();
  let req = requestCounts.get(ws);
  if (!req || now - req.windowStart >= 60_000) {
    req = { count: 0, windowStart: now };
    requestCounts.set(ws, req);
  }
  req.count += 1;
}

/**
 * Record token usage from a completed LLM call.
 */
export function recordTokens(workspaceId, tokens) {
  const ws = String(workspaceId || "default");
  const n = Number(tokens) || 0;
  if (n <= 0) return;
  const now = Date.now();
  let tok = tokenCounts.get(ws);
  if (!tok || now - tok.dayStart >= 24 * 60 * 60 * 1000) {
    tok = { count: 0, dayStart: now };
    tokenCounts.set(ws, tok);
  }
  tok.count += n;
}

/**
 * Update the in-memory storage-bytes counter for a workspace.
 */
export function recordStorageBytes(workspaceId, bytes) {
  const ws = String(workspaceId || "default");
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return;
  storageBytes.set(ws, Math.floor(n));
}

/**
 * Read the live usage snapshot for a workspace (admin endpoint).
 */
export function getUsageSnapshot(workspaceId) {
  const ws = String(workspaceId || "default");
  return {
    requestsThisMinute: requestCounts.get(ws)?.count || 0,
    tokensToday: tokenCounts.get(ws)?.count || 0,
    storageBytes: storageBytes.get(ws) || 0,
  };
}

/**
 * Read effective quotas for a workspace (defaults + override).
 */
export async function getEffectiveQuotas(workspaceId, storage) {
  return getQuotasForWorkspace(String(workspaceId || "default"), storage);
}

/**
 * Persist a per-workspace override.
 * @param {string} workspaceId
 * @param {object} patch — partial { requestsPerMinute, tokensPerDay, storageBytesMax }
 * @param {object} storage — the namespace import from lib/storage.js
 */
export async function setQuotaOverride(workspaceId, patch, storage) {
  const ws = String(workspaceId || "").trim();
  if (!ws) return { ok: false, error: "workspaceId required" };
  if (!storage || typeof storage.add !== "function") {
    return { ok: false, error: "storage unavailable" };
  }
  const allowed = ["requestsPerMinute", "tokensPerDay", "storageBytesMax"];
  const item = { id: ws, workspaceId: ws, updatedAt: new Date().toISOString() };
  for (const key of allowed) {
    if (patch && patch[key] != null) {
      const num = Number(patch[key]);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: `${key} must be a positive number` };
      }
      item[key] = Math.floor(num);
    }
  }
  await storage.add(TENANT_QUOTAS_TYPE, item, ws, true, ws);
  return { ok: true, override: item };
}

/**
 * Remove a per-workspace override; workspace falls back to env defaults.
 */
export async function deleteQuotaOverride(workspaceId, storage) {
  const ws = String(workspaceId || "").trim();
  if (!ws) return { ok: false, error: "workspaceId required" };
  if (!storage || typeof storage.remove !== "function") {
    return { ok: false, error: "storage unavailable" };
  }
  try {
    await storage.remove(TENANT_QUOTAS_TYPE, ws, ws, ws);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "delete failed" };
  }
}

/**
 * List all workspaces that have a stored quota override.
 */
export async function listQuotaOverrides(storage) {
  if (!storage || typeof storage.list !== "function" || typeof storage.listWorkspaces !== "function") {
    return [];
  }
  const out = [];
  try {
    const workspaces = await storage.listWorkspaces();
    for (const entry of workspaces || []) {
      const wsId = entry?.workspace?.id || entry?.id || null;
      if (!wsId) continue;
      try {
        const items = await storage.list(TENANT_QUOTAS_TYPE, wsId, wsId);
        for (const item of items || []) {
          out.push({
            workspaceId: item.workspaceId || wsId,
            requestsPerMinute: item.requestsPerMinute,
            tokensPerDay: item.tokensPerDay,
            storageBytesMax: item.storageBytesMax,
            updatedAt: item.updatedAt,
          });
        }
      } catch {
        // skip workspaces with no quota collection
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** For testing: reset all in-memory state. */
export function __resetForTests() {
  requestCounts.clear();
  tokenCounts.clear();
  storageBytes.clear();
}
