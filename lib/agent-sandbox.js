// @ts-check
/**
 * Phase 56.1: Docker agent sandboxes.
 *
 * Pluggable container runtime abstraction for running untrusted agent tools in
 * isolated environments. The default runtime is an in-process mock used for
 * tests and development — real backends (docker CLI, podman, containerd) can
 * be wired in via `registerRuntime`. The module persists sandbox metadata via
 * `json-path-store.js` so the state survives process restarts and so
 * management operations work across routes and tests.
 *
 * Design goals:
 *   - No new dependencies. Everything is plain Node.
 *   - Deterministic resource limits (`DEFAULT_LIMITS` + `enforceLimits`).
 *   - Runtime-agnostic API (`createSandbox`, `execInSandbox`, etc.).
 *   - Read-only volume mounts by default.
 *   - Explicit lifecycle (`created → running → stopped → removed`).
 *
 * @module agent-sandbox
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Image catalogue
// ---------------------------------------------------------------------------

export const SANDBOX_IMAGES = {
  "node-alpine": { base: "node:20-alpine", tools: ["node", "npm"] },
  "python-slim": { base: "python:3.12-slim", tools: ["python", "pip"] },
  "shell": { base: "ubuntu:22.04", tools: ["bash"] },
};

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

export const DEFAULT_LIMITS = {
  cpuShares: 512,
  memoryMB: 512,
  timeoutSec: 60,
  network: "none",
};

const LIMIT_MAXIMA = {
  cpuShares: 4096,
  memoryMB: 8192,
  timeoutSec: 600,
};

const ALLOWED_NETWORKS = new Set(["none", "bridge", "host"]);

/**
 * Enforce and normalize resource limits. Unknown keys are stripped and values
 * are clamped to the configured maxima.
 *
 * @param {object} [request]
 * @param {object} [defaults]
 * @returns {{cpuShares: number, memoryMB: number, timeoutSec: number, network: string}}
 */
