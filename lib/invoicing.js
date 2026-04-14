/**
 * Phase 71.5: Invoicing / receipt generation.
 *
 * Monotonic per-workspace invoice numbers, integer-cent arithmetic, and both
 * JSON and plain-text export formats.
 *
 * Storage layout:
 *   data/invoicing/{workspaceId}.json — all invoices for the workspace
 *   data/invoicing/_counters.json     — per-workspace monotonic counters
 *   data/invoicing/_index.json        — invoiceId -> workspace
 *   data/invoicing/_workspaces.json   — known workspaces
 */
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";
import { randomUUID } from "crypto";

export const INVOICE_STATUSES = Object.freeze(["draft", "issued", "paid", "void"]);

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

function workspacePath(workspaceId) {
  return join(getDataDir(), "invoicing", `${sanitizeId(workspaceId)}.json`);
}

function countersPath() {
  return join(getDataDir(), "invoicing", "_counters.json");
}

function indexPath() {
  return join(getDataDir(), "invoicing", "_index.json");
}

function workspacesPath() {
  return join(getDataDir(), "invoicing", "_workspaces.json");
}

async function touchWorkspace(workspaceId) {
  const ws = sanitizeId(workspaceId);
  await withPathLock(workspacesPath(), async () => {
    const idx = await readJsonPath(workspacesPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(workspacesPath(), { workspaces: list });
    }
  });
}

async function nextInvoiceNumber(workspaceId) {
  const ws = sanitizeId(workspaceId);
  let next = 1;
  await withPathLock(countersPath(), async () => {
    const store = await readJsonPath(countersPath(), { counters: {} });
    const counters = store.counters && typeof store.counters === "object" ? store.counters : {};
    const current = Number(counters[ws]) || 0;
    next = current + 1;
    counters[ws] = next;
    await writeJsonPath(countersPath(), { counters });
  });
  return next;
}

async function indexInvoice(invoiceId, workspaceId) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { invoices: {} });
    const map = idx.invoices && typeof idx.invoices === "object" ? idx.invoices : {};
    map[invoiceId] = sanitizeId(workspaceId);
    await writeJsonPath(indexPath(), { invoices: map });
  });
}

async function workspaceOfInvoice(invoiceId) {
  const idx = await readJsonPath(indexPath(), { invoices: {} });
  const map = idx.invoices && typeof idx.invoices === "object" ? idx.invoices : {};
  return map[invoiceId] || null;
}

function normalizeLineItem(raw, idx) {
  if (!raw || typeof raw !== "object") throw new Error(`lineItems[${idx}] must be an object`);
  const quantity = Number(raw.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`lineItems[${idx}].quantity must be a non-negative number`);
  }
  const unitPriceCents = usdToCents(raw.unitPrice);
  if (unitPriceCents < 0) throw new Error(`lineItems[${idx}].unitPrice must be non-negative`);
  let amountCents;
  if (raw.amount !== undefined && raw.amount !== null) {
    amountCents = usdToCents(raw.amount);
  } else {
    amountCents = Math.round(unitPriceCents * quantity);
  }
  return {
    description: String(raw.description || "").slice(0, 500),
    quantity,
    unitPriceCents,
    unitPrice: centsToUsd(unitPriceCents),
    amountCents,
    amount: centsToUsd(amountCents),
  };
}

/**
 * Create a new invoice in "draft" state.
 *
 * @param {{
 *   workspaceId: string,
 *   periodStart: number, periodEnd: number,
 *   lineItems: Array<{description,quantity,unitPrice,amount?}>,
 *   currency?: string, taxRate?: number, customer?: object,
 * }} input
 */
export async function createInvoice(input = {}) {
  if (!input || !input.workspaceId) throw new Error("workspaceId is required");
  if (!Array.isArray(input.lineItems) || input.lineItems.length === 0) {
    throw new Error("lineItems must be a non-empty array");
  }
  const workspaceId = sanitizeId(input.workspaceId);
  const currency = input.currency ? String(input.currency).toUpperCase().slice(0, 8) : "USD";
  const taxRate = Number(input.taxRate);
  const tax = Number.isFinite(taxRate) && taxRate >= 0 ? taxRate : 0;

  const items = input.lineItems.map((li, i) => normalizeLineItem(li, i));
  const subtotalCents = items.reduce((s, li) => s + li.amountCents, 0);
  const taxCents = Math.round(subtotalCents * tax);
  const totalCents = subtotalCents + taxCents;
  const number = await nextInvoiceNumber(workspaceId);
  const invoice = {
    invoiceId: randomUUID(),
    workspaceId,
    number,
    status: "issued",
    subtotalCents,
    subtotal: centsToUsd(subtotalCents),
    taxRate: tax,
    taxCents,
    tax: centsToUsd(taxCents),
    totalCents,
    total: centsToUsd(totalCents),
    currency,
    periodStart: Number(input.periodStart) || 0,
    periodEnd: Number(input.periodEnd) || 0,
    lineItems: items,
    customer: input.customer && typeof input.customer === "object" ? input.customer : null,
    paidAt: null,
    paymentReference: null,
    voidReason: null,
    createdAt: Date.now(),
  };
  await withPathLock(workspacePath(workspaceId), async () => {
    const store = await readJsonPath(workspacePath(workspaceId), { invoices: [] });
    const list = Array.isArray(store.invoices) ? store.invoices : [];
    list.push(invoice);
    await writeJsonPath(workspacePath(workspaceId), { invoices: list });
  });
  await touchWorkspace(workspaceId);
  await indexInvoice(invoice.invoiceId, workspaceId);
  return invoice;
}

