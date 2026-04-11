// @ts-check
/**
 * Phase 56.1: Docker agent sandboxes.
 *
 * Provides isolated sandboxes for untrusted agent runs. Each sandbox
 * wraps a (mockable) `docker exec`-style function with resource limits
 * (cpu, memory, timeout), an image policy allowlist, and persistent
 * lifecycle metadata. External docker binary is never required — the
 * executor is injectable, so tests pass a pure-JS stub.
 *
 * Exports:
 *   - createSandbox(spec)       -- create + persist a sandbox record
 *   - runInSandbox(id, cmd)     -- run a command, honoring resource limits
 *   - destroySandbox(id)        -- tear down, keep a "destroyed" audit row
 *   - listSandboxes()           -- list all known sandboxes
 *   - setResourceLimits(id, r)  -- mutate cpu/memory/timeout on an existing box
 *   - setExecutor(fn)           -- dependency injection for docker exec
 *   - isImageAllowed(img)       -- image policy helper
 *
 * @module agent-sandbox
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

/** Default allow-list of docker images approved for agent sandboxes. */
export const DEFAULT_ALLOWED_IMAGES = Object.freeze([
  "python:3.11-slim",
  "python:3.12-slim",
  "node:20-alpine",
  "node:22-alpine",
  "alpine:3.19",
  "ubuntu:22.04",
  "debian:bookworm-slim",
]);

/** Default per-sandbox resource ceiling. */
export const DEFAULT_LIMITS = Object.freeze({
  cpus: 1,
  memoryMb: 512,
  timeoutMs: 30_000,
  pidsLimit: 128,
});

/** Absolute maximum enforced regardless of caller input. */
export const HARD_LIMITS = Object.freeze({
  cpus: 8,
  memoryMb: 8192,
  timeoutMs: 10 * 60_000,
  pidsLimit: 2048,
});

function storePath() {
  return join(getDataDir(), "agent-sandbox.json");
}

function now() {
  return new Date().toISOString();
}