export function enforceLimits(request = {}, defaults = DEFAULT_LIMITS) {
  const base = { ...DEFAULT_LIMITS, ...defaults };
  const req = request && typeof request === "object" ? request : {};
  const cpuShares = clampNumber(req.cpuShares, base.cpuShares, 2, LIMIT_MAXIMA.cpuShares);
  const memoryMB = clampNumber(req.memoryMB, base.memoryMB, 16, LIMIT_MAXIMA.memoryMB);
  const timeoutSec = clampNumber(req.timeoutSec, base.timeoutSec, 1, LIMIT_MAXIMA.timeoutSec);
  const network = ALLOWED_NETWORKS.has(req.network) ? req.network : base.network;
  return { cpuShares, memoryMB, timeoutSec, network };
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

const runtimes = new Map();
let defaultRuntimeName = "mock";

/**
 * Register a container runtime implementation.
 *
 * Runtimes must implement: pull, run, exec, stop, remove, logs, list.
 *
 * @param {string} name
 * @param {object} runtime
 */
export function registerRuntime(name, runtime) {
  if (!name || typeof name !== "string") {
    throw new Error("registerRuntime: name is required");
  }
  if (!runtime || typeof runtime !== "object") {
    throw new Error("registerRuntime: runtime must be an object");
  }
  for (const method of ["pull", "run", "exec", "stop", "remove", "logs", "list"]) {
    if (typeof runtime[method] !== "function") {
      throw new Error(`registerRuntime: runtime.${method} must be a function`);
    }
  }
  runtimes.set(name, runtime);
}

/**
 * Resolve a registered runtime by name (defaults to "mock").
 *
 * @param {string} [name]
 * @returns {object}
 */
export function getRuntime(name = defaultRuntimeName) {
  const resolved = runtimes.get(name);
  if (!resolved) {
    throw new Error(`runtime not registered: ${name}`);
  }
  return resolved;
}

export function setDefaultRuntime(name) {
  if (!runtimes.has(name)) {
    throw new Error(`cannot set default runtime: ${name} is not registered`);
  }
  defaultRuntimeName = name;
}

// ---------------------------------------------------------------------------
// Mock runtime
// ---------------------------------------------------------------------------

const mockContainers = new Map();
const mockLogs = new Map();

export const mockRuntime = {
  async pull(image) {
    return { image, pulled: true, digest: `sha256:${hashString(image)}` };
  },

  async run(config) {
    const id = `mock_${crypto.randomBytes(8).toString("hex")}`;
    const now = Date.now();
    const container = {
      id,
      image: config.image,
      command: config.command || null,
      env: config.env || {},
      workdir: config.workdir || "/workspace",
      limits: config.limits || DEFAULT_LIMITS,
      mounts: config.mounts ? [...config.mounts] : [],
      state: "running",
      startedAt: now,
      exitCode: null,
      stoppedAt: null,
    };
    mockContainers.set(id, container);
    mockLogs.set(id, []);
    return container;
  },

  async exec(containerId, command, options = {}) {
    const container = mockContainers.get(containerId);
    if (!container) {
      const err = new Error(`container not found: ${containerId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (container.state !== "running") {
      const err = new Error(`container ${containerId} is not running (state=${container.state})`);
      err.code = "NOT_RUNNING";
      throw err;
    }
    const timeoutSec = Number(options.timeoutSec) || container.limits.timeoutSec || 60;
    // Simulate timeout: if a command explicitly requests a sleep greater than
    // the configured timeout, mark it as timed out instead of executing.
    const sleepMatch = typeof command === "string" ? command.match(/^sleep\s+(\d+)/) : null;
    if (sleepMatch && Number(sleepMatch[1]) > timeoutSec) {
      const entry = {
        command,
        stdout: "",
        stderr: `timeout after ${timeoutSec}s`,
        exitCode: 124,
        timedOut: true,
        at: Date.now(),
      };
      mockLogs.get(containerId).push(entry);
      return entry;
    }
    const stdout = renderMockStdout(command);
    const entry = {
      command,
      stdout,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      at: Date.now(),
    };
    mockLogs.get(containerId).push(entry);
    return entry;
  },

  async stop(containerId) {
    const container = mockContainers.get(containerId);
    if (!container) {
      const err = new Error(`container not found: ${containerId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (container.state === "stopped") return container;
    container.state = "stopped";
    container.stoppedAt = Date.now();
    container.exitCode = 0;
    return container;
  },

  async remove(containerId) {
    const existed = mockContainers.delete(containerId);
    mockLogs.delete(containerId);
    return { removed: existed };
  },

  async logs(containerId, options = {}) {
    const entries = mockLogs.get(containerId);
    if (!entries) {
      const err = new Error(`container not found: ${containerId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const tail = Number(options.tail);
    if (Number.isFinite(tail) && tail > 0) {
      return entries.slice(-tail);
    }
    return [...entries];
  },

  async list() {
    return [...mockContainers.values()].map((c) => ({ ...c }));
  },

  // Test helper — not part of the public runtime interface.
  _reset() {
    mockContainers.clear();
    mockLogs.clear();
  },
};

registerRuntime("mock", mockRuntime);

function renderMockStdout(command) {
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (/^echo\s+/.test(trimmed)) {
    return trimmed.replace(/^echo\s+/, "") + "\n";
  }
  if (trimmed === "pwd") return "/workspace\n";
  if (trimmed === "whoami") return "sandbox\n";
  if (trimmed === "uname -a") return "Linux sandbox 0.0.0 mock\n";
  return `[mock] ${trimmed}\n`;
}

function hashString(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "agent-sandbox.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    sandboxes: base.sandboxes && typeof base.sandboxes === "object" ? base.sandboxes : {},
  };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), { _version: STORE_VERSION, sandboxes: {} }));
}

async function saveStore(store) {
  await writeJsonPath(storePath(), normalizeStore(store));
}

async function mutateStore(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and start a sandbox container.
 *
 * @param {string} imageKey - A key from SANDBOX_IMAGES.
 * @param {object} [options]
 * @param {string} [options.runtime="mock"]
 * @param {object} [options.limits]
 * @param {object} [options.env]
 * @param {string|string[]} [options.command]
 * @param {string} [options.workdir]
 * @param {Array<{hostPath:string,containerPath:string,readOnly?:boolean}>} [options.mounts]
 * @param {object} [options.metadata]
 * @returns {Promise<object>}
 */
export async function createSandbox(imageKey, options = {}) {
  if (!imageKey || !Object.prototype.hasOwnProperty.call(SANDBOX_IMAGES, imageKey)) {
    throw new Error(`invalid imageKey: ${imageKey}`);
  }
  const image = SANDBOX_IMAGES[imageKey];
  const runtimeName = options.runtime || defaultRuntimeName;
  const runtime = getRuntime(runtimeName);
  const limits = enforceLimits(options.limits || {});
  const mounts = Array.isArray(options.mounts)
    ? options.mounts.map(normalizeMount)
    : [];
  const env = options.env && typeof options.env === "object" ? { ...options.env } : {};
  const workdir = typeof options.workdir === "string" ? options.workdir : "/workspace";
  const command = options.command || null;

  await runtime.pull(image.base);
  const container = await runtime.run({
    image: image.base,
    imageKey,
    command,
    env,
    workdir,
    limits,
    mounts,
  });

  const now = Date.now();
  const record = {
    sandboxId: container.id,
    imageKey,
    image: image.base,
    tools: [...image.tools],
    runtime: runtimeName,
    state: container.state || "running",
    limits,
    mounts,
    env,
    workdir,
    command,
    createdAt: now,
    startedAt: container.startedAt || now,
    stoppedAt: null,
    metadata: options.metadata && typeof options.metadata === "object" ? { ...options.metadata } : {},
  };

  await mutateStore((store) => {
    store.sandboxes[record.sandboxId] = record;
  });

  return record;
}

function normalizeMount(m) {
  if (!m || typeof m !== "object") {
    throw new Error("mount must be an object");
  }
  if (typeof m.hostPath !== "string" || !m.hostPath) {
    throw new Error("mount.hostPath is required");
  }
  if (typeof m.containerPath !== "string" || !m.containerPath) {
    throw new Error("mount.containerPath is required");
  }
  return {
    hostPath: m.hostPath,
    containerPath: m.containerPath,
    readOnly: m.readOnly !== false,
  };
}

/**
 * Execute a command inside a sandbox.
 *
 * @param {string} sandboxId
 * @param {string} command
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function execInSandbox(sandboxId, command, options = {}) {
  if (!sandboxId) throw new Error("sandboxId is required");
  if (typeof command !== "string" || !command) throw new Error("command is required");
  const record = await getSandbox(sandboxId);
  if (!record) {
    const err = new Error(`sandbox not found: ${sandboxId}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (record.state !== "running") {
    const err = new Error(`sandbox ${sandboxId} is not running (state=${record.state})`);
    err.code = "NOT_RUNNING";
    throw err;
  }
  const runtime = getRuntime(record.runtime);
  const timeoutSec = Number.isFinite(options.timeoutSec)
    ? Number(options.timeoutSec)
    : record.limits.timeoutSec;
  const result = await runtime.exec(sandboxId, command, { ...options, timeoutSec });
  return {
    sandboxId,
    command,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    timedOut: !!result.timedOut,
    at: result.at || Date.now(),
  };
}

/**
 * Stop a running sandbox.
 *
 * @param {string} sandboxId
 * @returns {Promise<object>}
 */
export async function stopSandbox(sandboxId) {
  if (!sandboxId) throw new Error("sandboxId is required");
  const record = await getSandbox(sandboxId);
  if (!record) {
    const err = new Error(`sandbox not found: ${sandboxId}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (record.state === "stopped") return record;
  const runtime = getRuntime(record.runtime);
  await runtime.stop(sandboxId);
  return mutateStore((store) => {
    const entry = store.sandboxes[sandboxId];
    if (!entry) return null;
    entry.state = "stopped";
    entry.stoppedAt = Date.now();
    return { ...entry };
  });
}

/**
 * Remove a sandbox (must be stopped). Clears runtime resources and metadata.
 *
 * @param {string} sandboxId
 * @returns {Promise<{removed: boolean}>}
 */
export async function removeSandbox(sandboxId) {
  if (!sandboxId) throw new Error("sandboxId is required");
  const record = await getSandbox(sandboxId);
  if (!record) {
    return { removed: false };
  }
  if (record.state === "running") {
    try {
      await stopSandbox(sandboxId);
    } catch (_) {
      // best-effort stop
    }
  }
  const runtime = getRuntime(record.runtime);
  try {
    await runtime.remove(sandboxId);
  } catch (_) {
    // runtime may have already cleaned up
  }
  await mutateStore((store) => {
    delete store.sandboxes[sandboxId];
  });
  return { removed: true };
}

/**
 * Fetch a sandbox metadata record.
 *
 * @param {string} sandboxId
 * @returns {Promise<object|null>}
 */
export async function getSandbox(sandboxId) {
  if (!sandboxId) return null;
  const store = await loadStore();
  const entry = store.sandboxes[sandboxId];
  return entry ? { ...entry } : null;
}

/**
 * List sandbox metadata records, optionally filtered.
 *
 * @param {object} [filter]
 * @param {string} [filter.state]
 * @param {string} [filter.imageKey]
 * @param {string} [filter.runtime]
 * @returns {Promise<object[]>}
 */
export async function listSandboxes(filter = {}) {
  const store = await loadStore();
  let entries = Object.values(store.sandboxes);
  if (filter && typeof filter === "object") {
    if (filter.state) entries = entries.filter((e) => e.state === filter.state);
    if (filter.imageKey) entries = entries.filter((e) => e.imageKey === filter.imageKey);
    if (filter.runtime) entries = entries.filter((e) => e.runtime === filter.runtime);
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt).map((e) => ({ ...e }));
}

/**
 * Fetch sandbox runtime logs.
 *
 * @param {string} sandboxId
 * @param {object} [options]
 * @param {number} [options.tail]
 * @returns {Promise<object[]>}
 */
export async function getSandboxLogs(sandboxId, options = {}) {
  if (!sandboxId) throw new Error("sandboxId is required");
  const record = await getSandbox(sandboxId);
  if (!record) {
    const err = new Error(`sandbox not found: ${sandboxId}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const runtime = getRuntime(record.runtime);
  return runtime.logs(sandboxId, options);
}

/**
 * Record a volume mount on an existing sandbox. Mounts default to read-only.
 *
 * @param {string} sandboxId
 * @param {string} hostPath
 * @param {string} containerPath
 * @param {boolean} [readOnly=true]
 * @returns {Promise<object>}
 */
export async function mountVolume(sandboxId, hostPath, containerPath, readOnly = true) {
  if (!sandboxId) throw new Error("sandboxId is required");
  const mount = normalizeMount({ hostPath, containerPath, readOnly });
  return mutateStore((store) => {
    const entry = store.sandboxes[sandboxId];
    if (!entry) {
      const err = new Error(`sandbox not found: ${sandboxId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    if (!Array.isArray(entry.mounts)) entry.mounts = [];
    // Replace by containerPath if already mounted.
    const existingIdx = entry.mounts.findIndex((m) => m.containerPath === mount.containerPath);
    if (existingIdx >= 0) {
      entry.mounts[existingIdx] = mount;
    } else {
      entry.mounts.push(mount);
    }
    return { ...mount };
  });
}

/**
 * Garbage-collect stopped sandboxes older than the given threshold.
 *
 * @param {number} [olderThanMs=3600000]
 * @returns {Promise<{removed: string[]}>}
 */
export async function gcStoppedSandboxes(olderThanMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - Math.max(0, Number(olderThanMs) || 0);
  const removed = [];
  const store = await loadStore();
  for (const entry of Object.values(store.sandboxes)) {
    if (entry.state !== "stopped") continue;
    const stoppedAt = entry.stoppedAt || entry.createdAt || 0;
    if (stoppedAt <= cutoff) {
      try {
        await removeSandbox(entry.sandboxId);
        removed.push(entry.sandboxId);
      } catch (_) {
        // swallow — GC is best-effort
      }
    }
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// Test helpers (exported for internal tests only)
// ---------------------------------------------------------------------------

export const _internals = {
  storePath,
  loadStore,
  saveStore,
  runtimes,
  resetForTests: async () => {
    runtimes.clear();
    defaultRuntimeName = "mock";
    registerRuntime("mock", mockRuntime);
    mockRuntime._reset();
    await writeJsonPath(storePath(), { _version: STORE_VERSION, sandboxes: {} });
  },
};
