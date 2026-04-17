/**
 * Phase 75.5: Synthetic user simulation.
 *
 * Lets operators define personas (traits + goals) and run multi-turn simulated
 * conversations against an assistant. Scoring checks how many of a persona's
 * goals (substrings) appear in the assistant's turns so we can regression-test
 * agent behaviors.
 *
 * Storage layout:
 *   data/synthetic-users/{workspaceId}.json — personas + simulations per workspace
 *   data/synthetic-users/_personas.json     — personaId → workspaceId lookup
 *   data/synthetic-users/_sims.json         — simulationId → workspaceId lookup
 *   data/synthetic-users/_index.json        — known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const VALID_ROLES = Object.freeze(["user", "assistant", "system", "tool"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "synthetic-users", `${sanitizeId(workspaceId)}.json`);
}

function personasIndexPath() {
  return join(getDataDir(), "synthetic-users", "_personas.json");
}

function simsIndexPath() {
  return join(getDataDir(), "synthetic-users", "_sims.json");
}

function indexPath() {
  return join(getDataDir(), "synthetic-users", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

async function registerLookup(pathFn, id, workspaceId, rootKey) {
  await withPathLock(pathFn(), async () => {
    const idx = await readJsonPath(pathFn(), { [rootKey]: {} });
    const map = idx[rootKey] && typeof idx[rootKey] === "object" ? idx[rootKey] : {};
    map[id] = sanitizeId(workspaceId);
    await writeJsonPath(pathFn(), { [rootKey]: map });
  });
}

async function lookupWorkspace(pathFn, id, rootKey) {
  const idx = await readJsonPath(pathFn(), { [rootKey]: {} });
  const map = idx[rootKey] && typeof idx[rootKey] === "object" ? idx[rootKey] : {};
  return map[id] || null;
}

async function loadStore(workspaceId) {
  return readJsonPath(storePath(workspaceId), { personas: [], simulations: [] });
}

/**
 * Create a persona with traits and goals.
 * @param {{ workspaceId: string, name: string, traits?: string[]|string, goals?: string[]|string }} input
 */
export async function createPersona({ workspaceId, name, traits, goals } = {}) {
  if (!name) throw new Error("name is required");
  const ws = sanitizeId(workspaceId);
  const record = {
    personaId: randomUUID(),
    workspaceId: ws,
    name: String(name).slice(0, 200),
    traits: Array.isArray(traits) ? traits.map((t) => String(t)) : traits ? [String(traits)] : [],
    goals: Array.isArray(goals) ? goals.map((g) => String(g)) : goals ? [String(goals)] : [],
    createdAt: Date.now(),
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.personas) ? store.personas : [];
    list.push(record);
    await writeJsonPath(file, { ...store, personas: list });
  });
  await registerLookup(personasIndexPath, record.personaId, ws, "personas");
  await touchIndex(ws);
  return record;
}

/**
 * List personas for a workspace.
 */
export async function listPersonas(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const list = Array.isArray(store.personas) ? store.personas.slice() : [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

export async function getPersona(id) {
  if (!id) return null;
  const ws = await lookupWorkspace(personasIndexPath, id, "personas");
  if (!ws) return null;
  const store = await loadStore(ws);
  const list = Array.isArray(store.personas) ? store.personas : [];
  return list.find((p) => p.personaId === id) || null;
}

/**
 * Start a new multi-turn simulation.
 */
export async function startSimulation({ workspaceId, personaId, systemPrompt, maxTurns } = {}) {
  if (!personaId) throw new Error("personaId is required");
  const persona = await getPersona(personaId);
  if (!persona) throw new Error(`unknown personaId ${personaId}`);
  const ws = sanitizeId(workspaceId || persona.workspaceId);
  const sim = {
    simulationId: randomUUID(),
    workspaceId: ws,
    personaId,
    personaSnapshot: { name: persona.name, traits: persona.traits, goals: persona.goals },
    systemPrompt: systemPrompt ? String(systemPrompt) : null,
    maxTurns: Math.max(1, Math.min(1000, Number(maxTurns) || 20)),
    turns: [],
    status: "running",
    score: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.simulations) ? store.simulations : [];
    list.push(sim);
    await writeJsonPath(file, { ...store, simulations: list });
  });
  await registerLookup(simsIndexPath, sim.simulationId, ws, "sims");
  await touchIndex(ws);
  return sim;
}

/**
 * Append a turn to an existing simulation.
 */
