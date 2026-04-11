/**
 * Phase 45.4: Federated learning consortium management tests.
 *
 * Covers lifecycle (create, invite, accept, reject, remove), governance
 * (proposals, voting, quorum, approval thresholds, expiry, emergency halt),
 * statistics, and the hash-chained audit log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted state does not pollute the
// project data dir or leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fl-consortium-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;
// Force deterministic governance parameters for tests.
process.env.FL_APPROVE_THRESHOLD = "0.6667";
process.env.FL_VOTE_WINDOW_MS = "3600000";
process.env.FL_INVITE_EXPIRY_MS = "3600000";
process.env.FL_EMERGENCY_OVERRIDE = "1";

const {
  createConsortium,
  inviteOrganization,
  acceptInvite,
  rejectInvite,
  listMembers,
  proposeTrainingRound,
  voteOnProposal,
  removeConsortiumMember,
  getConsortiumStats,
  auditLogForConsortium,
  emergencyHalt,
  recordContribution,
  getProposal,
  getConsortium,
  listConsortia,
  _internals,
} = await import("../lib/fl-consortium.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

async function makeConsortium(label) {
  return createConsortium(`c-${label}-${Date.now()}`, `founder-${label}`);
}

// ---- Lifecycle ----

test("createConsortium persists a new federation with founder as member", async () => {
  const c = await createConsortium("Global Health Research", "org-mayo");
  assert.ok(c.id.startsWith("consortium_"));
  assert.equal(c.name, "Global Health Research");
  assert.equal(c.founderOrgId, "org-mayo");
  assert.equal(c.status, "active");
  assert.equal(c.members["org-mayo"].role, "founder");
});

test("createConsortium rejects missing name or founder", async () => {
  await assert.rejects(() => createConsortium("", "org-x"), /name is required/);
  await assert.rejects(() => createConsortium("name", ""), /founderOrgId is required/);
});

test("inviteOrganization creates a pending invite from the founder", async () => {
  const c = await makeConsortium("inv1");
  const invite = await inviteOrganization(c.id, "org-b", c.founderOrgId);
  assert.equal(invite.orgId, "org-b");
  assert.equal(invite.status, "pending");
  assert.ok(invite.token);
  assert.ok(invite.expiresAt > Date.now());
});

test("inviteOrganization rejects unknown inviter", async () => {
  const c = await makeConsortium("inv2");
  await assert.rejects(
    () => inviteOrganization(c.id, "org-b", "ghost-org"),
    /not an active member/,
  );
});

test("inviteOrganization rejects duplicate pending invites", async () => {
  const c = await makeConsortium("inv3");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await assert.rejects(
    () => inviteOrganization(c.id, "org-b", c.founderOrgId),
    /pending invite/,
  );
});

test("inviteOrganization rejects inviting an existing member", async () => {
  const c = await makeConsortium("inv4");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await acceptInvite(c.id, "org-b", "sig-b");
  await assert.rejects(
    () => inviteOrganization(c.id, "org-b", c.founderOrgId),
    /already a member/,
  );
});

test("acceptInvite promotes the org to member and records signature", async () => {
  const c = await makeConsortium("acc1");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  const member = await acceptInvite(c.id, "org-b", "sig-xyz");
  assert.equal(member.role, "member");
  assert.equal(member.signature, "sig-xyz");
  assert.equal(member.invitedBy, c.founderOrgId);
});

test("acceptInvite requires a signature", async () => {
  const c = await makeConsortium("acc2");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await assert.rejects(() => acceptInvite(c.id, "org-b", ""), /signature is required/);
});

test("acceptInvite rejects when no pending invite exists", async () => {
  const c = await makeConsortium("acc3");
  await assert.rejects(() => acceptInvite(c.id, "org-b", "sig"), /no pending invite/);
});

test("rejectInvite marks an invite as rejected and is idempotent", async () => {
  const c = await makeConsortium("rej1");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  const inv = await rejectInvite(c.id, "org-b");
  assert.equal(inv.status, "rejected");
  const inv2 = await rejectInvite(c.id, "org-b");
  assert.equal(inv2.status, "rejected");
});

test("listMembers returns only active members", async () => {
  const c = await makeConsortium("lm1");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await acceptInvite(c.id, "org-b", "sig-b");
  await inviteOrganization(c.id, "org-c", c.founderOrgId);
  // org-c has not yet accepted
  const members = await listMembers(c.id);
  const ids = members.map((m) => m.orgId).sort();
  assert.deepEqual(ids, [c.founderOrgId, "org-b"].sort());
});

test("removeConsortiumMember removes a member with reason", async () => {
  const c = await makeConsortium("rm1");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await acceptInvite(c.id, "org-b", "sig-b");
  const removed = await removeConsortiumMember(c.id, "org-b", "policy violation");
  assert.equal(removed.role, "removed");
  assert.equal(removed.removalReason, "policy violation");
  const members = await listMembers(c.id);
  assert.equal(members.length, 1);
});

test("removeConsortiumMember refuses to remove the founder", async () => {
  const c = await makeConsortium("rm2");
  await assert.rejects(
    () => removeConsortiumMember(c.id, c.founderOrgId, "mutiny"),
    /cannot remove the founder/,
  );
});

test("removeConsortiumMember requires a reason", async () => {
  const c = await makeConsortium("rm3");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await acceptInvite(c.id, "org-b", "sig-b");
  await assert.rejects(
    () => removeConsortiumMember(c.id, "org-b", ""),
    /reason is required/,
  );
});

// ---- Proposals and voting ----

async function consortiumWithMembers(label, count) {
  const c = await createConsortium(`p-${label}`, "founder-0");
  for (let i = 1; i < count; i++) {
    await inviteOrganization(c.id, `org-${i}`, "founder-0");
    await acceptInvite(c.id, `org-${i}`, `sig-${i}`);
  }
  return c;
}

test("proposeTrainingRound opens a proposal from any member", async () => {
  const c = await consortiumWithMembers("propose", 3);
  const prop = await proposeTrainingRound(c.id, {
    proposerOrgId: "org-1",
    modelId: "llama-3-8b",
    rounds: 5,
    dataset: "ds-42",
    hyperparams: { lr: 0.001 },
    description: "Fine-tune on shared medical records",
  });
  assert.equal(prop.status, "open");
  assert.equal(prop.proposerOrgId, "org-1");
  assert.equal(prop.modelId, "llama-3-8b");
  assert.equal(prop.rounds, 5);
});

test("proposeTrainingRound refuses non-members", async () => {
  const c = await consortiumWithMembers("propose2", 3);
  await assert.rejects(
    () => proposeTrainingRound(c.id, { proposerOrgId: "org-999", modelId: "x" }),
    /not a member/,
  );
});

test("voteOnProposal approves when 2/3 of quorum approve", async () => {
  const c = await consortiumWithMembers("vote1", 4);
  const prop = await proposeTrainingRound(c.id, {
    proposerOrgId: "founder-0",
    modelId: "model-a",
  });
  // quorum for 4 members = ceil(4*0.5) = 2. approval threshold = 2/3.
  await voteOnProposal(prop.id, "founder-0", "approve");
  const after = await voteOnProposal(prop.id, "org-1", "approve");
  assert.equal(after.status, "approved");
});

test("voteOnProposal rejects when majority rejects", async () => {
  const c = await consortiumWithMembers("vote2", 4);
  const prop = await proposeTrainingRound(c.id, {
    proposerOrgId: "founder-0",
    modelId: "model-b",
  });
  await voteOnProposal(prop.id, "founder-0", "reject");
  const after = await voteOnProposal(prop.id, "org-1", "reject");
  assert.equal(after.status, "rejected");
});

test("voteOnProposal lets orgs change their vote", async () => {
  const c = await consortiumWithMembers("vote3", 4);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await voteOnProposal(prop.id, "founder-0", "reject");
  const updated = await voteOnProposal(prop.id, "founder-0", "approve");
  assert.equal(updated.votes["founder-0"], "approve");
  assert.equal(updated.approveCount, 1);
  assert.equal(updated.rejectCount, 0);
});

test("voteOnProposal validates the vote value", async () => {
  const c = await consortiumWithMembers("vote4", 3);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await assert.rejects(
    () => voteOnProposal(prop.id, "founder-0", "maybe"),
    /vote must be one of/,
  );
});

test("voteOnProposal refuses non-members", async () => {
  const c = await consortiumWithMembers("vote5", 3);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await assert.rejects(
    () => voteOnProposal(prop.id, "org-hostile", "approve"),
    /not an active member/,
  );
});

test("voteOnProposal refuses voting on a closed proposal", async () => {
  const c = await consortiumWithMembers("vote6", 3);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await voteOnProposal(prop.id, "founder-0", "approve");
  await voteOnProposal(prop.id, "org-1", "approve");
  // proposal should now be approved with 2/2 decisive approvals
  const refreshed = await getProposal(prop.id);
  assert.equal(refreshed.status, "approved");
  await assert.rejects(
    () => voteOnProposal(prop.id, "org-2", "reject"),
    /proposal is/,
  );
});

test("abstain votes count toward quorum but not toward decisive outcome", async () => {
  // 5 members → quorum = ceil(5*0.5) = 3
  const c = await consortiumWithMembers("vote7", 5);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  // Total votes must reach quorum=3 before resolution. An abstain ensures we
  // exercise the "abstain counts toward quorum, not decisive" branch.
  await voteOnProposal(prop.id, "org-2", "abstain");
  await voteOnProposal(prop.id, "founder-0", "approve");
  const last = await voteOnProposal(prop.id, "org-1", "approve");
  assert.equal(last.status, "approved");
  // decisive = 2 (approve) + 0 (reject) = 2; approveRatio = 1.0 >= 0.6667
  assert.equal(last.approveCount, 2);
  assert.equal(last.abstainCount, 1);
});

// ---- Governance params ----

test("governanceFor computes quorum and approval ratio", async () => {
  const c = await consortiumWithMembers("gov", 5);
  const gov = _internals.governanceFor(await getConsortium(c.id));
  assert.equal(gov.activeMembers, 5);
  assert.equal(gov.quorum, 3); // ceil(5*0.5) = 3
  assert.ok(Math.abs(gov.approvalRatio - 0.6667) < 0.001);
});

// ---- Stats ----

test("getConsortiumStats returns member counts and per-org contributions", async () => {
  const c = await consortiumWithMembers("stats1", 3);
  await recordContribution(c.id, "founder-0", 5);
  await recordContribution(c.id, "org-1", 2);
  const stats = await getConsortiumStats(c.id);
  assert.equal(stats.memberCount, 3);
  assert.equal(stats.contributions["founder-0"].contributions, 5);
  assert.equal(stats.contributions["org-1"].contributions, 2);
  assert.equal(stats.contributions["org-2"].contributions, 0);
  assert.equal(stats.governance.activeMembers, 3);
});

test("getConsortiumStats tracks approved training rounds", async () => {
  const c = await consortiumWithMembers("stats2", 3);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await voteOnProposal(prop.id, "founder-0", "approve");
  await voteOnProposal(prop.id, "org-1", "approve");
  const stats = await getConsortiumStats(c.id);
  assert.equal(stats.trainingRounds, 1);
  assert.equal(stats.proposals.approved, 1);
});

test("getConsortiumStats returns null for unknown consortium", async () => {
  const stats = await getConsortiumStats("does-not-exist");
  assert.equal(stats, null);
});

// ---- Audit trail ----

test("auditLogForConsortium records creation, invite, accept, and vote events", async () => {
  const c = await consortiumWithMembers("audit1", 3);
  const prop = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  await voteOnProposal(prop.id, "founder-0", "approve");
  await voteOnProposal(prop.id, "org-1", "approve");
  const entries = await auditLogForConsortium(c.id);
  const events = entries.map((e) => e.event);
  assert.ok(events.includes("consortium_created"));
  assert.ok(events.includes("invite_sent"));
  assert.ok(events.includes("invite_accepted"));
  assert.ok(events.includes("proposal_created"));
  assert.ok(events.includes("proposal_voted"));
  assert.ok(events.includes("proposal_approved"));
});

test("auditLogForConsortium returns a hash-linked, verified chain", async () => {
  const c = await makeConsortium("audit2");
  await inviteOrganization(c.id, "org-b", c.founderOrgId);
  await acceptInvite(c.id, "org-b", "sig");
  const entries = await auditLogForConsortium(c.id);
  assert.ok(entries.length >= 3);
  for (const e of entries) {
    assert.equal(e._verified, true);
    assert.equal(typeof e.hash, "string");
    assert.equal(e.hash.length, 64);
  }
  // prevHash chaining: each entry's prevHash equals the previous entry's hash
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].prevHash, entries[i - 1].hash);
  }
});

test("auditLogForConsortium returns empty array for unknown id", async () => {
  const entries = await auditLogForConsortium("no-such-consortium");
  assert.deepEqual(entries, []);
});

// ---- Emergency halt ----

test("emergencyHalt cancels open proposals and pauses the consortium", async () => {
  const c = await consortiumWithMembers("halt1", 3);
  const p1 = await proposeTrainingRound(c.id, { proposerOrgId: "founder-0" });
  const p2 = await proposeTrainingRound(c.id, { proposerOrgId: "org-1" });
  const result = await emergencyHalt(c.id, "founder-0", "security incident");
  assert.equal(result.status, "paused");
  assert.equal(result.cancelled, 2);
  const after1 = await getProposal(p1.id);
  const after2 = await getProposal(p2.id);
  assert.equal(after1.status, "cancelled");
  assert.equal(after2.status, "cancelled");
  const fresh = await getConsortium(c.id);
  assert.equal(fresh.status, "paused");
});

test("emergencyHalt only permitted for the founder", async () => {
  const c = await consortiumWithMembers("halt2", 3);
  await assert.rejects(
    () => emergencyHalt(c.id, "org-1", "I disagree"),
    /only the founder/,
  );
});

test("emergencyHalt requires a reason", async () => {
  const c = await makeConsortium("halt3");
  await assert.rejects(
    () => emergencyHalt(c.id, c.founderOrgId, ""),
    /reason is required/,
  );
});

// ---- Contributions and listing ----

test("recordContribution refuses non-members", async () => {
  const c = await makeConsortium("contrib1");
  await assert.rejects(
    () => recordContribution(c.id, "ghost", 1),
    /not an active member/,
  );
});

test("listConsortia returns a lightweight overview of all federations", async () => {
  await createConsortium("federation-alpha", "founder-alpha");
  await createConsortium("federation-beta", "founder-beta");
  const all = await listConsortia();
  const names = all.map((c) => c.name);
  assert.ok(names.includes("federation-alpha"));
  assert.ok(names.includes("federation-beta"));
  for (const c of all) {
    assert.ok(typeof c.memberCount === "number");
    assert.ok(typeof c.trainingRounds === "number");
  }
});

// ---- Proposals on paused consortium ----

test("proposals cannot be created on a paused consortium", async () => {
  const c = await consortiumWithMembers("paused", 3);
  await emergencyHalt(c.id, "founder-0", "maintenance");
  await assert.rejects(
    () => proposeTrainingRound(c.id, { proposerOrgId: "founder-0" }),
    /not active/,
  );
});

// ---- Getters ----

test("getProposal and getConsortium return null for unknown ids", async () => {
  assert.equal(await getProposal("no-such-proposal"), null);
  assert.equal(await getConsortium("no-such-consortium"), null);
});
