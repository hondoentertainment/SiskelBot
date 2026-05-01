// Manages multi-repo workspace configurations
// Storage: data/multi-repo-workspaces/{workspaceId}.json
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { resolveMultiRepoPath } from "./workspace-path-guard.js";

const VALID_REPO_NAME = /^[a-zA-Z0-9_-]+$/;

function storePath(workspaceId) {
  return join(getDataDir(), "multi-repo-workspaces", String(workspaceId).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") + ".json");
}

function normalizeConfig(raw, workspaceId) {
  if (raw && typeof raw === "object" && Array.isArray(raw.repositories)) return raw;
  return { workspaceId: String(workspaceId), repositories: [], updatedAt: Date.now() };
}

export async function getMultiRepoConfig(workspaceId) {
  const path = storePath(workspaceId);
  const raw = await readJsonPath(path, null);
  return normalizeConfig(raw, workspaceId);
}

export async function addRepository(workspaceId, { name, root, remoteUrl = null, branch = null }) {
  if (!name || !VALID_REPO_NAME.test(String(name))) {
    throw new Error("Repository name must be alphanumeric with dashes and underscores only");
  }
  if (!root || typeof root !== "string") {
    throw new Error("root is required");
  }

  const path = storePath(workspaceId);
  let added = null;
  await withPathLock(path, async () => {
    const config = normalizeConfig(await readJsonPath(path, null), workspaceId);
    if (config.repositories.find((r) => r.name === name)) {
      throw new Error(`Repository "${name}" already exists`);
    }
    const repo = {
      name: String(name),
      root: String(root),
      remoteUrl: remoteUrl ? String(remoteUrl) : null,
      branch: branch ? String(branch) : null,
      addedAt: Date.now(),
    };
    config.repositories.push(repo);
    config.updatedAt = Date.now();
    await writeJsonPath(path, config);
    added = repo;
  });
  return added;
}

export async function removeRepository(workspaceId, name) {
  const path = storePath(workspaceId);
  let removed = false;
  await withPathLock(path, async () => {
    const config = normalizeConfig(await readJsonPath(path, null), workspaceId);
    const before = config.repositories.length;
    config.repositories = config.repositories.filter((r) => r.name !== name);
    if (config.repositories.length < before) {
      removed = true;
      config.updatedAt = Date.now();
      await writeJsonPath(path, config);
    }
  });
  return removed;
}

export async function listRepositories(workspaceId) {
  const config = await getMultiRepoConfig(workspaceId);
  return config.repositories;
}

export async function resolvePathInWorkspace(workspaceId, relativePath) {
  const config = await getMultiRepoConfig(workspaceId);
  return resolveMultiRepoPath(config.repositories, relativePath);
}
