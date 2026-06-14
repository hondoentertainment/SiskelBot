import test from "node:test";
import assert from "node:assert/strict";
import { createHSMClient, PROVIDERS, getGlobalHSM, resetGlobalHSM, isHSMConfigured } from "../lib/hsm.js";

test("PROVIDERS exposes all supported providers", () => {
  assert.ok(PROVIDERS.software);
  assert.ok(PROVIDERS["aws-kms"]);
  assert.ok(PROVIDERS["gcp-kms"]);
  assert.ok(PROVIDERS["azure-keyvault"]);
  assert.ok(PROVIDERS.pkcs11);
});

test("createHSMClient rejects unknown provider", () => {
  assert.throws(() => createHSMClient("nonexistent"), /Unknown HSM provider/);
});

test("createHSMClient defaults to software", () => {
  const hsm = createHSMClient();
  assert.equal(hsm.provider, "software");
});

test("software HSM generates symmetric key", async () => {
  const hsm = createHSMClient("software");
  const result = await hsm.generateKey("test-aes", "aes-256");
  assert.equal(result.keyId, "test-aes");
  assert.equal(result.keyType, "aes-256");
  assert.ok(result.createdAt);
});

test("software HSM generates RSA keypair", async () => {
  const hsm = createHSMClient("software");
  const result = await hsm.generateKey("test-rsa", "rsa-2048");
  assert.equal(result.keyId, "test-rsa");
  assert.equal(result.keyType, "rsa-2048");
});

test("software HSM generates EC keypair", async () => {
  const hsm = createHSMClient("software");
  const result = await hsm.generateKey("test-ec", "ecdsa-p256");
  assert.equal(result.keyId, "test-ec");
  assert.equal(result.keyType, "ecdsa-p256");
});

test("software HSM rejects duplicate keyId", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("dup", "aes-256");
  await assert.rejects(hsm.generateKey("dup", "aes-256"), /already exists/);
});

test("software HSM rejects empty keyId", async () => {
  const hsm = createHSMClient("software");
  await assert.rejects(hsm.generateKey("", "aes-256"), /keyId is required/);
});

test("software HSM rejects unsupported key type", async () => {
  const hsm = createHSMClient("software");
  await assert.rejects(hsm.generateKey("bad", "unknown-type"), /Unsupported key type/);
});

test("software HSM encrypts and decrypts with AES-256", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("enc-key", "aes-256");
  const plaintext = "hello world";
  const encrypted = await hsm.encrypt("enc-key", plaintext);
  assert.ok(encrypted.ciphertext);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.authTag);
  const decrypted = await hsm.decrypt("enc-key", encrypted);
  assert.equal(decrypted, plaintext);
});

test("software HSM decrypt accepts separate args", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("enc2", "aes-256");
  const encrypted = await hsm.encrypt("enc2", "test data");
  const decrypted = await hsm.decrypt("enc2", encrypted.ciphertext, encrypted.iv, encrypted.authTag);
  assert.equal(decrypted, "test data");
});

test("software HSM rejects encrypting with asymmetric key", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("asym-enc", "rsa-2048");
  await assert.rejects(hsm.encrypt("asym-enc", "data"), /Cannot encrypt with asymmetric/);
});

test("software HSM signs and verifies with RSA", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("sign-rsa", "rsa-2048");
  const data = "message to sign";
  const signature = await hsm.sign("sign-rsa", data);
  assert.ok(signature);
  const valid = await hsm.verify("sign-rsa", data, signature);
  assert.equal(valid, true);
});

test("software HSM signs and verifies with EC", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("sign-ec", "ecdsa-p256");
  const signature = await hsm.sign("sign-ec", "ec test");
  const valid = await hsm.verify("sign-ec", "ec test", signature);
  assert.equal(valid, true);
});

test("software HSM verify fails for tampered data", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("tamper", "rsa-2048");
  const signature = await hsm.sign("tamper", "original");
  const valid = await hsm.verify("tamper", "modified", signature);
  assert.equal(valid, false);
});

test("software HSM rejects signing with symmetric key", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("sym-sign", "aes-256");
  await assert.rejects(hsm.sign("sym-sign", "data"), /Cannot sign with symmetric/);
});

