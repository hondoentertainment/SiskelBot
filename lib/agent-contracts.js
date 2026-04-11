/**
 * Phase 47.3: Contract enforcement for agent negotiation.
 *
 * Once a bid is accepted (lib/agent-negotiation.js), a contract record is
 * persisted in the same workspace store. This module provides helpers to
 * create, execute, and inspect contracts. Contract execution monitors the
 * agent's deliverables and applies penalties when requirements are breached.
 */
import { _internals as _negInternals } from "./agent-negotiation.js";
import { randomUUID } from "crypto";

const { withStore, loadStore } = _negInternals;

function nowIso() {
  return new Date().toISOString();
}

/**
 * Create a contract from an announcement and the winning bid. Normally called
 * indirectly via acceptBid in agent-negotiation.js, but exposed here so a
 * principal can construct contracts manually (e.g. cross-workspace transfer).
 *
 * @param {object} announcement
 * @param {object} winningBid
 * @param {string} [workspaceId]
 * @returns {Promise<object>} contract record
 */
export async function createContract(announcement, winningBid, workspaceId) {
  if (!announcement || typeof announcement !== "object") {
    throw new Error("announcement is required");
  }
  if (!winningBid || typeof winningBid !== "object") {
    throw new Error("winningBid is required");
  }
  const ws = workspaceId || announcement.workspaceId || "default";
  return withStore(ws, (store) => {
    const contract = {
      id: randomUUID(),
      workspaceId: ws,
      announcementId: announcement.id,
      bidId: winningBid.id,
      principalId: announcement.principalId || "anonymous",
      agentId: winningBid.agentId,
      requirements: Array.isArray(announcement.requirements) ? announcement.requirements : [],
      deadline: announcement.deadline || null,
      budget: announcement.budget || 0,
      agreedCost: winningBid.estimatedCost || 0,
      agreedTime: winningBid.estimatedTime || 0,
      proposal: winningBid.proposal || "",
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      penalties: [],
      result: null,
    };
    store.contracts.push(contract);
    return contract;
  });
}

/**
 * Execute a contract: simulates monitoring of the agent's deliverables and
 * applies penalties for breaches (over-budget, late, missing requirements).
 *
 * The actual agent execution happens elsewhere — this function is a control
 * point that records the outcome and updates contract state.
 *
 * @param {string} contractId
 * @param {object} [execution] Execution record from agent runtime
 * @param {boolean} [execution.completed]
 * @param {number} [execution.actualCost]
 * @param {number} [execution.actualTime] in ms
 * @param {string[]} [execution.deliveredRequirements]
 * @param {string} [execution.notes]
 * @param {string} [workspaceId]
 * @returns {Promise<object>} updated contract
 */
export async function executeContract(contractId, execution = {}, workspaceId = "default") {
  if (!contractId) throw new Error("contractId is required");
  return withStore(workspaceId, (store) => {
    const contract = store.contracts.find((c) => c.id === contractId);
    if (!contract) throw new Error("contract not found");
    if (contract.status !== "active") {
      throw new Error(`contract is ${contract.status}, cannot execute`);
    }

    const completed = !!execution.completed;
    const actualCost = Number.isFinite(execution.actualCost) ? execution.actualCost : contract.agreedCost;
    const actualTime = Number.isFinite(execution.actualTime) ? execution.actualTime : contract.agreedTime;
    const delivered = Array.isArray(execution.deliveredRequirements)
      ? execution.deliveredRequirements
      : contract.requirements;

    const penalties = [];

    // Penalty: over-budget
    if (contract.budget > 0 && actualCost > contract.budget) {
      penalties.push({
        type: "over_budget",
        amount: actualCost - contract.budget,
        message: `Actual cost ${actualCost} exceeded budget ${contract.budget}`,
      });
    }

    // Penalty: cost exceeded agreed cost (less severe)
    if (contract.agreedCost > 0 && actualCost > contract.agreedCost * 1.1) {
      penalties.push({
        type: "agreed_cost_exceeded",
        amount: actualCost - contract.agreedCost,
        message: `Actual cost ${actualCost} exceeded agreed cost ${contract.agreedCost} by >10%`,
      });
    }

    // Penalty: missed deadline
    if (contract.deadline) {
      const dl = Date.parse(contract.deadline);
      if (Number.isFinite(dl) && Date.now() > dl) {
        penalties.push({
          type: "missed_deadline",
          message: `Deadline ${contract.deadline} passed`,
        });
      }
    }

    // Penalty: time over agreed
    if (contract.agreedTime > 0 && actualTime > contract.agreedTime * 1.5) {
      penalties.push({
        type: "slow_execution",
        message: `Actual time ${actualTime} exceeded agreed time ${contract.agreedTime} by >50%`,
      });
    }

    // Penalty: missing required deliverables
    const missing = contract.requirements.filter((r) => !delivered.includes(r));
    if (missing.length > 0) {
      penalties.push({
        type: "missing_requirements",
        items: missing,
        message: `Missing deliverables: ${missing.join(", ")}`,
      });
    }

    contract.penalties = penalties;
    contract.result = {
      completed,
      actualCost,
      actualTime,
      deliveredRequirements: delivered,
      notes: typeof execution.notes === "string" ? execution.notes.slice(0, 1_000) : "",
    };
    contract.updatedAt = nowIso();

    if (!completed) {
      contract.status = "breached";
    } else if (penalties.length > 0) {
      contract.status = "fulfilled_with_penalties";
    } else {
      contract.status = "fulfilled";
    }

    return contract;
  });
}

/**
 * Look up a contract by id.
 *
 * @param {string} contractId
 * @param {string} [workspaceId]
 * @returns {Promise<object|null>}
 */
export async function getContractStatus(contractId, workspaceId = "default") {
  if (!contractId) throw new Error("contractId is required");
  const store = await loadStore(workspaceId);
  const contract = store.contracts.find((c) => c.id === contractId);
  return contract || null;
}

/**
 * List all contracts in a workspace, optionally filtered by agent or principal.
 *
 * @param {object} [filter]
 * @param {string} [filter.workspaceId]
 * @param {string} [filter.agentId]
 * @param {string} [filter.principalId]
 * @param {string} [filter.status]
 * @returns {Promise<object[]>}
 */
export async function listContracts(filter = {}) {
  const workspaceId = filter.workspaceId || "default";
  const store = await loadStore(workspaceId);
  let items = store.contracts;
  if (filter.agentId) items = items.filter((c) => c.agentId === filter.agentId);
  if (filter.principalId) items = items.filter((c) => c.principalId === filter.principalId);
  if (filter.status) items = items.filter((c) => c.status === filter.status);
  return items;
}

/**
 * Cancel an active contract before execution. The agent is released and the
 * announcement is reopened only via the negotiation API; here we just mark
 * the contract cancelled.
 *
 * @param {string} contractId
 * @param {string} reason
 * @param {string} [workspaceId]
 */
export async function cancelContract(contractId, reason, workspaceId = "default") {
  if (!contractId) throw new Error("contractId is required");
  return withStore(workspaceId, (store) => {
    const contract = store.contracts.find((c) => c.id === contractId);
    if (!contract) throw new Error("contract not found");
    if (contract.status !== "active") {
      throw new Error(`contract is ${contract.status}, cannot cancel`);
    }
    contract.status = "cancelled";
    contract.cancelledReason = typeof reason === "string" ? reason.slice(0, 500) : "cancelled";
    contract.updatedAt = nowIso();
    return contract;
  });
}
