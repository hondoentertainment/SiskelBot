// @ts-check
/**
 * Phase 48.4: Crypto payment integration.
 *
 * Provides an abstraction over crypto payment flows (USDC, USDT, ETH, SOL)
 * with pluggable verification so the module can run in tests without hitting
 * real chains while still supporting production HTTP checkers.
 *
 * Storage is routed through `json-path-store.js` so file/SQLite/Postgres KV
 * backends all work identically.
 *
 * @module crypto-payments
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const INVOICE_STATUSES = new Set(["pending", "paid", "expired", "refunded", "underpaid"]);

export const SUPPORTED_CURRENCIES = {
  "USDC-ETH": { chain: "ethereum", token: "USDC", decimals: 6 },
  "USDT-ETH": { chain: "ethereum", token: "USDT", decimals: 6 },
  "ETH": { chain: "ethereum", token: "ETH", decimals: 18 },
  "USDC-SOL": { chain: "solana", token: "USDC", decimals: 6 },
  "SOL": { chain: "solana", token: "SOL", decimals: 9 },
};

// Mocked exchange rates (quote currency USD unless noted).
const EXCHANGE_RATES_USD = {
  "USDC-ETH": 1.0,
  "USDT-ETH": 1.0,
  "USDC-SOL": 1.0,
  "ETH": 3200.0,
  "SOL": 150.0,
  "USD": 1.0,
};

// Pluggable checkers are indexed by chain id ("ethereum" | "solana" | ...).
const checkers = new Map();

function storePath() {
  return join(getDataDir(), "crypto-payments.json");
}

function now() {
  return Date.now();
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    invoices: base.invoices && typeof base.invoices === "object" ? base.invoices : {},
    payments: Array.isArray(base.payments) ? base.payments : [],
    webhookLog: Array.isArray(base.webhookLog) ? base.webhookLog : [],
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), {
      _version: STORE_VERSION,
      invoices: {},
      payments: [],
      webhookLog: [],
    }),
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

function assertPositiveAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("amount must be a positive finite number");
  }
  return n;
}

function assertCurrency(currency) {
  if (!currency || typeof currency !== "string") {
    throw new Error("currency is required");
  }
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_CURRENCIES, currency)) {
    throw new Error(`unsupported currency: ${currency}`);
  }
  return SUPPORTED_CURRENCIES[currency];
}

function generateAddress(chain, invoiceId) {
  const digest = crypto.createHash("sha256").update(`${chain}:${invoiceId}`).digest("hex");
  if (chain === "ethereum") {
    return `0x${digest.slice(0, 40)}`;
  }
  if (chain === "solana") {
    // Return a deterministic base58-ish stub (not a real Solana key).
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let out = "";
    let n = BigInt(`0x${digest}`);
    while (out.length < 44 && n > 0n) {
      out = alphabet[Number(n % 58n)] + out;
      n = n / 58n;
    }
    return out || digest.slice(0, 44);
  }
  return digest.slice(0, 40);
}

function buildQrPayload(invoice) {
  const spec = SUPPORTED_CURRENCIES[invoice.currency];
  if (!spec) return null;
  if (spec.chain === "ethereum") {
    if (spec.token === "ETH") {
      return `ethereum:${invoice.address}?value=${invoice.amount}`;
    }
    return `ethereum:${invoice.address}?token=${spec.token}&amount=${invoice.amount}`;
  }
  if (spec.chain === "solana") {
    return `solana:${invoice.address}?amount=${invoice.amount}&spl-token=${spec.token}`;
  }
  return `${spec.chain}:${invoice.address}?amount=${invoice.amount}`;
}

/**
 * Create a new crypto invoice.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.workspaceId]
 * @param {number} opts.amount
 * @param {string} opts.currency
 * @param {string} [opts.description]
 * @param {number} [opts.expiresInMs]
 * @param {string} [opts.metadata]
 */
