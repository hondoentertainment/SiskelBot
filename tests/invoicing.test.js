/**
 * Phase 71.5: Invoicing tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-invoicing-"));
process.env.STORAGE_PATH = TMP;

const {
  createInvoice,
  getInvoice,
  listInvoices,
  markPaid,
  voidInvoice,
  exportInvoiceJson,
  exportInvoiceText,
  INVOICE_STATUSES,
  _reset,
} = await import("../lib/invoicing.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("INVOICE_STATUSES exposes draft/issued/paid/void", () => {
  for (const s of ["draft", "issued", "paid", "void"]) {
    assert.ok(INVOICE_STATUSES.includes(s), `missing ${s}`);
  }
});

test("createInvoice derives amounts, subtotal, tax, total in cents", async () => {
  await _reset();
  const inv = await createInvoice({
    workspaceId: "acme",
    periodStart: 1000,
    periodEnd: 2000,
    taxRate: 0.1,
    lineItems: [
      { description: "API calls", quantity: 1000, unitPrice: 0.01 },
      { description: "Storage", quantity: 5, unitPrice: 2.00 },
    ],
  });
  // 1000 * 0.01 = 10.00 ; 5 * 2.00 = 10.00 ; subtotal = 20.00 ; tax = 2.00 ; total = 22.00
  assert.equal(inv.subtotal, 20);
  assert.equal(inv.tax, 2);
  assert.equal(inv.total, 22);
  assert.equal(inv.status, "issued");
  assert.equal(inv.number, 1);
  assert.equal(inv.currency, "USD");
  assert.equal(inv.lineItems[0].amount, 10);
});

test("createInvoice rejects empty lineItems or missing workspaceId", async () => {
  await _reset();
  await assert.rejects(() => createInvoice({ lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] }), /workspaceId/);
  await assert.rejects(() => createInvoice({ workspaceId: "a", lineItems: [] }), /lineItems/);
  await assert.rejects(
    () => createInvoice({ workspaceId: "a", lineItems: [{ description: "x", quantity: -1, unitPrice: 1 }] }),
    /quantity/,
  );
});

test("Invoice numbers are monotonic per workspace", async () => {
  await _reset();
  const a1 = await createInvoice({ workspaceId: "w1", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  const a2 = await createInvoice({ workspaceId: "w1", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  const b1 = await createInvoice({ workspaceId: "w2", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  assert.equal(a1.number, 1);
  assert.equal(a2.number, 2);
  assert.equal(b1.number, 1);
});

test("getInvoice and listInvoices", async () => {
  await _reset();
  const inv = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  const fetched = await getInvoice(inv.invoiceId);
  assert.ok(fetched);
  assert.equal(fetched.invoiceId, inv.invoiceId);
  await createInvoice({ workspaceId: "w", lineItems: [{ description: "y", quantity: 2, unitPrice: 5 }] });
  const list = await listInvoices("w");
  assert.equal(list.length, 2);
  // sorted by number desc
  assert.ok(list[0].number > list[1].number);
});

test("markPaid transitions status and records reference", async () => {
  await _reset();
  const inv = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 1, unitPrice: 10 }] });
  const paid = await markPaid({ invoiceId: inv.invoiceId, paymentReference: "stripe-123" });
  assert.equal(paid.status, "paid");
  assert.equal(paid.paymentReference, "stripe-123");
  assert.ok(paid.paidAt);
});

test("voidInvoice transitions status and records reason", async () => {
  await _reset();
  const inv = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 1, unitPrice: 10 }] });
  const voided = await voidInvoice({ invoiceId: inv.invoiceId, reason: "duplicate" });
  assert.equal(voided.status, "void");
  assert.equal(voided.voidReason, "duplicate");
});

test("cannot void a paid invoice or pay a void invoice", async () => {
  await _reset();
  const a = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  await markPaid({ invoiceId: a.invoiceId, paymentReference: "ref" });
  await assert.rejects(
    () => voidInvoice({ invoiceId: a.invoiceId, reason: "oops" }),
    /paid/,
  );
  const b = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 1, unitPrice: 1 }] });
  await voidInvoice({ invoiceId: b.invoiceId, reason: "err" });
  await assert.rejects(
    () => markPaid({ invoiceId: b.invoiceId, paymentReference: "ref" }),
    /void/,
  );
});

test("markPaid/voidInvoice reject unknown invoice", async () => {
  await _reset();
  await assert.rejects(
    () => markPaid({ invoiceId: "nope", paymentReference: "r" }),
    /not found/,
  );
  await assert.rejects(
    () => voidInvoice({ invoiceId: "nope", reason: "r" }),
    /not found/,
  );
});

test("exportInvoiceJson returns parseable JSON", async () => {
  await _reset();
  const inv = await createInvoice({ workspaceId: "w", lineItems: [{ description: "x", quantity: 2, unitPrice: 1.5 }] });
  const body = await exportInvoiceJson(inv.invoiceId);
  const parsed = JSON.parse(body);
  assert.equal(parsed.invoiceId, inv.invoiceId);
  assert.equal(parsed.total, 3);
});

test("exportInvoiceText includes invoice number, totals, description", async () => {
  await _reset();
  const inv = await createInvoice({
    workspaceId: "w",
    lineItems: [{ description: "API calls", quantity: 10, unitPrice: 0.5 }],
    taxRate: 0.2,
  });
  const body = await exportInvoiceText(inv.invoiceId);
  assert.ok(body.includes(`INVOICE #${inv.number}`));
  assert.ok(body.includes("API calls"));
  assert.ok(body.includes("USD 5.00")); // subtotal
  assert.ok(body.includes("TOTAL"));
  assert.ok(body.includes("USD 6.00")); // total = subtotal + 20% tax
});

test("line item amount override takes precedence over quantity*unitPrice", async () => {
  await _reset();
  const inv = await createInvoice({
    workspaceId: "w",
    lineItems: [{ description: "Discounted bundle", quantity: 10, unitPrice: 1.00, amount: 8.00 }],
  });
  assert.equal(inv.lineItems[0].amount, 8);
  assert.equal(inv.subtotal, 8);
});
