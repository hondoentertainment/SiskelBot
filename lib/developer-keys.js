/**
 * Phase 34.4: Developer API keys with free tier quotas and self-service signup.
 *
 * Provides a self-service developer registration flow, tiered quotas
 * (free/pro/enterprise), per-key usage tracking, monthly request limits,
 * and per-minute rate limits.
 *
 * Data is persisted to data/developer-keys.json (via json-path-store) and is
 * keyed by developerId. Raw API keys are never stored — only their SHA-256
 * hashes. Keys are issued once at creation time and cannot be retrieved again.
 */

import { join } from "path";
import { createHash, randomBytes as nodeRandomBytes } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { isEmailConfigured, sendEmail } from "./email-notifications.js";

export const DEVELOPER_TIERS = {
  free: {
    name: "Free Developer",
    monthlyRequests: 10_000,
    rateLimitPerMinute: 60,
    maxKeysPerDeveloper: 3,
    scopes: ["read"],
    features: ["chat", "knowledge_search", "recipes_read"],
  },
  pro: {
    name: "Pro Developer",
    monthlyRequests: 1_000_000,
    rateLimitPerMinute: 300,
    maxKeysPerDeveloper: 10,
    scopes: ["read", "write"],
    features: ["chat", "knowledge", "recipes", "agent", "workflows"],
  },
  enterprise: {
    name: "Enterprise Developer",
    monthlyRequests: Infinity,
    rateLimitPerMinute: 1000,
    maxKeysPerDeveloper: Infinity,
    scopes: ["read", "write", "admin"],
    features: ["*"],
  },
};

function storePath() {
  return join(getDataDir(), "developer-keys.json");
}

function emptyStore() {
  return { developers: {}, _version: 1 };
}

async function readStore() {
  const data = await readJsonPath(storePath(), emptyStore());
  if (!data || typeof data !== "object" || !data.developers) return emptyStore();
  return data;
}

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

