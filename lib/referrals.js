/**
 * Phase 34.5: Referral tracking and reward distribution.
 *
 * Stores referral codes, signups, and conversion events per workspace.
 * Uses json-path-store so it automatically respects the configured storage backend
 * (JSON files, SQLite KV, or PostgreSQL KV).
 *
 * Storage layout:
 *   data/referrals/codes.json     — { codes: { [code]: codeRecord } }
 *   data/referrals/signups.json   — { signups: [signupRecord] }
 *   data/referrals/conversions.json — { conversions: [conversionRecord] }
 *
 * Reward rules (calculateRewards):
 *   - signup:        $5 credit for referrer, $5 for referee
 *   - plan_upgrade:  20% of first month value for referrer
 *
 * @module referrals
 */
import { randomBytes } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const CODE_LENGTH = 8;
const MAX_CODES_PER_USER = 25;
const MAX_SIGNUPS = 100_000;
const MAX_CONVERSIONS = 200_000;

const SIGNUP_CREDIT = 5; // dollars credited to referrer on signup
const REFEREE_CREDIT = 5; // dollars credited to referee on signup
const UPGRADE_REWARD_RATE = 0.2; // 20% of first month upgrade value

const VALID_EVENTS = new Set(["signup", "first_chat", "plan_upgrade", "recipe_published"]);

// ─── paths ───────────────────────────────────────────────────────────────────

function codesPath() {
  return join(getDataDir(), "referrals", "codes.json");
}

function signupsPath() {
  return join(getDataDir(), "referrals", "signups.json");
}

function conversionsPath() {
  return join(getDataDir(), "referrals", "conversions.json");
}

// ─── loaders ─────────────────────────────────────────────────────────────────

async function loadCodes() {
  const data = await readJsonPath(codesPath(), { _version: 1, codes: {} });
  return data && typeof data.codes === "object" && data.codes !== null ? data.codes : {};
}

async function saveCodes(codes) {
  await writeJsonPath(codesPath(), { _version: 1, codes });
}

async function loadSignups() {
  const data = await readJsonPath(signupsPath(), { _version: 1, signups: [] });
  return Array.isArray(data.signups) ? data.signups : [];
}

async function saveSignups(signups) {
  const trimmed = signups.length > MAX_SIGNUPS ? signups.slice(-MAX_SIGNUPS) : signups;
  await writeJsonPath(signupsPath(), { _version: 1, signups: trimmed });
}

async function loadConversions() {
  const data = await readJsonPath(conversionsPath(), { _version: 1, conversions: [] });
  return Array.isArray(data.conversions) ? data.conversions : [];
}

