import crypto from "node:crypto";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getRuntime } from "./agent-sandbox.js";

const execFile = promisify(_execFile);

const MAX_SNAPSHOTS_PER_WORKSPACE = 50;

function storePath(workspaceId) {
  return join(getDataDir(), "machine-snapshots", `${workspaceId}.json`);
}

function newSnapshotId() {
  return crypto.randomUUID();
}

async function loadStore(workspaceId) {
  const data = await readJsonPath(storePath(workspaceId), { snapshots: [] });
  if (!Array.isArray(data.snapshots)) data.snapshots = [];
  return data;
}

async function saveStore(workspaceId, data) {
  await writeJsonPath(storePath(workspaceId), data);
}

async function mutateStore(workspaceId, fn) {
  return withPathLock(storePath(workspaceId), async () => {
    const store = await loadStore(workspaceId);
    const result = await fn(store);
    await saveStore(workspaceId, store);
    return result;
  });
}

async function dockerCli(...args) {
  try {
    const { stdout, stderr } = await execFile("docker", args, { maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (e) {
    return { ok: false, error: e?.stderr || e?.message || String(e) };
  }
}

export async function createSnapshot(workspaceId, sandboxId, name, description, metadata = {}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sandboxId) throw new Error("sandboxId is required");
  if (!name) throw new Error("name is required");

  const snapshotId = newSnapshotId();
  const imageTag = `siskelbot-snapshot-${snapshotId}`;

  const commitResult = await dockerCli("commit", sandboxId, imageTag);
  if (!commitResult.ok) {
    if (/not found|no such/i.test(commitResult.error) || /docker/i.test(commitResult.error)) {
      return { ok: false, error: commitResult.error };
    }
    throw Object.assign(new Error(`docker commit failed: ${commitResult.error}`), { code: "DOCKER_ERROR" });
  }

  let sizeBytes = null;
  const inspectResult = await dockerCli("image", "inspect", imageTag, "--format", "{{.Size}}");
  if (inspectResult.ok) {
    const n = parseInt(inspectResult.stdout.trim(), 10);
    if (Number.isFinite(n)) sizeBytes = n;
  }

  const record = {
    snapshotId,
    workspaceId,
    sandboxId,
    imageTag,
    name: String(name),
    description: description ? String(description) : "",
    createdAt: Date.now(),
    sizeBytes,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
  };

  await mutateStore(workspaceId, async (store) => {
    if (store.snapshots.length >= MAX_SNAPSHOTS_PER_WORKSPACE) {
      throw Object.assign(new Error(`snapshot limit reached (${MAX_SNAPSHOTS_PER_WORKSPACE})`), { code: "LIMIT_REACHED" });
    }
    store.snapshots.push(record);
  });

  return record;
}

export async function listSnapshots(workspaceId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const store = await loadStore(workspaceId);
  return [...store.snapshots].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSnapshot(workspaceId, snapshotId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!snapshotId) throw new Error("snapshotId is required");
  const store = await loadStore(workspaceId);
  return store.snapshots.find((s) => s.snapshotId === snapshotId) || null;
}

export async function deleteSnapshot(workspaceId, snapshotId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!snapshotId) throw new Error("snapshotId is required");

  let imageTag = null;
  await mutateStore(workspaceId, async (store) => {
    const idx = store.snapshots.findIndex((s) => s.snapshotId === snapshotId);
    if (idx === -1) {
      throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: "NOT_FOUND" });
    }
    imageTag = store.snapshots[idx].imageTag;
    store.snapshots.splice(idx, 1);
  });

  if (imageTag) {
    await dockerCli("rmi", imageTag);
  }

  return { ok: true, snapshotId };
}

export async function restoreSnapshot(workspaceId, snapshotId, options = {}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!snapshotId) throw new Error("snapshotId is required");

  const snapshot = await getSnapshot(workspaceId, snapshotId);
  if (!snapshot) {
    throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: "NOT_FOUND" });
  }

  let runtime;
  try {
    runtime = getRuntime(options.runtime || "docker");
  } catch {
    try {
      runtime = getRuntime();
    } catch {
      return { ok: false, error: "Docker not available" };
    }
  }

  const runConfig = {
    image: snapshot.imageTag,
    workdir: options.workdir || "/workspace",
    limits: options.limits,
    env: options.env || {},
    mounts: options.mounts || [],
    ...(options.command ? { command: options.command } : {}),
  };

  let container;
  try {
    container = await runtime.run(runConfig);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }

  return {
    ok: true,
    snapshotId,
    containerId: container.id,
    image: snapshot.imageTag,
    state: container.state,
    startedAt: container.startedAt,
  };
}

export async function applySnapshotToSandbox(workspaceId, snapshotId, targetSandboxId) {
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!snapshotId) throw new Error("snapshotId is required");
  if (!targetSandboxId) throw new Error("targetSandboxId is required");

  const snapshot = await getSnapshot(workspaceId, snapshotId);
  if (!snapshot) {
    throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: "NOT_FOUND" });
  }

  const exportResult = await dockerCli("export", snapshot.sandboxId);
  if (!exportResult.ok) {
    return { ok: false, error: exportResult.error };
  }

  const cpResult = await dockerCli("cp", `${snapshot.sandboxId}:/`, `${targetSandboxId}:/`);
  if (!cpResult.ok) {
    return { ok: false, error: cpResult.error };
  }

  return { ok: true, snapshotId, targetSandboxId };
}