export async function createInvoice({
  userId,
  workspaceId,
  amount,
  currency,
  description,
  expiresInMs,
  metadata,
}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  const amt = assertPositiveAmount(amount);
  const spec = assertCurrency(currency);

  const ttl = Number.isFinite(expiresInMs) && Number(expiresInMs) > 0
    ? Number(expiresInMs)
    : DEFAULT_EXPIRY_MS;

  const invoiceId = `inv_${crypto.randomBytes(8).toString("hex")}`;
  const createdAt = now();
  const address = generateAddress(spec.chain, invoiceId);
  const invoice = {
    invoiceId,
    userId,
    workspaceId: workspaceId || "default",
    amount: amt,
    currency,
    chain: spec.chain,
    token: spec.token,
    decimals: spec.decimals,
    description: description || "",
    metadata: metadata || null,
    address,
    status: "pending",
    createdAt,
    expiresAt: createdAt + ttl,
    paidAt: null,
    txHash: null,
    amountReceived: 0,
    fromAddress: null,
    refundedAt: null,
    refundReason: null,
    qrPayload: null,
    confirmations: 0,
  };
  invoice.qrPayload = buildQrPayload(invoice);

  await mutate(async (store) => {
    store.invoices[invoiceId] = invoice;
  });
  return invoice;
}

/**
 * Fetch an invoice by ID. Returns null if not found.
 * @param {string} invoiceId
 */
export async function getInvoice(invoiceId) {
  const store = await loadStore();
  return store.invoices[invoiceId] || null;
}

/**
 * List invoices, optionally filtering by userId/workspaceId/status/currency.
 * Results are sorted by createdAt descending.
 *
 * @param {object} [filter]
 */
export async function listInvoices(filter = {}) {
  const store = await loadStore();
  let invoices = Object.values(store.invoices);
  if (filter.userId) invoices = invoices.filter((i) => i.userId === filter.userId);
  if (filter.workspaceId) invoices = invoices.filter((i) => i.workspaceId === filter.workspaceId);
  if (filter.status) invoices = invoices.filter((i) => i.status === filter.status);
  if (filter.currency) invoices = invoices.filter((i) => i.currency === filter.currency);
  invoices.sort((a, b) => b.createdAt - a.createdAt);
  return invoices;
}

/**
 * Verify payment for an invoice via the registered checker for its chain.
 *
 * @param {string} invoiceId
 * @param {object} [options]
 * @returns {Promise<{paid:boolean, txHash?:string, confirmations:number, amountReceived:number, status:string}>}
 */
export async function verifyPayment(invoiceId, options = {}) {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) throw new Error(`invoice not found: ${invoiceId}`);

  // Auto-expire before checking.
  if (invoice.status === "pending" && invoice.expiresAt <= now()) {
    await mutate(async (store) => {
      const i = store.invoices[invoiceId];
      if (i && i.status === "pending") i.status = "expired";
    });
    return { paid: false, confirmations: 0, amountReceived: 0, status: "expired" };
  }

  if (invoice.status === "paid") {
    return {
      paid: true,
      txHash: invoice.txHash,
      confirmations: invoice.confirmations,
      amountReceived: invoice.amountReceived,
      status: "paid",
    };
  }
  if (invoice.status !== "pending") {
    return { paid: false, confirmations: 0, amountReceived: 0, status: invoice.status };
  }

  const checker = checkers.get(invoice.chain) || mockChecker;
  const result = await checker(invoice, options);
  const res = result && typeof result === "object" ? result : {};
  const paid = Boolean(res.paid);
  const confirmations = Number.isFinite(res.confirmations) ? Number(res.confirmations) : 0;
  const amountReceived = Number.isFinite(res.amountReceived) ? Number(res.amountReceived) : 0;
  const txHash = typeof res.txHash === "string" ? res.txHash : null;
  const fromAddress = typeof res.fromAddress === "string" ? res.fromAddress : null;

  if (paid && amountReceived >= invoice.amount && txHash) {
    await recordPayment(invoiceId, txHash, amountReceived, fromAddress);
    return { paid: true, txHash, confirmations, amountReceived, status: "paid" };
  }
  if (amountReceived > 0 && amountReceived < invoice.amount) {
    await mutate(async (store) => {
      const i = store.invoices[invoiceId];
      if (i && i.status === "pending") {
        i.amountReceived = amountReceived;
        i.txHash = txHash || i.txHash;
        i.confirmations = confirmations;
      }
    });
    return { paid: false, txHash: txHash || undefined, confirmations, amountReceived, status: "underpaid" };
  }
  return { paid: false, txHash: txHash || undefined, confirmations, amountReceived, status: "pending" };
}

