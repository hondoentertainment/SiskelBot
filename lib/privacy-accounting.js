/**
 * Phase 45.5: Privacy accounting — track (ε, δ) privacy budget across training runs.
 *
 * Provides a differential-privacy budget ledger with strong composition,
 * Rényi DP (RDP) accountant for the sub-sampled Gaussian mechanism
 * (used by DP-SGD), RDP→DP conversion, freeze-on-exhaust semantics, and
 * JSON/CSV audit exports.
 *
 * Storage: data/privacy-accounting/{workspaceId}/{ledgerId}.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ledgerDir(workspaceId) {
  const ws = sanitize(workspaceId, "default");
  return join(getDataDir(), "privacy-accounting", ws);
}

function ledgerFile(workspaceId, ledgerId) {
  return join(ledgerDir(workspaceId), `${sanitize(ledgerId, "ledger")}.json`);
}

function loadLedger(workspaceId, ledgerId) {
  const file = ledgerFile(workspaceId, ledgerId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveLedger(ledger) {
  const file = ledgerFile(ledger.workspaceId, ledger.id);
  ensureDir(file);
  writeFileSync(file, JSON.stringify(ledger, null, 2), "utf8");
}

function findLedger(ledgerId) {
  const root = join(getDataDir(), "privacy-accounting");
  if (!existsSync(root)) return null;
  const workspaces = readdirSync(root);
  for (const ws of workspaces) {
    const file = join(root, ws, `${sanitize(ledgerId, "ledger")}.json`);
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function validateEpsDelta(epsilon, delta) {
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new Error("epsilon must be a non-negative finite number");
  }
  if (!Number.isFinite(delta) || delta < 0 || delta >= 1) {
    throw new Error("delta must be in [0, 1)");
  }
}

// --------------------------------------------------------------------------
// Ledger CRUD
// --------------------------------------------------------------------------

/**
 * Initialize a new privacy ledger with a total (ε, δ) budget.
 * @param {object} budget - { epsilon, delta, workspaceId?, name?, description? }
 * @returns {object} the persisted ledger
 */
