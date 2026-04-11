/**
 * Phase 48.4: Crypto payment integration tests.
 *
 * Covers invoice lifecycle (create, get, list, filter), verification flow
 * (mock/pluggable checkers), recordPayment/refundPayment, user history,
 * expiration sweep, currency validation, and exchange rate stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-crypto-payments-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createInvoice,
  getInvoice,
  listInvoices,
  verifyPayment,
  recordPayment,
  refundPayment,
  getUserPaymentHistory,
  notifyPaymentWebhook,
  registerPaymentChecker,
  clearPaymentCheckers,
  expireOldInvoices,
  getExchangeRate,
  listSupportedCurrencies,
  SUPPORTED_CURRENCIES,
  mockChecker,
} = await import("../lib/crypto-payments.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function baseArgs(overrides = {}) {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    amount: 10,
    currency: "USDC-ETH",
    description: "unit test",
    ...overrides,
  };
}

test("createInvoice returns a structured invoice with address + qrPayload", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "alpha" }));
  assert.ok(invoice.invoiceId.startsWith("inv_"));
  assert.equal(invoice.userId, "alpha");
  assert.equal(invoice.amount, 10);
  assert.equal(invoice.currency, "USDC-ETH");
  assert.equal(invoice.chain, "ethereum");
  assert.equal(invoice.status, "pending");
  assert.ok(invoice.address.startsWith("0x"));
  assert.equal(invoice.address.length, 42);
  assert.ok(invoice.expiresAt > invoice.createdAt);
  assert.ok(invoice.qrPayload);
  assert.match(invoice.qrPayload, /^ethereum:/);
});

test("createInvoice produces unique deterministic addresses per invoice id", async () => {
  const a = await createInvoice(baseArgs({ userId: "addr-a" }));
  const b = await createInvoice(baseArgs({ userId: "addr-b" }));
  assert.notEqual(a.invoiceId, b.invoiceId);
  assert.notEqual(a.address, b.address);
});

test("createInvoice honors expiresInMs", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "exp-user", expiresInMs: 1000 }));
  assert.equal(invoice.expiresAt - invoice.createdAt, 1000);
});

test("getInvoice returns persisted invoice and null for unknown id", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "get-user" }));
  const fetched = await getInvoice(invoice.invoiceId);
  assert.ok(fetched);
  assert.equal(fetched.invoiceId, invoice.invoiceId);
  assert.equal(fetched.userId, "get-user");
  assert.equal(await getInvoice("inv_does_not_exist"), null);
});

test("listInvoices filters by userId, workspaceId, status, and currency", async () => {
  await createInvoice(baseArgs({ userId: "list-user", workspaceId: "list-ws", currency: "ETH", amount: 0.5 }));
  await createInvoice(baseArgs({ userId: "list-user", workspaceId: "list-ws", currency: "USDT-ETH" }));
  await createInvoice(baseArgs({ userId: "list-other", workspaceId: "other" }));

  const byUser = await listInvoices({ userId: "list-user" });
  assert.ok(byUser.length >= 2);
  for (const inv of byUser) assert.equal(inv.userId, "list-user");

  const byWs = await listInvoices({ workspaceId: "list-ws" });
  for (const inv of byWs) assert.equal(inv.workspaceId, "list-ws");

  const byCurrency = await listInvoices({ currency: "ETH" });
  for (const inv of byCurrency) assert.equal(inv.currency, "ETH");

  // Ensure ordering: newest first (createdAt desc)
  for (let i = 1; i < byUser.length; i++) {
    assert.ok(byUser[i - 1].createdAt >= byUser[i].createdAt);
  }
});

test("verifyPayment uses mock checker via env var to mark invoice paid", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "verify-user" }));
  process.env[`CRYPTO_PAYMENTS_MOCK_${invoice.invoiceId}`] = JSON.stringify({
    paid: true,
    amountReceived: 10,
    txHash: "0xabc123",
    confirmations: 3,
  });
  try {
    const result = await verifyPayment(invoice.invoiceId);
    assert.equal(result.paid, true);
    assert.equal(result.status, "paid");
    assert.equal(result.amountReceived, 10);
    assert.equal(result.txHash, "0xabc123");

    const refreshed = await getInvoice(invoice.invoiceId);
    assert.equal(refreshed.status, "paid");
    assert.ok(refreshed.paidAt);
  } finally {
    delete process.env[`CRYPTO_PAYMENTS_MOCK_${invoice.invoiceId}`];
  }
});

test("recordPayment marks invoice as paid and appends a ledger entry", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "record-user", amount: 25 }));
  const updated = await recordPayment(invoice.invoiceId, "0xdeadbeef", 25, "0xfrom");
  assert.equal(updated.status, "paid");
  assert.equal(updated.txHash, "0xdeadbeef");
  assert.equal(updated.amountReceived, 25);
  assert.equal(updated.fromAddress, "0xfrom");
  assert.ok(updated.paidAt);
});

test("recordPayment with insufficient amount keeps invoice pending", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "short-user", amount: 50 }));
  const updated = await recordPayment(invoice.invoiceId, "0xpartial", 20, null);
  assert.equal(updated.status, "pending");
  assert.equal(updated.amountReceived, 20);
  assert.equal(updated.txHash, "0xpartial");
  assert.equal(updated.paidAt, null);
});

test("refundPayment transitions a paid invoice to refunded", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "refund-user" }));
  await recordPayment(invoice.invoiceId, "0xpaid", 10, null);
  const refunded = await refundPayment(invoice.invoiceId, "customer request");
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.refundReason, "customer request");
  assert.ok(refunded.refundedAt);
});

test("refundPayment rejects unpaid invoices", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "refund-fail" }));
  await assert.rejects(() => refundPayment(invoice.invoiceId, "n/a"), /only paid invoices/);
});

test("getUserPaymentHistory returns invoices for a user ordered newest first", async () => {
  await createInvoice(baseArgs({ userId: "history-user" }));
  await new Promise((r) => setTimeout(r, 5));
  await createInvoice(baseArgs({ userId: "history-user", amount: 5 }));
  const history = await getUserPaymentHistory("history-user");
  assert.ok(history.length >= 2);
  for (let i = 1; i < history.length; i++) {
    assert.ok(history[i - 1].createdAt >= history[i].createdAt);
  }
});

test("registerPaymentChecker overrides the default checker per chain", async () => {
  let called = 0;
  registerPaymentChecker("ethereum", async (inv) => {
    called++;
    return {
      paid: true,
      txHash: `0xplug_${inv.invoiceId}`,
      confirmations: 5,
      amountReceived: inv.amount,
    };
  });
  try {
    const invoice = await createInvoice(baseArgs({ userId: "plug-user" }));
    const result = await verifyPayment(invoice.invoiceId);
    assert.equal(called, 1);
    assert.equal(result.paid, true);
    assert.match(result.txHash, /^0xplug_/);
    assert.equal(result.confirmations, 5);
  } finally {
    clearPaymentCheckers();
  }
});

test("expireOldInvoices transitions pending invoices past their expiry", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "expire-user", expiresInMs: 1 }));
  await new Promise((r) => setTimeout(r, 10));
  const n = await expireOldInvoices();
  assert.ok(n >= 1);
  const refreshed = await getInvoice(invoice.invoiceId);
  assert.equal(refreshed.status, "expired");
});

test("createInvoice accepts every supported currency", async () => {
  for (const currency of Object.keys(SUPPORTED_CURRENCIES)) {
    const invoice = await createInvoice(baseArgs({
      userId: `multi-${currency}`,
      currency,
      amount: 1,
    }));
    assert.equal(invoice.currency, currency);
    assert.ok(invoice.address);
    assert.ok(invoice.qrPayload);
  }
  const list = listSupportedCurrencies();
  assert.equal(list.length, Object.keys(SUPPORTED_CURRENCIES).length);
});

test("createInvoice rejects malformed currency and amount", async () => {
  await assert.rejects(
    () => createInvoice(baseArgs({ userId: "bad-curr", currency: "BTC-BTC" })),
    /unsupported currency/,
  );
  await assert.rejects(
    () => createInvoice(baseArgs({ userId: "bad-amt", amount: -1 })),
    /amount must be/,
  );
  await assert.rejects(
    () => createInvoice(baseArgs({ userId: "bad-amt-2", amount: 0 })),
    /amount must be/,
  );
  await assert.rejects(
    () => createInvoice({ amount: 5, currency: "ETH" }),
    /userId is required/,
  );
});

test("getExchangeRate returns mocked rates and zero on unknown currencies", () => {
  assert.equal(getExchangeRate("USDC-ETH", "USD"), 1);
  assert.equal(getExchangeRate("USD", "USDC-ETH"), 1);
  assert.equal(getExchangeRate("ETH", "USD"), 3200);
  const ethToSol = getExchangeRate("ETH", "SOL");
  assert.ok(ethToSol > 0);
  assert.equal(getExchangeRate("ETH", "BTC-UNKNOWN"), 0);
  assert.equal(getExchangeRate("MYSTERY", "USD"), 0);
});

test("verifyPayment transitions an expired invoice into expired status", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "verify-expired", expiresInMs: 1 }));
  await new Promise((r) => setTimeout(r, 10));
  const result = await verifyPayment(invoice.invoiceId);
  assert.equal(result.paid, false);
  assert.equal(result.status, "expired");
});

test("notifyPaymentWebhook records the event even without a delivery URL", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "webhook-user" }));
  const r = await notifyPaymentWebhook(invoice.invoiceId, "payment.created");
  assert.ok(r.payload);
  assert.equal(r.payload.event, "payment.created");
  assert.equal(r.payload.invoiceId, invoice.invoiceId);
  assert.equal(r.delivered, false);
});

test("mockChecker returns zeros when no env override exists", async () => {
  const invoice = await createInvoice(baseArgs({ userId: "mock-user" }));
  const result = await mockChecker(invoice);
  assert.equal(result.paid, false);
  assert.equal(result.amountReceived, 0);
});
