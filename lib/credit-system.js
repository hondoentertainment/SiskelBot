/**
 * Phase 71.4: Prepaid credit balances with append-only transactions.
 *
 * Credits are stored internally as integer cents to avoid floating-point
 * drift; all public amounts are returned as USD decimals.
 *
 * Storage layout:
 *   data/credit-system/transactions/{userId}.json — append-only log
 *   data/credit-system/balances/{userId}.json     — cached balance state
 *   data/credit-system/_users.json                — known users (for iteration)
 *   data/credit-system/_tx-index.json             — txId -> userId for refund lookup
 */
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";
import { randomUUID } from "crypto";

export const TRANSACTION_TYPES = Object.freeze(["add", "consume", "refund"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function usdToCents(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) throw new Error("amount must be a number");
  return Math.round(n * 100);
}

function centsToUsd(cents) {
  return Math.round(cents) / 100;
}

function transactionsPath(userId) {
  return join(getDataDir(), "credit-system", "transactions", `${sanitizeId(userId)}.json`);
}

function balancePath(userId) {
  return join(getDataDir(), "credit-system", "balances", `${sanitizeId(userId)}.json`);
}

function usersPath() {
  return join(getDataDir(), "credit-system", "_users.json");
}

function txIndexPath() {
  return join(getDataDir(), "credit-system", "_tx-index.json");
}

async function touchUser(userId) {
  const uid = sanitizeId(userId);
  await withPathLock(usersPath(), async () => {
    const idx = await readJsonPath(usersPath(), { users: [] });
    const list = Array.isArray(idx.users) ? idx.users : [];
    if (!list.includes(uid)) {
      list.push(uid);
      await writeJsonPath(usersPath(), { users: list });
    }
  });
}

async function indexTx(txId, userId) {
  await withPathLock(txIndexPath(), async () => {
    const idx = await readJsonPath(txIndexPath(), { tx: {} });
    const map = idx.tx && typeof idx.tx === "object" ? idx.tx : {};
    map[txId] = sanitizeId(userId);
    await writeJsonPath(txIndexPath(), { tx: map });
  });
}

async function userOfTx(txId) {
  const idx = await readJsonPath(txIndexPath(), { tx: {} });
  const map = idx.tx && typeof idx.tx === "object" ? idx.tx : {};
  return map[txId] || null;
}

/**
 * Perform a transaction under the user's lock. Validates and appends to the
 * ledger, updating the cached balance atomically with respect to other
 * transactions on the same user.
 */
async function performTx(userId, txType, amountCents, extra) {
  const uid = sanitizeId(userId);
  let result = null;
  let error = null;
  await withPathLock(transactionsPath(uid), async () => {
    const cache = await readJsonPath(balancePath(uid), { balanceCents: 0 });
    const current = Number(cache.balanceCents) || 0;
    let nextBalance = current;
    if (txType === "add") nextBalance = current + amountCents;
    else if (txType === "consume") nextBalance = current - amountCents;
    else if (txType === "refund") nextBalance = current + amountCents;
    if (txType === "consume" && nextBalance < 0) {
      error = new Error("insufficient credits");
      return;
    }
    const store = await readJsonPath(transactionsPath(uid), { transactions: [] });
    const list = Array.isArray(store.transactions) ? store.transactions : [];
    const record = {
      txId: randomUUID(),
      userId: uid,
      type: txType,
      amountCents,
      amount: centsToUsd(amountCents),
      balanceAfterCents: nextBalance,
      balanceAfter: centsToUsd(nextBalance),
      source: extra.source || null,
      reason: extra.reason || null,
      reference: extra.reference || null,
      refundedTxId: extra.refundedTxId || null,
      timestamp: Date.now(),
    };
    list.push(record);
    await writeJsonPath(transactionsPath(uid), { transactions: list });
    await writeJsonPath(balancePath(uid), { balanceCents: nextBalance });
    result = record;
  });
  if (error) throw error;
  await touchUser(uid);
  if (result) await indexTx(result.txId, uid);
  return result;
}

/**
 * Add credits to the user's balance.
 *
 * @param {{ userId: string, amount: number, source: string, reference?: string }} input
 */
export async function addCredits(input = {}) {
  if (!input || !input.userId) throw new Error("userId is required");
  if (!input.source) throw new Error("source is required");
  const cents = usdToCents(input.amount);
  if (cents <= 0) throw new Error("amount must be positive");
  return performTx(input.userId, "add", cents, { source: String(input.source), reference: input.reference ? String(input.reference) : null });
}

/**
 * Consume credits. Throws if balance would go negative.
 *
 * @param {{ userId: string, amount: number, reason: string, reference?: string }} input
 */
export async function consumeCredits(input = {}) {
  if (!input || !input.userId) throw new Error("userId is required");
  if (!input.reason) throw new Error("reason is required");
  const cents = usdToCents(input.amount);
  if (cents <= 0) throw new Error("amount must be positive");
  return performTx(input.userId, "consume", cents, { reason: String(input.reason), reference: input.reference ? String(input.reference) : null });
}

/**
 * Refund a previous consume transaction. Returns the refund transaction or
 * throws if the original cannot be found or is not a "consume".
 *
 * @param {{ userId: string, transactionId: string }} input
 */
export async function refundCredits(input = {}) {
  if (!input || !input.userId) throw new Error("userId is required");
  if (!input.transactionId) throw new Error("transactionId is required");
  const uid = sanitizeId(input.userId);
  const owner = await userOfTx(input.transactionId);
  if (!owner || owner !== uid) throw new Error("transaction not found for user");
  const store = await readJsonPath(transactionsPath(uid), { transactions: [] });
  const list = Array.isArray(store.transactions) ? store.transactions : [];
  const original = list.find((t) => t.txId === input.transactionId);
  if (!original) throw new Error("transaction not found");
  if (original.type !== "consume") throw new Error("only consume transactions can be refunded");
  // Check if already refunded.
  const alreadyRefunded = list.some((t) => t.type === "refund" && t.refundedTxId === original.txId);
  if (alreadyRefunded) throw new Error("transaction already refunded");
  return performTx(uid, "refund", original.amountCents, {
    reason: `refund for ${original.txId}`,
    refundedTxId: original.txId,
  });
}

/**
 * Get the user's current balance.
 */
export async function getBalance(userId) {
  const uid = sanitizeId(userId);
  const cache = await readJsonPath(balancePath(uid), { balanceCents: 0 });
  const cents = Number(cache.balanceCents) || 0;
  return { userId: uid, balance: centsToUsd(cents), balanceCents: cents, currency: "USD" };
}

/**
 * List transactions for a user with optional filtering.
 *
 * @param {{ userId: string, limit?: number, offset?: number, type?: string }} input
 */
export async function listTransactions(input = {}) {
  if (!input || !input.userId) throw new Error("userId is required");
  const uid = sanitizeId(input.userId);
  const limit = Math.max(1, Math.min(10000, Number(input.limit) || 100));
  const offset = Math.max(0, Number(input.offset) || 0);
  const store = await readJsonPath(transactionsPath(uid), { transactions: [] });
  let list = Array.isArray(store.transactions) ? store.transactions.slice() : [];
  if (input.type && TRANSACTION_TYPES.includes(input.type)) {
    list = list.filter((t) => t.type === input.type);
  }
  list.sort((a, b) => b.timestamp - a.timestamp);
  return {
    userId: uid,
    total: list.length,
    limit,
    offset,
    transactions: list.slice(offset, offset + limit),
  };
}

export async function _reset() {
  const idx = await readJsonPath(usersPath(), { users: [] });
  const users = Array.isArray(idx.users) ? idx.users : [];
  for (const uid of users) {
    await writeJsonPath(transactionsPath(uid), { transactions: [] });
    await writeJsonPath(balancePath(uid), { balanceCents: 0 });
  }
  await writeJsonPath(usersPath(), { users: [] });
  await writeJsonPath(txIndexPath(), { tx: {} });
}

export const _internals = { sanitizeId, usdToCents, centsToUsd, transactionsPath, balancePath, usersPath };
