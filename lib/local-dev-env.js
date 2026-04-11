// @ts-check
/**
 * Phase 61.4: Local dev environment.
 *
 * Parses a manifest of services and seed data and tracks their "state"
 * in a persisted registry. This module does NOT spawn real
 * processes (tests must stay hermetic); instead, it invokes an
 * injectable `spawner` callback so callers can wire in child_process
 * or docker-compose themselves.
 *
 * Export surface:
 *   - loadManifest(manifest | path)
 *   - seedData(config)
 *   - startServices({ spawner? })
 *   - stopServices({ stopper? })
 *   - getDevStatus()
 *
 * @module local-dev-env
 */
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "local-dev-env.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function emptyStore() {
  return {
    version: STORE_VERSION,
    manifest: null,
    services: {},
    seeds: [],
    updatedAt: null,
  };
}

async function loadStore() {
  const data = await readJsonPath(storePath(), emptyStore());
  if (!data.services || typeof data.services !== "object") data.services = {};
  if (!Array.isArray(data.seeds)) data.seeds = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    manifest: data.manifest || null,
    services: data.services || {},
    seeds: data.seeds || [],
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Validate and normalize a dev manifest.
 *
 * Manifest shape:
 *   {
 *     name: string,
 *     services: [{ name, command, cwd?, env?, port?, dependsOn? }],
 *     seeds: [{ name, type, data? | file? }]
 *   }
 *
 * @param {any} manifest
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error("manifest.name is required");
  }
  if (!Array.isArray(manifest.services)) {
    throw new Error("manifest.services must be an array");
  }
  /** @type {any[]} */
  const services = [];
  const seen = new Set();
  for (const s of manifest.services) {
    if (!s || typeof s !== "object") {
      throw new Error("each service must be an object");
    }
    if (!s.name || typeof s.name !== "string") {
      throw new Error("service.name is required");
    }
    if (seen.has(s.name)) {
      throw new Error(`duplicate service name: ${s.name}`);
    }
    seen.add(s.name);
    services.push({
      name: s.name,
      command: typeof s.command === "string" ? s.command : "",
      cwd: typeof s.cwd === "string" ? s.cwd : null,
      env: s.env && typeof s.env === "object" ? { ...s.env } : {},
      port: Number.isFinite(s.port) ? s.port : null,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : [],
      healthCheck: typeof s.healthCheck === "string" ? s.healthCheck : null,
    });
  }
  /** @type {any[]} */
  const seeds = [];
  if (Array.isArray(manifest.seeds)) {
    for (const seed of manifest.seeds) {
      if (!seed || typeof seed !== "object") continue;
      if (!seed.name) continue;
      seeds.push({
        name: seed.name,
        type: typeof seed.type === "string" ? seed.type : "json",
        data: seed.data != null ? seed.data : null,
        file: typeof seed.file === "string" ? seed.file : null,
      });
    }
  }
  return { name: manifest.name, services, seeds };
}

/**
 * Load a manifest from an object or a file path.
 *
 * @param {string|object} manifestOrPath
 */
export async function loadManifest(manifestOrPath) {
  let raw = manifestOrPath;
  if (typeof manifestOrPath === "string") {
    if (!existsSync(manifestOrPath)) {
      throw new Error(`manifest file not found: ${manifestOrPath}`);
    }
    try {
      raw = JSON.parse(readFileSync(manifestOrPath, "utf8"));
    } catch (err) {
      throw new Error(`failed to parse manifest: ${err?.message || err}`);
    }
  }
  const normalized = validateManifest(raw);
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    store.manifest = normalized;
    // Reset any prior service state so a new manifest starts clean.
    store.services = {};
    for (const s of normalized.services) {
      store.services[s.name] = {
        name: s.name,
        status: "stopped",
        command: s.command,
        port: s.port,
        startedAt: null,
        stoppedAt: null,
        pid: null,
      };
    }
    await saveStore(store);
    return normalized;
  });
}

/* -------------------------------------------------------------------------- */
/* Seed data                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Persist a seed data configuration. The actual writing is handled by
 * an injectable `apply` callback so tests can verify it.
 *
 * @param {{ name?: string, type?: string, data?: any, apply?: (seed: any) => Promise<any> }} [config]
 */
export async function seedData(config = {}) {
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const manifestSeeds = store.manifest?.seeds || [];
    /** @type {any[]} */
    const seedsToApply = [];
    if (config.name) {
      const fromManifest = manifestSeeds.find((s) => s.name === config.name);
      if (fromManifest) seedsToApply.push(fromManifest);
      else seedsToApply.push({ name: config.name, type: config.type || "json", data: config.data });
    } else if (manifestSeeds.length > 0) {
      seedsToApply.push(...manifestSeeds);
    } else if (config.data != null) {
      seedsToApply.push({ name: "adhoc", type: config.type || "json", data: config.data });
    }
    const applyFn = typeof config.apply === "function" ? config.apply : async () => ({ applied: true });
    /** @type {any[]} */
    const results = [];
    for (const seed of seedsToApply) {
      let result = null;
      let error = null;
      try {
        result = await applyFn(seed);
      } catch (err) {
        error = err?.message || String(err);
      }
      const record = {
        name: seed.name,
        type: seed.type,
        result,
        error,
        appliedAt: new Date().toISOString(),
      };
      store.seeds.push(record);
      results.push(record);
    }
    if (store.seeds.length > 500) {
      store.seeds = store.seeds.slice(-500);
    }
    await saveStore(store);
    return { seeded: results.length, results };
  });
}

