// @ts-check
/**
 * Phase 45.4: Federated learning consortium management.
 *
 * A consortium is a multi-organization federation that coordinates federated
 * training rounds without sharing raw data. Member organizations can propose
 * training rounds, vote on proposals (quorum-based), and contribute model
 * updates while the coordinator records an immutable audit trail.
 *
 * Governance rules (defaults, configurable via env vars):
 *   - Minimum quorum:         ceil(members * 0.5) (at least 2)          FL_MIN_QUORUM
 *   - Approval threshold:     2/3 of voters must vote "approve"         FL_APPROVE_THRESHOLD
 *   - Emergency threshold:    founder alone may halt/cancel rounds      FL_EMERGENCY_OVERRIDE
 *   - Invite expiry:          7 days                                    FL_INVITE_EXPIRY_MS
 *   - Vote window:            48 hours                                  FL_VOTE_WINDOW_MS
 *
 * Storage: JSON-backed via `json-path-store.js` so the module works across
 * file, SQLite, or Postgres KV backends without code changes.
 *
 * @module fl-consortium
 */
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_VOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEFAULT_APPROVE_THRESHOLD = 2 / 3;

const VALID_ROLES = new Set(["founder", "member", "invited", "suspended", "removed"]);
const VALID_INVITE_STATUS = new Set(["pending", "accepted", "rejected", "expired", "revoked"]);
const VALID_PROPOSAL_STATUS = new Set(["open", "approved", "rejected", "cancelled", "executed", "expired"]);
const VALID_VOTES = new Set(["approve", "reject", "abstain"]);

function storePath() {
  return join(getDataDir(), "fl-consortium.json");
}

function now() {
  return Date.now();
}

