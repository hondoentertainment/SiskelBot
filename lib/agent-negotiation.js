/**
 * Phase 47.3: Agent negotiation protocols for distributed task allocation.
 *
 * Implements a contract-net + market-based negotiation system where agents
 * bid on announced tasks and a principal selects a winner using a configurable
 * strategy. Tracks per-agent market reputation (success rate, average cost,
 * average completion time) and supports negotiating for resource quotas.
 *
 * Storage: data/agent-negotiation/{workspaceId}.json
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_ANNOUNCEMENTS_PER_WORKSPACE = 10_000;
const MAX_BIDS_PER_ANNOUNCEMENT = 500;

const VALID_STRATEGIES = new Set([
  "lowest_cost",
  "fastest",
  "highest_confidence",
  "best_value",
]);

const STATUS_OPEN = "open";
const STATUS_AWARDED = "awarded";
const STATUS_CANCELLED = "cancelled";
const STATUS_EXPIRED = "expired";

const BID_PENDING = "pending";
const BID_ACCEPTED = "accepted";
const BID_REJECTED = "rejected";
const BID_WITHDRAWN = "withdrawn";

function sanitizeWs(ws) {
  if (typeof ws !== "string" || !ws.trim()) return "default";
  return ws.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
}

function negotiationPath(workspaceId) {
  const ws = sanitizeWs(workspaceId);
  return join(getDataDir(), "agent-negotiation", `${ws}.json`);
}

function defaultStore() {
  return {
    _version: 1,
    announcements: [],
    bids: [],
    contracts: [],
    outcomes: [],
    quotas: {},
  };
}

async function loadStore(workspaceId) {
  const path = negotiationPath(workspaceId);
  const data = await readJsonPath(path, defaultStore());
  return {
    _version: data._version || 1,
    announcements: Array.isArray(data.announcements) ? data.announcements : [],
    bids: Array.isArray(data.bids) ? data.bids : [],
    contracts: Array.isArray(data.contracts) ? data.contracts : [],
    outcomes: Array.isArray(data.outcomes) ? data.outcomes : [],
    quotas: data.quotas && typeof data.quotas === "object" ? data.quotas : {},
  };
}

async function saveStore(workspaceId, store) {
  const path = negotiationPath(workspaceId);
  if (store.announcements.length > MAX_ANNOUNCEMENTS_PER_WORKSPACE) {
    store.announcements = store.announcements.slice(-MAX_ANNOUNCEMENTS_PER_WORKSPACE);
  }
  await writeJsonPath(path, store);
}

function withStore(workspaceId, fn) {
  const path = negotiationPath(workspaceId);
  return withPathLock(path, async () => {
    const store = await loadStore(workspaceId);
    const result = await fn(store);
    await saveStore(workspaceId, store);
    return result;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function normalizeBid(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    estimatedTime: Math.max(0, normalizeNumber(raw.estimatedTime, 0)),
    estimatedCost: Math.max(0, normalizeNumber(raw.estimatedCost, 0)),
    confidence: Math.max(0, Math.min(1, normalizeNumber(raw.confidence, 0))),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.slice(0, 50).map(String) : [],
    proposal: typeof raw.proposal === "string" ? raw.proposal.slice(0, 4_000) : "",
  };
}

function isExpired(announcement) {
  if (!announcement.deadline) return false;
  const dl = Date.parse(announcement.deadline);
  if (!Number.isFinite(dl)) return false;
  return Date.now() > dl;
}

/**
 * Compute a value score for "best_value" strategy.
 * Higher is better. Combines confidence (positive) with cost and time (negative).
 *
 * value = confidence * 100 - normalizedCost - normalizedTime
 */
export function computeValue(bid, opts = {}) {
  const maxCost = normalizeNumber(opts.maxCost, 1) || 1;
  const maxTime = normalizeNumber(opts.maxTime, 1) || 1;
  const conf = normalizeNumber(bid.confidence, 0);
  const cost = normalizeNumber(bid.estimatedCost, 0);
  const time = normalizeNumber(bid.estimatedTime, 0);
  return conf * 100 - (cost / maxCost) * 50 - (time / maxTime) * 50;
}

/**
 * Bid selection strategies. Each takes an array of bid objects and returns the
 * winning bid (or null when there are no candidates).
 */
