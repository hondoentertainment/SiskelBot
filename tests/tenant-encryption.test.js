/**
 * Phase 66.4: Tenant encryption tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tenant-enc-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createTenantKey,
  rotateTenantKey,
  encryptForTenant,
  decryptForTenant,
  listKeys,
  deleteTenantKeys,
} = await import("../lib/tenant-encryption.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createTenantKey generates a current key", async () => {
  const out = await createTenantKey("t-alpha");
  assert.equal(out.tenantId, "t-alpha");
  assert.ok(out.keyId);
  assert.ok(out.createdAt);
});

test("createTenantKey refuses duplicate creation", async () => {
  await createTenantKey("t-dup");
  await assert.rejects(() => createTenantKey("t-dup"));
  await assert.rejects(() => createTenantKey(""));
});

test("encryptForTenant and decryptForTenant round-trip a string", async () => {
  await createTenantKey("t-rt");
  const payload = await encryptForTenant("t-rt", "hello world");
  assert.ok(payload.keyId);
  assert.ok(payload.iv);
  assert.ok(payload.tag);
  assert.ok(payload.ciphertext);
  const plain = await decryptForTenant("t-rt", payload);
  assert.equal(plain, "hello world");
});

test("encryptForTenant accepts a Buffer input", async () => {
  await createTenantKey("t-buf");
  const payload = await encryptForTenant("t-buf", Buffer.from("binary-data"));
  const plain = await decryptForTenant("t-buf", payload);
  assert.equal(plain, "binary-data");
});

test("encryptForTenant fails when tenant has no keys", async () => {
  await assert.rejects(() => encryptForTenant("never", "data"));
  await assert.rejects(() => decryptForTenant("never", { keyId: "x", iv: "y", tag: "z", ciphertext: "w" }));
});

test("decryptForTenant rejects malformed payloads", async () => {
  await createTenantKey("t-bad");
  await assert.rejects(() => decryptForTenant("t-bad", null));
  await assert.rejects(() => decryptForTenant("t-bad", { keyId: "k" }));
});

test("rotateTenantKey promotes new key but retains old for decrypt", async () => {
  await createTenantKey("t-rot");
  const first = await encryptForTenant("t-rot", "first-msg");
  const rotation = await rotateTenantKey("t-rot");
  assert.ok(rotation.newKeyId);
  assert.ok(rotation.previousKeyId);
  assert.notEqual(rotation.newKeyId, rotation.previousKeyId);
  // Old payload still decrypts via the retired key
  const plainOld = await decryptForTenant("t-rot", first);
  assert.equal(plainOld, "first-msg");
  // New payloads use the new key
  const second = await encryptForTenant("t-rot", "second-msg");
  assert.equal(second.keyId, rotation.newKeyId);
});

test("rotateTenantKey fails for unknown tenant", async () => {
  await assert.rejects(() => rotateTenantKey("unknown-tenant"));
});

test("listKeys returns metadata without raw key bytes", async () => {
  await createTenantKey("t-list");
  const all = await listKeys();
  const t = all.find((x) => x.tenantId === "t-list");
  assert.ok(t);
  assert.ok(t.currentKeyId);
  assert.ok(Array.isArray(t.keys));
  for (const k of t.keys) {
    assert.ok(k.keyId);
    assert.ok(k.status);
    assert.equal(k.keyBase64, undefined);
  }
});

test("listKeys(tenantId) filters to one tenant", async () => {
  await createTenantKey("t-one");
  const arr = await listKeys("t-one");
  assert.equal(arr.length, 1);
  assert.equal(arr[0].tenantId, "t-one");
});

test("deleteTenantKeys removes all keys", async () => {
  await createTenantKey("t-del");
  const ok = await deleteTenantKeys("t-del");
  assert.equal(ok, true);
  const again = await deleteTenantKeys("t-del");
  assert.equal(again, false);
  const list = await listKeys("t-del");
  assert.equal(list.length, 0);
});

test("decrypt fails if ciphertext was tampered with", async () => {
  await createTenantKey("t-tamper");
  const payload = await encryptForTenant("t-tamper", "safe");
  const tampered = { ...payload, ciphertext: Buffer.from("wrong").toString("base64") };
  await assert.rejects(() => decryptForTenant("t-tamper", tampered));
});
