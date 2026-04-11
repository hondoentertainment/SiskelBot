/**
 * Phase 67.1: CSAM hash detection tests.
 *
 * NOTE: all digests used in these tests are placeholder strings. No
 * real CSAM content is referenced or processed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-csam-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  addHashToList,
  checkHash,
  removeHash,
  listHashes,
  scanBatch,
  normalizeDigest,
} = await import("../lib/csam-detection.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// Placeholder digests — non-CSAM, arbitrary hex strings used only for
// testing the lookup logic.
const FAKE_DENY_DIGEST = "a".repeat(64);
const FAKE_ALLOW_DIGEST = "b".repeat(64);
const FAKE_UNKNOWN_DIGEST = "c".repeat(64);

test("normalizeDigest lowercases hex and rejects non-hex input", () => {
  assert.equal(normalizeDigest("DEADBEEF"), "deadbeef");
  assert.throws(() => normalizeDigest(""));
  assert.throws(() => normalizeDigest(null));
  assert.throws(() => normalizeDigest("not-hex!"));
});

test("addHashToList persists a denylist entry", async () => {
  const rec = await addHashToList(FAKE_DENY_DIGEST, { source: "test", notes: "placeholder" });
  assert.equal(rec.digest, FAKE_DENY_DIGEST);
  assert.equal(rec.list, "denylist");
  assert.equal(rec.source, "test");
});

test("addHashToList accepts allowlist", async () => {
  const rec = await addHashToList(FAKE_ALLOW_DIGEST, { list: "allowlist" });
  assert.equal(rec.list, "allowlist");
});

test("addHashToList rejects unknown list names", async () => {
  await assert.rejects(() => addHashToList("ff".repeat(32), { list: "bogus" }));
});

test("checkHash returns matched=true for a seeded denylist entry", async () => {
  await addHashToList(FAKE_DENY_DIGEST);
  const r = await checkHash(FAKE_DENY_DIGEST);
  assert.equal(r.matched, true);
  assert.equal(r.list, "denylist");
});

test("checkHash returns matched=false for unknown digests", async () => {
  const r = await checkHash(FAKE_UNKNOWN_DIGEST);
  assert.equal(r.matched, false);
  assert.equal(r.list, null);
});

test("checkHash is case-insensitive", async () => {
  await addHashToList("1234" + "a".repeat(60));
  const r = await checkHash(("1234" + "a".repeat(60)).toUpperCase());
  assert.equal(r.matched, true);
});

test("removeHash deletes an entry", async () => {
  const digest = "e".repeat(64);
  await addHashToList(digest);
  const ok = await removeHash(digest);
  assert.equal(ok, true);
  assert.equal((await checkHash(digest)).matched, false);
  const again = await removeHash(digest);
  assert.equal(again, false);
});

test("listHashes returns entries filtered by list", async () => {
  await addHashToList("f".repeat(64), { list: "denylist" });
  await addHashToList("1".repeat(64), { list: "allowlist" });
  const deny = await listHashes({ list: "denylist" });
  for (const h of deny) assert.equal(h.list, "denylist");
  const allow = await listHashes({ list: "allowlist" });
  for (const h of allow) assert.equal(h.list, "allowlist");
});

test("listHashes honors source filter and limit", async () => {
  await addHashToList("2".repeat(64), { source: "ncmec-sim" });
  const src = await listHashes({ source: "ncmec-sim" });
  for (const h of src) assert.equal(h.source, "ncmec-sim");
  const capped = await listHashes({ limit: 1 });
  assert.ok(capped.length <= 1);
});

test("scanBatch returns denylist and allowlist matches", async () => {
  const denyDigest = "3".repeat(64);
  const allowDigest = "4".repeat(64);
  await addHashToList(denyDigest, { list: "denylist" });
  await addHashToList(allowDigest, { list: "allowlist" });
  const result = await scanBatch([denyDigest, allowDigest, FAKE_UNKNOWN_DIGEST, "bogus"]);
  assert.equal(result.scanned, 4);
  assert.ok(result.matches.length >= 2);
  assert.ok(result.deny >= 1);
  assert.ok(result.allow >= 1);
});

test("scanBatch rejects non-array input", async () => {
  await assert.rejects(() => scanBatch("not-array"));
});