test("software HSM lists keys", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("list-1", "aes-256");
  await hsm.generateKey("list-2", "rsa-2048");
  const keys = await hsm.listKeys();
  assert.ok(keys.length >= 2);
  const ids = keys.map((k) => k.keyId);
  assert.ok(ids.includes("list-1"));
  assert.ok(ids.includes("list-2"));
});

test("software HSM getKeyMetadata returns info", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("meta-key", "rsa-2048");
  const meta = await hsm.getKeyMetadata("meta-key");
  assert.equal(meta.keyId, "meta-key");
  assert.equal(meta.keyType, "rsa-2048");
  assert.equal(meta.algorithm, "rsa-2048");
  assert.equal(meta.hasPublicKey, true);
});

test("software HSM getKeyMetadata returns null for missing", async () => {
  const hsm = createHSMClient("software");
  const meta = await hsm.getKeyMetadata("nonexistent");
  assert.equal(meta, null);
});

test("software HSM deletes key", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("del-me", "aes-256");
  const deleted = await hsm.deleteKey("del-me");
  assert.equal(deleted, true);
  const meta = await hsm.getKeyMetadata("del-me");
  assert.equal(meta, null);
});

test("software HSM delete returns false for missing key", async () => {
  const hsm = createHSMClient("software");
  const deleted = await hsm.deleteKey("never-existed");
  assert.equal(deleted, false);
});

test("software HSM wraps and unwraps keys", async () => {
  const hsm = createHSMClient("software");
  await hsm.generateKey("wrapper", "aes-256");
  await hsm.generateKey("target", "aes-256");
  const wrapped = await hsm.wrapKey("wrapper", "target");
  assert.ok(wrapped.ciphertext);
  // Delete original and re-import
  await hsm.deleteKey("target");
  const unwrapped = await hsm.unwrapKey("wrapper", wrapped);
  assert.equal(unwrapped.keyId, "target");
  // Verify target is usable again
  const enc = await hsm.encrypt("target", "after unwrap");
  const dec = await hsm.decrypt("target", enc);
  assert.equal(dec, "after unwrap");
});

test("getGlobalHSM returns software provider by default", () => {
  resetGlobalHSM();
  const prev = process.env.HSM_PROVIDER;
  delete process.env.HSM_PROVIDER;
  const hsm = getGlobalHSM();
  assert.equal(hsm.provider, "software");
  if (prev) process.env.HSM_PROVIDER = prev;
  resetGlobalHSM();
});

test("isHSMConfigured returns false for software", () => {
  const prev = process.env.HSM_PROVIDER;
  delete process.env.HSM_PROVIDER;
  assert.equal(isHSMConfigured(), false);
  process.env.HSM_PROVIDER = "software";
  assert.equal(isHSMConfigured(), false);
  if (prev) process.env.HSM_PROVIDER = prev;
  else delete process.env.HSM_PROVIDER;
});

test("isHSMConfigured returns true for non-software provider", () => {
  const prev = process.env.HSM_PROVIDER;
  process.env.HSM_PROVIDER = "aws-kms";
  assert.equal(isHSMConfigured(), true);
  if (prev) process.env.HSM_PROVIDER = prev;
  else delete process.env.HSM_PROVIDER;
});

test("GCP KMS provider throws when access token missing", async () => {
  const hsm = createHSMClient("gcp-kms", { projectId: "test" });
  const prev = process.env.GCP_ACCESS_TOKEN;
  delete process.env.GCP_ACCESS_TOKEN;
  await assert.rejects(hsm.listKeys(), /access token not configured/);
  if (prev) process.env.GCP_ACCESS_TOKEN = prev;
});

test("Azure Key Vault provider throws when access token missing", async () => {
  const hsm = createHSMClient("azure-keyvault", { vaultName: "test" });
  const prev = process.env.AZURE_ACCESS_TOKEN;
  delete process.env.AZURE_ACCESS_TOKEN;
  await assert.rejects(hsm.listKeys(), /access token not configured/);
  if (prev) process.env.AZURE_ACCESS_TOKEN = prev;
});
