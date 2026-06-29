/**
 * Initiative engine tests: signal -> proposal generation, persistence, dedup,
 * lifecycle transitions, and caps. Uses a temp STORAGE_PATH and injected
 * signal providers / llmComplete so no backend is required.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-initiative-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

const fakeSignals = () => [
  {
    kind: "scheduled_agent_failure",
    summary: 'Scheduled agent "Nightly report" failed 3/5 recent runs',
    detail: "Latest error: timeout",
    severity: 3,
    fingerprint: "fp-fail-1",
    ref: { type: "scheduled_agent", id: "agent-1" },
  },
];

const provider = async () => fakeSignals();

test("heuristic path creates proposals when no LLM is available", async () => {
  const { runInitiativeCycle, listProposals } = await import("../lib/initiative-engine.js");
  const ws = "heuristic-ws";

  const result = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  assert.equal(result.source, "heuristic");
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].status, "pending");
  assert.equal(result.created[0].category, "fix");

  const proposals = await listProposals(ws);
  assert.equal(proposals.length, 1);
});

test("LLM path parses JSON proposals", async () => {
  const { runInitiativeCycle } = await import("../lib/initiative-engine.js");
  const ws = "llm-ws";
  const llmComplete = async () =>
    '```json\n[{"title":"Fix the report job","rationale":"It keeps timing out","category":"fix","suggestedAction":"Increase timeout","confidence":0.8}]\n```';

  const result = await runInitiativeCycle({ workspaceId: ws, providers: [provider], llmComplete });
  assert.equal(result.source, "llm");
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].title, "Fix the report job");
  assert.equal(result.created[0].confidence, 0.8);
});

test("dedup skips proposals with an open fingerprint", async () => {
  const { runInitiativeCycle } = await import("../lib/initiative-engine.js");
  const ws = "dedup-ws";

  const first = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  assert.equal(first.created.length, 1);

  const second = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped, 1);
});

test("resolveProposal transitions status and rejects unknown id", async () => {
  const { runInitiativeCycle, resolveProposal, getProposal } = await import("../lib/initiative-engine.js");
  const ws = "resolve-ws";

  const result = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  const id = result.created[0].id;

  const approved = await resolveProposal(ws, id, { status: "approved", by: "tester", resolution: "lgtm" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.resolvedBy, "tester");

  const fetched = await getProposal(ws, id);
  assert.equal(fetched.status, "approved");

  const missing = await resolveProposal(ws, "no-such-id", { status: "dismissed" });
  assert.equal(missing, null);
});

test("resolveProposal rejects invalid status", async () => {
  const { resolveProposal } = await import("../lib/initiative-engine.js");
  await assert.rejects(() => resolveProposal("any-ws", "id", { status: "pending" }));
  await assert.rejects(() => resolveProposal("any-ws", "id", { status: "bogus" }));
});

test("a dismissed proposal frees the fingerprint for a new cycle", async () => {
  const { runInitiativeCycle, resolveProposal } = await import("../lib/initiative-engine.js");
  const ws = "reopen-ws";

  const first = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  await resolveProposal(ws, first.created[0].id, { status: "dismissed" });

  const second = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  assert.equal(second.created.length, 1, "dismissed fingerprint should allow a fresh proposal");
});

test("empty signals produce no proposals", async () => {
  const { runInitiativeCycle } = await import("../lib/initiative-engine.js");
  const result = await runInitiativeCycle({ workspaceId: "empty-ws", providers: [async () => []] });
  assert.equal(result.created.length, 0);
  assert.equal(result.source, "none");
});

test("onProposal handler is invoked for each new proposal", async () => {
  const { runInitiativeCycle } = await import("../lib/initiative-engine.js");
  const seen = [];
  await runInitiativeCycle({
    workspaceId: "notify-ws",
    providers: [provider],
    onProposal: (p) => seen.push(p.id),
  });
  assert.equal(seen.length, 1);
});

test("listProposals filters by status", async () => {
  const { runInitiativeCycle, resolveProposal, listProposals } = await import("../lib/initiative-engine.js");
  const ws = "filter-ws";
  const result = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  await resolveProposal(ws, result.created[0].id, { status: "approved" });

  const pending = await listProposals(ws, { status: "pending" });
  const approved = await listProposals(ws, { status: "approved" });
  assert.equal(pending.length, 0);
  assert.equal(approved.length, 1);
});

test("formatProposalMessage includes title and id", async () => {
  const { formatProposalMessage } = await import("../lib/initiative-engine.js");
  const msg = formatProposalMessage({
    title: "Do the thing",
    rationale: "because",
    suggestedAction: "act",
    category: "fix",
    confidence: 0.75,
    id: "abc123",
  });
  assert.match(msg, /Do the thing/);
  assert.match(msg, /abc123/);
  assert.match(msg, /75%/);
});

test("handleSlackInteraction resolves the referenced proposal", async () => {
  const { runInitiativeCycle, getProposal } = await import("../lib/initiative-engine.js");
  const { handleSlackInteraction } = await import("../lib/slack-bot.js");
  const ws = "slack-ws";
  const result = await runInitiativeCycle({ workspaceId: ws, providers: [provider] });
  const id = result.created[0].id;

  // response_url is empty so no network call is attempted; resolution still runs.
  const res = await handleSlackInteraction({
    type: "block_actions",
    user: { username: "alice" },
    response_url: "",
    actions: [{ action_id: "initiative_approve", value: JSON.stringify({ w: ws, p: id }) }],
  });
  assert.equal(res.status, 200);

  // Resolution happens on the next tick (setImmediate so Slack gets a fast 200).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));

  const updated = await getProposal(ws, id);
  assert.equal(updated.status, "approved");
  assert.equal(updated.resolvedBy, "alice");
});

test("handleSlackInteraction ignores non-initiative actions", async () => {
  const { handleSlackInteraction } = await import("../lib/slack-bot.js");
  const a = await handleSlackInteraction({ type: "block_actions", actions: [{ action_id: "other" }] });
  assert.deepEqual(a, { status: 200, body: { ok: true } });
  const b = await handleSlackInteraction({ type: "view_submission" });
  assert.deepEqual(b, { status: 200, body: { ok: true } });
});

test("formatProposalBlocks renders Approve/Dismiss buttons carrying workspace+id", async () => {
  const { formatProposalBlocks } = await import("../lib/initiative-engine.js");
  const blocks = formatProposalBlocks({
    workspaceId: "ws-1",
    id: "prop-1",
    title: "Fix it",
    rationale: "why",
    suggestedAction: "do",
    category: "fix",
    confidence: 0.6,
  });
  const actions = blocks.find((b) => b.type === "actions");
  assert.ok(actions, "has an actions block");
  const ids = actions.elements.map((e) => e.action_id);
  assert.deepEqual(ids, ["initiative_approve", "initiative_dismiss"]);
  const value = JSON.parse(actions.elements[0].value);
  assert.equal(value.w, "ws-1");
  assert.equal(value.p, "prop-1");
});
