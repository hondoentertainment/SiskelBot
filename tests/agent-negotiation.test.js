/**
 * Phase 47.3: Tests for agent negotiation, contracts, and resource quotas.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createTaskAnnouncement,
  submitBid,
  selectBid,
  acceptBid,
  rejectBid,
  getOpenAnnouncements,
  getBidsForAnnouncement,
  recordNegotiationOutcome,
  getAgentMarketStats,
  negotiateResourceQuota,
  computeValue,
  BID_STRATEGIES,
} from "../lib/agent-negotiation.js";

import {
  createContract,
  executeContract,
  getContractStatus,
  listContracts,
  cancelContract,
} from "../lib/agent-contracts.js";

function uniqueWs(label) {
  return `neg-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Announcement creation ---

test("createTaskAnnouncement persists an open announcement", async () => {
  const ws = uniqueWs("ann");
  const ann = await createTaskAnnouncement({
    description: "Summarize incoming bug reports",
    requirements: ["nlp", "summarization"],
    deadline: new Date(Date.now() + 60_000).toISOString(),
    budget: 10,
    priority: "high",
    workspaceId: ws,
    principalId: "alice",
  });
  assert.ok(ann.id);
  assert.equal(ann.status, "open");
  assert.equal(ann.priority, "high");
  assert.equal(ann.principalId, "alice");
  assert.deepEqual(ann.requirements, ["nlp", "summarization"]);
});

test("createTaskAnnouncement rejects missing description", async () => {
  await assert.rejects(() => createTaskAnnouncement({ workspaceId: uniqueWs("bad") }), /description/);
});

test("getOpenAnnouncements lists only open and unexpired", async () => {
  const ws = uniqueWs("open");
  const a1 = await createTaskAnnouncement({ description: "task A", workspaceId: ws });
  await createTaskAnnouncement({
    description: "task B (expired)",
    workspaceId: ws,
    deadline: new Date(Date.now() - 1000).toISOString(),
  });
  const list = await getOpenAnnouncements({ workspaceId: ws });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, a1.id);
});

test("getOpenAnnouncements filters by priority and requirements", async () => {
  const ws = uniqueWs("filter");
  await createTaskAnnouncement({
    description: "low task",
    workspaceId: ws,
    priority: "low",
    requirements: ["docs"],
  });
  const high = await createTaskAnnouncement({
    description: "high task",
    workspaceId: ws,
    priority: "high",
    requirements: ["nlp"],
  });
  const filteredHigh = await getOpenAnnouncements({ workspaceId: ws, priority: "high" });
  assert.equal(filteredHigh.length, 1);
  assert.equal(filteredHigh[0].id, high.id);
  const filteredReq = await getOpenAnnouncements({ workspaceId: ws, requirements: ["docs"] });
  assert.equal(filteredReq.length, 1);
  assert.equal(filteredReq[0].requirements[0], "docs");
});

// --- Bid submission ---

test("submitBid attaches a normalized bid to an announcement", async () => {
  const ws = uniqueWs("bid");
  const ann = await createTaskAnnouncement({ description: "Index docs", workspaceId: ws });
  const bid = await submitBid(
    ann.id,
    "agent-1",
    {
      estimatedTime: 1500,
      estimatedCost: 4.5,
      confidence: 0.9,
      capabilities: ["indexing"],
      proposal: "Use BM25 + chunking",
    },
    ws
  );
  assert.ok(bid.id);
  assert.equal(bid.agentId, "agent-1");
  assert.equal(bid.status, "pending");
  assert.equal(bid.confidence, 0.9);
  assert.equal(bid.estimatedCost, 4.5);
});

test("submitBid clamps confidence to [0,1] and rejects unknown announcement", async () => {
  const ws = uniqueWs("clamp");
  const ann = await createTaskAnnouncement({ description: "x", workspaceId: ws });
  const bid = await submitBid(ann.id, "agent-2", { confidence: 5 }, ws);
  assert.equal(bid.confidence, 1);
  await assert.rejects(() => submitBid("missing", "agent-2", {}, ws), /not found/);
});

test("submitBid withdraws a previous pending bid from the same agent", async () => {
  const ws = uniqueWs("withdraw");
  const ann = await createTaskAnnouncement({ description: "y", workspaceId: ws });
  await submitBid(ann.id, "agent-3", { estimatedCost: 10 }, ws);
  await submitBid(ann.id, "agent-3", { estimatedCost: 5 }, ws);
  const all = await getBidsForAnnouncement(ann.id, ws);
  const pending = all.filter((b) => b.status === "pending");
  const withdrawn = all.filter((b) => b.status === "withdrawn");
  assert.equal(pending.length, 1);
  assert.equal(withdrawn.length, 1);
  assert.equal(pending[0].estimatedCost, 5);
});

// --- Bid selection strategies ---

test("BID_STRATEGIES.lowest_cost picks the cheapest bid", () => {
  const bids = [
    { id: "a", estimatedCost: 10, estimatedTime: 1, confidence: 0.5 },
    { id: "b", estimatedCost: 3, estimatedTime: 5, confidence: 0.5 },
    { id: "c", estimatedCost: 7, estimatedTime: 2, confidence: 0.9 },
  ];
  assert.equal(BID_STRATEGIES.lowest_cost(bids).id, "b");
});

test("BID_STRATEGIES.fastest picks the lowest estimatedTime", () => {
  const bids = [
    { id: "a", estimatedCost: 10, estimatedTime: 5, confidence: 0.5 },
    { id: "b", estimatedCost: 3, estimatedTime: 1, confidence: 0.5 },
  ];
  assert.equal(BID_STRATEGIES.fastest(bids).id, "b");
});

test("BID_STRATEGIES.highest_confidence picks the highest confidence", () => {
  const bids = [
    { id: "a", estimatedCost: 1, estimatedTime: 1, confidence: 0.4 },
    { id: "b", estimatedCost: 1, estimatedTime: 1, confidence: 0.95 },
  ];
  assert.equal(BID_STRATEGIES.highest_confidence(bids).id, "b");
});

test("BID_STRATEGIES.best_value combines cost, time, and confidence", () => {
  const bids = [
    { id: "cheap-slow", estimatedCost: 1, estimatedTime: 100, confidence: 0.5 },
    { id: "fast-confident", estimatedCost: 5, estimatedTime: 1, confidence: 0.95 },
    { id: "mediocre", estimatedCost: 10, estimatedTime: 10, confidence: 0.5 },
  ];
  const winner = BID_STRATEGIES.best_value(bids);
  assert.equal(winner.id, "fast-confident");
});

test("BID_STRATEGIES return null for empty input", () => {
  assert.equal(BID_STRATEGIES.lowest_cost([]), null);
  assert.equal(BID_STRATEGIES.fastest([]), null);
  assert.equal(BID_STRATEGIES.highest_confidence([]), null);
  assert.equal(BID_STRATEGIES.best_value([]), null);
});

test("computeValue rewards higher confidence", () => {
  const a = { confidence: 0.9, estimatedCost: 5, estimatedTime: 5 };
  const b = { confidence: 0.2, estimatedCost: 5, estimatedTime: 5 };
  assert.ok(computeValue(a) > computeValue(b));
});

test("selectBid honours the requested strategy on persisted bids", async () => {
  const ws = uniqueWs("select");
  const ann = await createTaskAnnouncement({ description: "compile", workspaceId: ws });
  await submitBid(ann.id, "a1", { estimatedCost: 10, estimatedTime: 100, confidence: 0.5 }, ws);
  await submitBid(ann.id, "a2", { estimatedCost: 3, estimatedTime: 50, confidence: 0.7 }, ws);
  const cheapest = await selectBid(ann.id, "lowest_cost", ws);
  assert.equal(cheapest.agentId, "a2");
  await assert.rejects(() => selectBid(ann.id, "magic", ws), /invalid strategy/);
});

// --- Accept / reject ---

test("acceptBid creates contract and rejects sibling bids", async () => {
  const ws = uniqueWs("accept");
  const ann = await createTaskAnnouncement({
    description: "deploy",
    requirements: ["k8s"],
    budget: 100,
    workspaceId: ws,
    principalId: "ops",
  });
  const b1 = await submitBid(ann.id, "agentA", { estimatedCost: 50, estimatedTime: 200, confidence: 0.8 }, ws);
  const b2 = await submitBid(ann.id, "agentB", { estimatedCost: 80, estimatedTime: 300, confidence: 0.6 }, ws);
  const result = await acceptBid(b1.id, "ops", ws);
  assert.equal(result.bid.status, "accepted");
  assert.equal(result.announcement.status, "awarded");
  assert.equal(result.announcement.awardedBidId, b1.id);
  assert.ok(result.contract.id);
  assert.equal(result.contract.agentId, "agentA");
  const all = await getBidsForAnnouncement(ann.id, ws);
  const sibling = all.find((b) => b.id === b2.id);
  assert.equal(sibling.status, "rejected");
});

test("acceptBid fails when bid is already non-pending", async () => {
  const ws = uniqueWs("acceptdup");
  const ann = await createTaskAnnouncement({ description: "deploy v2", workspaceId: ws });
  const b1 = await submitBid(ann.id, "agentA", { estimatedCost: 50 }, ws);
  await acceptBid(b1.id, "ops", ws);
  await assert.rejects(() => acceptBid(b1.id, "ops", ws), /cannot accept/);
});

test("rejectBid moves a single bid to rejected", async () => {
  const ws = uniqueWs("reject");
  const ann = await createTaskAnnouncement({ description: "task", workspaceId: ws });
  const b = await submitBid(ann.id, "agentX", { estimatedCost: 1 }, ws);
  const updated = await rejectBid(b.id, "underqualified", ws);
  assert.equal(updated.status, "rejected");
  assert.equal(updated.rejectionReason, "underqualified");
});

test("submitBid fails after announcement is awarded", async () => {
  const ws = uniqueWs("postaward");
  const ann = await createTaskAnnouncement({ description: "x", workspaceId: ws });
  const b = await submitBid(ann.id, "a1", { estimatedCost: 5 }, ws);
  await acceptBid(b.id, "owner", ws);
  await assert.rejects(() => submitBid(ann.id, "a2", { estimatedCost: 1 }, ws), /cannot accept bids/);
});

// --- Contracts ---

test("createContract directly creates and lists a contract", async () => {
  const ws = uniqueWs("contract");
  const ann = await createTaskAnnouncement({
    description: "build report",
    requirements: ["sql"],
    budget: 20,
    workspaceId: ws,
  });
  const bid = await submitBid(ann.id, "agentZ", { estimatedCost: 15, estimatedTime: 60 }, ws);
  const contract = await createContract(ann, bid, ws);
  assert.equal(contract.status, "active");
  assert.equal(contract.agentId, "agentZ");
  const found = await getContractStatus(contract.id, ws);
  assert.equal(found.id, contract.id);
  const list = await listContracts({ workspaceId: ws, agentId: "agentZ" });
  assert.ok(list.length >= 1);
});

test("executeContract marks contract fulfilled when delivered", async () => {
  const ws = uniqueWs("exec-ok");
  const ann = await createTaskAnnouncement({
    description: "ok task",
    requirements: ["a", "b"],
    budget: 10,
    workspaceId: ws,
  });
  const bid = await submitBid(ann.id, "ag1", { estimatedCost: 5, estimatedTime: 100, confidence: 0.9 }, ws);
  const { contract } = await acceptBid(bid.id, "owner", ws);
  const result = await executeContract(
    contract.id,
    {
      completed: true,
      actualCost: 5,
      actualTime: 100,
      deliveredRequirements: ["a", "b"],
    },
    ws
  );
  assert.equal(result.status, "fulfilled");
  assert.equal(result.penalties.length, 0);
});

test("executeContract applies over-budget and missing-requirements penalties", async () => {
  const ws = uniqueWs("exec-penalty");
  const ann = await createTaskAnnouncement({
    description: "expensive task",
    requirements: ["a", "b", "c"],
    budget: 10,
    workspaceId: ws,
  });
  const bid = await submitBid(ann.id, "ag2", { estimatedCost: 8, estimatedTime: 50 }, ws);
  const { contract } = await acceptBid(bid.id, "owner", ws);
  const result = await executeContract(
    contract.id,
    {
      completed: true,
      actualCost: 25,
      actualTime: 50,
      deliveredRequirements: ["a"],
    },
    ws
  );
  assert.equal(result.status, "fulfilled_with_penalties");
  const types = result.penalties.map((p) => p.type);
  assert.ok(types.includes("over_budget"));
  assert.ok(types.includes("missing_requirements"));
});

test("executeContract marks contract breached when not completed", async () => {
  const ws = uniqueWs("exec-breach");
  const ann = await createTaskAnnouncement({ description: "fragile", workspaceId: ws });
  const bid = await submitBid(ann.id, "ag3", { estimatedCost: 1 }, ws);
  const { contract } = await acceptBid(bid.id, "owner", ws);
  const result = await executeContract(contract.id, { completed: false }, ws);
  assert.equal(result.status, "breached");
});

test("cancelContract marks an active contract cancelled", async () => {
  const ws = uniqueWs("cancel");
  const ann = await createTaskAnnouncement({ description: "cancel me", workspaceId: ws });
  const bid = await submitBid(ann.id, "ag4", { estimatedCost: 2 }, ws);
  const { contract } = await acceptBid(bid.id, "owner", ws);
  const cancelled = await cancelContract(contract.id, "no longer needed", ws);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelledReason, "no longer needed");
});

// --- Market stats ---

test("getAgentMarketStats tracks bids and outcomes", async () => {
  const ws = uniqueWs("stats");
  const a1 = await createTaskAnnouncement({ description: "stats task 1", workspaceId: ws });
  const a2 = await createTaskAnnouncement({ description: "stats task 2", workspaceId: ws });
  const b1 = await submitBid(a1.id, "rep-agent", { estimatedCost: 5 }, ws);
  const b2 = await submitBid(a2.id, "rep-agent", { estimatedCost: 5 }, ws);
  await acceptBid(b1.id, "owner", ws);
  await rejectBid(b2.id, "passed", ws);
  await recordNegotiationOutcome(b1.id, { success: true, actualCost: 4, actualTime: 80 }, ws);
  const stats = await getAgentMarketStats("rep-agent", ws);
  assert.equal(stats.bidsTotal, 2);
  assert.equal(stats.bidsWon, 1);
  assert.equal(stats.bidsLost, 1);
  assert.equal(stats.outcomesRecorded, 1);
  assert.equal(stats.successRate, 1);
  assert.equal(stats.avgCost, 4);
  assert.equal(stats.avgTime, 80);
});

test("recordNegotiationOutcome tracks failures in success rate", async () => {
  const ws = uniqueWs("fail");
  const ann = await createTaskAnnouncement({ description: "fail task", workspaceId: ws });
  const bid = await submitBid(ann.id, "fail-agent", { estimatedCost: 3 }, ws);
  await acceptBid(bid.id, "owner", ws);
  await recordNegotiationOutcome(bid.id, { success: false, actualCost: 9 }, ws);
  const stats = await getAgentMarketStats("fail-agent", ws);
  assert.equal(stats.successRate, 0);
  assert.equal(stats.avgCost, 9);
});

// --- Resource quota negotiation ---

test("negotiateResourceQuota grants requested amount under limit", () => {
  const result = negotiateResourceQuota({ id: "agent-q", successRate: 0.8 }, "tokens", 1000);
  assert.equal(result.granted, true);
  assert.equal(result.quota, 1000);
  assert.equal(result.resourceType, "tokens");
  assert.ok(result.price > 0);
});

test("negotiateResourceQuota caps requests above the limit", () => {
  const result = negotiateResourceQuota({ id: "agent-q", successRate: 0.5 }, "tokens", 5_000_000);
  assert.equal(result.granted, false);
  assert.equal(result.quota, 1_000_000);
  assert.match(result.reason, /exceeds limit/);
});

test("negotiateResourceQuota gives reputation discount", () => {
  const lowRep = negotiateResourceQuota({ successRate: 0 }, "tools", 100);
  const highRep = negotiateResourceQuota({ successRate: 1 }, "tools", 100);
  assert.ok(highRep.price < lowRep.price);
});

test("negotiateResourceQuota validates inputs", () => {
  const noAgent = negotiateResourceQuota(null, "tokens", 100);
  assert.equal(noAgent.granted, false);
  const noResource = negotiateResourceQuota({}, "", 100);
  assert.equal(noResource.granted, false);
  const noAmount = negotiateResourceQuota({}, "tokens", 0);
  assert.equal(noAmount.granted, false);
});
