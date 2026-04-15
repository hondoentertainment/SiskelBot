/**
 * Phase 63.5: Migration assistant.
 *
 * Drives a codebase through a stepwise migration playbook (e.g. "upgrade Node 18
 * to Node 20", "switch Jest to node:test"). Playbooks are registered globally
 * and instantiated per-workspace as migrations. Each migration tracks current
 * step, status, and a log of step outcomes.
 *
 * Storage layout:
 *   data/migration/playbooks.json
 *     { playbooks: { [name]: playbook } }
 *   data/migration/{workspaceId}.json
 *     { migrations: { [id]: migration } }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function playbookPath() {
  return join(getDataDir(), "migration", "playbooks.json");
}
function workspacePath(workspaceId) {
  return join(getDataDir(), "migration", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "migration", "index.json");
}

// Persistent migrationId → workspaceId index (replaces module-level Map so
// lookups work across server restarts and multi-replica deployments).
async function indexSet(migrationId, workspaceId) {
  const file = indexPath();
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { migrationToWorkspace: {} });
    store.migrationToWorkspace = store.migrationToWorkspace || {};
    store.migrationToWorkspace[migrationId] = workspaceId;
    await writeJsonPath(file, store);
  });
}

async function indexGet(migrationId) {
  const store = await readJsonPath(indexPath(), { migrationToWorkspace: {} });
  return store.migrationToWorkspace?.[migrationId] || null;
}

async function indexDelete(migrationId) {
  const file = indexPath();
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { migrationToWorkspace: {} });
    if (store.migrationToWorkspace && Object.prototype.hasOwnProperty.call(store.migrationToWorkspace, migrationId)) {
      delete store.migrationToWorkspace[migrationId];
      await writeJsonPath(file, store);
    }
  });
}

function validatePlaybook(pb) {
  if (!pb || typeof pb !== "object") throw new Error("playbook must be an object");
  if (typeof pb.name !== "string" || !pb.name.trim()) throw new Error("playbook.name is required");
  if (!Array.isArray(pb.steps) || pb.steps.length === 0) throw new Error("playbook.steps must be a non-empty array");
  for (const step of pb.steps) {
    if (!step || typeof step !== "object") throw new Error("each step must be an object");
    if (typeof step.id !== "string" || !step.id.trim()) throw new Error("each step requires id");
    if (typeof step.title !== "string" || !step.title.trim()) throw new Error("each step requires title");
  }
  return {
    name: pb.name.trim(),
    description: typeof pb.description === "string" ? pb.description : "",
    steps: pb.steps.map((s) => ({
      id: s.id,
      title: s.title,
      command: typeof s.command === "string" ? s.command : null,
      check: typeof s.check === "string" ? s.check : null,
      rollback: typeof s.rollback === "string" ? s.rollback : null,
    })),
  };
}

export async function registerPlaybook(playbook) {
  const clean = validatePlaybook(playbook);
  await withPathLock(playbookPath(), async () => {
    const store = await readJsonPath(playbookPath(), { playbooks: {} });
    store.playbooks = store.playbooks || {};
    store.playbooks[clean.name] = clean;
    await writeJsonPath(playbookPath(), store);
  });
  return clean;
}

export async function listPlaybooks() {
  const store = await readJsonPath(playbookPath(), { playbooks: {} });
  const playbooks = Object.values(store.playbooks || {}).map((p) => ({
    name: p.name,
    description: p.description,
    stepCount: p.steps.length,
  }));
  return { playbooks };
}

export async function getPlaybook(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  const store = await readJsonPath(playbookPath(), { playbooks: {} });
  return store.playbooks?.[name.trim()] || null;
}

export async function startMigration({ workspaceId, playbookName, repoId } = {}) {
  const ws = sanitizeId(workspaceId);
  const playbook = await getPlaybook(playbookName);
  if (!playbook) throw new Error(`playbook not found: ${playbookName}`);
  const migrationId = randomUUID();
  const migration = {
    migrationId,
    workspaceId: ws,
    playbookName: playbook.name,
    repoId: repoId ? String(repoId) : null,
    steps: playbook.steps.map((s) => ({ id: s.id, title: s.title, status: "pending", outcome: null, at: null })),
    currentStep: 0,
    status: "in-progress",
    log: [{ at: Date.now(), event: "start", playbook: playbook.name }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const file = workspacePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { migrations: {} });
    store.migrations = store.migrations || {};
    store.migrations[migrationId] = migration;
    await writeJsonPath(file, store);
  });
  await indexSet(migrationId, ws);
  return migration;
}

async function loadMigration(migrationId, workspaceId) {
  const ws = workspaceId ? sanitizeId(workspaceId) : await indexGet(migrationId);
  if (!ws) return { migration: null, workspaceId: null };
  const store = await readJsonPath(workspacePath(ws), { migrations: {} });
  const m = store.migrations?.[migrationId] || null;
  return { migration: m, workspaceId: ws };
}

export async function getMigrationStatus(migrationId, workspaceId) {
  const { migration } = await loadMigration(migrationId, workspaceId);
  return migration;
}

export async function advanceMigration({ migrationId, stepOutcome, workspaceId } = {}) {
  const allowed = new Set(["pass", "fail", "skip"]);
  if (!allowed.has(stepOutcome)) {
    throw new Error(`stepOutcome must be one of ${Array.from(allowed).join(", ")}`);
  }
  const { migration, workspaceId: ws } = await loadMigration(migrationId, workspaceId);
  if (!migration) return null;
  if (TERMINAL_STATUSES.has(migration.status)) {
    return migration;
  }
  const file = workspacePath(ws);
  let result;
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { migrations: {} });
    const m = store.migrations?.[migrationId];
    if (!m) return;
    const idx = m.currentStep;
    const step = m.steps[idx];
    if (step) {
      step.outcome = stepOutcome;
      step.at = Date.now();
      if (stepOutcome === "pass") step.status = "completed";
      else if (stepOutcome === "skip") step.status = "skipped";
      else step.status = "failed";
    }
    m.log.push({ at: Date.now(), event: "advance", stepIndex: idx, stepId: step?.id || null, outcome: stepOutcome });
    if (stepOutcome === "fail") {
      m.status = "failed";
    } else {
      m.currentStep = idx + 1;
      if (m.currentStep >= m.steps.length) {
        m.status = "completed";
      }
    }
    m.updatedAt = Date.now();
    store.migrations[migrationId] = m;
    await writeJsonPath(file, store);
    result = m;
  });
  return result || null;
}

export async function listMigrations(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(workspacePath(ws), { migrations: {} });
  const migrations = Object.values(store.migrations || {})
    .map((m) => ({
      migrationId: m.migrationId,
      playbookName: m.playbookName,
      status: m.status,
      currentStep: m.currentStep,
      stepCount: m.steps.length,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { migrations };
}

export async function _reset(workspaceId) {
  await writeJsonPath(indexPath(), { migrationToWorkspace: {} });
  await writeJsonPath(playbookPath(), { playbooks: {} });
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { migrations: {} });
    return;
  }
  await writeJsonPath(workspacePath("default"), { migrations: {} });
}

export const _internals = { sanitizeId, playbookPath, workspacePath, validatePlaybook, indexPath, indexGet, indexSet, indexDelete };
