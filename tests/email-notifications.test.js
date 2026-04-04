import test from "node:test";
import assert from "node:assert/strict";
import { isEmailConfigured, isDigestEnabled, sendDigest } from "../lib/email-notifications.js";

test("isEmailConfigured returns false when SMTP_HOST not set", () => {
  // SMTP_HOST is read at module load time and defaults to ""
  assert.equal(isEmailConfigured(), false);
});

test("isDigestEnabled returns false when email not configured", () => {
  // Even if EMAIL_DIGEST_ENABLED were set, without SMTP_HOST it should be false
  assert.equal(isDigestEnabled(), false);
});

test("sendDigest returns error results when email not configured", async () => {
  const events = [
    { event: "swarm_completed", timestamp: "2025-01-01T00:00:00Z", data: { success: true } },
    { event: "recipe_executed", timestamp: "2025-01-01T01:00:00Z", data: { recipeName: "test-recipe" } },
    { type: "audit", event: "plan_created", timestamp: "2025-01-01T02:00:00Z" },
  ];

  const results = await sendDigest("admin@example.com", events, "daily");
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error.includes("not configured"));
});

test("sendDigest handles multiple recipients", async () => {
  const results = await sendDigest(
    ["a@example.com", "b@example.com"],
    [],
    "weekly",
  );
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("not configured"));
  }
});

test("sendDigest handles empty events array", async () => {
  const results = await sendDigest("test@example.com", [], "daily");
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 1);
  // Should still attempt to send (and fail due to no SMTP)
  assert.equal(results[0].ok, false);
});
