import test from "node:test";
import assert from "node:assert/strict";
import {
  setSecret,
  getSecretValue,
  listSecrets,
  deleteSecret,
  injectSecretsIntoEnv,
  resolveSessionSecrets,
} from "../lib/secrets-store.js";

const scope = () => ["workspace", `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`];

test("setSecret and getSecretValue round-trips value", async () => {
  const [type, id] = scope();
  const result = await setSecret(type, id, "MY_KEY", "secret-value", "test secret");
  assert.equal(result.name, "MY_KEY");
  assert.ok(!result.encryptedValue, "encryptedValue should be stripped");
  const retrieved = await getSecretValue(type, id, "MY_KEY");
  assert.equal(retrieved, "secret-value");
});

test("getSecretValue returns null for missing secret", async () => {
  const [type, id] = scope();
  const result = await getSecretValue(type, id, "NONEXISTENT");
  assert.equal(result, null);
});

test("listSecrets returns all set secrets without sensitive fields", async () => {
  const [type, id] = scope();
  await setSecret(type, id, "KEY_A", "val-a");
  await setSecret(type, id, "KEY_B", "val-b");
  const list = await listSecrets(type, id);
  assert.equal(list.length, 2);
  assert.ok(list.every((s) => !s.encryptedValue), "encryptedValue should not be in list");
  assert.ok(list.some((s) => s.name === "KEY_A"));
  assert.ok(list.some((s) => s.name === "KEY_B"));
});

test("setSecret overwrites existing secret", async () => {
  const [type, id] = scope();
  await setSecret(type, id, "OVERWRITE_KEY", "original");
  await setSecret(type, id, "OVERWRITE_KEY", "updated");
  const val = await getSecretValue(type, id, "OVERWRITE_KEY");
  assert.equal(val, "updated");
  const list = await listSecrets(type, id);
  assert.equal(list.filter((s) => s.name === "OVERWRITE_KEY").length, 1);
});

test("deleteSecret removes the secret", async () => {
  const [type, id] = scope();
  await setSecret(type, id, "TO_DELETE", "val");
  const del = await deleteSecret(type, id, "TO_DELETE");
  assert.equal(del.deleted, true);
  const val = await getSecretValue(type, id, "TO_DELETE");
  assert.equal(val, null);
});

test("deleteSecret returns deleted:false when secret does not exist", async () => {
  const [type, id] = scope();
  const del = await deleteSecret(type, id, "NEVER_SET");
  assert.equal(del.deleted, false);
});

test("injectSecretsIntoEnv returns key-value object", async () => {
  const [type, id] = scope();
  await setSecret(type, id, "ENV_A", "env-val-a");
  await setSecret(type, id, "ENV_B", "env-val-b");
  const env = await injectSecretsIntoEnv(type, id);
  assert.equal(env.ENV_A, "env-val-a");
  assert.equal(env.ENV_B, "env-val-b");
});

test("resolveSessionSecrets merges org, workspace, session envs (session wins)", async () => {
  const orgId = `test-org-${Date.now()}`;
  const wsId = `test-ws-${Date.now()}`;
  const sessId = `test-sess-${Date.now()}`;
  await setSecret("org", orgId, "SHARED", "from-org");
  await setSecret("workspace", wsId, "SHARED", "from-ws");
  await setSecret("session", sessId, "SHARED", "from-session");
  const env = await resolveSessionSecrets(orgId, wsId, sessId);
  assert.equal(env.SHARED, "from-session");
});

test("listSecrets returns empty array for unknown scope", async () => {
  const [type, id] = scope();
  const list = await listSecrets(type, id);
  assert.deepEqual(list, []);
});
