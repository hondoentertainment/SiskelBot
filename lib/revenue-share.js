/**
 * Phase 71.3: Revenue share for plugin / recipe / template authors.
 *
 * Tracks registered authors and their royalty rate, records per-usage revenue
 * events, and computes payouts for a billing period.
 *
 * Currency is stored internally as integer cents to avoid floating-point
 * accumulation errors; all public amounts are returned as USD decimals.
 *
 * Storage layout:
 *   data/revenue-share/authors.json          — author registry
 *   data/revenue-share/usage/{authorId}.json — per-author usage events
 *   data/revenue-share/payouts/{authorId}.json — per-author payout ledger
 */
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";
import { randomUUID } from "crypto";

export const AUTHOR_USAGE_TYPES = Object.freeze(["plugin", "recipe", "template", "other"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function usdToCents(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error("amount must be a non-negative number (USD)");
  return Math.round(n * 100);
}

function centsToUsd(cents) {
  return Math.round(cents) / 100;
}

function authorsPath() {
  return join(getDataDir(), "revenue-share", "authors.json");
}

function usagePath(authorId) {
  return join(getDataDir(), "revenue-share", "usage", `${sanitizeId(authorId)}.json`);
}

function payoutsPath(authorId) {
  return join(getDataDir(), "revenue-share", "payouts", `${sanitizeId(authorId)}.json`);
}

function normalizeRate(r, fallback = 0.7) {
  const n = Number(r);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Register a new author (or update an existing one).
 *
 * @param {{ authorId: string, name: string, payoutMethod: string, defaultRate?: number }} input
 */
export async function registerAuthor(input = {}) {
  if (!input || !input.authorId) throw new Error("authorId is required");
  if (!input.name) throw new Error("name is required");
  if (!input.payoutMethod) throw new Error("payoutMethod is required");
  const authorId = sanitizeId(input.authorId);
  const record = {
    authorId,
    name: String(input.name).slice(0, 200),
    payoutMethod: String(input.payoutMethod).slice(0, 100),
    rate: normalizeRate(input.defaultRate, 0.7),
    createdAt: Date.now(),
  };
  await withPathLock(authorsPath(), async () => {
    const store = await readJsonPath(authorsPath(), { authors: {} });
    const authors = store.authors && typeof store.authors === "object" ? store.authors : {};
    const existing = authors[authorId];
    if (existing) {
      authors[authorId] = {
        ...existing,
        name: record.name,
        payoutMethod: record.payoutMethod,
        rate: record.rate,
        updatedAt: Date.now(),
      };
    } else {
      authors[authorId] = record;
    }
    await writeJsonPath(authorsPath(), { authors });
  });
  return (await getAuthor(authorId));
}

export async function getAuthor(authorId) {
  if (!authorId) return null;
  const id = sanitizeId(authorId);
  const store = await readJsonPath(authorsPath(), { authors: {} });
  const authors = store.authors && typeof store.authors === "object" ? store.authors : {};
  return authors[id] || null;
}

export async function listAuthors() {
  const store = await readJsonPath(authorsPath(), { authors: {} });
  const authors = store.authors && typeof store.authors === "object" ? store.authors : {};
  return Object.values(authors);
}

export async function setShareRate(input = {}) {
  const authorId = sanitizeId(input.authorId);
  const rate = normalizeRate(input.rate, null);
  if (rate == null || !Number.isFinite(Number(input.rate))) throw new Error("rate must be a number in [0,1]");
  let updated = null;
  await withPathLock(authorsPath(), async () => {
    const store = await readJsonPath(authorsPath(), { authors: {} });
    const authors = store.authors && typeof store.authors === "object" ? store.authors : {};
    if (!authors[authorId]) throw new Error("author not found");
    authors[authorId] = { ...authors[authorId], rate, updatedAt: Date.now() };
    updated = authors[authorId];
    await writeJsonPath(authorsPath(), { authors });
  });
  return updated;
}

/**
 * Record a single usage revenue event attributable to the author.
 *
 * @param {{ authorId: string, type: string, units: number, grossAmount: number, reference?: string, timestamp?: number }} input
 */
export async function recordUsage(input = {}) {
  if (!input || !input.authorId) throw new Error("authorId is required");
  const authorId = sanitizeId(input.authorId);
  if (!AUTHOR_USAGE_TYPES.includes(input.type)) {
    throw new Error(`type must be one of ${AUTHOR_USAGE_TYPES.join(", ")}`);
  }
  const author = await getAuthor(authorId);
  if (!author) throw new Error("author not found");
  const units = Number(input.units);
  if (!Number.isFinite(units) || units < 0) throw new Error("units must be non-negative");
  const grossCents = usdToCents(input.grossAmount);
  const record = {
    usageId: randomUUID(),
    authorId,
    type: input.type,
    units,
    grossAmountCents: grossCents,
    grossAmount: centsToUsd(grossCents),
    reference: input.reference ? String(input.reference).slice(0, 200) : null,
    timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
  };
  await withPathLock(usagePath(authorId), async () => {
    const store = await readJsonPath(usagePath(authorId), { usage: [] });
    const list = Array.isArray(store.usage) ? store.usage : [];
    list.push(record);
    await writeJsonPath(usagePath(authorId), { usage: list });
  });
  return record;
}

/**
 * Compute the payout for a period.
 *
 * @param {{ authorId: string, period: { start: number, end: number } }} input
 */
export async function computePayout(input = {}) {
  const authorId = sanitizeId(input.authorId);
  const author = await getAuthor(authorId);
  if (!author) throw new Error("author not found");
  const period = input.period || {};
  const start = Number(period.start);
  const end = Number(period.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("period.start and period.end must be numbers, end >= start");
  }
  const store = await readJsonPath(usagePath(authorId), { usage: [] });
  const list = Array.isArray(store.usage) ? store.usage : [];
  let totalGrossCents = 0;
  let usageCount = 0;
  for (const u of list) {
    if (u.timestamp < start || u.timestamp > end) continue;
    totalGrossCents += Number(u.grossAmountCents) || 0;
    usageCount += 1;
  }
  const rate = Number(author.rate) || 0;
  const totalShareCents = Math.round(totalGrossCents * rate);
  return {
    authorId,
    period: { start, end },
    totalGross: centsToUsd(totalGrossCents),
    totalShare: centsToUsd(totalShareCents),
    rate,
    usageCount,
    currency: "USD",
  };
}

/**
 * Append a payout to the author's ledger.
 *
 * @param {{ authorId: string, period: { start: number, end: number }, amount: number, reference?: string }} input
 */
export async function recordPayout(input = {}) {
  const authorId = sanitizeId(input.authorId);
  const author = await getAuthor(authorId);
  if (!author) throw new Error("author not found");
  const cents = usdToCents(input.amount);
  const record = {
    payoutId: randomUUID(),
    authorId,
    period: input.period && typeof input.period === "object"
      ? { start: Number(input.period.start) || 0, end: Number(input.period.end) || 0 }
      : null,
    amountCents: cents,
    amount: centsToUsd(cents),
    reference: input.reference ? String(input.reference).slice(0, 200) : null,
    timestamp: Date.now(),
  };
  await withPathLock(payoutsPath(authorId), async () => {
    const store = await readJsonPath(payoutsPath(authorId), { payouts: [] });
    const list = Array.isArray(store.payouts) ? store.payouts : [];
    list.push(record);
    await writeJsonPath(payoutsPath(authorId), { payouts: list });
  });
  return record;
}

export async function listPayouts(authorId) {
  if (!authorId) return [];
  const id = sanitizeId(authorId);
  const store = await readJsonPath(payoutsPath(id), { payouts: [] });
  const list = Array.isArray(store.payouts) ? store.payouts : [];
  return list.slice().sort((a, b) => b.timestamp - a.timestamp);
}

export async function _reset() {
  const store = await readJsonPath(authorsPath(), { authors: {} });
  const authors = store.authors && typeof store.authors === "object" ? store.authors : {};
  for (const id of Object.keys(authors)) {
    await writeJsonPath(usagePath(id), { usage: [] });
    await writeJsonPath(payoutsPath(id), { payouts: [] });
  }
  await writeJsonPath(authorsPath(), { authors: {} });
}

export const _internals = { sanitizeId, usdToCents, centsToUsd, normalizeRate, authorsPath, usagePath, payoutsPath };
