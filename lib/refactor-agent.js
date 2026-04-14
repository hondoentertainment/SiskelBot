/**
 * Phase 63.4: Refactoring agent (planning surface).
 *
 * Computes hypothetical diffs for a transform without touching the filesystem.
 * The engineer passes in file { path, content } pairs, picks a transform, and
 * receives a plan with before/after snapshots. `applyRefactor` with dryRun=false
 * marks the plan applied but does not write to disk — callers write the files
 * themselves using the plan's modified content.
 *
 * Storage layout:
 *   data/refactor/{workspaceId}.json
 *     { plans: { [planId]: { ... } }, order: [planId...] }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_PLANS_PER_WORKSPACE = 500;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "refactor", `${sanitizeId(workspaceId)}.json`);
}

// Map planId → workspaceId so plan accessors can resolve workspace.
const planIndex = new Map();

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyTransform(content, transform) {
  if (typeof content !== "string") return { modified: "", changes: 0 };
  const { type, from, to } = transform || {};
  if (!from || typeof from !== "string") return { modified: content, changes: 0 };
  const replacement = typeof to === "string" ? to : "";
  let pattern;
  if (type === "rename") {
    // Word-boundary rename (identifier-level).
    pattern = new RegExp(`\\b${escapeRegex(from)}\\b`, "g");
  } else if (type === "replace") {
    pattern = new RegExp(escapeRegex(from), "g");
  } else {
    return { modified: content, changes: 0 };
  }
  let changes = 0;
  const modified = content.replace(pattern, () => {
    changes += 1;
    return replacement;
  });
  return { modified, changes };
}

/**
 * Plan a refactor. Returns stored plan.
 */
export async function planRefactor({ workspaceId, files, transform } = {}) {
  const ws = sanitizeId(workspaceId);
  if (!Array.isArray(files)) throw new Error("files must be an array");
  if (!transform || typeof transform !== "object") throw new Error("transform is required");
  const allowed = new Set(["rename", "replace"]);
  if (!allowed.has(transform.type)) {
    throw new Error(`transform.type must be one of ${Array.from(allowed).join(", ")}`);
  }

  const planId = randomUUID();
  const processed = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string") continue;
    const content = typeof f.content === "string" ? f.content : "";
    const { modified, changes } = applyTransform(content, transform);
    processed.push({
      path: f.path,
      original: content,
      modified,
      changes,
      changed: modified !== content,
    });
  }

  const plan = {
    planId,
    workspaceId: ws,
    createdAt: Date.now(),
    transform: { type: transform.type, from: String(transform.from), to: String(transform.to ?? "") },
    status: "planned",
    files: processed,
    appliedAt: null,
    rolledBackAt: null,
  };

  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { plans: {}, order: [] });
    store.plans = store.plans || {};
    store.order = Array.isArray(store.order) ? store.order : [];
    store.plans[planId] = plan;
    store.order.push(planId);
    if (store.order.length > MAX_PLANS_PER_WORKSPACE) {
      const drop = store.order.splice(0, store.order.length - MAX_PLANS_PER_WORKSPACE);
      for (const id of drop) delete store.plans[id];
    }
    await writeJsonPath(file, store);
  });
  planIndex.set(planId, ws);
  return plan;
}

async function loadPlan(planId, workspaceId) {
  const ws = workspaceId ? sanitizeId(workspaceId) : planIndex.get(planId);
  if (!ws) {
    // Search default as a fallback.
    const store = await readJsonPath(storePath("default"), { plans: {}, order: [] });
    const plan = store.plans?.[planId];
    if (plan) {
      planIndex.set(planId, "default");
      return { plan, workspaceId: "default" };
    }
    return { plan: null, workspaceId: null };
  }
  const store = await readJsonPath(storePath(ws), { plans: {}, order: [] });
  const plan = store.plans?.[planId] || null;
  return { plan, workspaceId: ws };
}

export async function getPlan(planId, workspaceId) {
  const { plan } = await loadPlan(planId, workspaceId);
  return plan;
}

export async function previewRefactor(planId, workspaceId) {
  const { plan } = await loadPlan(planId, workspaceId);
  if (!plan) return null;
  return {
    planId: plan.planId,
    status: plan.status,
    transform: plan.transform,
    files: plan.files.map((f) => ({
      path: f.path,
      changes: f.changes,
      changed: f.changed,
      original: f.original,
      modified: f.modified,
    })),
  };
}

export async function applyRefactor({ planId, dryRun, workspaceId } = {}) {
  const { plan, workspaceId: ws } = await loadPlan(planId, workspaceId);
  if (!plan) return null;
  if (dryRun) {
    return {
      planId,
      dryRun: true,
      status: plan.status,
      diffs: plan.files.map((f) => ({ path: f.path, changes: f.changes, changed: f.changed })),
    };
  }
  const file = storePath(ws);
  let updated;
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { plans: {}, order: [] });
    const existing = store.plans?.[planId];
    if (!existing) return;
    if (existing.status === "applied") {
      updated = existing;
      return;
    }
    existing.status = "applied";
    existing.appliedAt = Date.now();
    existing.appliedSnapshot = existing.files.map((f) => ({ path: f.path, content: f.modified }));
    store.plans[planId] = existing;
    await writeJsonPath(file, store);
    updated = existing;
  });
  if (!updated) return null;
  return {
    planId,
    dryRun: false,
    status: updated.status,
    appliedAt: updated.appliedAt,
    files: updated.appliedSnapshot,
  };
}

export async function listPlans(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(storePath(ws), { plans: {}, order: [] });
  const order = Array.isArray(store.order) ? store.order : [];
  const plans = order
    .map((id) => store.plans?.[id])
    .filter(Boolean)
    .map((p) => ({
      planId: p.planId,
      createdAt: p.createdAt,
      status: p.status,
      transform: p.transform,
      fileCount: p.files.length,
      totalChanges: p.files.reduce((s, f) => s + (f.changes || 0), 0),
    }));
  return { plans };
}

export async function _reset(workspaceId) {
  planIndex.clear();
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { plans: {}, order: [] });
    return;
  }
  await writeJsonPath(storePath("default"), { plans: {}, order: [] });
}

export const _internals = { sanitizeId, storePath, applyTransform };
