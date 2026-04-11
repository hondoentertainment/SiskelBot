/**
 * Phase 48.2: NFT-gated workspaces — unit tests.
 *
 * Covers gate CRUD, local ownership registry, checker plugin model,
 * workspace access verification, caching TTL behavior, minBalance,
 * and specific tokenId matching.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate STORAGE_PATH so persisted state does not leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-nft-gating-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  setNftGate,
  getNftGate,
  removeNftGate,
  listGatedWorkspaces,
  checkOwnership,
  claimNftOwnership,
  verifyWorkspaceAccess,
  cacheOwnership,
  getCachedOwnership,
  registerOwnershipChecker,
  getOwnershipChecker,
  mockChecker,
  httpChecker,
} = await import("../lib/nft-gating.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- Gate CRUD ----

test("setNftGate and getNftGate roundtrip", async () => {
  const gate = await setNftGate("ws-1", {
    chain: "ethereum",
    contract: "0xabc",
    tokenIds: [1, 2, 3],
    minBalance: 1,
    collection: "cool-cats",
  });
  assert.equal(gate.workspaceId, "ws-1");
  assert.equal(gate.chain, "ethereum");
  assert.equal(gate.contract, "0xabc");
  assert.deepEqual(gate.tokenIds, ["1", "2", "3"]);
  assert.equal(gate.minBalance, 1);
  assert.equal(gate.collection, "cool-cats");

  const fetched = await getNftGate("ws-1");
  assert.ok(fetched);
  assert.equal(fetched.contract, "0xabc");
  assert.deepEqual(fetched.tokenIds, ["1", "2", "3"]);
});

test("setNftGate normalizes chain and contract casing", async () => {
  const gate = await setNftGate("ws-case", {
    chain: "Polygon",
    contract: "0xDEAD",
  });
  assert.equal(gate.chain, "polygon");
  assert.equal(gate.contract, "0xdead");
});

test("setNftGate rejects missing contract", async () => {
  await assert.rejects(
    () => setNftGate("ws-bad", { chain: "ethereum" }),
    /contract is required/,
  );
});

test("removeNftGate removes an existing gate", async () => {
  await setNftGate("ws-rm", { chain: "ethereum", contract: "0x1" });
  const removed = await removeNftGate("ws-rm");
  assert.equal(removed, true);
  const after = await getNftGate("ws-rm");
  assert.equal(after, null);

  const removedAgain = await removeNftGate("ws-rm");
  assert.equal(removedAgain, false);
});

test("listGatedWorkspaces returns all gates and filters by chain", async () => {
  await setNftGate("ws-list-eth", { chain: "ethereum", contract: "0xa" });
  await setNftGate("ws-list-poly", { chain: "polygon", contract: "0xb" });

  const all = await listGatedWorkspaces();
  const ids = all.map((g) => g.workspaceId);
  assert.ok(ids.includes("ws-list-eth"));
  assert.ok(ids.includes("ws-list-poly"));

  const ethOnly = await listGatedWorkspaces("ethereum");
  const ethIds = ethOnly.map((g) => g.workspaceId);
  assert.ok(ethIds.includes("ws-list-eth"));
  assert.ok(!ethIds.includes("ws-list-poly"));
});

// ---- Local ownership registry ----

test("claimNftOwnership persists a claim in the local registry", async () => {
  const claim = await claimNftOwnership("0xwallet1", "0xcontract1", 42, "ethereum");
  assert.equal(claim.walletAddress, "0xwallet1");
  assert.equal(claim.contract, "0xcontract1");
  assert.deepEqual(claim.tokenIds, ["42"]);
});

test("claimNftOwnership accumulates multiple tokenIds idempotently", async () => {
  await claimNftOwnership("0xwallet2", "0xc", 1, "ethereum");
  await claimNftOwnership("0xwallet2", "0xc", 2, "ethereum");
  // duplicate claim should not double-insert
  const claim = await claimNftOwnership("0xwallet2", "0xc", 1, "ethereum");
  assert.deepEqual(claim.tokenIds.sort(), ["1", "2"]);
});

test("checkOwnership returns owns=true for a claimed NFT", async () => {
  await claimNftOwnership("0xhodler", "0xnft", 7, "ethereum");
  const result = await checkOwnership(
    "0xhodler",
    { chain: "ethereum", contract: "0xnft" },
    { useCache: false },
  );
  assert.equal(result.owns, true);
  assert.ok(result.tokenIds.includes("7"));
  assert.equal(result.balance, 1);
});

test("checkOwnership returns owns=false for an unclaimed NFT", async () => {
  const result = await checkOwnership(
    "0xnobody",
    { chain: "ethereum", contract: "0xnft-zero" },
    { useCache: false },
  );
  assert.equal(result.owns, false);
  assert.equal(result.balance, 0);
  assert.deepEqual(result.tokenIds, []);
});

test("checkOwnership enforces minBalance", async () => {
  await claimNftOwnership("0xmb", "0xmb-c", "a", "ethereum");
  const denied = await checkOwnership(
    "0xmb",
    { chain: "ethereum", contract: "0xmb-c", minBalance: 2 },
    { useCache: false },
  );
  assert.equal(denied.owns, false);

  await claimNftOwnership("0xmb", "0xmb-c", "b", "ethereum");
  const allowed = await checkOwnership(
    "0xmb",
    { chain: "ethereum", contract: "0xmb-c", minBalance: 2 },
    { useCache: false },
  );
  assert.equal(allowed.owns, true);
  assert.ok(allowed.balance >= 2);
});

test("checkOwnership enforces specific tokenIds filter", async () => {
  await claimNftOwnership("0xti", "0xti-c", "10", "ethereum");
  await claimNftOwnership("0xti", "0xti-c", "20", "ethereum");

  const matching = await checkOwnership(
    "0xti",
    { chain: "ethereum", contract: "0xti-c", tokenIds: ["10"] },
    { useCache: false },
  );
  assert.equal(matching.owns, true);
  assert.deepEqual(matching.tokenIds, ["10"]);

  const notMatching = await checkOwnership(
    "0xti",
    { chain: "ethereum", contract: "0xti-c", tokenIds: ["99"] },
    { useCache: false },
  );
  assert.equal(notMatching.owns, false);
});

// ---- Workspace access verification ----

test("verifyWorkspaceAccess without a gate is allowed", async () => {
  const result = await verifyWorkspaceAccess("0xanyone", "ws-open");
  assert.equal(result.allowed, true);
  assert.match(result.reason, /no gate/);
});

test("verifyWorkspaceAccess with gate + ownership is allowed", async () => {
  await setNftGate("ws-gated", { chain: "ethereum", contract: "0xgated" });
  await claimNftOwnership("0xmember", "0xgated", 1, "ethereum");
  const result = await verifyWorkspaceAccess("0xmember", "ws-gated", { useCache: false });
  assert.equal(result.allowed, true);
  assert.match(result.reason, /ownership verified/);
});

test("verifyWorkspaceAccess with gate but no ownership is denied", async () => {
  await setNftGate("ws-gated-2", { chain: "ethereum", contract: "0xexclusive" });
  const result = await verifyWorkspaceAccess("0xoutsider", "ws-gated-2", { useCache: false });
  assert.equal(result.allowed, false);
  assert.ok(result.gate);
});

test("verifyWorkspaceAccess with gate and no wallet is denied", async () => {
  await setNftGate("ws-gated-3", { chain: "ethereum", contract: "0xany" });
  const result = await verifyWorkspaceAccess("", "ws-gated-3");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /walletAddress is required/);
});

// ---- Cache ----

test("cacheOwnership stores and getCachedOwnership returns entry within TTL", async () => {
  await cacheOwnership("0xc1", "0xcc", "33", "ethereum", 60_000);
  const cached = await getCachedOwnership("0xc1", "0xcc", "ethereum");
  assert.ok(cached);
  assert.equal(cached.tokenId, "33");
  assert.equal(cached.chain, "ethereum");
});

test("getCachedOwnership returns null when TTL has expired", async () => {
  await cacheOwnership("0xexp", "0xexp-c", "1", "ethereum", 1);
  await new Promise((r) => setTimeout(r, 10));
  const cached = await getCachedOwnership("0xexp", "0xexp-c", "ethereum");
  assert.equal(cached, null);
});

test("checkOwnership uses cache on repeated calls and refreshes after expiry", async () => {
  let calls = 0;
  registerOwnershipChecker("counting-chain", async (_wallet, _gate) => {
    calls++;
    return { owns: true, tokenIds: ["1"], balance: 1, verifiedAt: Date.now() };
  });

  const gate = { chain: "counting-chain", contract: "0xcount" };
  const first = await checkOwnership("0xcache", gate, { cacheTtlMs: 60_000 });
  assert.equal(first.owns, true);
  assert.equal(calls, 1);

  const second = await checkOwnership("0xcache", gate, { cacheTtlMs: 60_000 });
  assert.equal(second.owns, true);
  assert.equal(second.cached, true);
  assert.equal(calls, 1); // served from cache

  // Expire the cache by writing a zero-TTL entry and verifying the next
  // call goes through to the checker again.
  await cacheOwnership("0xcache", "0xcount", "1", "counting-chain", 1);
  await new Promise((r) => setTimeout(r, 10));
  const third = await checkOwnership("0xcache", gate, { cacheTtlMs: 60_000 });
  assert.equal(third.owns, true);
  assert.equal(calls, 2); // checker invoked again after expiry
});

// ---- Pluggability ----

test("registerOwnershipChecker adds a pluggable checker for a new chain", async () => {
  let invoked = false;
  registerOwnershipChecker("test-chain", async (wallet, gate) => {
    invoked = true;
    assert.equal(gate.chain, "test-chain");
    return { owns: wallet === "0xgood", tokenIds: ["5"], balance: 1, verifiedAt: Date.now() };
  });

  const checker = getOwnershipChecker("test-chain");
  assert.equal(typeof checker, "function");

  const good = await checkOwnership(
    "0xgood",
    { chain: "test-chain", contract: "0xyz" },
    { useCache: false },
  );
  assert.equal(good.owns, true);
  assert.equal(invoked, true);

  const bad = await checkOwnership(
    "0xbad",
    { chain: "test-chain", contract: "0xyz" },
    { useCache: false },
  );
  assert.equal(bad.owns, false);
});

test("checkOwnership on an unknown chain falls back to mock checker", async () => {
  await claimNftOwnership("0xfallback", "0xfb", 1, "some-unknown-chain");
  const result = await checkOwnership(
    "0xfallback",
    { chain: "some-unknown-chain", contract: "0xfb" },
    { useCache: false },
  );
  assert.equal(result.owns, true);
});

test("checkOwnership returns a structured failure when the checker throws", async () => {
  registerOwnershipChecker("throwing-chain", async () => {
    throw new Error("boom");
  });
  const result = await checkOwnership(
    "0xanyone",
    { chain: "throwing-chain", contract: "0xzz" },
    { useCache: false },
  );
  assert.equal(result.owns, false);
  assert.match(result.reason, /boom/);
});

test("mockChecker is the same function returned for chain 'mock'", () => {
  const fn = getOwnershipChecker("mock");
  assert.equal(fn, mockChecker);
});

test("httpChecker rejects when no RPC URL is configured", async () => {
  // Ensure env is not set for this chain.
  delete process.env.NFT_RPC_URL;
  delete process.env.NFT_RPC_URL_NORPC;
  await assert.rejects(
    () => httpChecker("0xw", { chain: "norpc", contract: "0xc" }),
    /No RPC URL configured/,
  );
});
