/**
 * Feature flag system tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  getFlag,
  isEnabled,
  setFlag,
  deleteFlag,
  listFlags,
  evaluateTargeting,
  __resetCacheForTests,
} from "../lib/feature-flags.js";

function makeMockStorage() {
  const data = new Map();
  const calls = { getItem: 0, setItem: 0, deleteItem: 0, listItems: 0 };
  return {
    data,
    calls,
    async getItem(type, id /*, workspace, userId */) {
      calls.getItem++;
      return data.get(`${type}\0${id}`) ?? null;
    },
    async setItem(type, id, value /*, workspace, userId */) {
      calls.setItem++;
      data.set(`${type}\0${id}`, value);
    },
    async deleteItem(type, id /*, workspace, userId */) {
      calls.deleteItem++;
      data.delete(`${type}\0${id}`);
    },
    async listItems(type /*, workspace, userId */) {
      calls.listItems++;
      const out = [];
      for (const [k, v] of data.entries()) {
        if (k.startsWith(`${type}\0`)) out.push(v);
      }
      return out;
    },
  };
}

test("evaluateTargeting: disabled flag returns false regardless of targeting", () => {
  const flag = {
    key: "f1",
    enabled: false,
    value: true,
    defaultValue: false,
    targeting: { workspaces: ["acme"], users: ["u1"], percentage: 100 },
  };
  assert.equal(evaluateTargeting(flag, { workspaceId: "acme", userId: "u1" }), false);
});

test("evaluateTargeting: workspace allowlist hits then misses", () => {
  const flag = {
    key: "f2",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { workspaces: ["acme", "beta"] },
  };
  assert.equal(evaluateTargeting(flag, { workspaceId: "acme" }), true);
  assert.equal(evaluateTargeting(flag, { workspaceId: "beta" }), true);
  assert.equal(evaluateTargeting(flag, { workspaceId: "other" }), false);
  assert.equal(evaluateTargeting(flag, {}), false);
});

test("evaluateTargeting: user allowlist hits then misses", () => {
  const flag = {
    key: "f3",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { users: ["u1", "u2"] },
  };
  assert.equal(evaluateTargeting(flag, { userId: "u1" }), true);
  assert.equal(evaluateTargeting(flag, { userId: "u2" }), true);
  assert.equal(evaluateTargeting(flag, { userId: "other" }), false);
});

test("evaluateTargeting: percentage rollout is deterministic for same userId", () => {
  const flag = {
    key: "f-pct",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { percentage: 50 },
  };
  const r1 = evaluateTargeting(flag, { userId: "stable-user-123" });
  const r2 = evaluateTargeting(flag, { userId: "stable-user-123" });
  const r3 = evaluateTargeting(flag, { userId: "stable-user-123" });
  assert.equal(r1, r2);
  assert.equal(r2, r3);
});

test("evaluateTargeting: percentage rollout distribution roughly matches percentage (±5)", () => {
  const flag = {
    key: "f-dist",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { percentage: 25 },
  };
  let hits = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    if (evaluateTargeting(flag, { userId: `user-${i}` })) hits++;
  }
  const pct = (hits / N) * 100;
  assert.ok(Math.abs(pct - 25) <= 5, `expected ~25%, got ${pct}%`);
});

test("evaluateTargeting: percentage 100 means everyone with userId enabled", () => {
  const flag = {
    key: "f-all",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { percentage: 100 },
  };
  for (let i = 0; i < 50; i++) {
    assert.equal(evaluateTargeting(flag, { userId: `u-${i}` }), true);
  }
});

test("evaluateTargeting: date window — before start is false", () => {
  const flag = {
    key: "f-date",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { startDate: new Date(Date.now() + 60_000).toISOString() },
  };
  assert.equal(evaluateTargeting(flag, { userId: "u1" }), false);
});

test("evaluateTargeting: date window — after end is false", () => {
  const flag = {
    key: "f-date2",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: { endDate: new Date(Date.now() - 60_000).toISOString() },
  };
  assert.equal(evaluateTargeting(flag, { userId: "u1" }), false);
});

test("evaluateTargeting: date window — within window is true (no other rules)", () => {
  const flag = {
    key: "f-date3",
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: {
      startDate: new Date(Date.now() - 60_000).toISOString(),
      endDate: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  assert.equal(evaluateTargeting(flag, { userId: "u1" }), true);
});

test("getFlag: returns value when matched, defaultValue when not matched", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "swarm", {
    enabled: true,
    value: "new-engine",
    defaultValue: "old-engine",
    targeting: { workspaces: ["acme"] },
  });
  __resetCacheForTests();
  assert.equal(await getFlag(storage, "swarm", { workspaceId: "acme" }), "new-engine");
  __resetCacheForTests();
  assert.equal(await getFlag(storage, "swarm", { workspaceId: "other" }), "old-engine");
});

test("getFlag: returns undefined when flag does not exist", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  const v = await getFlag(storage, "no-such-flag", { userId: "u1" });
  assert.equal(v, undefined);
});

test("getFlag: cache hit avoids storage on second call within TTL", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "cached", {
    enabled: true,
    value: 42,
    defaultValue: 0,
    targeting: {},
  });
  __resetCacheForTests();
  const before = storage.calls.getItem;
  const v1 = await getFlag(storage, "cached", { userId: "u1" });
  const after1 = storage.calls.getItem;
  const v2 = await getFlag(storage, "cached", { userId: "u1" });
  const after2 = storage.calls.getItem;
  assert.equal(v1, 42);
  assert.equal(v2, 42);
  assert.equal(after1 - before, 1, "first call hits storage");
  assert.equal(after2 - after1, 0, "second call within TTL must not hit storage");
});

test("setFlag: invalidates cache for that key", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "tog", {
    enabled: true,
    value: "A",
    defaultValue: "B",
    targeting: {},
  });
  assert.equal(await getFlag(storage, "tog", { userId: "u1" }), "A");
  // Update flag — cache should be busted, so we see new value.
  await setFlag(storage, "tog", {
    enabled: true,
    value: "C",
    defaultValue: "B",
    targeting: {},
  });
  assert.equal(await getFlag(storage, "tog", { userId: "u1" }), "C");
});

test("deleteFlag: removes flag and invalidates cache", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "to-delete", {
    enabled: true,
    value: 1,
    defaultValue: 0,
    targeting: {},
  });
  assert.equal(await getFlag(storage, "to-delete", { userId: "u1" }), 1);
  await deleteFlag(storage, "to-delete");
  assert.equal(await getFlag(storage, "to-delete", { userId: "u1" }), undefined);
});

test("isEnabled: returns true only when flag value is strictly true", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "bool-flag", {
    enabled: true,
    value: true,
    defaultValue: false,
    targeting: {},
  });
  assert.equal(await isEnabled(storage, "bool-flag", { userId: "u1" }), true);

  __resetCacheForTests();
  await setFlag(storage, "string-flag", {
    enabled: true,
    value: "yes",
    defaultValue: false,
    targeting: {},
  });
  assert.equal(await isEnabled(storage, "string-flag", { userId: "u1" }), false);
});

test("listFlags: returns all stored flags", async () => {
  __resetCacheForTests();
  const storage = makeMockStorage();
  await setFlag(storage, "a", { enabled: true, value: 1, defaultValue: 0, targeting: {} });
  await setFlag(storage, "b", { enabled: false, value: 1, defaultValue: 0, targeting: {} });
  const flags = await listFlags(storage);
  assert.equal(flags.length, 2);
  const keys = flags.map((f) => f.key).sort();
  assert.deepEqual(keys, ["a", "b"]);
});