export const BID_STRATEGIES = {
  lowest_cost: (bids) => {
    if (!Array.isArray(bids) || bids.length === 0) return null;
    return [...bids].sort((a, b) => a.estimatedCost - b.estimatedCost)[0];
  },
  fastest: (bids) => {
    if (!Array.isArray(bids) || bids.length === 0) return null;
    return [...bids].sort((a, b) => a.estimatedTime - b.estimatedTime)[0];
  },
  highest_confidence: (bids) => {
    if (!Array.isArray(bids) || bids.length === 0) return null;
    return [...bids].sort((a, b) => b.confidence - a.confidence)[0];
  },
  best_value: (bids) => {
    if (!Array.isArray(bids) || bids.length === 0) return null;
    const maxCost = bids.reduce((m, b) => Math.max(m, b.estimatedCost || 0), 1);
    const maxTime = bids.reduce((m, b) => Math.max(m, b.estimatedTime || 0), 1);
    return [...bids].sort(
      (a, b) => computeValue(b, { maxCost, maxTime }) - computeValue(a, { maxCost, maxTime })
    )[0];
  },
};

/**
 * Broadcast a new task announcement to eligible agents.
 *
 * @param {object} task
 * @param {string} [task.id]
 * @param {string} task.description
 * @param {string[]} [task.requirements]
 * @param {string} [task.deadline] ISO timestamp
 * @param {number} [task.budget]
 * @param {string} [task.priority] low|normal|high|critical
 * @param {string} [task.workspaceId]
 * @param {string} [task.principalId]
 * @returns {Promise<object>} announcement record
 */
export async function createTaskAnnouncement(task) {
  if (!task || typeof task !== "object") {
    throw new Error("task is required");
  }
  if (typeof task.description !== "string" || !task.description.trim()) {
    throw new Error("description is required");
  }
  const workspaceId = task.workspaceId || "default";
  return withStore(workspaceId, (store) => {
    const announcement = {
      id: task.id || randomUUID(),
      workspaceId,
      principalId: task.principalId || "anonymous",
      description: task.description.trim().slice(0, 4_000),
      requirements: Array.isArray(task.requirements)
        ? task.requirements.slice(0, 50).map((r) => String(r).slice(0, 200))
        : [],
      deadline: task.deadline || null,
      budget: normalizeNumber(task.budget, 0),
      priority: ["low", "normal", "high", "critical"].includes(task.priority)
        ? task.priority
        : "normal",
      status: STATUS_OPEN,
      createdAt: nowIso(),
      awardedBidId: null,
      contractId: null,
    };
    store.announcements.push(announcement);
    return announcement;
  });
}

/**
 * Submit a bid against an open announcement.
 *
 * @param {string} announcementId
 * @param {string} agentId
 * @param {object} bid
 * @param {string} [workspaceId]
 * @returns {Promise<object>} bid record
 */
export async function submitBid(announcementId, agentId, bid, workspaceId = "default") {
  if (!announcementId) throw new Error("announcementId is required");
  if (!agentId) throw new Error("agentId is required");
  const normalized = normalizeBid(bid);
  if (!normalized) throw new Error("bid is required");

  return withStore(workspaceId, (store) => {
    const announcement = store.announcements.find((a) => a.id === announcementId);
    if (!announcement) throw new Error("announcement not found");
    if (announcement.status !== STATUS_OPEN) {
      throw new Error(`announcement is ${announcement.status}, cannot accept bids`);
    }
    if (isExpired(announcement)) {
      announcement.status = STATUS_EXPIRED;
      throw new Error("announcement has expired");
    }
    const existingForAgent = store.bids.filter(
      (b) => b.announcementId === announcementId && b.agentId === agentId && b.status === BID_PENDING
    );
    for (const prev of existingForAgent) {
      prev.status = BID_WITHDRAWN;
      prev.updatedAt = nowIso();
    }
    const bidsForAnnouncement = store.bids.filter((b) => b.announcementId === announcementId);
    if (bidsForAnnouncement.length >= MAX_BIDS_PER_ANNOUNCEMENT) {
      throw new Error("bid limit reached for announcement");
    }
    const record = {
      id: randomUUID(),
      announcementId,
      agentId,
      ...normalized,
      status: BID_PENDING,
      submittedAt: nowIso(),
      updatedAt: nowIso(),
    };
    store.bids.push(record);
    return record;
  });
}

/**
 * Select a winning bid for an announcement using the given strategy.
 * Does NOT mutate state — call acceptBid to finalize.
 *
 * @param {string} announcementId
 * @param {string} strategy
 * @param {string} [workspaceId]
 * @returns {Promise<object|null>} winning bid or null
 */