export function createPrivacyLedger(budget) {
  if (!budget || typeof budget !== "object") {
    throw new Error("budget is required");
  }
  const { epsilon, delta } = budget;
  validateEpsDelta(epsilon, delta);
  const workspaceId = sanitize(budget.workspaceId, "default");
  const id = sanitize(budget.id || `ledger-${randomUUID().slice(0, 8)}`, "ledger");
  const now = new Date().toISOString();
  const ledger = {
    _version: 1,
    id,
    workspaceId,
    name: typeof budget.name === "string" ? budget.name.slice(0, 200) : id,
    description: typeof budget.description === "string" ? budget.description.slice(0, 1000) : "",
    budget: { epsilon: Number(epsilon), delta: Number(delta) },
    spent: { epsilon: 0, delta: 0 },
    frozen: false,
    frozenAt: null,
    frozenReason: null,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
  saveLedger(ledger);
  return ledger;
}

/**
 * List all ledgers for a workspace.
 */
export function listPrivacyLedgers(workspaceId) {
  const dir = ledgerDir(workspaceId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out.push(data);
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Retrieve a ledger by id (searches all workspaces if workspaceId omitted).
 */
export function getPrivacyLedger(ledgerId, workspaceId) {
  if (workspaceId) return loadLedger(workspaceId, ledgerId);
  return findLedger(ledgerId);
}

/**
 * Delete a ledger permanently.
 */
export function deletePrivacyLedger(ledgerId, workspaceId) {
  const ledger = workspaceId ? loadLedger(workspaceId, ledgerId) : findLedger(ledgerId);
  if (!ledger) return false;
  const file = ledgerFile(ledger.workspaceId, ledger.id);
  if (existsSync(file)) {
    unlinkSync(file);
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Budget tracking
// --------------------------------------------------------------------------

/**
 * Debit (ε, δ) from a ledger for an operation. Composition is basic additive
 * (sequential composition) unless caller supplies a pre-composed bound.
 * @param {string} ledgerId
 * @param {number} epsilon
 * @param {number} delta
 * @param {string|object} operation - label or metadata object
 * @returns {object} the updated ledger
 */
export function recordPrivacyLoss(ledgerId, epsilon, delta, operation) {
  validateEpsDelta(epsilon, delta);
  const ledger = findLedger(ledgerId);
  if (!ledger) throw new Error(`ledger not found: ${ledgerId}`);
  if (ledger.frozen) {
    throw new Error(`ledger ${ledgerId} is frozen: ${ledger.frozenReason || "budget exhausted"}`);
  }
  const newEps = ledger.spent.epsilon + epsilon;
  const newDelta = ledger.spent.delta + delta;
  if (newEps > ledger.budget.epsilon + 1e-12 || newDelta > ledger.budget.delta + 1e-12) {
    throw new Error(
      `privacy budget exhausted: requested (ε=${epsilon}, δ=${delta}) would exceed ` +
        `(ε=${ledger.budget.epsilon}, δ=${ledger.budget.delta}); ` +
        `already spent (ε=${ledger.spent.epsilon}, δ=${ledger.spent.delta})`,
    );
  }
  ledger.spent.epsilon = newEps;
  ledger.spent.delta = newDelta;
  const entry = {
    id: randomUUID().slice(0, 12),
    epsilon: Number(epsilon),
    delta: Number(delta),
    operation:
      typeof operation === "string"
        ? { label: operation }
        : operation && typeof operation === "object"
          ? operation
          : { label: "unknown" },
    at: new Date().toISOString(),
  };
  ledger.entries.push(entry);
  ledger.updatedAt = entry.at;

  // Auto-freeze when at or over budget (within epsilon tolerance)
  if (
    ledger.spent.epsilon >= ledger.budget.epsilon - 1e-12 ||
    ledger.spent.delta >= ledger.budget.delta - 1e-12
  ) {
    ledger.frozen = true;
    ledger.frozenAt = entry.at;
    ledger.frozenReason = "budget exhausted";
  }
  saveLedger(ledger);
  return ledger;
}

/**
 * Return the remaining (ε, δ) budget and utilization fraction.
 */
export function getRemainingBudget(ledgerId) {
  const ledger = findLedger(ledgerId);
  if (!ledger) throw new Error(`ledger not found: ${ledgerId}`);
  const remEps = Math.max(0, ledger.budget.epsilon - ledger.spent.epsilon);
  const remDelta = Math.max(0, ledger.budget.delta - ledger.spent.delta);
  return {
    ledgerId: ledger.id,
    budget: { ...ledger.budget },
    spent: { ...ledger.spent },
    remaining: { epsilon: remEps, delta: remDelta },
    utilization: {
      epsilon: ledger.budget.epsilon > 0 ? ledger.spent.epsilon / ledger.budget.epsilon : 0,
      delta: ledger.budget.delta > 0 ? ledger.spent.delta / ledger.budget.delta : 0,
    },
    frozen: !!ledger.frozen,
  };
}

/**
 * Pre-check whether an operation fits within the remaining budget.
 * Returns { affordable: bool, reason?: string }
 */
export function canAffordOperation(ledgerId, epsilon, delta) {
  validateEpsDelta(epsilon, delta);
  const ledger = findLedger(ledgerId);
  if (!ledger) return { affordable: false, reason: `ledger not found: ${ledgerId}` };
  if (ledger.frozen) return { affordable: false, reason: "ledger is frozen" };
  const newEps = ledger.spent.epsilon + epsilon;
  const newDelta = ledger.spent.delta + delta;
  if (newEps > ledger.budget.epsilon + 1e-12) {
    return {
      affordable: false,
      reason: `would exceed ε budget (${newEps} > ${ledger.budget.epsilon})`,
    };
  }
  if (newDelta > ledger.budget.delta + 1e-12) {
    return {
      affordable: false,
      reason: `would exceed δ budget (${newDelta} > ${ledger.budget.delta})`,
    };
  }
  return { affordable: true };
}

/**
 * Freeze a ledger so no further operations can be recorded.
 * Typically used when the budget is exhausted or by admin override.
 */
export function freezeLedger(ledgerId, reason) {
  const ledger = findLedger(ledgerId);
  if (!ledger) throw new Error(`ledger not found: ${ledgerId}`);
  ledger.frozen = true;
  ledger.frozenAt = new Date().toISOString();
  ledger.frozenReason = typeof reason === "string" && reason ? reason.slice(0, 500) : "manual freeze";
  ledger.updatedAt = ledger.frozenAt;
  saveLedger(ledger);
  return ledger;
}

// --------------------------------------------------------------------------
// Composition theorems
// --------------------------------------------------------------------------

/**
 * Compose k (ε_i, δ_i) releases into an overall (ε, δ) bound.
 *
 * - "basic" (sequential additive): ε_total = Σ ε_i, δ_total = Σ δ_i
 * - "advanced" / "strong": for a slack δ' > 0,
 *     ε_total = Σ ε_i (e^{ε_i} - 1) + sqrt(2 ln(1/δ') · Σ ε_i²)
 *     δ_total = Σ δ_i + δ'
 *   (Dwork & Roth, Theorem 3.20 — applies when all ε_i equal or as upper bound.)
 *
 * @param {number[]} epsilons
 * @param {number[]} deltas
 * @param {"basic"|"advanced"|"strong"} composition
 * @param {object} [opts] - { deltaPrime: number } for advanced composition
 * @returns {{ epsilon: number, delta: number }}
 */
export function composePrivacyLoss(epsilons, deltas, composition = "basic", opts = {}) {
  if (!Array.isArray(epsilons) || !Array.isArray(deltas)) {
    throw new Error("epsilons and deltas must be arrays");
  }
  if (epsilons.length !== deltas.length) {
    throw new Error("epsilons and deltas must have equal length");
  }
  if (epsilons.length === 0) return { epsilon: 0, delta: 0 };
  for (let i = 0; i < epsilons.length; i++) {
    validateEpsDelta(epsilons[i], deltas[i]);
  }
  if (composition === "basic") {
    return {
      epsilon: epsilons.reduce((a, b) => a + b, 0),
      delta: deltas.reduce((a, b) => a + b, 0),
    };
  }
  if (composition === "advanced" || composition === "strong") {
    const deltaPrime = Number(opts.deltaPrime ?? 1e-5);
    if (!(deltaPrime > 0 && deltaPrime < 1)) {
      throw new Error("opts.deltaPrime must be in (0, 1)");
    }
    let sumSq = 0;
    let concentration = 0;
    for (const e of epsilons) {
      sumSq += e * e;
      concentration += e * (Math.exp(e) - 1);
    }
    const slack = Math.sqrt(2 * Math.log(1 / deltaPrime) * sumSq);
    const epsTotal = concentration + slack;
    const deltaTotal = deltas.reduce((a, b) => a + b, 0) + deltaPrime;
    return { epsilon: epsTotal, delta: deltaTotal };
  }
  throw new Error(`unknown composition method: ${composition}`);
}

// --------------------------------------------------------------------------
// RDP accountant (sub-sampled Gaussian mechanism, a.k.a. DP-SGD)
// --------------------------------------------------------------------------

// A canonical list of RDP orders used by standard DP-SGD accountants.
const DEFAULT_RDP_ORDERS = [
  1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10, 12, 14, 16, 20,
  24, 28, 32, 48, 64, 128, 256, 512,
];

function logSumExp(a, b) {
  // numerically stable log(e^a + e^b)
  const m = Math.max(a, b);
  if (!Number.isFinite(m)) return m;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

function logBinom(n, k) {
  // log C(n, k) using lgamma
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

// Lanczos approximation for log Gamma
function lgamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * RDP bound at order α for a single step of the sub-sampled Gaussian mechanism
 * with sampling rate q and noise multiplier σ. Based on Mironov (2017) and
 * Wang, Balle, Kasiviswanathan (2019).
 *
 * For integer α ≥ 2, we use the exact binomial expansion of the Rényi
 * divergence between q·N(1, σ²) + (1−q)·N(0, σ²) and N(0, σ²):
 *
 *   R_α(P ‖ Q) = (1 / (α − 1)) · log Σ_{k=0..α} C(α,k) (1−q)^{α−k} q^k ·
 *                  exp( k(k−1) / (2σ²) )
 *
 * For fractional α we fall back to the (tight) Gaussian bound α / (2σ²),
 * scaled by q² (the small-q regime, Wang et al. 2019).
 */
function rdpSingleStep(q, sigma, alpha) {
  if (q <= 0) return 0;
  if (sigma <= 0) return Infinity;
  if (q >= 1) return alpha / (2 * sigma * sigma);
  const isInt = Number.isInteger(alpha);
  if (isInt && alpha >= 2 && alpha <= 128) {
    // Exact binomial expansion in log space
    let logSum = -Infinity;
    for (let k = 0; k <= alpha; k++) {
      const logTerm =
        logBinom(alpha, k) +
        (alpha - k) * Math.log(1 - q) +
        k * Math.log(q) +
        (k * (k - 1)) / (2 * sigma * sigma);
      logSum = logSumExp(logSum, logTerm);
    }
    return logSum / (alpha - 1);
  }
  // Small-q Gaussian approximation (valid when q is small and σ is moderate)
  // Wang et al. 2019: approx bound q² α / σ²
  return (q * q * alpha) / (sigma * sigma);
}

/**
 * RDP accountant for the sub-sampled Gaussian mechanism (DP-SGD).
 *
 * @param {number} sigma - noise multiplier (std-dev of Gaussian noise / L2 sensitivity)
 * @param {number} samplingRate - q = batch / dataset size, in (0, 1]
 * @param {number} iterations - number of DP-SGD training steps
 * @param {number[]} [orders=DEFAULT_RDP_ORDERS] - Rényi orders to evaluate
 * @returns {{ orders: number[], rdp: number[] }}
 */
export function subsampledGaussian(sigma, samplingRate, iterations, orders) {
  if (!(sigma > 0)) throw new Error("sigma must be > 0");
  if (!(samplingRate > 0 && samplingRate <= 1)) {
    throw new Error("samplingRate must be in (0, 1]");
  }
  if (!(iterations >= 0) || !Number.isFinite(iterations)) {
    throw new Error("iterations must be a non-negative finite number");
  }
  const useOrders = Array.isArray(orders) && orders.length ? orders : DEFAULT_RDP_ORDERS;
  for (const a of useOrders) {
    if (!(a > 1)) throw new Error("all RDP orders must be > 1");
  }
  const rdp = useOrders.map((alpha) => iterations * rdpSingleStep(samplingRate, sigma, alpha));
  return { orders: useOrders.slice(), rdp };
}

/**
 * Convert an RDP curve { orders, rdp } to a single (ε, δ)-DP guarantee.
 * ε(α) = rdp(α) + log(1/δ) / (α − 1); take the min over α.
 *
 * @param {{ orders: number[], rdp: number[] }} rdp
 * @param {number} delta - target δ
 * @returns {{ epsilon: number, delta: number, optimalOrder: number }}
 */
export function convertRDPtoDP(rdp, delta) {
  if (!rdp || !Array.isArray(rdp.orders) || !Array.isArray(rdp.rdp)) {
    throw new Error("rdp must be { orders, rdp }");
  }
  if (rdp.orders.length !== rdp.rdp.length || rdp.orders.length === 0) {
    throw new Error("orders and rdp must be non-empty equal-length arrays");
  }
  if (!(delta > 0 && delta < 1)) throw new Error("delta must be in (0, 1)");
  let bestEps = Infinity;
  let bestOrder = rdp.orders[0];
  for (let i = 0; i < rdp.orders.length; i++) {
    const a = rdp.orders[i];
    const r = rdp.rdp[i];
    if (!Number.isFinite(r)) continue;
    const eps = r + Math.log(1 / delta) / (a - 1);
    if (eps < bestEps) {
      bestEps = eps;
      bestOrder = a;
    }
  }
  return { epsilon: bestEps, delta, optimalOrder: bestOrder };
}

// --------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------

/**
 * Export a ledger for audit. Supports JSON and CSV.
 * @param {string} ledgerId
 * @param {"json"|"csv"} format
 * @returns {{ contentType: string, body: string }}
 */
export function exportLedger(ledgerId, format = "json") {
  const ledger = findLedger(ledgerId);
  if (!ledger) throw new Error(`ledger not found: ${ledgerId}`);
  const fmt = String(format || "json").toLowerCase();
  if (fmt === "json") {
    return { contentType: "application/json", body: JSON.stringify(ledger, null, 2) };
  }
  if (fmt === "csv") {
    const header = "entry_id,at,epsilon,delta,operation,cumulative_epsilon,cumulative_delta";
    const lines = [header];
    let cumEps = 0;
    let cumDelta = 0;
    for (const e of ledger.entries) {
      cumEps += e.epsilon;
      cumDelta += e.delta;
      const op = e.operation && e.operation.label ? String(e.operation.label) : "";
      const safeOp = '"' + op.replace(/"/g, '""') + '"';
      lines.push(
        [e.id, e.at, e.epsilon, e.delta, safeOp, cumEps, cumDelta].join(","),
      );
    }
    return { contentType: "text/csv", body: lines.join("\n") + "\n" };
  }
  throw new Error(`unsupported export format: ${format}`);
}

export const _internals = {
  rdpSingleStep,
  logSumExp,
  logBinom,
  lgamma,
  DEFAULT_RDP_ORDERS,
};