async function saveConversions(conversions) {
  const trimmed =
    conversions.length > MAX_CONVERSIONS ? conversions.slice(-MAX_CONVERSIONS) : conversions;
  await writeJsonPath(conversionsPath(), { _version: 1, conversions: trimmed });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function generateCode() {
  // URL-safe alphanumeric, uppercase for readability.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function getBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/+$/, "");
}

function buildUrl(code) {
  return `${getBaseUrl()}/r/${encodeURIComponent(code)}`;
}

function parsePeriodCutoff(period) {
  if (!period || period === "all") return 0;
  const m = String(period).match(/^(\d+)([dhm])$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  let ms;
  if (unit === "d") ms = n * 24 * 3_600_000;
  else if (unit === "h") ms = n * 3_600_000;
  else if (unit === "m") ms = n * 60_000;
  else return 0;
  return Date.now() - ms;
}

function isCodeActive(record) {
  if (!record) return false;
  if (record.deactivated) return false;
  if (record.expiresAt) {
    const exp = new Date(record.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) return false;
  }
  if (typeof record.maxUses === "number" && record.maxUses > 0) {
    if ((record.uses || 0) >= record.maxUses) return false;
  }
  return true;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Create a new referral code for a user.
 * @param {string} userId
 * @param {{ name?: string, expiresAt?: string|number, maxUses?: number }} [metadata]
 * @returns {Promise<{ code: string, url: string, createdAt: string, name: string|null, expiresAt: string|null, maxUses: number|null }>}
 */
export async function createReferralCode(userId, metadata = {}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  const path = codesPath();
  let created;
  await withPathLock(path, async () => {
    const codes = await loadCodes();
    const ownedCount = Object.values(codes).filter((c) => c.userId === userId).length;
    if (ownedCount >= MAX_CODES_PER_USER) {
      throw new Error(`Maximum referral codes per user (${MAX_CODES_PER_USER}) reached`);
    }
    let code;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      if (attempts > 50) throw new Error("Failed to generate unique referral code");
    } while (codes[code]);

    const now = new Date().toISOString();
    let expiresAt = null;
    if (metadata.expiresAt) {
      const t = new Date(metadata.expiresAt).getTime();
      if (Number.isFinite(t)) expiresAt = new Date(t).toISOString();
    }
    let maxUses = null;
    if (typeof metadata.maxUses === "number" && metadata.maxUses > 0) {
      maxUses = Math.floor(metadata.maxUses);
    }

    const record = {
      code,
      userId,
      name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 200) : null,
      createdAt: now,
      expiresAt,
      maxUses,
      uses: 0,
      deactivated: false,
    };
    codes[code] = record;
    await saveCodes(codes);
    created = { ...record, url: buildUrl(code) };
  });
  return created;
}

/**
 * List all referral codes belonging to a user.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function listUserReferralCodes(userId) {
  if (!userId) return [];
  const codes = await loadCodes();
  return Object.values(codes)
    .filter((c) => c.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((c) => ({ ...c, url: buildUrl(c.code), active: isCodeActive(c) }));
}

/**
 * Look up a referral code by its public code string.
 * @param {string} code
 * @returns {Promise<object|null>}
 */
export async function getReferralCode(code) {
  if (!code || typeof code !== "string") return null;
  const codes = await loadCodes();
  const record = codes[code];
  if (!record) return null;
  return { ...record, url: buildUrl(record.code), active: isCodeActive(record) };
}

/**
 * Deactivate a referral code. Only the owner can deactivate.
 * @param {string} code
 * @param {string} userId
 * @returns {Promise<{ code: string, deactivated: boolean }>}
 */
export async function deactivateReferralCode(code, userId) {
  if (!code || typeof code !== "string") throw new Error("code is required");
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const path = codesPath();
  let result;
  await withPathLock(path, async () => {
    const codes = await loadCodes();
    const record = codes[code];
    if (!record) throw new Error("Referral code not found");
    if (record.userId !== userId) throw new Error("Not authorized to deactivate this code");
    record.deactivated = true;
    record.deactivatedAt = new Date().toISOString();
    codes[code] = record;
    await saveCodes(codes);
    result = { code, deactivated: true };
  });
  return result;
}

/**
 * Record that a new user signed up via a referral code.
 * Increments the code's usage and credits the referrer.
 * @param {string} code
 * @param {string} newUserId
 * @returns {Promise<{ referralId: string, referrerId: string, refereeId: string, createdAt: string }>}
 */
export async function recordReferralSignup(code, newUserId) {
  if (!code || typeof code !== "string") throw new Error("code is required");
  if (!newUserId || typeof newUserId !== "string") throw new Error("newUserId is required");

  // Step 1: validate + bump code uses (within code lock).
  let referrerId;
  await withPathLock(codesPath(), async () => {
    const codes = await loadCodes();
    const record = codes[code];
    if (!record) throw new Error("Referral code not found");
    if (!isCodeActive(record)) throw new Error("Referral code is not active");
    if (record.userId === newUserId) throw new Error("Cannot self-refer");
    record.uses = (record.uses || 0) + 1;
    referrerId = record.userId;
    codes[code] = record;
    await saveCodes(codes);
  });

  // Step 2: append signup record (within signups lock).
  const referralId = `ref_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const createdAt = new Date().toISOString();
  await withPathLock(signupsPath(), async () => {
    const signups = await loadSignups();
    // De-dupe: a single newUserId should only appear once for the same code.
    const exists = signups.find((s) => s.refereeId === newUserId && s.code === code);
    if (exists) {
      // Roll back the uses bump if duplicate.
      await withPathLock(codesPath(), async () => {
        const codes = await loadCodes();
        if (codes[code]) {
          codes[code].uses = Math.max(0, (codes[code].uses || 1) - 1);
          await saveCodes(codes);
        }
      });
      throw new Error("Signup already recorded for this user/code");
    }
    signups.push({
      referralId,
      code,
      referrerId,
      refereeId: newUserId,
      createdAt,
    });
    await saveSignups(signups);
  });

  // Step 3: credit referrer with a 'signup' conversion event.
  await recordReferralConversion(referralId, "signup", SIGNUP_CREDIT);

  return { referralId, referrerId, refereeId: newUserId, createdAt };
}

/**
 * Record a conversion event against an existing referral.
 * @param {string} referralId
 * @param {"signup"|"first_chat"|"plan_upgrade"|"recipe_published"} event
 * @param {number} [value=0] dollar amount
 * @returns {Promise<{ id: string, referralId: string, event: string, value: number, createdAt: string }>}
 */
export async function recordReferralConversion(referralId, event, value = 0) {
  if (!referralId || typeof referralId !== "string") throw new Error("referralId is required");
  if (!VALID_EVENTS.has(event)) throw new Error(`Invalid event: ${event}`);
  const numValue = Number(value);
  const safeValue = Number.isFinite(numValue) ? numValue : 0;

  const id = `cvt_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const createdAt = new Date().toISOString();
  const path = conversionsPath();
  let entry;
  await withPathLock(path, async () => {
    const conversions = await loadConversions();
    entry = { id, referralId, event, value: safeValue, createdAt };
    conversions.push(entry);
    await saveConversions(conversions);
  });
  return entry;
}

/**
 * Get aggregated stats for a user's referral activity.
 * @param {string} userId
 * @returns {Promise<{ totalReferrals: number, activeReferrals: number, conversions: object, earnings: number }>}
 */
export async function getReferralStats(userId) {
  if (!userId) {
    return { totalReferrals: 0, activeReferrals: 0, conversions: {}, earnings: 0 };
  }
  const [signups, conversions] = await Promise.all([loadSignups(), loadConversions()]);
  const userSignups = signups.filter((s) => s.referrerId === userId);
  const referralIds = new Set(userSignups.map((s) => s.referralId));
  const userConversions = conversions.filter((c) => referralIds.has(c.referralId));

  const conversionsByEvent = {};
  for (const c of userConversions) {
    conversionsByEvent[c.event] = (conversionsByEvent[c.event] || 0) + 1;
  }

  // "Active" referrals are those that produced any conversion beyond signup
  // (i.e. the referee actually did something).
  const activeReferralIds = new Set(
    userConversions.filter((c) => c.event !== "signup").map((c) => c.referralId),
  );

  const rewards = await calculateRewards(userId);

  return {
    totalReferrals: userSignups.length,
    activeReferrals: activeReferralIds.size,
    conversions: conversionsByEvent,
    earnings: rewards.totalValue,
  };
}

/**
 * Get the top referrers by total conversions.
 * @param {number} [limit=10]
 * @returns {Promise<Array<{ userId: string, referrals: number, conversions: number, earnings: number }>>}
 */
export async function getTopReferrers(limit = 10) {
  const [signups, conversions] = await Promise.all([loadSignups(), loadConversions()]);
  const refToReferrer = new Map();
  for (const s of signups) refToReferrer.set(s.referralId, s.referrerId);

  const tally = new Map(); // userId -> { referrals, conversions, earnings }
  for (const s of signups) {
    if (!tally.has(s.referrerId)) {
      tally.set(s.referrerId, { userId: s.referrerId, referrals: 0, conversions: 0, earnings: 0 });
    }
    tally.get(s.referrerId).referrals += 1;
  }
  for (const c of conversions) {
    const referrerId = refToReferrer.get(c.referralId);
    if (!referrerId) continue;
    if (!tally.has(referrerId)) {
      tally.set(referrerId, { userId: referrerId, referrals: 0, conversions: 0, earnings: 0 });
    }
    const row = tally.get(referrerId);
    row.conversions += 1;
    row.earnings += rewardForEvent(c.event, c.value);
  }

  return Array.from(tally.values())
    .sort((a, b) => b.conversions - a.conversions || b.earnings - a.earnings)
    .slice(0, Math.max(1, Math.min(1000, limit)))
    .map((r) => ({ ...r, earnings: round2(r.earnings) }));
}

/**
 * Get a leaderboard scoped to a time window.
 * @param {"7d"|"30d"|"all"} [period="30d"]
 * @returns {Promise<Array<{ userId: string, referrals: number, conversions: number, earnings: number }>>}
 */
export async function getReferralLeaderboard(period = "30d") {
  const cutoff = parsePeriodCutoff(period);
  const [signups, conversions] = await Promise.all([loadSignups(), loadConversions()]);

  const refToReferrer = new Map();
  for (const s of signups) refToReferrer.set(s.referralId, s.referrerId);

  const recentSignups = signups.filter((s) => new Date(s.createdAt).getTime() >= cutoff);
  const recentConversions = conversions.filter((c) => new Date(c.createdAt).getTime() >= cutoff);

  const tally = new Map();
  for (const s of recentSignups) {
    if (!tally.has(s.referrerId)) {
      tally.set(s.referrerId, { userId: s.referrerId, referrals: 0, conversions: 0, earnings: 0 });
    }
    tally.get(s.referrerId).referrals += 1;
  }
  for (const c of recentConversions) {
    const referrerId = refToReferrer.get(c.referralId);
    if (!referrerId) continue;
    if (!tally.has(referrerId)) {
      tally.set(referrerId, { userId: referrerId, referrals: 0, conversions: 0, earnings: 0 });
    }
    const row = tally.get(referrerId);
    row.conversions += 1;
    row.earnings += rewardForEvent(c.event, c.value);
  }

  return Array.from(tally.values())
    .sort((a, b) => b.conversions - a.conversions || b.earnings - a.earnings)
    .map((r) => ({ ...r, earnings: round2(r.earnings) }));
}

/**
 * Calculate pending rewards for a user across all referrals they own.
 * Reward rules:
 *   - signup:       $5 credit for referrer (already credited via the conversion event)
 *   - plan_upgrade: 20% of first month upgrade value
 * @param {string} userId
 * @returns {Promise<{ credits: number, cash: number, totalValue: number }>}
 */
export async function calculateRewards(userId) {
  if (!userId) return { credits: 0, cash: 0, totalValue: 0 };
  const [signups, conversions] = await Promise.all([loadSignups(), loadConversions()]);
  const ownedReferralIds = new Set(
    signups.filter((s) => s.referrerId === userId).map((s) => s.referralId),
  );

  let credits = 0;
  let cash = 0;
  for (const c of conversions) {
    if (!ownedReferralIds.has(c.referralId)) continue;
    if (c.event === "signup") {
      credits += SIGNUP_CREDIT;
    } else if (c.event === "plan_upgrade") {
      cash += Number(c.value || 0) * UPGRADE_REWARD_RATE;
    }
  }

  credits = round2(credits);
  cash = round2(cash);
  return { credits, cash, totalValue: round2(credits + cash) };
}

// ─── internal helpers ────────────────────────────────────────────────────────

function rewardForEvent(event, value) {
  if (event === "signup") return SIGNUP_CREDIT;
  if (event === "plan_upgrade") return Number(value || 0) * UPGRADE_REWARD_RATE;
  return 0;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

// Exported constants for reuse in routes/tests.
export const REFERRAL_CONSTANTS = {
  SIGNUP_CREDIT,
  REFEREE_CREDIT,
  UPGRADE_REWARD_RATE,
  MAX_CODES_PER_USER,
  CODE_LENGTH,
};