/**
 * Record a payment against an invoice. Marks paid when amount is sufficient,
 * otherwise leaves the invoice pending but tracks underpayment.
 *
 * @param {string} invoiceId
 * @param {string} txHash
 * @param {number} amount
 * @param {string|null} [fromAddress]
 */
export async function recordPayment(invoiceId, txHash, amount, fromAddress = null) {
  if (!invoiceId) throw new Error("invoiceId is required");
  if (!txHash || typeof txHash !== "string") throw new Error("txHash is required");
  const amt = assertPositiveAmount(amount);

  const result = await mutate(async (store) => {
    const invoice = store.invoices[invoiceId];
    if (!invoice) throw new Error(`invoice not found: ${invoiceId}`);
    if (invoice.status === "refunded") {
      throw new Error(`invoice ${invoiceId} has been refunded and cannot be paid`);
    }
    if (invoice.status === "expired") {
      throw new Error(`invoice ${invoiceId} has expired`);
    }

    invoice.amountReceived = amt;
    invoice.txHash = txHash;
    invoice.fromAddress = fromAddress || null;

    if (amt >= invoice.amount) {
      invoice.status = "paid";
      invoice.paidAt = now();
      invoice.confirmations = Math.max(1, invoice.confirmations || 0);
      store.payments.push({
        invoiceId,
        txHash,
        amount: amt,
        currency: invoice.currency,
        fromAddress: fromAddress || null,
        at: invoice.paidAt,
        kind: "payment",
      });
    } else {
      invoice.status = "pending";
    }
    return invoice;
  });

  if (result.status === "paid") {
    try {
      await notifyPaymentWebhook(invoiceId, "payment.confirmed");
    } catch (_) {
      // Webhook failures are non-fatal for the ledger.
    }
  }
  return result;
}

/**
 * Refund a paid invoice.
 * @param {string} invoiceId
 * @param {string} reason
 */
export async function refundPayment(invoiceId, reason) {
  if (!reason || typeof reason !== "string") {
    throw new Error("reason is required");
  }
  const result = await mutate(async (store) => {
    const invoice = store.invoices[invoiceId];
    if (!invoice) throw new Error(`invoice not found: ${invoiceId}`);
    if (invoice.status !== "paid") {
      throw new Error(`only paid invoices can be refunded (current: ${invoice.status})`);
    }
    invoice.status = "refunded";
    invoice.refundedAt = now();
    invoice.refundReason = reason;
    store.payments.push({
      invoiceId,
      txHash: invoice.txHash,
      amount: invoice.amountReceived,
      currency: invoice.currency,
      fromAddress: invoice.fromAddress,
      at: invoice.refundedAt,
      kind: "refund",
      reason,
    });
    return invoice;
  });

  try {
    await notifyPaymentWebhook(invoiceId, "payment.refunded");
  } catch (_) {
    // Non-fatal
  }
  return result;
}

/**
 * Return all invoices for a user (ordered by createdAt descending).
 * @param {string} userId
 */
export async function getUserPaymentHistory(userId) {
  if (!userId) throw new Error("userId is required");
  return listInvoices({ userId });
}

/**
 * Emit a webhook-style event. Stored in the ledger for audit. If
 * CRYPTO_PAYMENTS_WEBHOOK_URL is configured we'll POST; otherwise we only log.
 *
 * @param {string} invoiceId
 * @param {string} event
 */