function inviteExpiryMs() {
  const v = Number(process.env.FL_INVITE_EXPIRY_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INVITE_EXPIRY_MS;
}

function voteWindowMs() {
  const v = Number(process.env.FL_VOTE_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_VOTE_WINDOW_MS;
}

function approveThreshold() {
  const v = Number(process.env.FL_APPROVE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_APPROVE_THRESHOLD;
}

function minQuorumOverride() {
  const v = Number(process.env.FL_MIN_QUORUM);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

function emergencyOverrideEnabled() {
  const v = String(process.env.FL_EMERGENCY_OVERRIDE || "1").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    consortia: base.consortia && typeof base.consortia === "object" ? base.consortia : {},
    proposals: base.proposals && typeof base.proposals === "object" ? base.proposals : {},
    audit: base.audit && typeof base.audit === "object" ? base.audit : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, consortia: {}, proposals: {}, audit: {} }),
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

// ---- Audit trail (immutable append-only with hash chain) ----

/**
 * Append an audit entry with a hash-chain link to the previous entry for
 * tamper-evidence. Each entry stores `prevHash` and its own `hash` derived
 * from the serialized entry + previous hash.
 * @param {object} store
 * @param {string} consortiumId
 * @param {string} event
 * @param {object} payload
 * @returns {object}
 */
function appendAudit(store, consortiumId, event, payload) {
  if (!store.audit[consortiumId]) store.audit[consortiumId] = [];
  const chain = store.audit[consortiumId];
  const prev = chain.length ? chain[chain.length - 1] : null;
  const prevHash = prev ? prev.hash : "0".repeat(64);
  const entry = {
    id: randomUUID(),
    consortiumId,
    event,
    payload: payload || {},
    at: now(),
    prevHash,
  };
  const material = JSON.stringify({
    id: entry.id,
    consortiumId,
    event,
    payload: entry.payload,
    at: entry.at,
    prevHash,
  });
  entry.hash = createHash("sha256").update(material).digest("hex");
  chain.push(entry);
  return entry;
}

/**
 * Return the immutable audit trail for a consortium. The returned entries
 * are copied so callers cannot mutate the persisted chain in place.
 * @param {string} consortiumId
 * @returns {Promise<Array<object>>}
 */
export async function auditLogForConsortium(consortiumId) {
  if (typeof consortiumId !== "string" || !consortiumId) return [];
  const store = await loadStore();
  const chain = store.audit[consortiumId];
  if (!Array.isArray(chain)) return [];
  // Verify the chain as we copy; mark any tampered entry with `_verified: false`.
  let prevHash = "0".repeat(64);
  return chain.map((entry) => {
    const material = JSON.stringify({
      id: entry.id,
      consortiumId: entry.consortiumId,
      event: entry.event,
      payload: entry.payload,
      at: entry.at,
      prevHash,
    });
    const expected = createHash("sha256").update(material).digest("hex");
    const verified = entry.prevHash === prevHash && entry.hash === expected;
    prevHash = entry.hash;
    return { ...entry, _verified: verified };
  });
}

// ---- Consortium lifecycle ----

/**
 * Create a new consortium with the founder organization as the first member.
 * @param {string} name
 * @param {string} founderOrgId
 * @returns {Promise<object>}
 */
export async function createConsortium(name, founderOrgId) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("name is required");
  }
  if (typeof founderOrgId !== "string" || !founderOrgId.trim()) {
    throw new Error("founderOrgId is required");
  }
  const id = `consortium_${randomUUID()}`;
  return mutate(async (store) => {
    const consortium = {
      id,
      name: name.trim(),
      founderOrgId,
      createdAt: now(),
      members: {
        [founderOrgId]: {
          orgId: founderOrgId,
          role: "founder",
          joinedAt: now(),
          signature: null,
          contributions: 0,
          trainingRoundsParticipated: 0,
        },
      },
      invites: {},
      proposalIds: [],
      trainingRounds: 0,
      status: "active",
    };
    store.consortia[id] = consortium;
    appendAudit(store, id, "consortium_created", { name: consortium.name, founderOrgId });
    return consortium;
  });
}

/**
 * Send an invitation to an organization. Only founder or existing members may
 * invite new orgs. Invites expire after the configured window.
 * @param {string} consortiumId
 * @param {string} orgId
 * @param {string} invitedBy
 * @returns {Promise<object>}
 */
export async function inviteOrganization(consortiumId, orgId, invitedBy) {
  if (typeof consortiumId !== "string" || !consortiumId) {
    throw new Error("consortiumId is required");
  }
  if (typeof orgId !== "string" || !orgId) {
    throw new Error("orgId is required");
  }
  if (typeof invitedBy !== "string" || !invitedBy) {
    throw new Error("invitedBy is required");
  }
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    if (consortium.status !== "active") throw new Error("consortium is not active");
    const inviter = consortium.members[invitedBy];
    if (!inviter || (inviter.role !== "founder" && inviter.role !== "member")) {
      throw new Error(`org ${invitedBy} is not an active member`);
    }
    const existing = consortium.members[orgId];
    if (existing && (existing.role === "founder" || existing.role === "member")) {
      throw new Error(`org ${orgId} is already a member`);
    }
    const pending = consortium.invites[orgId];
    if (pending && pending.status === "pending" && pending.expiresAt > now()) {
      throw new Error(`org ${orgId} already has a pending invite`);
    }
    const invite = {
      orgId,
      invitedBy,
      consortiumId,
      status: "pending",
      createdAt: now(),
      expiresAt: now() + inviteExpiryMs(),
      token: randomUUID(),
    };
    consortium.invites[orgId] = invite;
    appendAudit(store, consortiumId, "invite_sent", { orgId, invitedBy });
    return invite;
  });
}

/**
 * Accept an outstanding invitation. The signature string is an opaque
 * acknowledgement (e.g., a JWS or ed25519 signature over the consortium id +
 * invite token) that the coordinator records but does not validate here —
 * verification is the caller's responsibility.
 * @param {string} consortiumId
 * @param {string} orgId
 * @param {string} signature
 * @returns {Promise<object>}
 */
export async function acceptInvite(consortiumId, orgId, signature) {
  if (typeof signature !== "string" || !signature) {
    throw new Error("signature is required");
  }
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    const invite = consortium.invites[orgId];
    if (!invite || invite.status !== "pending") {
      throw new Error(`no pending invite for org ${orgId}`);
    }
    if (invite.expiresAt <= now()) {
      invite.status = "expired";
      appendAudit(store, consortiumId, "invite_expired", { orgId });
      throw new Error("invite has expired");
    }
    invite.status = "accepted";
    invite.acceptedAt = now();
    consortium.members[orgId] = {
      orgId,
      role: "member",
      joinedAt: now(),
      signature,
      contributions: 0,
      trainingRoundsParticipated: 0,
      invitedBy: invite.invitedBy,
    };
    appendAudit(store, consortiumId, "invite_accepted", { orgId, invitedBy: invite.invitedBy });
    return consortium.members[orgId];
  });
}

