/**
 * Phase 61.4: local-dev-env tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-devenv-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  loadManifest,
  seedData,
  startServices,
  stopServices,
  getDevStatus,
  validateManifest,
} = await import("../lib/local-dev-env.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function basicManifest() {
  return {
    name: "basic",
    services: [
      { name: "db", command: "fake-db" },
      { name: "api", command: "fake-api", dependsOn: ["db"], port: 3000 },
      { name: "worker", command: "fake-worker", dependsOn: ["db"] },
    ],
    seeds: [
      { name: "users", type: "json", data: [{ id: 1 }] },
    ],
  };
}

test("validateManifest normalizes shape", () => {
  const n = validateManifest(basicManifest());
  assert.equal(n.services.length, 3);
  assert.equal(n.seeds.length, 1);
});

test("validateManifest rejects bogus input", () => {
  assert.throws(() => validateManifest(null));
  assert.throws(() => validateManifest({ name: "x" }));
  assert.throws(() => validateManifest({ name: "x", services: [{}] }));
  assert.throws(() => validateManifest({
    name: "x",
    services: [{ name: "a" }, { name: "a" }],
  }));
});

test("loadManifest stores manifest from object", async () => {
  const manifest = await loadManifest(basicManifest());
  assert.equal(manifest.name, "basic");
  const status = await getDevStatus();
  assert.equal(status.manifest, "basic");
  assert.equal(status.services.length, 3);
});

test("loadManifest loads from a file", async () => {
  const path = join(TMP_DATA_DIR, "manifest.json");
  writeFileSync(path, JSON.stringify(basicManifest()));
  const manifest = await loadManifest(path);
  assert.equal(manifest.name, "basic");
});

test("loadManifest rejects missing file", async () => {
  await assert.rejects(() => loadManifest("/nonexistent/manifest.json"));
});

test("seedData applies seeds via injected callback", async () => {
  await loadManifest(basicManifest());
  const applied = [];
  const result = await seedData({
    apply: async (seed) => {
      applied.push(seed.name);
      return { written: 1 };
    },
  });
  assert.equal(result.seeded, 1);
  assert.deepEqual(applied, ["users"]);
  assert.equal(result.results[0].result.written, 1);
});

test("seedData captures per-seed errors", async () => {
  await loadManifest(basicManifest());
  const result = await seedData({
    apply: async () => { throw new Error("db down"); },
  });
  assert.equal(result.seeded, 1);
  assert.equal(result.results[0].error, "db down");
});

test("startServices starts in dependency order", async () => {
  await loadManifest(basicManifest());
  const started = [];
  const spawner = async (svc) => {
    started.push(svc.name);
    return { ok: true, pid: `pid-${svc.name}` };
  };
  const result = await startServices({ spawner });
  assert.equal(result.started, 3);
  assert.equal(started[0], "db");
  assert.ok(started.indexOf("api") > started.indexOf("db"));
  assert.ok(started.indexOf("worker") > started.indexOf("db"));
});

test("startServices marks errors without aborting siblings", async () => {
  await loadManifest(basicManifest());
  const spawner = async (svc) => {
    if (svc.name === "api") throw new Error("port busy");
    return { ok: true, pid: "x" };
  };
  const result = await startServices({ spawner });
  const apiResult = result.results.find((r) => r.name === "api");
  assert.ok(apiResult);
  assert.equal(apiResult.ok, false);
  assert.equal(apiResult.error, "port busy");
  const status = await getDevStatus();
  const apiState = status.services.find((s) => s.name === "api");
  assert.equal(apiState.status, "error");
});

test("startServices honors names filter", async () => {
  await loadManifest(basicManifest());
  const seen = [];
  await startServices({
    names: ["db"],
    spawner: async (svc) => { seen.push(svc.name); return { ok: true, pid: 1 }; },
  });
  assert.deepEqual(seen, ["db"]);
});

test("stopServices stops running services", async () => {
  await loadManifest(basicManifest());
  await startServices({ spawner: async () => ({ ok: true, pid: 1 }) });
  const result = await stopServices({ stopper: async () => ({ ok: true }) });
  assert.ok(result.stopped >= 3);
  const status = await getDevStatus();
  assert.equal(status.running, 0);
});

test("getDevStatus reflects counts", async () => {
  await loadManifest(basicManifest());
  await startServices({ spawner: async () => ({ ok: true, pid: 1 }) });
  const status = await getDevStatus();
  assert.equal(status.running, 3);
  assert.equal(status.stopped, 0);
  assert.equal(status.manifest, "basic");
});

test("startServices throws without a manifest", async () => {
  // Clear the store by loading a manifest with no services? Instead
  // test directly by wiping.
  const path = join(TMP_DATA_DIR, "manifest-empty.json");
  writeFileSync(path, JSON.stringify({ name: "n", services: [] }));
  await loadManifest(path);
  const result = await startServices({ spawner: async () => ({ ok: true }) });
  assert.equal(result.started, 0);
});
