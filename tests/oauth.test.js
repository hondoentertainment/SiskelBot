import test from "node:test";
import assert from "node:assert/strict";

test("isOAuthConfigured returns false when no env vars set", async () => {
  // Clear OAuth env vars
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const { isOAuthConfigured } = await import("../lib/oauth.js");
  assert.equal(isOAuthConfigured(), false);
});

test("isOAuthConfigured returns true when GitHub vars are set", async () => {
  process.env.GITHUB_CLIENT_ID = "test-client-id";
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const { isOAuthConfigured } = await import("../lib/oauth.js");
  assert.equal(isOAuthConfigured(), true);

  // Cleanup
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

test("isOAuthConfigured returns true when Google vars are set", async () => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID = "test-google-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";

  const { isOAuthConfigured } = await import("../lib/oauth.js");
  assert.equal(isOAuthConfigured(), true);

  // Cleanup
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

test("initPassport returns strategy status", async () => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const { initPassport } = await import("../lib/oauth.js");
  const result = initPassport();
  assert.equal(typeof result.github, "boolean");
  assert.equal(typeof result.google, "boolean");
  // Without env vars, both should be false
  assert.equal(result.github, false);
  assert.equal(result.google, false);
});

test("getOrCreateUser creates a new user", async () => {
  process.env.STORAGE_PATH = "/tmp/oauth-test-" + Date.now();
  const { getOrCreateUser } = await import("../lib/oauth.js");
  const result = await getOrCreateUser("github", "12345");
  assert.equal(result.provider, "github");
  assert.ok(result.userId.startsWith("github-"));
  assert.ok(result.userId.includes("12345"));
});

test("getOrCreateUser returns existing user on second call", async () => {
  const { getOrCreateUser } = await import("../lib/oauth.js");
  const first = await getOrCreateUser("github", "67890");
  const second = await getOrCreateUser("github", "67890");
  assert.equal(first.userId, second.userId);
});