function randomId() {
  return `sbx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    sandboxes: {},
    allowedImages: DEFAULT_ALLOWED_IMAGES.slice(),
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, sandboxes: {}, allowedImages: DEFAULT_ALLOWED_IMAGES.slice() };
  }
  if (!raw.sandboxes || typeof raw.sandboxes !== "object") raw.sandboxes = {};
  if (!Array.isArray(raw.allowedImages)) raw.allowedImages = DEFAULT_ALLOWED_IMAGES.slice();
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    sandboxes: store.sandboxes || {},
    allowedImages: Array.isArray(store.allowedImages)
      ? store.allowedImages
      : DEFAULT_ALLOWED_IMAGES.slice(),
  });
}

/* -------------------------------------------------------------------------- */
/* Image policy                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Check whether an image is permitted by policy.
 * @param {string} image
 * @param {string[]} [allowed]
 */
export function isImageAllowed(image, allowed = DEFAULT_ALLOWED_IMAGES.slice()) {
  if (!image || typeof image !== "string") return false;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.includes(image.trim());
}

/* -------------------------------------------------------------------------- */
/* Resource limits                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Clamp requested limits against HARD_LIMITS. Missing fields fall back
 * to DEFAULT_LIMITS.
 * @param {object} [requested]
 */
export function normalizeLimits(requested = {}) {
  const r = requested && typeof requested === "object" ? requested : {};
  const cpus = Math.max(0.1, Math.min(HARD_LIMITS.cpus,
    Number.isFinite(r.cpus) ? r.cpus : DEFAULT_LIMITS.cpus));
  const memoryMb = Math.max(32, Math.min(HARD_LIMITS.memoryMb,
    Number.isFinite(r.memoryMb) ? Math.floor(r.memoryMb) : DEFAULT_LIMITS.memoryMb));
  const timeoutMs = Math.max(100, Math.min(HARD_LIMITS.timeoutMs,
    Number.isFinite(r.timeoutMs) ? Math.floor(r.timeoutMs) : DEFAULT_LIMITS.timeoutMs));
  const pidsLimit = Math.max(8, Math.min(HARD_LIMITS.pidsLimit,
    Number.isFinite(r.pidsLimit) ? Math.floor(r.pidsLimit) : DEFAULT_LIMITS.pidsLimit));
  return { cpus, memoryMb, timeoutMs, pidsLimit };
}

/* -------------------------------------------------------------------------- */
/* Injectable executor                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {(spec: {containerId: string, image: string, command: string[], limits: object, cwd?: string, env?: object}) => Promise<{exitCode: number, stdout: string, stderr: string, durationMs: number}>} SandboxExecutor
 */

/** @type {SandboxExecutor} */
let _executor = async ({ command }) => {
  // Default executor: pure-JS "echo"-style stub. Never shells out.
  const joined = Array.isArray(command) ? command.join(" ") : String(command || "");
  return {
    exitCode: 0,
    stdout: `[stub] ${joined}\n`,
    stderr: "",
    durationMs: 1,
  };
};

/**
 * Install a custom executor. Tests pass a fake, production wires a
 * real docker exec wrapper.
 * @param {SandboxExecutor | null} fn
 */
export function setExecutor(fn) {
  if (fn === null) {
    _executor = async ({ command }) => ({
      exitCode: 0,
      stdout: `[stub] ${Array.isArray(command) ? command.join(" ") : command}\n`,
      stderr: "",
      durationMs: 1,
    });
    return;
  }
  if (typeof fn !== "function") throw new Error("executor must be a function");
  _executor = fn;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create and persist a new sandbox record.
 * @param {object} spec
 * @param {string} spec.image
 * @param {string} [spec.name]
 * @param {object} [spec.limits]
 * @param {string[]} [spec.allowedImages]
 * @param {object} [spec.metadata]
 */
export async function createSandbox(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  const image = typeof spec.image === "string" ? spec.image.trim() : "";
  if (!image) throw new Error("image is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const allow = Array.isArray(spec.allowedImages) && spec.allowedImages.length > 0
      ? spec.allowedImages
      : store.allowedImages;
    if (!isImageAllowed(image, allow)) {
      throw new Error(`image "${image}" is not in the allowed image list`);
    }
    const id = randomId();
    const ts = now();
    const record = {
      id,
      name: typeof spec.name === "string" && spec.name.trim() ? spec.name.trim() : id,
      image,
      limits: normalizeLimits(spec.limits || {}),
      state: "created",
      runs: [],
      metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {},
      createdAt: ts,
      updatedAt: ts,
      destroyedAt: null,
    };
    store.sandboxes[id] = record;
    await saveStore(store);
    return record;
  });
}

/**
 * Run a command inside a sandbox. Honors the sandbox timeout by racing
 * the executor promise against a timer.
 * @param {string} id
 * @param {string[] | string} command
 * @param {object} [opts]
 */
export async function runInSandbox(id, command, opts = {}) {
  if (!id || typeof id !== "string") throw new Error("sandbox id is required");
  const cmd = Array.isArray(command)
    ? command.map((c) => String(c))
    : typeof command === "string" && command.length > 0
      ? [command]
      : null;
  if (!cmd || cmd.length === 0) throw new Error("command is required");
  const path = storePath();

  // Read the record outside the lock so we can execute without holding it.
  const store = await loadStore();
  const rec = store.sandboxes[id];
  if (!rec) throw new Error(`sandbox "${id}" not found`);
  if (rec.state === "destroyed") throw new Error(`sandbox "${id}" is destroyed`);

  const limits = rec.limits || DEFAULT_LIMITS;
  const start = Date.now();
  let result;
  try {
    const execPromise = Promise.resolve().then(() => _executor({
      containerId: id,
      image: rec.image,
      command: cmd,
      limits,
      cwd: opts.cwd,
      env: opts.env,
    }));
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`sandbox "${id}" timed out after ${limits.timeoutMs}ms`)),
        limits.timeoutMs).unref?.();
    });
    const raw = await Promise.race([execPromise, timeoutPromise]);
    result = {
      exitCode: Number.isFinite(raw?.exitCode) ? raw.exitCode : 0,
      stdout: typeof raw?.stdout === "string" ? raw.stdout : "",
      stderr: typeof raw?.stderr === "string" ? raw.stderr : "",
      durationMs: Number.isFinite(raw?.durationMs) ? raw.durationMs : Date.now() - start,
      timedOut: false,
    };
  } catch (err) {
    result = {
      exitCode: -1,
      stdout: "",
      stderr: err?.message || String(err),
      durationMs: Date.now() - start,
      timedOut: /timed out/i.test(err?.message || ""),
    };
  }

  await withPathLock(path, async () => {
    const cur = await loadStore();
    const r = cur.sandboxes[id];
    if (!r) return;
    r.runs = Array.isArray(r.runs) ? r.runs : [];
    r.runs.push({
      command: cmd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
      at: now(),
    });
    if (r.runs.length > 100) r.runs = r.runs.slice(-100);
    r.state = result.exitCode === 0 ? "idle" : "error";
    r.updatedAt = now();
    cur.sandboxes[id] = r;
    await saveStore(cur);
  });

  return { sandboxId: id, ...result };
}

/**
 * Mark a sandbox destroyed and invoke the executor with a special
 * "destroy" command so a real docker driver can remove the container.
 * @param {string} id
 */
export async function destroySandbox(id) {
  if (!id || typeof id !== "string") throw new Error("sandbox id is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const rec = store.sandboxes[id];
    if (!rec) throw new Error(`sandbox "${id}" not found`);
    if (rec.state === "destroyed") return rec;
    try {
      await _executor({
        containerId: id,
        image: rec.image,
        command: ["__destroy__"],
        limits: rec.limits || DEFAULT_LIMITS,
      });
    } catch (_err) {
      // Best-effort: we still mark destroyed on executor failure.
    }
    rec.state = "destroyed";
    rec.destroyedAt = now();
    rec.updatedAt = rec.destroyedAt;
    store.sandboxes[id] = rec;
    await saveStore(store);
    return rec;
  });
}

/**
 * List all sandboxes (optionally filtered by state).
 * @param {object} [opts]
 */
export async function listSandboxes(opts = {}) {
  const store = await loadStore();
  const all = Object.values(store.sandboxes || {});
  if (opts && typeof opts.state === "string") {
    return all.filter((s) => s.state === opts.state);
  }
  return all;
}

/**
 * Fetch a single sandbox by id.
 * @param {string} id
 */
export async function getSandbox(id) {
  if (!id || typeof id !== "string") return null;
  const store = await loadStore();
  return store.sandboxes[id] || null;
}

/**
 * Mutate the resource limits on an existing sandbox. Clamped to
 * HARD_LIMITS and persisted immediately.
 * @param {string} id
 * @param {object} limits
 */
export async function setResourceLimits(id, limits) {
  if (!id || typeof id !== "string") throw new Error("sandbox id is required");
  if (!limits || typeof limits !== "object") throw new Error("limits is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const rec = store.sandboxes[id];
    if (!rec) throw new Error(`sandbox "${id}" not found`);
    if (rec.state === "destroyed") throw new Error(`sandbox "${id}" is destroyed`);
    rec.limits = normalizeLimits({ ...(rec.limits || {}), ...limits });
    rec.updatedAt = now();
    store.sandboxes[id] = rec;
    await saveStore(store);
    return rec;
  });
}

/**
 * Replace the allowed-images policy. Admin-only in typical deploys.
 * @param {string[]} images
 */
export async function setAllowedImages(images) {
  if (!Array.isArray(images)) throw new Error("images must be an array");
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    store.allowedImages = images.map((i) => String(i)).filter(Boolean);
    await saveStore(store);
    return store.allowedImages.slice();
  });
}

/** Read the allowed-images policy. */
export async function getAllowedImages() {
  const store = await loadStore();
  return (store.allowedImages || DEFAULT_ALLOWED_IMAGES).slice();
}