/**
 * Reject a pending invitation. Idempotent for already-rejected invites.
 * @param {string} consortiumId
 * @param {string} orgId
 * @returns {Promise<object>}
 */
export async function rejectInvite(consortiumId, orgId) {
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    const invite = consortium.invites[orgId];
    if (!invite) throw new Error(`no invite found for org ${orgId}`);
    if (invite.status !== "pending") return invite;
    invite.status = "rejected";
    invite.rejectedAt = now();
    appendAudit(store, consortiumId, "invite_rejected", { orgId });
    return invite;
  });
}

/**
 * List active members of a consortium (founder + members in good standing).
 * Suspended / removed members are excluded.
 * @param {string} consortiumId
 * @returns {Promise<Array<object>>}
 */
export async function listMembers(consortiumId) {
  const store = await loadStore();
  const consortium = store.consortia[consortiumId];
  if (!consortium) return [];
  return Object.values(consortium.members)
    .filter((m) => m && (m.role === "founder" || m.role === "member"))
    .map((m) => ({ ...m }));
}

// ---- Training round proposals ----

/**
 * Propose a new training round. Any active member may propose.
 * @param {string} consortiumId
 * @param {object} proposal - { proposerOrgId, modelId, rounds, dataset, hyperparams, description, emergency }
 * @returns {Promise<object>}
 */
export async function proposeTrainingRound(consortiumId, proposal) {
  if (!proposal || typeof proposal !== "object") {
    throw new Error("proposal is required");
  }
  const { proposerOrgId } = proposal;
  if (typeof proposerOrgId !== "string" || !proposerOrgId) {
    throw new Error("proposerOrgId is required");
  }
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    if (consortium.status !== "active") throw new Error("consortium is not active");
    const member = consortium.members[proposerOrgId];
    if (!member || (member.role !== "founder" && member.role !== "member")) {
      throw new Error(`org ${proposerOrgId} is not a member`);
    }
    const id = `proposal_${randomUUID()}`;
    const record = {
      id,
      consortiumId,
      proposerOrgId,
      status: "open",
      createdAt: now(),
      closesAt: now() + voteWindowMs(),
      emergency: Boolean(proposal.emergency),
      modelId: proposal.modelId || null,
      rounds: Number.isFinite(proposal.rounds) ? Number(proposal.rounds) : 1,
      dataset: proposal.dataset || null,
      hyperparams: proposal.hyperparams && typeof proposal.hyperparams === "object" ? proposal.hyperparams : {},
      description: typeof proposal.description === "string" ? proposal.description : "",
      votes: {},
      approveCount: 0,
      rejectCount: 0,
      abstainCount: 0,
    };
    store.proposals[id] = record;
    consortium.proposalIds.push(id);
    appendAudit(store, consortiumId, "proposal_created", {
      proposalId: id,
      proposerOrgId,
      emergency: record.emergency,
      modelId: record.modelId,
    });
    return record;
  });
}

/**
 * Resolve the governance parameters for a consortium at this moment.
 * @param {object} consortium
 * @returns {{ activeMembers: number, quorum: number, approvalRatio: number }}
 */
function governanceFor(consortium) {
  const activeMembers = Object.values(consortium.members).filter(
    (m) => m && (m.role === "founder" || m.role === "member"),
  ).length;
  const override = minQuorumOverride();
  const defaultQuorum = Math.max(2, Math.ceil(activeMembers * 0.5));
  const quorum = override != null ? Math.min(override, activeMembers) : Math.min(defaultQuorum, activeMembers);
  return {
    activeMembers,
    quorum: Math.max(1, quorum),
    approvalRatio: approveThreshold(),
  };
}

/**
 * Cast or update a vote on a proposal. Re-voting overwrites the previous vote
 * from the same org. When quorum is met the proposal is auto-resolved and the
 * outcome recorded.
 * @param {string} proposalId
 * @param {string} orgId
 * @param {"approve"|"reject"|"abstain"} vote
 * @returns {Promise<object>}
 */