export async function getInvoice(invoiceId) {
  if (!invoiceId) return null;
  const ws = await workspaceOfInvoice(invoiceId);
  if (!ws) return null;
  const store = await readJsonPath(workspacePath(ws), { invoices: [] });
  const list = Array.isArray(store.invoices) ? store.invoices : [];
  return list.find((i) => i.invoiceId === invoiceId) || null;
}

export async function listInvoices(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(workspacePath(ws), { invoices: [] });
  const list = Array.isArray(store.invoices) ? store.invoices : [];
  return list.slice().sort((a, b) => b.number - a.number);
}

export async function markPaid(input = {}) {
  if (!input || !input.invoiceId) throw new Error("invoiceId is required");
  if (!input.paymentReference) throw new Error("paymentReference is required");
  const ws = await workspaceOfInvoice(input.invoiceId);
  if (!ws) throw new Error("invoice not found");
  const paidAt = typeof input.paidAt === "number" ? input.paidAt : Date.now();
  let updated = null;
  await withPathLock(workspacePath(ws), async () => {
    const store = await readJsonPath(workspacePath(ws), { invoices: [] });
    const list = Array.isArray(store.invoices) ? store.invoices : [];
    const idx = list.findIndex((i) => i.invoiceId === input.invoiceId);
    if (idx < 0) throw new Error("invoice not found");
    if (list[idx].status === "void") throw new Error("cannot mark void invoice as paid");
    list[idx] = {
      ...list[idx],
      status: "paid",
      paidAt,
      paymentReference: String(input.paymentReference).slice(0, 200),
    };
    updated = list[idx];
    await writeJsonPath(workspacePath(ws), { invoices: list });
  });
  return updated;
}

export async function voidInvoice(input = {}) {
  if (!input || !input.invoiceId) throw new Error("invoiceId is required");
  if (!input.reason) throw new Error("reason is required");
  const ws = await workspaceOfInvoice(input.invoiceId);
  if (!ws) throw new Error("invoice not found");
  let updated = null;
  await withPathLock(workspacePath(ws), async () => {
    const store = await readJsonPath(workspacePath(ws), { invoices: [] });
    const list = Array.isArray(store.invoices) ? store.invoices : [];
    const idx = list.findIndex((i) => i.invoiceId === input.invoiceId);
    if (idx < 0) throw new Error("invoice not found");
    if (list[idx].status === "paid") throw new Error("cannot void a paid invoice");
    list[idx] = {
      ...list[idx],
      status: "void",
      voidReason: String(input.reason).slice(0, 500),
    };
    updated = list[idx];
    await writeJsonPath(workspacePath(ws), { invoices: list });
  });
  return updated;
}

export async function exportInvoiceJson(invoiceId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error("invoice not found");
  return JSON.stringify(inv, null, 2);
}

function padRight(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function fmtMoney(usd, currency) {
  return `${currency} ${Number(usd).toFixed(2)}`;
}

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

export async function exportInvoiceText(invoiceId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error("invoice not found");
  const lines = [];
  lines.push(`INVOICE #${inv.number}`);
  lines.push("=".repeat(40));
  lines.push(`Workspace:   ${inv.workspaceId}`);
  lines.push(`Invoice ID:  ${inv.invoiceId}`);
  lines.push(`Status:      ${inv.status.toUpperCase()}`);
  lines.push(`Period:      ${fmtDate(inv.periodStart)} to ${fmtDate(inv.periodEnd)}`);
  lines.push(`Created:     ${fmtDate(inv.createdAt)}`);
  if (inv.paidAt) lines.push(`Paid:        ${fmtDate(inv.paidAt)} (ref: ${inv.paymentReference})`);
  if (inv.voidReason) lines.push(`Void reason: ${inv.voidReason}`);
  lines.push("");
  lines.push(padRight("DESCRIPTION", 30) + padLeft("QTY", 8) + padLeft("UNIT", 12) + padLeft("AMOUNT", 14));
  lines.push("-".repeat(64));
  for (const li of inv.lineItems) {
    lines.push(
      padRight(li.description, 30) +
        padLeft(String(li.quantity), 8) +
        padLeft(fmtMoney(li.unitPrice, inv.currency), 12) +
        padLeft(fmtMoney(li.amount, inv.currency), 14),
    );
  }
  lines.push("-".repeat(64));
  lines.push(padLeft(`Subtotal: ${fmtMoney(inv.subtotal, inv.currency)}`, 64));
  lines.push(padLeft(`Tax (${(inv.taxRate * 100).toFixed(2)}%): ${fmtMoney(inv.tax, inv.currency)}`, 64));
  lines.push(padLeft(`TOTAL:    ${fmtMoney(inv.total, inv.currency)}`, 64));
  return lines.join("\n");
}

export async function _reset() {
  const idx = await readJsonPath(workspacesPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { invoices: [] });
  }
  await writeJsonPath(workspacesPath(), { workspaces: [] });
  await writeJsonPath(countersPath(), { counters: {} });
  await writeJsonPath(indexPath(), { invoices: {} });
}

export const _internals = { sanitizeId, usdToCents, centsToUsd, workspacePath, countersPath, indexPath };