export async function appendTurn({ simulationId, role, content } = {}) {
  if (!simulationId) throw new Error("simulationId is required");
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`role must be one of ${VALID_ROLES.join(", ")}`);
  }
  if (content == null) throw new Error("content is required");
  const ws = await lookupWorkspace(simsIndexPath, simulationId, "sims");
  if (!ws) throw new Error(`unknown simulationId ${simulationId}`);
  const file = storePath(ws);
  let returned;
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.simulations) ? store.simulations : [];
    const idx = list.findIndex((s) => s.simulationId === simulationId);
    if (idx < 0) throw new Error(`simulation ${simulationId} not found`);
    const s = list[idx];
    if (s.status !== "running") {
      returned = s;
      return;
    }
    s.turns.push({
      role,
      content: typeof content === "string" ? content : JSON.stringify(content),
      timestamp: Date.now(),
    });
    if (s.turns.length >= s.maxTurns) {
      s.status = "complete";
      s.completedAt = Date.now();
    }
    s.updatedAt = Date.now();
    list[idx] = s;
    await writeJsonPath(file, { ...store, simulations: list });
    returned = s;
  });
  return returned;
}

/**
 * Mark a simulation complete manually.
 */
export async function completeSimulation({ simulationId } = {}) {
  if (!simulationId) throw new Error("simulationId is required");
  const ws = await lookupWorkspace(simsIndexPath, simulationId, "sims");
  if (!ws) throw new Error(`unknown simulationId ${simulationId}`);
  const file = storePath(ws);
  let returned;
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.simulations) ? store.simulations : [];
    const idx = list.findIndex((s) => s.simulationId === simulationId);
    if (idx < 0) throw new Error(`simulation ${simulationId} not found`);
    const s = list[idx];
    s.status = "complete";
    s.completedAt = Date.now();
    s.updatedAt = Date.now();
    list[idx] = s;
    await writeJsonPath(file, { ...store, simulations: list });
    returned = s;
  });
  return returned;
}

/**
 * Score a simulation by checking how many persona goals (substrings) appear
 * in the assistant turns. Optionally allow caller to pass per-goal weights.
 */
export async function scoreSimulation({ simulationId, goalWeights } = {}) {
  if (!simulationId) throw new Error("simulationId is required");
  const ws = await lookupWorkspace(simsIndexPath, simulationId, "sims");
  if (!ws) throw new Error(`unknown simulationId ${simulationId}`);
  const file = storePath(ws);
  let result;
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.simulations) ? store.simulations : [];
    const idx = list.findIndex((s) => s.simulationId === simulationId);
    if (idx < 0) throw new Error(`simulation ${simulationId} not found`);
    const s = list[idx];
    const goals = Array.isArray(s.personaSnapshot?.goals) ? s.personaSnapshot.goals : [];
    const assistantText = s.turns
      .filter((t) => t.role === "assistant")
      .map((t) => String(t.content || "").toLowerCase())
      .join("\n");

    const perGoal = {};
    let hit = 0;
    let weightHit = 0;
    let weightTotal = 0;
    for (const g of goals) {
      const needle = String(g).toLowerCase();
      const found = needle.length > 0 && assistantText.includes(needle);
      if (found) hit += 1;
      perGoal[g] = found;
      const w = goalWeights && typeof goalWeights[g] === "number" ? goalWeights[g] : 1;
      weightTotal += w;
      if (found) weightHit += w;
    }
    const total = goals.length;
    const score = total === 0 ? 0 : Number((hit / total).toFixed(4));
    const weightedScore = weightTotal === 0 ? 0 : Number((weightHit / weightTotal).toFixed(4));
    const scoreRecord = {
      simulationId,
      goalsHit: hit,
      goalsTotal: total,
      score,
      weightedScore,
      perGoal,
      scoredAt: Date.now(),
    };
    s.score = scoreRecord;
    s.updatedAt = Date.now();
    list[idx] = s;
    await writeJsonPath(file, { ...store, simulations: list });
    result = scoreRecord;
  });
  return result;
}

export async function getSimulation(id) {
  if (!id) return null;
  const ws = await lookupWorkspace(simsIndexPath, id, "sims");
  if (!ws) return null;
  const store = await loadStore(ws);
  const list = Array.isArray(store.simulations) ? store.simulations : [];
  return list.find((s) => s.simulationId === id) || null;
}

export async function listSimulations(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const list = Array.isArray(store.simulations) ? store.simulations.slice() : [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { personas: [], simulations: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(storePath(ws), { personas: [], simulations: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
  await writeJsonPath(personasIndexPath(), { personas: {} });
  await writeJsonPath(simsIndexPath(), { sims: {} });
}

export const _internals = { sanitizeId, storePath, indexPath, VALID_ROLES };