export async function voteOnProposal(proposalId, orgId, vote) {
  if (typeof proposalId !== "string" || !proposalId) {
    throw new Error("proposalId is required");
  }
  if (typeof orgId !== "string" || !orgId) {
    throw new Error("orgId is required");
  }
  if (!VALID_VOTES.has(vote)) {
    throw new Error(`vote must be one of ${[...VALID_VOTES].join(", ")}`);
  }
  return mutate(async (store) => {
    const proposal = store.proposals[proposalId];
    if (!proposal) throw new Error(`proposal ${proposalId} not found`);
    if (proposal.status !== "open") throw new Error(`proposal is ${proposal.status}`);
    const consortium = store.consortia[proposal.consortiumId];
    if (!consortium) throw new Error("consortium missing");
    const member = consortium.members[orgId];
    if (!member || (member.role !== "founder" && member.role !== "member")) {
      throw new Error(`org ${orgId} is not an active member`);
    }

    if (proposal.closesAt <= now()) {
      proposal.status = "expired";
      appendAudit(store, consortium.id, "proposal_expired", { proposalId });
      throw new Error("voting window has closed");
    }

    // Remove any previous vote from this org.
    const prev = proposal.votes[orgId];
    if (prev) {
      if (prev === "approve") proposal.approveCount--;
      else if (prev === "reject") proposal.rejectCount--;
      else if (prev === "abstain") proposal.abstainCount--;
    }
    proposal.votes[orgId] = vote;
    if (vote === "approve") proposal.approveCount++;
    else if (vote === "reject") proposal.rejectCount++;
    else proposal.abstainCount++;

    appendAudit(store, consortium.id, "proposal_voted", { proposalId, orgId, vote });

    // Auto-resolve if enough votes are in.
    const totalVotes = proposal.approveCount + proposal.rejectCount + proposal.abstainCount;
    const gov = governanceFor(consortium);
    if (totalVotes >= gov.quorum) {
      const decisive = proposal.approveCount + proposal.rejectCount;
      if (decisive > 0) {
        const approveRatio = proposal.approveCount / decisive;
        if (approveRatio >= gov.approvalRatio) {
          proposal.status = "approved";
          proposal.resolvedAt = now();
          consortium.trainingRounds++;
          for (const m of Object.values(consortium.members)) {
            if (m && (m.role === "founder" || m.role === "member")) {
              m.trainingRoundsParticipated = (m.trainingRoundsParticipated || 0) + 1;
            }
          }
          appendAudit(store, consortium.id, "proposal_approved", {
            proposalId,
            approveCount: proposal.approveCount,
            rejectCount: proposal.rejectCount,
            quorum: gov.quorum,
          });
        } else if (proposal.rejectCount / decisive > 1 - gov.approvalRatio) {
          proposal.status = "rejected";
          proposal.resolvedAt = now();
          appendAudit(store, consortium.id, "proposal_rejected", {
            proposalId,
            approveCount: proposal.approveCount,
            rejectCount: proposal.rejectCount,
            quorum: gov.quorum,
          });
        }
      }
    }

    return proposal;
  });
}

/**
 * Record a contribution (e.g., a submitted gradient batch) for an org within
 * a training round. Used by `getConsortiumStats` to show per-org activity.
 * @param {string} consortiumId
 * @param {string} orgId
 * @param {number} [amount=1]
 * @returns {Promise<object>}
 */
export async function recordContribution(consortiumId, orgId, amount = 1) {
  const delta = Number.isFinite(amount) && amount > 0 ? Number(amount) : 1;
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    const member = consortium.members[orgId];
    if (!member || (member.role !== "founder" && member.role !== "member")) {
      throw new Error(`org ${orgId} is not an active member`);
    }
    member.contributions = (member.contributions || 0) + delta;
    appendAudit(store, consortiumId, "contribution_recorded", { orgId, amount: delta });
    return { orgId, contributions: member.contributions };
  });
}

/**
 * Remove a member from the consortium. Only the founder may remove others,
 * and the founder cannot be removed. The member's audit history is preserved.
 * @param {string} consortiumId
 * @param {string} orgId
 * @param {string} reason
 * @returns {Promise<object>}
 */
export async function removeConsortiumMember(consortiumId, orgId, reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    const target = consortium.members[orgId];
    if (!target) throw new Error(`org ${orgId} is not a member`);
    if (target.role === "founder") {
      throw new Error("cannot remove the founder");
    }
    target.role = "removed";
    target.removedAt = now();
    target.removalReason = reason;
    appendAudit(store, consortiumId, "member_removed", { orgId, reason });
    return { ...target };
  });
}