export async function notifyPaymentWebhook(invoiceId, event) {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) throw new Error(`invoice not found: ${invoiceId}`);

  const payload = {
    event,
    invoiceId,
    userId: invoice.userId,
    workspaceId: invoice.workspaceId,
    amount: invoice.amount,
    amountReceived: invoice.amountReceived,
    currency: invoice.currency,
    status: invoice.status,
    txHash: invoice.txHash,
    at: now(),
  };

  const url = process.env.CRYPTO_PAYMENTS_WEBHOOK_URL;
  let delivered = false;
  let error = null;
  if (url && typeof fetch === "function") {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      delivered = r && r.ok;
      if (!delivered && r) error = `HTTP ${r.status}`;
    } catch (e) {
      error = (e && e.message) || String(e);
    }
  }

  await mutate(async (store) => {
    store.webhookLog.push({ ...payload, delivered, error });
    // Cap log to latest 500 events.
    if (store.webhookLog.length > 500) {
      store.webhookLog.splice(0, store.webhookLog.length - 500);
    }
  });
  return { delivered, error, payload };
}

/**
 * Register a pluggable payment checker for a given chain.
 *
 * @param {string} chain
 * @param {(invoice:object, options?:object) => Promise<object>} fn
 */
export function registerPaymentChecker(chain, fn) {
  if (!chain || typeof chain !== "string") throw new Error("chain is required");
  if (typeof fn !== "function") throw new Error("checker must be a function");
  checkers.set(chain, fn);
}

export function clearPaymentCheckers() {
  checkers.clear();
}

/**
 * Local mock checker: reads CRYPTO_PAYMENTS_MOCK_<invoiceId> env or
 * returns a pending status. Primarily for tests.
 */
export const mockChecker = async (invoice) => {
  const key = `CRYPTO_PAYMENTS_MOCK_${invoice.invoiceId}`;
  const raw = process.env[key];
  if (!raw) return { paid: false, confirmations: 0, amountReceived: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      paid: Boolean(parsed.paid),
      txHash: parsed.txHash || `mock_${invoice.invoiceId}`,
      confirmations: Number(parsed.confirmations ?? 1),
      amountReceived: Number(parsed.amountReceived ?? invoice.amount),
      fromAddress: parsed.fromAddress || null,
    };
  } catch (_) {
    return { paid: false, confirmations: 0, amountReceived: 0 };
  }
};

/**
 * HTTP checker: POSTs {invoice} to CRYPTO_PAYMENTS_CHECKER_URL and expects
 * a JSON body conforming to the checker response contract.
 */
export const httpChecker = async (invoice) => {
  const url = process.env.CRYPTO_PAYMENTS_CHECKER_URL;
  if (!url) return { paid: false, confirmations: 0, amountReceived: 0 };
  if (typeof fetch !== "function") {
    return { paid: false, confirmations: 0, amountReceived: 0 };
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invoice }),
    });
    if (!r || !r.ok) return { paid: false, confirmations: 0, amountReceived: 0 };
    const body = await r.json();
    return {
      paid: Boolean(body?.paid),
      txHash: body?.txHash || null,
      confirmations: Number(body?.confirmations ?? 0),
      amountReceived: Number(body?.amountReceived ?? 0),
      fromAddress: body?.fromAddress || null,
    };
  } catch (_) {
    return { paid: false, confirmations: 0, amountReceived: 0 };
  }
};

/**
 * Mark any pending invoices past their expiry as expired. Returns the
 * number of invoices that were transitioned.
 */
export async function expireOldInvoices() {
  return mutate(async (store) => {
    const t = now();
    let n = 0;
    for (const id of Object.keys(store.invoices)) {
      const inv = store.invoices[id];
      if (inv.status === "pending" && inv.expiresAt <= t) {
        inv.status = "expired";
        n++;
      }
    }
    return n;
  });
}

/**
 * Naive exchange rate lookup between supported currencies and USD.
 * Returns 0 when either currency is unknown.
 *
 * @param {string} fromCurrency
 * @param {string} toCurrency
 */
export function getExchangeRate(fromCurrency, toCurrency) {
  const from = EXCHANGE_RATES_USD[fromCurrency];
  const to = EXCHANGE_RATES_USD[toCurrency];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to === 0) return 0;
  return from / to;
}

/**
 * List supported currencies with metadata.
 */
export function listSupportedCurrencies() {
  return Object.entries(SUPPORTED_CURRENCIES).map(([code, spec]) => ({ code, ...spec }));
}

export const _internals = {
  storePath,
  loadStore,
  saveStore,
  generateAddress,
  buildQrPayload,
  checkers,
};
