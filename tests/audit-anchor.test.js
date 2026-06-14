/**
 * Phase 48.3: On-chain audit log anchoring tests.
 *
 * Covers Merkle tree construction, proof generation/verification, batch
 * creation and persistence, pluggable submitters, and the scheduler hook.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated STORAGE_PATH keeps persisted anchors out of the project data dir.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-audit-anchor-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  sha256,
  canonicalJson,
  hashEvent,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  createAnchorBatch,
  submitAnchor,
  getAnchor,
  listAnchors,
  verifyAuditEvent,
  registerAnchorSubmitter,
  mockSubmitter,
  httpSubmitter,
  runAnchoringJob,
  _internals,
} = await import("../lib/audit-anchor.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function makeEvent(i) {
  return {
    id: `evt-${i}`,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    action: "test.action",
    userId: `user-${i % 3}`,
    workspaceId: "ws-test",
    payload: { index: i, value: `v${i}` },
  };
}

// ─── sha256 + canonical json ─────────────────────────────────────────────────

test("sha256 is deterministic and 64 hex chars", () => {
  const a = sha256("hello");
  const b = sha256("hello");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(sha256("hello"), sha256("world"));
});

test("canonicalJson sorts object keys so equivalent events hash the same", () => {
  const e1 = { a: 1, b: { x: 1, y: 2 } };
  const e2 = { b: { y: 2, x: 1 }, a: 1 };
  assert.equal(canonicalJson(e1), canonicalJson(e2));
  assert.equal(hashEvent(e1), hashEvent(e2));
});

// ─── Merkle tree shapes ──────────────────────────────────────────────────────

test("buildMerkleTree returns empty tree for empty leaves", () => {
  const tree = buildMerkleTree([]);
  assert.equal(tree.root, null);
  assert.deepEqual(tree.levels, []);
  assert.deepEqual(tree.leaves, []);
});

test("buildMerkleTree handles a single leaf (root = leaf)", () => {
  const leaf = sha256("only");
  const tree = buildMerkleTree([leaf]);
  assert.equal(tree.root, leaf);
  assert.equal(tree.levels.length, 1);
  assert.equal(tree.leaves.length, 1);
});

test("buildMerkleTree handles a pair (root = H(left || right))", () => {
  const a = sha256("a");
  const b = sha256("b");
  const tree = buildMerkleTree([a, b]);
  assert.equal(tree.levels.length, 2);
  assert.notEqual(tree.root, null);
  assert.match(tree.root, /^[0-9a-f]{64}$/);
});

test("buildMerkleTree duplicates the last leaf when count is odd", () => {
  const a = sha256("a");
  const b = sha256("b");
  const c = sha256("c");
  const tree = buildMerkleTree([a, b, c]);
  assert.ok(tree.root);
  // Odd count of 3 means level 1 should have 2 nodes (a-b, c-c).
  assert.equal(tree.levels[1].length, 2);
  assert.equal(tree.levels[2].length, 1);
});

test("buildMerkleTree handles many leaves and produces a stable root", () => {
  const leaves = Array.from({ length: 16 }, (_, i) => sha256(`leaf-${i}`));
  const tree1 = buildMerkleTree(leaves);
  const tree2 = buildMerkleTree(leaves);
  assert.equal(tree1.root, tree2.root);
  // For a balanced 16-leaf tree: 5 levels (16→8→4→2→1).
  assert.equal(tree1.levels.length, 5);
});

// ─── Merkle proofs ───────────────────────────────────────────────────────────

test("generateMerkleProof + verifyMerkleProof succeed for all positions", () => {
  const leaves = Array.from({ length: 8 }, (_, i) => sha256(`l-${i}`));
  const tree = buildMerkleTree(leaves);
  for (let i = 0; i < leaves.length; i += 1) {
    const proof = generateMerkleProof(tree, i);
    assert.equal(proof.leaf, leaves[i]);
    assert.equal(proof.root, tree.root);
    assert.ok(verifyMerkleProof(proof), `proof at ${i} should verify`);
  }
});

test("verifyMerkleProof fails when the leaf is tampered", () => {
  const leaves = Array.from({ length: 4 }, (_, i) => sha256(`l-${i}`));
  const tree = buildMerkleTree(leaves);
  const proof = generateMerkleProof(tree, 2);
  const tampered = { ...proof, leaf: sha256("evil") };
  assert.equal(verifyMerkleProof(tampered), false);
});

test("verifyMerkleProof fails when a sibling hash is corrupted", () => {
  const leaves = Array.from({ length: 4 }, (_, i) => sha256(`l-${i}`));
  const tree = buildMerkleTree(leaves);
  const proof = generateMerkleProof(tree, 0);
  const corrupted = {
    ...proof,
    siblings: proof.siblings.map((s, idx) =>
      idx === 0 ? { ...s, hash: sha256("tamper") } : s,
    ),
  };
  assert.equal(verifyMerkleProof(corrupted), false);
});

test("generateMerkleProof rejects out-of-range indices", () => {
  const leaves = [sha256("a"), sha256("b")];
  const tree = buildMerkleTree(leaves);
  assert.throws(() => generateMerkleProof(tree, 5), /out of range/);
  assert.throws(() => generateMerkleProof(tree, -1), /out of range/);
});

test("Merkle proof works for a large tree (20 leaves, odd level handling)", () => {
  const events = Array.from({ length: 20 }, (_, i) => makeEvent(i));
  const leaves = events.map(hashEvent);
  const tree = buildMerkleTree(leaves);
  for (const idx of [0, 5, 10, 15, 19]) {
    const proof = generateMerkleProof(tree, idx);
    assert.ok(verifyMerkleProof(proof), `proof ${idx} must verify`);
  }
});

// ─── batch lifecycle ─────────────────────────────────────────────────────────

test("createAnchorBatch builds the expected Merkle root and persists it", async () => {
  const events = Array.from({ length: 4 }, (_, i) => makeEvent(i));
  const batch = await createAnchorBatch(events, { chain: "mock", workspaceId: "ws-test" });
  assert.ok(batch.batchId.startsWith("anchor_"));
  assert.equal(batch.eventCount, 4);
  assert.ok(batch.root);
  assert.equal(batch.eventIds.length, 4);

  // Recompute root independently and compare.
  const manualLeaves = events.map(hashEvent);
  const manualTree = buildMerkleTree(manualLeaves);
  assert.equal(batch.root, manualTree.root);

  const record = await getAnchor(batch.batchId);
  assert.ok(record);
  assert.equal(record.batch.root, batch.root);
  assert.equal(record.batch.eventCount, 4);
});

test("createAnchorBatch handles an empty event list gracefully", async () => {
  const batch = await createAnchorBatch([], { chain: "mock" });
  assert.equal(batch.eventCount, 0);
  assert.equal(batch.root, null);
  const record = await getAnchor(batch.batchId);
  assert.ok(record);
  assert.equal(record.batch.eventCount, 0);
});

test("getAnchor returns null for unknown ids", async () => {
  const missing = await getAnchor("anchor_does_not_exist");
  assert.equal(missing, null);
});

// ─── submitter pipeline ──────────────────────────────────────────────────────

test("submitAnchor with mockSubmitter persists a receipt", async () => {
  const events = Array.from({ length: 3 }, (_, i) => makeEvent(100 + i));
  const batch = await createAnchorBatch(events, { chain: "mock", workspaceId: "ws-test" });
  const receipt = await submitAnchor(batch.batchId, "mock");
  assert.match(receipt.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.chain, "mock");
  assert.ok(receipt.confirmedAt);

  const stored = await getAnchor(batch.batchId);
  assert.ok(stored.receipt);
  assert.equal(stored.receipt.txHash, receipt.txHash);
});

test("submitAnchor throws for unknown chain", async () => {
  const events = [makeEvent(200)];
  const batch = await createAnchorBatch(events, { chain: "mock" });
  await assert.rejects(
    () => submitAnchor(batch.batchId, "neverRegistered"),
    /no submitter registered/,
  );
});

test("registerAnchorSubmitter installs a custom submitter and dispatches to it", async () => {
  const calls = [];
  registerAnchorSubmitter("custom-chain", async (record) => {
    calls.push(record.batch.batchId);
    return {
      txHash: "0x" + "ab".repeat(32),
      chain: "custom-chain",
      blockNumber: 42,
      confirmedAt: new Date().toISOString(),
    };
  });

  const events = [makeEvent(300), makeEvent(301)];
  const batch = await createAnchorBatch(events, { chain: "custom-chain" });
  const receipt = await submitAnchor(batch.batchId, "custom-chain");
  assert.equal(receipt.chain, "custom-chain");
  assert.equal(receipt.blockNumber, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], batch.batchId);

  // Clean up the custom submitter so later tests do not inherit it.
  registerAnchorSubmitter("custom-chain", null);
});

test("submitAnchor accepts a function submitter directly", async () => {
  const events = [makeEvent(400)];
  const batch = await createAnchorBatch(events, { chain: "mock" });
  const receipt = await submitAnchor(batch.batchId, async () => ({
    txHash: "0x" + "cd".repeat(32),
    chain: "inline",
    confirmedAt: new Date().toISOString(),
  }));
  assert.equal(receipt.txHash, "0x" + "cd".repeat(32));
  assert.equal(receipt.chain, "inline");
});

test("httpSubmitter is exported and fails without AUDIT_ANCHOR_HTTP_URL", async () => {
  const original = process.env.AUDIT_ANCHOR_HTTP_URL;
  delete process.env.AUDIT_ANCHOR_HTTP_URL;
  try {
    await assert.rejects(
      () => httpSubmitter({ batch: { root: "x", batchId: "y", chain: "http" } }),
      /not configured/,
    );
  } finally {
    if (original !== undefined) process.env.AUDIT_ANCHOR_HTTP_URL = original;
  }
  assert.equal(typeof httpSubmitter, "function");
});

test("mockSubmitter produces a deterministic-shape receipt", async () => {
  const record = { batch: { root: "abc", batchId: "b1", chain: "mock" } };
  const receipt = await mockSubmitter(record);
  assert.match(receipt.txHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.chain, "mock");
  assert.ok(receipt.confirmedAt);
});

// ─── listing and filtering ───────────────────────────────────────────────────

test("listAnchors filters by chain and workspaceId", async () => {
  // Seed three more anchors tagged with distinct chain/workspace combinations.
  await createAnchorBatch([makeEvent(501)], { chain: "listA", workspaceId: "wsA" });
  await createAnchorBatch([makeEvent(502)], { chain: "listA", workspaceId: "wsB" });
  await createAnchorBatch([makeEvent(503)], { chain: "listB", workspaceId: "wsA" });

  const byChain = await listAnchors({ chain: "listA" });
  assert.ok(byChain.length >= 2);
  for (const a of byChain) assert.equal(a.chain, "listA");

  const byWs = await listAnchors({ chain: "listA", workspaceId: "wsB" });
  assert.ok(byWs.length >= 1);
  for (const a of byWs) {
    assert.equal(a.chain, "listA");
    assert.equal(a.workspaceId, "wsB");
  }

  const all = await listAnchors();
  assert.ok(all.length >= 3);
});

// ─── end-to-end event verification ───────────────────────────────────────────

test("verifyAuditEvent produces a valid proof for an anchored event", async () => {
  const events = Array.from({ length: 6 }, (_, i) => makeEvent(600 + i));
  const batch = await createAnchorBatch(events, { chain: "mock", workspaceId: "ws-verify" });
  await submitAnchor(batch.batchId, "mock");

  const proof = await verifyAuditEvent("evt-603", batch.batchId);
  assert.ok(proof);
  assert.equal(proof.eventId, "evt-603");
  assert.equal(proof.root, batch.root);
  assert.equal(proof.verified, true);
  assert.ok(proof.txHash);
  assert.ok(proof.siblings.length > 0);
});

test("verifyAuditEvent returns null for unknown event id", async () => {
  const events = [makeEvent(700)];
  const batch = await createAnchorBatch(events, { chain: "mock" });
  const proof = await verifyAuditEvent("evt-not-in-batch", batch.batchId);
  assert.equal(proof, null);
});

test("verifyAuditEvent returns null for unknown anchor id", async () => {
  const proof = await verifyAuditEvent("evt-1", "anchor_missing");
  assert.equal(proof, null);
});

test("tampered anchor record makes verifyAuditEvent flag failure", async () => {
  const events = Array.from({ length: 4 }, (_, i) => makeEvent(800 + i));
  const batch = await createAnchorBatch(events, { chain: "mock" });

  // Mutate the stored events in place so the leaf hash no longer matches.
  const { readJsonPath, writeJsonPath } = await import("../lib/json-path-store.js");
  const record = await readJsonPath(_internals.anchorBatchPath(batch.batchId), null);
  record.batch.events[1] = { ...record.batch.events[1], payload: { evil: true } };
  await writeJsonPath(_internals.anchorBatchPath(batch.batchId), record);

  const proof = await verifyAuditEvent("evt-801", batch.batchId);
  assert.ok(proof);
  assert.equal(proof.verified, false);
});

// ─── scheduler hook ──────────────────────────────────────────────────────────

test("runAnchoringJob with supplied events produces an anchor and receipt", async () => {
  const events = Array.from({ length: 5 }, (_, i) => makeEvent(900 + i));
  const result = await runAnchoringJob({ events, chain: "mock", workspaceId: "ws-job" });
  assert.ok(result.batch);
  assert.ok(result.batch.batchId);
  assert.equal(result.batch.eventCount, 5);
  assert.ok(result.receipt);
  assert.match(result.receipt.txHash, /^0x[0-9a-f]{64}$/);

  const stored = await getAnchor(result.batch.batchId);
  assert.ok(stored);
  assert.equal(stored.receipt.txHash, result.receipt.txHash);
});

test("runAnchoringJob skips gracefully when there are no events", async () => {
  const result = await runAnchoringJob({ events: [], chain: "mock" });
  assert.equal(result.batch, null);
  assert.equal(result.skipped, true);
});

test("runAnchoringJob with submit=false creates the batch without dispatching", async () => {
  const events = [makeEvent(1000)];
  const result = await runAnchoringJob({ events, chain: "mock", submit: false });
  assert.ok(result.batch);
  assert.equal(result.receipt, null);
  const stored = await getAnchor(result.batch.batchId);
  assert.equal(stored.receipt, null);
});
