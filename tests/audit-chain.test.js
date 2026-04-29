import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-audit-chain-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const { computeEntryHash, getChainHead, writeChainedEntry, verifyChain } =
  await import("../lib/audit-chain.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function makeEntry(overrides = {}) {
  return {
    event: "test.action",
    userId: "user-1",
    workspaceId: "ws-test",
    createdAt: new Date().toISOString(),
    metadata: { detail: "value" },
    ...overrides,
  };
}

// ─── computeEntryHash ─────────────────────────────────────────────────────────

test("computeEntryHash is deterministic with the same inputs", () => {
  const entry = makeEntry();
  const h1 = computeEntryHash(entry, "0000000000000000");
  const h2 = computeEntryHash(entry, "0000000000000000");
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("computeEntryHash changes when entry event field changes", () => {
  const base = makeEntry({ event: "original.event" });
  const tampered = makeEntry({ event: "tampered.event" });
  const h1 = computeEntryHash(base, "0000000000000000");
  const h2 = computeEntryHash(tampered, "0000000000000000");
  assert.notEqual(h1, h2);
});

test("computeEntryHash changes when entry userId changes", () => {
  const base = makeEntry({ userId: "user-a" });
  const tampered = makeEntry({ userId: "user-b" });
  assert.notEqual(
    computeEntryHash(base, "0000000000000000"),
    computeEntryHash(tampered, "0000000000000000")
  );
});

test("computeEntryHash changes when prevHash changes", () => {
  const entry = makeEntry();
  const h1 = computeEntryHash(entry, "0000000000000000");
  const h2 = computeEntryHash(entry, "aaaaaaaaaaaaaaaa");
  assert.notEqual(h1, h2);
});

test("computeEntryHash changes when metadata changes", () => {
  const base = makeEntry({ metadata: { value: "original" } });
  const tampered = makeEntry({ metadata: { value: "changed" } });
  assert.notEqual(
    computeEntryHash(base, "0000000000000000"),
    computeEntryHash(tampered, "0000000000000000")
  );
});

// ─── writeChainedEntry + getChainHead ────────────────────────────────────────

test("writeChainedEntry increments sequence on successive writes", async () => {
  const wsId = "ws-seq-test";
  const e1 = await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "evt.first" }));
  const e2 = await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "evt.second" }));
  assert.equal(e1.sequence, 1);
  assert.equal(e2.sequence, 2);
  assert.equal(e2.prevHash, e1.hash);
});

test("writeChainedEntry first entry uses genesis prevHash", async () => {
  const wsId = "ws-genesis-test";
  const e1 = await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId }));
  assert.equal(e1.prevHash, "0000000000000000");
  assert.equal(e1.sequence, 1);
});

test("getChainHead reflects latest written entry", async () => {
  const wsId = "ws-head-test";
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "head.a" }));
  const e2 = await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "head.b" }));
  const head = await getChainHead(wsId);
  assert.ok(head, "head should exist");
  assert.equal(head.hash, e2.hash);
  assert.equal(head.sequence, 2);
});

// ─── verifyChain ──────────────────────────────────────────────────────────────

test("verifyChain returns valid=true on untampered chain", async () => {
  const wsId = "ws-verify-good";
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "ok.1" }));
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "ok.2" }));
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "ok.3" }));
  const result = await verifyChain(wsId);
  assert.equal(result.valid, true);
  assert.equal(result.firstBadSequence, null);
  assert.equal(result.entriesChecked, 3);
  assert.equal(result.workspaceId, wsId);
  assert.ok(result.verifiedAt);
});

test("verifyChain returns valid=false with correct firstBadSequence after tamper", async () => {
  const wsId = "ws-verify-bad";
  const { readJsonPath, writeJsonPath } = await import("../lib/json-path-store.js");
  const { join } = await import("node:path");
  const logPath = join(TMP_DATA_DIR, "execution-audit.json");

  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "tamper.1" }));
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "tamper.2" }));
  await writeChainedEntry(wsId, makeEntry({ workspaceId: wsId, event: "tamper.3" }));

  const loaded = await readJsonPath(logPath, []);
  const tampered = loaded.map((e) => {
    if (e.workspaceId === wsId && e.sequence === 2) {
      return { ...e, event: "TAMPERED_EVENT" };
    }
    return e;
  });
  await writeJsonPath(logPath, tampered);

  const result = await verifyChain(wsId);
  assert.equal(result.valid, false);
  assert.equal(result.firstBadSequence, 2);
});

test("verifyChain returns empty result for workspace with no chained entries", async () => {
  const result = await verifyChain("ws-nonexistent-xyz");
  assert.equal(result.valid, true);
  assert.equal(result.entriesChecked, 0);
  assert.equal(result.firstBadSequence, null);
});