export async function selectBid(announcementId, strategy, workspaceId = "default") {
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`invalid strategy: ${strategy}`);
  }
  const store = await loadStore(workspaceId);
  const announcement = store.announcements.find((a) => a.id === announcementId);
  if (!announcement) throw new Error("announcement not found");
  const candidates = store.bids.filter(
    (b) => b.announcementId === announcementId && b.status === BID_PENDING
  );
  if (candidates.length === 0) return null;
  const fn = BID_STRATEGIES[strategy];
  return fn(candidates);
}

/**
 * Accept a bid: marks it accepted, marks the announcement awarded, and creates
 * a contract record between the principal and the winning agent.
 *
 * @param {string} bidId
 * @param {string} principalId
 * @param {string} [workspaceId]
 * @returns {Promise<{ bid: object, announcement: object, contract: object }>}
 */
export async function acceptBid(bidId, principalId, workspaceId = "default") {
  if (!bidId) throw new Error("bidId is required");
  return withStore(workspaceId, (store) => {
    const bid = store.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error("bid not found");
    if (bid.status !== BID_PENDING) {
      throw new Error(`bid is ${bid.status}, cannot accept`);
    }
    const announcement = store.announcements.find((a) => a.id === bid.announcementId);
    if (!announcement) throw new Error("announcement not found");
    if (announcement.status !== STATUS_OPEN) {
      throw new Error(`announcement is ${announcement.status}, cannot accept bid`);
    }

    bid.status = BID_ACCEPTED;
    bid.updatedAt = nowIso();

    // Reject siblings
    for (const other of store.bids) {
      if (other.announcementId === bid.announcementId && other.id !== bid.id && other.status === BID_PENDING) {
        other.status = BID_REJECTED;
        other.updatedAt = nowIso();
        other.rejectionReason = "another bid was selected";
      }
    }

    announcement.status = STATUS_AWARDED;
    announcement.awardedBidId = bid.id;

    const contract = {
      id: randomUUID(),
      workspaceId,
      announcementId: announcement.id,
      bidId: bid.id,
      principalId: principalId || announcement.principalId || "anonymous",
      agentId: bid.agentId,
      requirements: announcement.requirements,
      deadline: announcement.deadline,
      budget: announcement.budget,
      agreedCost: bid.estimatedCost,
      agreedTime: bid.estimatedTime,
      proposal: bid.proposal,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      penalties: [],
      result: null,
    };
    store.contracts.push(contract);
    announcement.contractId = contract.id;

    return { bid, announcement, contract };
  });
}

/**
 * Reject an individual bid.
 *
 * @param {string} bidId
 * @param {string} reason
 * @param {string} [workspaceId]
 * @returns {Promise<object>} updated bid
 */
export async function rejectBid(bidId, reason, workspaceId = "default") {
  if (!bidId) throw new Error("bidId is required");
  return withStore(workspaceId, (store) => {
    const bid = store.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error("bid not found");
    if (bid.status !== BID_PENDING) {
      throw new Error(`bid is ${bid.status}, cannot reject`);
    }
    bid.status = BID_REJECTED;
    bid.rejectionReason = typeof reason === "string" ? reason.slice(0, 500) : "rejected";
    bid.updatedAt = nowIso();
    return bid;
  });
}

/**
 * List open announcements, optionally filtered.
 *
 * @param {object} [filter]
 * @param {string} [filter.workspaceId]
 * @param {string} [filter.priority]
 * @param {string[]} [filter.requirements] Match if any requirement intersects
 * @returns {Promise<object[]>}
 */
export async function getOpenAnnouncements(filter = {}) {
  const workspaceId = filter.workspaceId || "default";
  const store = await loadStore(workspaceId);
  let items = store.announcements.filter((a) => a.status === STATUS_OPEN && !isExpired(a));
  if (filter.priority) {
    items = items.filter((a) => a.priority === filter.priority);
  }
  if (Array.isArray(filter.requirements) && filter.requirements.length) {
    const req = new Set(filter.requirements.map(String));
    items = items.filter((a) => a.requirements.some((r) => req.has(r)));
  }
  return items;
}

/**
 * List bids for a particular announcement.
 *
 * @param {string} announcementId
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function getBidsForAnnouncement(announcementId, workspaceId = "default") {
  if (!announcementId) throw new Error("announcementId is required");
  const store = await loadStore(workspaceId);
  return store.bids.filter((b) => b.announcementId === announcementId);
}

/**
 * Record the outcome of a completed contract for the agent's reputation.
 *
 * @param {string} bidId
 * @param {object} outcome
 * @param {boolean} outcome.success
 * @param {number} [outcome.actualCost]
 * @param {number} [outcome.actualTime]
 * @param {string} [outcome.notes]
 * @param {string} [workspaceId]
 * @returns {Promise<object>} outcome record
 */
