/**
 * Phase 74.3: Procedural memory — learn recipe-like steps from successful agent runs.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function storePath(workspaceId) {
  const ws = String(workspaceId || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return join(getDataDir(), "procedural-memory", `${ws}.json`);
}

async function load(workspaceId) {
  return readJsonPath(storePath(workspaceId), { _version: 1, procedures: [] });
}

async function save(workspaceId, data) {
  await writeJsonPath(storePath(workspaceId), data);
}

/**
 * Extract a procedure from a successful trajectory.
 * @param {string} workspaceId
 * @param {{ goal?: string, toolCalls?: Array<{ name?: string, args?: object, ok?: boolean }>, stopReason?: string }} traj
 */
export async function learnProcedureFromRun(workspaceId, traj = {}) {
  if (traj.stopReason && traj.stopReason !== "complete") {
    return { ok: false, reason: "run_not_complete" };
  }
  const steps = (traj.toolCalls || [])
    .filter((t) => t?.name && t.ok !== false)
    .map((t) => ({ tool: t.name, argsKeys: Object.keys(t.args || {}).sort().slice(0, 12) }));
  if (steps.length < 2) return { ok: false, reason: "too_few_steps" };

  const procedure = {
    id: randomUUID(),
    goal: String(traj.goal || "").slice(0, 500) || "Untitled procedure",
    steps,
    createdAt: new Date().toISOString(),
    useCount: 0,
  };

  return withPathLock(storePath(workspaceId), async () => {
    const data = await load(workspaceId);
    data.procedures = Array.isArray(data.procedures) ? data.procedures : [];
    data.procedures.unshift(procedure);
    data.procedures = data.procedures.slice(0, 200);
    await save(workspaceId, data);
    return { ok: true, procedure };
  });
}

export async function listProcedures(workspaceId, { limit = 50 } = {}) {
  const data = await load(workspaceId);
  return (data.procedures || []).slice(0, Math.min(200, Math.max(1, limit)));
}

export async function matchProcedures(workspaceId, goalText) {
  const q = String(goalText || "").toLowerCase();
  const all = await listProcedures(workspaceId, { limit: 200 });
  if (!q) return all.slice(0, 10);
  return all
    .map((p) => ({
      ...p,
      score: String(p.goal || "").toLowerCase().includes(q) ? 2 : q.split(/\s+/).filter((w) => String(p.goal || "").toLowerCase().includes(w)).length,
    }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}
