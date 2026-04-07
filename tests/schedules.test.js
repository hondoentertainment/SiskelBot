import test from "node:test";
import assert from "node:assert/strict";

// Mock json-path-store in-memory
let _mockStore = {};

test.before(async () => {
  // Set a temp data dir so getDataDir returns something predictable
  process.env.STORAGE_PATH = "/tmp/schedules-test-" + Date.now();
});

// We test the module by exercising the exported functions
// The underlying json-path-store will write to STORAGE_PATH

await test("list returns empty array for fresh workspace", async () => {
  const mod = await import("../lib/schedules.js");
  const items = await mod.list("sched-test-ws");
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

await test("upsert creates a new schedule", async () => {
  const mod = await import("../lib/schedules.js");
  const entry = await mod.upsert("recipe-1", { cron: "0 9 * * *", enabled: true }, "sched-test-ws");
  assert.equal(entry.recipeId, "recipe-1");
  assert.equal(entry.cron, "0 9 * * *");
  assert.equal(entry.enabled, true);
  assert.equal(entry.workspace, "sched-test-ws");
  assert.ok(entry.createdAt);
});

await test("list returns the created schedule", async () => {
  const mod = await import("../lib/schedules.js");
  const items = await mod.list("sched-test-ws");
  assert.equal(items.length, 1);
  assert.equal(items[0].recipeId, "recipe-1");
});

await test("get returns schedule by recipeId", async () => {
  const mod = await import("../lib/schedules.js");
  const entry = await mod.get("recipe-1", "sched-test-ws");
  assert.ok(entry);
  assert.equal(entry.recipeId, "recipe-1");
});

await test("get returns null for nonexistent recipeId", async () => {
  const mod = await import("../lib/schedules.js");
  const entry = await mod.get("nonexistent", "sched-test-ws");
  assert.equal(entry, null);
});

await test("upsert updates existing schedule", async () => {
  const mod = await import("../lib/schedules.js");
  const entry = await mod.upsert("recipe-1", { cron: "0 12 * * *", enabled: false }, "sched-test-ws");
  assert.equal(entry.cron, "0 12 * * *");
  assert.equal(entry.enabled, false);

  const items = await mod.list("sched-test-ws");
  assert.equal(items.length, 1);
});

await test("remove deletes a schedule", async () => {
  const mod = await import("../lib/schedules.js");
  const removed = await mod.remove("recipe-1", "sched-test-ws");
  assert.equal(removed, true);

  const items = await mod.list("sched-test-ws");
  assert.equal(items.length, 0);
});

await test("remove returns false for nonexistent schedule", async () => {
  const mod = await import("../lib/schedules.js");
  const removed = await mod.remove("nonexistent", "sched-test-ws");
  assert.equal(removed, false);
});

await test("upsert trims timezone string", async () => {
  const mod = await import("../lib/schedules.js");
  const entry = await mod.upsert("recipe-tz", { cron: "0 8 * * 1", timezone: "  America/New_York  " }, "sched-test-ws");
  assert.equal(entry.timezone, "America/New_York");
});