export async function recordNegotiationOutcome(bidId, outcome, workspaceId = "default") {
  if (!bidId) throw new Error("bidId is required");
  if (!outcome || typeof outcome !== "object") throw new Error("outcome is required");
  return withStore(workspaceId, (store) => {
    const bid = store.bids.find((b) => b.id === bidId);
    if (!bid) throw new Error("bid not found");
    const record = {
      id: randomUUID(),
      bidId,
      agentId: bid.agentId,
      announcementId: bid.announcementId,
      success: !!outcome.success,
      actualCost: normalizeNumber(outcome.actualCost, bid.estimatedCost),
      actualTime: normalizeNumber(outcome.actualTime, bid.estimatedTime),
      notes: typeof outcome.notes === "string" ? outcome.notes.slice(0, 1_000) : "",
      recordedAt: nowIso(),
    };
    store.outcomes.push(record);
    return record;
  });
}

/**
 * Get aggregate market statistics for an agent.
 *
 * @param {string} agentId
 * @param {string} [workspaceId]
 * @returns {Promise<{ agentId: string, bidsTotal: number, bidsWon: number, bidsLost: number, successRate: number, avgCost: number, avgTime: number }>}
 */
export async function getAgentMarketStats(agentId, workspaceId = "default") {
  if (!agentId) throw new Error("agentId is required");
  const store = await loadStore(workspaceId);
  const agentBids = store.bids.filter((b) => b.agentId === agentId);
  const won = agentBids.filter((b) => b.status === BID_ACCEPTED).length;
  const lost = agentBids.filter((b) => b.status === BID_REJECTED).length;
  const outcomes = store.outcomes.filter((o) => o.agentId === agentId);
  const successes = outcomes.filter((o) => o.success).length;
  const successRate = outcomes.length > 0 ? successes / outcomes.length : 0;
  const avgCost =
    outcomes.length > 0 ? outcomes.reduce((s, o) => s + (o.actualCost || 0), 0) / outcomes.length : 0;
  const avgTime =
    outcomes.length > 0 ? outcomes.reduce((s, o) => s + (o.actualTime || 0), 0) / outcomes.length : 0;
  return {
    agentId,
    bidsTotal: agentBids.length,
    bidsWon: won,
    bidsLost: lost,
    outcomesRecorded: outcomes.length,
    successRate,
    avgCost,
    avgTime,
  };
}

/**
 * Negotiate for a resource quota grant. Pricing scales with the requested
 * amount and the agent's success-rate reputation reduces the unit price.
 *
 * @param {{ id?: string, agentId?: string, successRate?: number }} agent
 * @param {string} resourceType e.g. "tokens", "tools", "memory"
 * @param {number} amount
 * @returns {{ granted: boolean, quota: number, price: number, resourceType: string }}
 */
export function negotiateResourceQuota(agent, resourceType, amount) {
  if (!agent || typeof agent !== "object") {
    return { granted: false, quota: 0, price: 0, resourceType, reason: "agent required" };
  }
  if (typeof resourceType !== "string" || !resourceType) {
    return { granted: false, quota: 0, price: 0, resourceType, reason: "resourceType required" };
  }
  const requested = Math.max(0, normalizeNumber(amount, 0));
  if (requested === 0) {
    return { granted: false, quota: 0, price: 0, resourceType, reason: "amount must be > 0" };
  }
  const limits = {
    tokens: 1_000_000,
    tools: 1_000,
    memory: 100_000,
  };
  const unitPrices = {
    tokens: 0.0001,
    tools: 0.01,
    memory: 0.001,
  };
  const max = limits[resourceType] ?? 100;
  const unit = unitPrices[resourceType] ?? 0.01;
  const reputation = Math.max(0, Math.min(1, normalizeNumber(agent.successRate, 0.5)));
  // High reputation gets up to 30% discount.
  const discount = 1 - reputation * 0.3;
  const granted = requested <= max;
  const quota = granted ? requested : max;
  const price = quota * unit * discount;
  return {
    granted,
    quota,
    price: Number(price.toFixed(6)),
    resourceType,
    reputation,
    reason: granted ? "ok" : "request exceeds limit; granted maximum",
  };
}

// --- Internal helpers exposed for contracts module ---
export const _internals = {
  loadStore,
  saveStore,
  withStore,
  STATUS_OPEN,
  STATUS_AWARDED,
  STATUS_CANCELLED,
  STATUS_EXPIRED,
  BID_PENDING,
  BID_ACCEPTED,
  BID_REJECTED,
  BID_WITHDRAWN,
  negotiationPath,
};