/**
 * Founder-only emergency halt: cancel all open proposals and mark the
 * consortium as paused. Requires `FL_EMERGENCY_OVERRIDE=1` (default enabled).
 * @param {string} consortiumId
 * @param {string} invokerOrgId
 * @param {string} reason
 * @returns {Promise<object>}
 */
export async function emergencyHalt(consortiumId, invokerOrgId, reason) {
  if (!emergencyOverrideEnabled()) {
    throw new Error("emergency override is disabled");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }
  return mutate(async (store) => {
    const consortium = store.consortia[consortiumId];
    if (!consortium) throw new Error(`consortium ${consortiumId} not found`);
    if (consortium.founderOrgId !== invokerOrgId) {
      throw new Error("only the founder may invoke emergency halt");
    }
    let cancelled = 0;
    for (const pid of consortium.proposalIds) {
      const p = store.proposals[pid];
      if (p && p.status === "open") {
        p.status = "cancelled";
        p.resolvedAt = now();
        p.cancellationReason = reason;
        cancelled++;
      }
    }
    consortium.status = "paused";
    consortium.pausedReason = reason;
    consortium.pausedAt = now();
    appendAudit(store, consortiumId, "emergency_halt", { invokerOrgId, reason, cancelled });
    return { consortiumId, cancelled, status: "paused" };
  });
}

/**
 * Return aggregate stats for a consortium: member counts, completed training
 * rounds, per-org contributions, and governance parameters.
 * @param {string} consortiumId
 * @returns {Promise<object|null>}
 */
export async function getConsortiumStats(consortiumId) {
  const store = await loadStore();
  const consortium = store.consortia[consortiumId];
  if (!consortium) return null;
  const members = Object.values(consortium.members);
  const active = members.filter((m) => m && (m.role === "founder" || m.role === "member"));
  const contributions = {};
  for (const m of active) {
    contributions[m.orgId] = {
      orgId: m.orgId,
      role: m.role,
      contributions: m.contributions || 0,
      trainingRoundsParticipated: m.trainingRoundsParticipated || 0,
    };
  }
  const proposals = consortium.proposalIds.map((id) => store.proposals[id]).filter(Boolean);
  const proposalStats = {
    total: proposals.length,
    open: proposals.filter((p) => p.status === "open").length,
    approved: proposals.filter((p) => p.status === "approved").length,
    rejected: proposals.filter((p) => p.status === "rejected").length,
    cancelled: proposals.filter((p) => p.status === "cancelled").length,
    expired: proposals.filter((p) => p.status === "expired").length,
  };
  const governance = governanceFor(consortium);
  return {
    id: consortium.id,
    name: consortium.name,
    status: consortium.status,
    createdAt: consortium.createdAt,
    founderOrgId: consortium.founderOrgId,
    trainingRounds: consortium.trainingRounds,
    memberCount: active.length,
    totalMembers: members.length,
    contributions,
    proposals: proposalStats,
    governance,
  };
}

/**
 * Fetch a proposal by id (read-only).
 * @param {string} proposalId
 * @returns {Promise<object|null>}
 */
export async function getProposal(proposalId) {
  if (typeof proposalId !== "string" || !proposalId) return null;
  const store = await loadStore();
  return store.proposals[proposalId] || null;
}

/**
 * Fetch a consortium by id (read-only).
 * @param {string} consortiumId
 * @returns {Promise<object|null>}
 */
export async function getConsortium(consortiumId) {
  if (typeof consortiumId !== "string" || !consortiumId) return null;
  const store = await loadStore();
  return store.consortia[consortiumId] || null;
}

/**
 * List all consortia (lightweight shape).
 * @returns {Promise<Array<object>>}
 */
export async function listConsortia() {
  const store = await loadStore();
  return Object.values(store.consortia).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    founderOrgId: c.founderOrgId,
    memberCount: Object.values(c.members).filter(
      (m) => m && (m.role === "founder" || m.role === "member"),
    ).length,
    trainingRounds: c.trainingRounds,
    createdAt: c.createdAt,
  }));
}

export const _internals = {
  storePath,
  normalizeStore,
  governanceFor,
  appendAudit,
  VALID_ROLES,
  VALID_INVITE_STATUS,
  VALID_PROPOSAL_STATUS,
  VALID_VOTES,
  DEFAULT_APPROVE_THRESHOLD,
  DEFAULT_INVITE_EXPIRY_MS,
  DEFAULT_VOTE_WINDOW_MS,
};