/* -------------------------------------------------------------------------- */
/* Services                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Start all services in dependency order. Uses injected spawner.
 *
 * @param {{ spawner?: (service: any) => Promise<{ pid?: number|string, ok?: boolean, error?: string }>, names?: string[] }} [opts]
 */
export async function startServices(opts = {}) {
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    if (!store.manifest) {
      throw new Error("no manifest loaded");
    }
    const services = store.manifest.services || [];
    const ordered = topoSort(services);
    const spawner = typeof opts.spawner === "function" ? opts.spawner : defaultSpawner;
    const wanted = Array.isArray(opts.names) && opts.names.length > 0 ? new Set(opts.names) : null;
    /** @type {any[]} */
    const results = [];
    for (const svc of ordered) {
      if (wanted && !wanted.has(svc.name)) continue;
      const state = store.services[svc.name] || { name: svc.name, status: "stopped" };
      if (state.status === "running") {
        results.push({ name: svc.name, skipped: true, reason: "already running" });
        continue;
      }
      let spawnResult = null;
      let error = null;
      try {
        spawnResult = await spawner(svc);
      } catch (err) {
        error = err?.message || String(err);
      }
      if (spawnResult && spawnResult.ok === false) {
        error = typeof spawnResult.error === "string" ? spawnResult.error : "spawner returned ok=false";
      }
      if (error) {
        store.services[svc.name] = {
          ...state,
          status: "error",
          error,
          updatedAt: new Date().toISOString(),
        };
        results.push({ name: svc.name, ok: false, error });
        continue;
      }
      store.services[svc.name] = {
        ...state,
        status: "running",
        pid: spawnResult?.pid != null ? spawnResult.pid : null,
        startedAt: new Date().toISOString(),
        error: null,
      };
      results.push({ name: svc.name, ok: true, pid: spawnResult?.pid });
    }
    await saveStore(store);
    return { started: results.filter((r) => r.ok).length, results };
  });
}

/**
 * Stop all running services. Uses injected stopper.
 *
 * @param {{ stopper?: (service: any) => Promise<{ ok?: boolean, error?: string }>, names?: string[] }} [opts]
 */
export async function stopServices(opts = {}) {
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const stopper = typeof opts.stopper === "function" ? opts.stopper : async () => ({ ok: true });
    const wanted = Array.isArray(opts.names) && opts.names.length > 0 ? new Set(opts.names) : null;
    /** @type {any[]} */
    const results = [];
    for (const [name, state] of Object.entries(store.services || {})) {
      if (wanted && !wanted.has(name)) continue;
      if (/** @type {any} */ (state).status !== "running") {
        results.push({ name, skipped: true, reason: "not running" });
        continue;
      }
      let error = null;
      try {
        const out = await stopper(state);
        if (out && out.ok === false) {
          error = typeof out.error === "string" ? out.error : "stopper returned ok=false";
        }
      } catch (err) {
        error = err?.message || String(err);
      }
      store.services[name] = {
        .../** @type {any} */ (state),
        status: error ? "error" : "stopped",
        stoppedAt: new Date().toISOString(),
        error: error || null,
        pid: null,
      };
      results.push({ name, ok: !error, error });
    }
    await saveStore(store);
    return { stopped: results.filter((r) => r.ok).length, results };
  });
}

/**
 * Return the dev environment status snapshot.
 */
export async function getDevStatus() {
  const data = await loadStore();
  const services = Object.values(data.services || {});
  const running = services.filter((s) => /** @type {any} */ (s).status === "running").length;
  return {
    manifest: data.manifest?.name || null,
    services,
    running,
    stopped: services.length - running,
    seedsApplied: (data.seeds || []).length,
    updatedAt: data.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Kahn's algorithm on services.dependsOn.
 *
 * @param {any[]} services
 */
function topoSort(services) {
  const nameToSvc = new Map(services.map((s) => [s.name, s]));
  const inDegree = new Map(services.map((s) => [s.name, 0]));
  for (const s of services) {
    for (const dep of s.dependsOn || []) {
      if (nameToSvc.has(dep)) {
        inDegree.set(s.name, (inDegree.get(s.name) || 0) + 1);
      }
    }
  }
  /** @type {any[]} */
  const out = [];
  /** @type {any[]} */
  const queue = [];
  for (const [name, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(nameToSvc.get(name));
  }
  while (queue.length > 0) {
    const svc = queue.shift();
    if (!svc) continue;
    out.push(svc);
    for (const other of services) {
      if ((other.dependsOn || []).includes(svc.name)) {
        inDegree.set(other.name, (inDegree.get(other.name) || 0) - 1);
        if (inDegree.get(other.name) === 0) {
          queue.push(nameToSvc.get(other.name));
        }
      }
    }
  }
  // If cycle, fall back to original order.
  return out.length === services.length ? out : services;
}

async function defaultSpawner(_service) {
  // We intentionally do NOT invoke child_process here; callers must inject.
  return { ok: true, pid: "simulated" };
}