function maskKey(key) {
  if (!key || key.length < 12) return "****";
  return key.slice(0, 6) + "****" + key.slice(-4);
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${nodeRandomBytes(6).toString("hex")}`;
}

function currentMonthKey(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function nextMonthResetAt(date = new Date()) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0);
}

function validTier(tier) {
  return Object.prototype.hasOwnProperty.call(DEVELOPER_TIERS, tier);
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Reset the in-memory store (for tests). Removes the underlying file too.
 */
export async function _resetDeveloperKeysForTesting() {
  await writeJsonPath(storePath(), emptyStore());
}

/**
 * Register a new developer. Sends a verification email if SMTP is configured;
 * otherwise returns the verification token in the response for manual testing.
 *
 * @param {string} email
 * @param {string} name
 * @returns {Promise<{ ok: boolean, developerId?: string, verified?: boolean, verificationToken?: string, error?: string }>}
 */
export async function registerDeveloper(email, name) {
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!isValidEmail(cleanEmail)) {
    return { ok: false, error: "Valid email required" };
  }
  if (!cleanName) {
    return { ok: false, error: "Name required" };
  }

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    // Dedupe by email
    for (const dev of Object.values(data.developers)) {
      if (dev.email === cleanEmail) {
        return { ok: false, error: "Developer with this email already exists" };
      }
    }

    const developerId = randomId("dev");
    const verificationToken = nodeRandomBytes(24).toString("hex");

    data.developers[developerId] = {
      id: developerId,
      email: cleanEmail,
      name: cleanName,
      tier: "free",
      verified: false,
      verificationToken,
      createdAt: new Date().toISOString(),
      keys: [],
      usage: {}, // keyed by "YYYY-MM": { total: number, byKey: { keyId: number } }
    };
    await writeJsonPath(path, data);

    // Best-effort email delivery. Never block signup on email failure.
    if (isEmailConfigured()) {
      try {
        await sendEmail(
          cleanEmail,
          "Verify your SiskelBot developer account",
          `Hi ${cleanName},\n\n` +
            `Thanks for signing up for the SiskelBot developer program.\n\n` +
            `Your developer ID: ${developerId}\n` +
            `Verification token: ${verificationToken}\n\n` +
            `POST /api/v1/developer/verify with { "developerId": "${developerId}", "token": "${verificationToken}" } to activate.\n`,
        );
      } catch (err) {
        console.warn("[developer-keys] verification email failed:", err?.message);
      }
    }

    return {
      ok: true,
      developerId,
      verified: false,
      // Always return token when SMTP is not configured so local dev still works.
      verificationToken: isEmailConfigured() ? undefined : verificationToken,
    };
  });
}

/**
 * Verify a developer account with the token emailed at signup.
 */
export async function verifyDeveloper(developerId, token) {
  if (!developerId || !token) {
    return { ok: false, error: "developerId and token required" };
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    const dev = data.developers[developerId];
    if (!dev) return { ok: false, error: "Developer not found" };
    if (dev.verified) return { ok: true, alreadyVerified: true };
    if (dev.verificationToken !== token) {
      return { ok: false, error: "Invalid verification token" };
    }
    dev.verified = true;
    dev.verificationToken = null;
    dev.verifiedAt = new Date().toISOString();
    await writeJsonPath(path, data);
    return { ok: true, verified: true };
  });
}

/**
 * Look up a developer by id (without raw keys).
 */
export async function getDeveloper(developerId) {
  const data = await readStore();
  const dev = data.developers[developerId];
  if (!dev) return null;
  return {
    id: dev.id,
    email: dev.email,
    name: dev.name,
    tier: dev.tier,
    verified: Boolean(dev.verified),
    createdAt: dev.createdAt,
    keyCount: (dev.keys || []).length,
  };
}

/**
 * Create a new developer API key. Only active (non-revoked) keys count toward
 * the tier's maxKeysPerDeveloper limit. The raw key is returned exactly once.
 *
 * @param {string} developerId
 * @param {string} label
 * @param {string} [tier] — optional override (defaults to developer's current tier)
 */
export async function createDeveloperKey(developerId, label, tier) {
  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (!cleanLabel) return { ok: false, error: "Label required" };

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    const dev = data.developers[developerId];
    if (!dev) return { ok: false, error: "Developer not found" };
    if (!dev.verified) return { ok: false, error: "Developer not verified" };

    const effectiveTier = tier && validTier(tier) ? tier : dev.tier;
    const tierConfig = DEVELOPER_TIERS[effectiveTier];
    if (!tierConfig) return { ok: false, error: "Invalid tier" };

    const active = (dev.keys || []).filter((k) => !k.revokedAt);
    if (active.length >= tierConfig.maxKeysPerDeveloper) {
      return {
        ok: false,
        error: `Key limit reached for tier "${effectiveTier}" (max ${tierConfig.maxKeysPerDeveloper})`,
      };
    }

    const rawKey = "skdev-" + nodeRandomBytes(24).toString("hex");
    const keyId = randomId("dkey");
    const entry = {
      keyId,
      label: cleanLabel,
      keyHash: hashKey(rawKey),
      masked: maskKey(rawKey),
      tier: effectiveTier,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    dev.keys = dev.keys || [];
    dev.keys.push(entry);
    await writeJsonPath(path, data);

    return {
      ok: true,
      keyId,
      key: rawKey,
      label: cleanLabel,
      tier: effectiveTier,
      masked: entry.masked,
      createdAt: entry.createdAt,
    };
  });
}

/**
 * List a developer's API keys (masked, no raw keys or hashes).
 */
export async function listDeveloperKeys(developerId) {
  const data = await readStore();
  const dev = data.developers[developerId];
  if (!dev) return { ok: false, error: "Developer not found" };
  const keys = (dev.keys || []).map((k) => ({
    keyId: k.keyId,
    label: k.label,
    masked: k.masked,
    tier: k.tier,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt || null,
  }));
  return { ok: true, keys };
}

/**
 * Revoke a developer API key. Revoked keys are retained for audit but cannot
 * be used for further requests.
 */
export async function revokeDeveloperKey(developerId, keyId) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    const dev = data.developers[developerId];
    if (!dev) return { ok: false, error: "Developer not found" };
    const key = (dev.keys || []).find((k) => k.keyId === keyId);
    if (!key) return { ok: false, error: "Key not found" };
    if (key.revokedAt) return { ok: true, alreadyRevoked: true };
    key.revokedAt = new Date().toISOString();
    await writeJsonPath(path, data);
    return { ok: true };
  });
}

/**
 * Return usage for the current (or requested) month and per-key breakdown.
 *
 * @param {string} developerId
 * @param {string} [period] — "YYYY-MM"; defaults to current UTC month
 */
export async function getDeveloperUsage(developerId, period) {
  const data = await readStore();
  const dev = data.developers[developerId];
  if (!dev) return { ok: false, error: "Developer not found" };
  const monthKey = period || currentMonthKey();
  const monthData = (dev.usage || {})[monthKey] || { total: 0, byKey: {} };
  const tierConfig = DEVELOPER_TIERS[dev.tier] || DEVELOPER_TIERS.free;
  const limit = tierConfig.monthlyRequests;
  const remaining = limit === Infinity ? Infinity : Math.max(0, limit - monthData.total);
  return {
    ok: true,
    tier: dev.tier,
    period: monthKey,
    currentMonth: {
      requests: monthData.total,
      limit,
      remaining,
      resetAt: nextMonthResetAt(),
    },
    byKey: monthData.byKey,
  };
}

/**
 * Upgrade (or downgrade) a developer's tier.
 */
export async function upgradeDeveloperTier(developerId, newTier) {
  if (!validTier(newTier)) {
    return { ok: false, error: `Invalid tier "${newTier}"` };
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    const dev = data.developers[developerId];
    if (!dev) return { ok: false, error: "Developer not found" };
    const previousTier = dev.tier;
    dev.tier = newTier;
    dev.tierChangedAt = new Date().toISOString();
    await writeJsonPath(path, data);
    return { ok: true, previousTier, tier: newTier };
  });
}

/**
 * Look up a developer/key by raw API key. Returns the scopes and tier info
 * for auth integration. Never returns raw material back to the caller.
 */
export async function findDeveloperByRawKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || !rawKey.startsWith("skdev-")) return null;
  const keyHash = hashKey(rawKey);
  const data = await readStore();
  for (const dev of Object.values(data.developers)) {
    for (const key of dev.keys || []) {
      if (key.keyHash === keyHash && !key.revokedAt) {
        const tierConfig = DEVELOPER_TIERS[key.tier] || DEVELOPER_TIERS[dev.tier] || DEVELOPER_TIERS.free;
        return {
          developerId: dev.id,
          keyId: key.keyId,
          label: key.label,
          tier: key.tier || dev.tier,
          scopes: tierConfig.scopes,
          features: tierConfig.features,
        };
      }
    }
  }
  return null;
}

// In-process minute window counter for rate limiting.
const _minuteBuckets = new Map(); // keyId -> { windowStart: number, count: number }

function getMinuteBucket(keyId, now = Date.now()) {
  const windowStart = Math.floor(now / 60_000) * 60_000;
  const existing = _minuteBuckets.get(keyId);
  if (!existing || existing.windowStart !== windowStart) {
    const bucket = { windowStart, count: 0 };
    _minuteBuckets.set(keyId, bucket);
    return bucket;
  }
  return existing;
}

export function _resetDeveloperRateBucketsForTesting() {
  _minuteBuckets.clear();
}

/**
 * Check whether a developer key is within its monthly quota and per-minute
 * rate limit. Does NOT increment counters — call recordDeveloperRequest() on
 * a successful request to increment usage.
 */
export async function checkDeveloperLimits(keyId) {
  const data = await readStore();
  let owner = null;
  let keyEntry = null;
  for (const dev of Object.values(data.developers)) {
    for (const key of dev.keys || []) {
      if (key.keyId === keyId) {
        owner = dev;
        keyEntry = key;
        break;
      }
    }
    if (owner) break;
  }
  if (!owner || !keyEntry) {
    return { allowed: false, reason: "Key not found", remaining: 0, resetAt: 0, tier: null };
  }
  if (keyEntry.revokedAt) {
    return { allowed: false, reason: "Key revoked", remaining: 0, resetAt: 0, tier: keyEntry.tier };
  }

  const tier = keyEntry.tier || owner.tier;
  const tierConfig = DEVELOPER_TIERS[tier] || DEVELOPER_TIERS.free;
  const monthKey = currentMonthKey();
  const monthData = (owner.usage || {})[monthKey] || { total: 0, byKey: {} };

  const monthlyLimit = tierConfig.monthlyRequests;
  const monthlyRemaining = monthlyLimit === Infinity ? Infinity : Math.max(0, monthlyLimit - monthData.total);
  if (monthlyLimit !== Infinity && monthData.total >= monthlyLimit) {
    return {
      allowed: false,
      reason: "Monthly quota exceeded",
      remaining: 0,
      resetAt: nextMonthResetAt(),
      tier,
    };
  }

  const bucket = getMinuteBucket(keyId);
  if (bucket.count >= tierConfig.rateLimitPerMinute) {
    return {
      allowed: false,
      reason: "Rate limit exceeded",
      remaining: monthlyRemaining,
      resetAt: bucket.windowStart + 60_000,
      tier,
    };
  }

  return {
    allowed: true,
    remaining: monthlyRemaining,
    resetAt: nextMonthResetAt(),
    tier,
  };
}

/**
 * Increment usage counters (monthly + minute) for a developer key. Safe to
 * call after the request has completed; storage writes are serialized per
 * file.
 */
export async function recordDeveloperRequest(keyId) {
  if (!keyId) return { ok: false, error: "keyId required" };
  // Always advance the in-process minute bucket even if we bail on disk write.
  const bucket = getMinuteBucket(keyId);
  bucket.count += 1;

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await readStore();
    let owner = null;
    for (const dev of Object.values(data.developers)) {
      if ((dev.keys || []).some((k) => k.keyId === keyId)) {
        owner = dev;
        break;
      }
    }
    if (!owner) return { ok: false, error: "Key not found" };

    const monthKey = currentMonthKey();
    owner.usage = owner.usage || {};
    const monthData = owner.usage[monthKey] || { total: 0, byKey: {} };
    monthData.total += 1;
    monthData.byKey[keyId] = (monthData.byKey[keyId] || 0) + 1;
    owner.usage[monthKey] = monthData;

    await writeJsonPath(path, data);
    return { ok: true, monthTotal: monthData.total };
  });
}
