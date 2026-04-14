/**
 * Phase 64.5: Reproducibility checks.
 *
 * Checklist for experiment reproducibility. Creates a check (tied to a
 * workspace + optional experiment), runs it against a results object
 * {itemId: boolean}, and produces a weighted score and letter grade.
 *
 * Storage layout:
 *   data/reproducibility-checks/{workspaceId}.json
 *     { checks: { [id]: {...} } }
 *   data/reproducibility-checks/_index.json — id -> workspace map + known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_CHECKLIST = Object.freeze([
  { id: "code-version-pinned",      label: "Code version pinned (commit SHA or tag)",            weight: 3, required: true },
  { id: "seed-recorded",            label: "Random seed recorded",                               weight: 2, required: true },
  { id: "data-hash-recorded",       label: "Dataset hash or version recorded",                   weight: 3, required: true },
  { id: "dependency-lockfile-present", label: "Dependency lockfile committed",                   weight: 2, required: true },
  { id: "hardware-documented",      label: "Hardware (GPU/CPU/RAM) documented",                  weight: 1, required: false },
  { id: "env-captured",             label: "Environment variables / container image captured",   weight: 2, required: true },
  { id: "metrics-recorded",         label: "Metrics recorded to tracker",                        weight: 2, required: true },
  { id: "artifacts-stored",         label: "Model/output artifacts stored",                      weight: 2, required: true },
]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "reproducibility-checks", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "reproducibility-checks", "_index.json");
}

async function touchIndex(workspaceId, checkId) {
  const ws = sanitizeId(workspaceId);
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) list.push(ws);
    const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
    if (checkId) ids[checkId] = ws;
    await writeJsonPath(indexPath(), { workspaces: list, ids });
  });
}

async function readStore(workspaceId) {
  const store = await readJsonPath(workspacePath(workspaceId), { checks: {} });
  return { checks: store.checks && typeof store.checks === "object" ? store.checks : {} };
}

async function resolveWorkspace(checkId) {
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
  return ids[checkId] || null;
}

export function getDefaultChecklist() {
  return DEFAULT_CHECKLIST.map((item) => ({ ...item }));
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length) return getDefaultChecklist();
  return items
    .filter((it) => it && typeof it === "object" && typeof it.id === "string" && it.id.trim())
    .map((it) => ({
      id: it.id.trim(),
      label: typeof it.label === "string" ? it.label : it.id,
      weight: typeof it.weight === "number" && Number.isFinite(it.weight) && it.weight > 0 ? it.weight : 1,
      required: Boolean(it.required),
    }));
}

function gradeFromScore(pct) {
  if (pct >= 90) return "A";
  if (pct >= 80) return "B";
  if (pct >= 70) return "C";
  if (pct >= 60) return "D";
  return "F";
}

/**
 * Create a reproducibility check for an experiment.
 *
 * @param {{ workspaceId?: string, experimentId?: string, items?: object[] }} input
 */
export async function createCheck({ workspaceId, experimentId, items } = {}) {
  const ws = sanitizeId(workspaceId);
  const id = randomUUID();
  const record = {
    id,
    workspaceId: ws,
    experimentId: experimentId ? String(experimentId) : null,
    items: normalizeItems(items),
    results: null,
    report: null,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const file = workspacePath(ws);
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    store.checks[id] = record;
    await writeJsonPath(file, store);
  });
  await touchIndex(ws, id);
  return record;
}

/**
 * Run a check against a results object {itemId: boolean}.
 * Returns the report (and persists it).
 */
export async function runCheck({ checkId, results } = {}) {
  if (!checkId) throw new Error("checkId is required");
  if (!results || typeof results !== "object") throw new Error("results must be an object");
  const ws = await resolveWorkspace(checkId);
  if (!ws) throw new Error(`check ${checkId} not found`);
  const file = workspacePath(ws);
  let report;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    const check = store.checks[checkId];
    if (!check) throw new Error(`check ${checkId} not found`);
    const items = Array.isArray(check.items) && check.items.length ? check.items : getDefaultChecklist();

    let totalWeight = 0;
    let earnedWeight = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failedItems = [];
    const missingRequired = [];

    for (const item of items) {
      totalWeight += item.weight;
      if (!(item.id in results)) {
        skipped += 1;
        if (item.required) missingRequired.push(item.id);
        continue;
      }
      if (results[item.id] === true) {
        passed += 1;
        earnedWeight += item.weight;
      } else {
        failed += 1;
        failedItems.push(item.id);
        if (item.required) missingRequired.push(item.id);
      }
    }

    const score = totalWeight === 0 ? 0 : Math.round((earnedWeight / totalWeight) * 10000) / 100;
    const grade = gradeFromScore(score);

    report = {
      checkId,
      passed,
      failed,
      skipped,
      score,
      grade,
      totalWeight,
      earnedWeight,
      failedItems,
      missingRequired,
      requiredSatisfied: missingRequired.length === 0,
      ranAt: Date.now(),
    };

    check.results = { ...results };
    check.report = report;
    check.status = "complete";
    check.updatedAt = Date.now();
    await writeJsonPath(file, store);
  });
  return report;
}

export async function getCheckReport(checkId) {
  if (!checkId) return null;
  const ws = await resolveWorkspace(checkId);
  if (!ws) return null;
  const store = await readStore(ws);
  return store.checks[checkId] || null;
}

/**
 * List checks for a workspace, optionally filtered by experiment.
 */
export async function listChecks({ workspaceId, experimentId } = {}) {
  const ws = sanitizeId(workspaceId);
  const store = await readStore(ws);
  let entries = Object.values(store.checks);
  if (experimentId) {
    entries = entries.filter((c) => c.experimentId === String(experimentId));
  }
  return entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { checks: {} });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { checks: {} });
  }
  await writeJsonPath(indexPath(), { workspaces: [], ids: {} });
}

export const _internals = { sanitizeId, workspacePath, indexPath, gradeFromScore, normalizeItems };
