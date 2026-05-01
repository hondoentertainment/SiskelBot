import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_PLAYBOOKS_PER_WORKSPACE = 200;
const MAX_GALLERY_ITEMS = 1000;
const GALLERY_ID = "_gallery";

function storePath(workspaceId) {
  return join(getDataDir(), "playbooks", `${workspaceId}.json`);
}

function galleryPath() {
  return join(getDataDir(), "playbooks", `${GALLERY_ID}.json`);
}

function sanitizeWorkspaceId(val) {
  if (typeof val !== "string" || !val.trim()) return "default";
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function validatePlaybookData(data) {
  if (!data || typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("name is required");
  }
}

export async function createPlaybook(workspaceId, data) {
  validatePlaybookData(data);
  const ws = sanitizeWorkspaceId(workspaceId);
  const file = storePath(ws);
  let record;
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { playbooks: [] });
    const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
    if (playbooks.length >= MAX_PLAYBOOKS_PER_WORKSPACE) {
      throw new Error(`Workspace playbook limit reached (${MAX_PLAYBOOKS_PER_WORKSPACE})`);
    }
    const now = Date.now();
    record = {
      playbookId: randomUUID(),
      workspaceId: ws,
      name: String(data.name).trim(),
      description: typeof data.description === "string" ? data.description : "",
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      systemPrompt: typeof data.systemPrompt === "string" ? data.systemPrompt : "",
      taskTemplate: typeof data.taskTemplate === "string" ? data.taskTemplate : "",
      parameters: Array.isArray(data.parameters) ? data.parameters : [],
      isPublic: Boolean(data.isPublic),
      authorWorkspaceId: ws,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    playbooks.push(record);
    await writeJsonPath(file, { playbooks });
  });
  return record;
}

export async function updatePlaybook(workspaceId, playbookId, updates) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const file = storePath(ws);
  let record;
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { playbooks: [] });
    const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
    const idx = playbooks.findIndex((p) => p.playbookId === playbookId);
    if (idx === -1) throw new Error("Playbook not found");
    const mutable = ["name", "description", "tags", "systemPrompt", "taskTemplate", "parameters", "isPublic"];
    for (const key of mutable) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        playbooks[idx][key] = updates[key];
      }
    }
    playbooks[idx].updatedAt = Date.now();
    record = playbooks[idx];
    await writeJsonPath(file, { playbooks });
  });
  return record;
}

export async function deletePlaybook(workspaceId, playbookId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { playbooks: [] });
    const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
    const idx = playbooks.findIndex((p) => p.playbookId === playbookId);
    if (idx === -1) throw new Error("Playbook not found");
    playbooks.splice(idx, 1);
    await writeJsonPath(file, { playbooks });
  });
  return { deleted: true };
}

export async function getPlaybook(workspaceId, playbookId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const store = await readJsonPath(storePath(ws), { playbooks: [] });
  const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
  return playbooks.find((p) => p.playbookId === playbookId) || null;
}

export async function listPlaybooks(workspaceId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const store = await readJsonPath(storePath(ws), { playbooks: [] });
  return Array.isArray(store.playbooks) ? store.playbooks : [];
}

export async function listGallery({ tags, limit, offset } = {}) {
  const store = await readJsonPath(galleryPath(), { playbooks: [] });
  let items = Array.isArray(store.playbooks) ? store.playbooks : [];
  if (Array.isArray(tags) && tags.length) {
    const tagSet = new Set(tags.map(String));
    items = items.filter((p) => p.tags && p.tags.some((t) => tagSet.has(t)));
  }
  const start = Number(offset) || 0;
  const end = start + (Number(limit) || 50);
  return items.slice(start, end);
}

export async function publishToGallery(workspaceId, playbookId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const source = await getPlaybook(ws, playbookId);
  if (!source) throw new Error("Playbook not found");
  const gPath = galleryPath();
  let galleryRecord;
  await withPathLock(gPath, async () => {
    const store = await readJsonPath(gPath, { playbooks: [] });
    const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
    const existing = playbooks.findIndex((p) => p.playbookId === playbookId);
    if (playbooks.length >= MAX_GALLERY_ITEMS && existing === -1) {
      throw new Error(`Gallery limit reached (${MAX_GALLERY_ITEMS})`);
    }
    galleryRecord = { ...source, workspaceId: GALLERY_ID, isPublic: true, updatedAt: Date.now() };
    if (existing !== -1) {
      playbooks[existing] = galleryRecord;
    } else {
      playbooks.push(galleryRecord);
    }
    await writeJsonPath(gPath, { playbooks });
  });
  return galleryRecord;
}

export async function hydratePlaybook(playbookId, params, workspaceId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  let pb = await getPlaybook(ws, playbookId);
  if (!pb) {
    const galleryStore = await readJsonPath(galleryPath(), { playbooks: [] });
    const galleryItems = Array.isArray(galleryStore.playbooks) ? galleryStore.playbooks : [];
    pb = galleryItems.find((p) => p.playbookId === playbookId) || null;
  }
  if (!pb) throw new Error("Playbook not found");
  const safeParams = params && typeof params === "object" ? params : {};
  const task = pb.taskTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(safeParams, key)
      ? String(safeParams[key])
      : "";
  });
  return {
    systemPrompt: pb.systemPrompt,
    task,
    playbookId: pb.playbookId,
    name: pb.name,
  };
}

export async function incrementUsage(playbookId, workspaceId) {
  const ws = sanitizeWorkspaceId(workspaceId);
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { playbooks: [] });
    const playbooks = Array.isArray(store.playbooks) ? store.playbooks : [];
    const idx = playbooks.findIndex((p) => p.playbookId === playbookId);
    if (idx !== -1) {
      playbooks[idx].usageCount = (playbooks[idx].usageCount || 0) + 1;
      await writeJsonPath(file, { playbooks });
    }
  });
}
