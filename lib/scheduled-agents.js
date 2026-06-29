/**
 * Phase 29: Scheduled agent runs.
 * CRUD for scheduled agent configurations and run history.
 * Storage: data/scheduled-agents/{workspaceId}.json
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { emitCostUpdate, disposeRunCostAccumulator } from "./agent-cost-emitter.js";
import { getSessionIdForRunSync, getSessionIdForRun } from "./agent-session.js";
import { checkBudget, recordSpend, estimateUsd } from "./cost-budget.js";

const MAX_RUNS = 200;
const MAX_SCHEDULED_AGENTS = 500;

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function storePath(workspaceId) {
  return join(getDataDir(), "scheduled-agents", sanitizeWorkspace(workspaceId) + ".json");
}

function runsStorePath(workspaceId) {
  return join(getDataDir(), "scheduled-agents", sanitizeWorkspace(workspaceId) + "-runs.json");
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.agents)) return raw;
  return { agents: [] };
}

function normalizeRunsStore(raw) {
  if (raw && typeof raw === "object" && typeof raw.runs === "object" && !Array.isArray(raw.runs)) return raw;
  return { runs: {} };
}

/**
 * Compute next run time from a cron expression (approximate).
 * Returns ISO string or null if cron-parser is unavailable.
 */
async function computeNextRun(cronExpr) {
  try {
    const mod = await import("cron-parser");
    const parseExpression = mod.parseExpression || mod.default?.parseExpression;
    if (!parseExpression) return null;
    const interval = parseExpression(cronExpr);
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression. Returns true if valid.
 */
function isValidCron(expr) {
  if (typeof expr !== "string" || !expr.trim()) return false;
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

/**
 * Create a scheduled agent configuration.
 * @param {{ workspaceId: string, cron: string, prompt: string, model?: string, agentMode?: string, name?: string, description?: string }} config
 * @returns {Promise<object>}
 */
export async function createScheduledAgent(config) {
  const workspaceId = sanitizeWorkspace(config.workspaceId);
  if (!config.prompt || typeof config.prompt !== "string" || !config.prompt.trim()) {
    throw new Error("prompt is required");
  }
  if (!config.cron || !isValidCron(config.cron)) {
    throw new Error("A valid cron expression is required");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const nextRun = await computeNextRun(config.cron);

  const agent = {
    id,
    workspaceId,
    name: typeof config.name === "string" ? config.name.trim().slice(0, 200) : "Untitled Agent",
    description: typeof config.description === "string" ? config.description.trim().slice(0, 1000) : "",
    cron: config.cron.trim(),
    prompt: config.prompt.trim().slice(0, 10000),
    model: typeof config.model === "string" ? config.model.trim() : "",
    agentMode: typeof config.agentMode === "string" ? config.agentMode.trim() : "single",
    crossRunNotes: typeof config.crossRunNotes === "string" ? config.crossRunNotes.slice(0, 20000) : "",
    enabled: true,
    nextRun,
    createdAt: now,
    updatedAt: now,
  };

  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    if (data.agents.length >= MAX_SCHEDULED_AGENTS) {
      throw new Error("Maximum number of scheduled agents reached");
    }
    data.agents.push(agent);
    await writeJsonPath(path, data);
  });

  return agent;
}

/**
 * List all scheduled agents for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<object[]>}
 */
export async function listScheduledAgents(workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.agents;
}

/**
 * Get a single scheduled agent by ID.
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getScheduledAgent(workspaceId, id) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.agents.find((a) => a.id === id) || null;
}

/**
 * Update a scheduled agent configuration.
 * @param {string} workspaceId
 * @param {string} id
 * @param {object} updates
 * @returns {Promise<object|null>}
 */
export async function updateScheduledAgent(workspaceId, id, updates) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let updated = null;

  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const idx = data.agents.findIndex((a) => a.id === id);
    if (idx === -1) return;

    const agent = data.agents[idx];
    const allowed = ["name", "description", "cron", "prompt", "model", "agentMode", "enabled"];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        agent[key] = updates[key];
      }
    }
    if (updates.cron && isValidCron(updates.cron)) {
      agent.nextRun = await computeNextRun(updates.cron);
    }
    agent.updatedAt = new Date().toISOString();
    data.agents[idx] = agent;
    await writeJsonPath(path, data);
    updated = agent;
  });

  return updated;
}

/**
 * Delete a scheduled agent.
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteScheduledAgent(workspaceId, id) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let deleted = false;

  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const before = data.agents.length;
    data.agents = data.agents.filter((a) => a.id !== id);
    if (data.agents.length < before) {
      deleted = true;
      await writeJsonPath(path, data);
    }
  });

  return deleted;
}

/**
 * Execute a scheduled agent immediately.
 * Runs the agent with the configured prompt, saves the result to run history.
 * @param {string} workspaceId
 * @param {string} id
 * @param {{ backendFetch?: Function, buildProxyConfig?: Function, model?: string }} opts
 * @returns {Promise<object>}
 */
export async function runScheduledAgent(workspaceId, id, opts = {}) {
  const agent = await getScheduledAgent(workspaceId, id);
  if (!agent) {
    throw new Error("Scheduled agent not found");
  }

  const runId = randomUUID();
  const startedAt = Date.now();

  // Budget pre-check: refuse to spend when the workspace is over its cap.
  const budget = await checkBudget(workspaceId).catch(() => ({ allowed: true }));
  if (!budget.allowed) {
    const run = {
      runId,
      agentId: id,
      workspaceId: sanitizeWorkspace(workspaceId),
      prompt: agent.prompt,
      response: "",
      tokens: 0,
      duration: 0,
      error: budget.reason,
      status: "budget_exceeded",
      createdAt: new Date().toISOString(),
    };
    const runsPath_ = runsStorePath(workspaceId);
    await withPathLock(runsPath_, async () => {
      const data = normalizeRunsStore(await readJsonPath(runsPath_, null));
      if (!Array.isArray(data.runs[id])) data.runs[id] = [];
      data.runs[id].unshift(run);
      data.runs[id] = data.runs[id].slice(0, MAX_RUNS);
      await writeJsonPath(runsPath_, data);
    });
    return { runId, response: "", tokens: 0, duration: 0, error: budget.reason, status: "budget_exceeded" };
  }

  let response = "";
  let tokens = 0;
  let error = null;

  try {
    if (typeof opts.backendFetch === "function" && typeof opts.buildProxyConfig === "function") {
      const config = opts.buildProxyConfig(agent.model || opts.model || "default");
      const url = `${config.baseUrl}${config.path}`;
      const body = {
        model: agent.model || opts.model || "default",
        messages: [
          { role: "system", content: "You are a scheduled agent. Execute the task given to you." },
          { role: "user", content: agent.prompt },
        ],
        stream: false,
      };
      const resp = await opts.backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
        response = data.choices?.[0]?.message?.content || "";
        tokens = data.usage?.total_tokens || 0;
        // Attribute spend to the workspace budget ledger (best-effort).
        try {
          await recordSpend(workspaceId, estimateUsd(agent.model || opts.model || "default", tokens), {
            model: agent.model || opts.model || "default",
          });
        } catch { /* best-effort */ }
        // Emit cost.update so any Agent Run hero listening on this scheduled
        // agent's session sees the completion cost. Silent when sessionId is
        // not resolvable (scheduled runs rarely have an attached SSE viewer).
        try {
          const explicitSessionId =
            (typeof opts.sessionId === "string" && opts.sessionId.trim()) || "";
          let liveSessionId = explicitSessionId;
          if (!liveSessionId) {
            const fromMemory = getSessionIdForRunSync(runId);
            if (fromMemory) {
              liveSessionId = fromMemory;
            } else {
              const resolved = await getSessionIdForRun(runId).catch(() => null);
              if (resolved) liveSessionId = resolved;
            }
          }
          if (liveSessionId) {
            emitCostUpdate({
              sessionId: liveSessionId,
              runId,
              model: agent.model || opts.model || "default",
              usage: data?.usage || null,
            });
          }
        } catch { /* best-effort */ }
      } else {
        error = `Backend error: ${resp.status}`;
      }
    } else {
      response = `[dry-run] Would execute agent "${agent.name}" with prompt: ${agent.prompt.slice(0, 200)}`;
    }
  } catch (err) {
    error = err.message;
  }

  const duration = Date.now() - startedAt;

  const run = {
    runId,
    agentId: id,
    workspaceId: sanitizeWorkspace(workspaceId),
    prompt: agent.prompt,
    response,
    tokens,
    duration,
    error,
    status: error ? "failed" : "completed",
    createdAt: new Date().toISOString(),
  };

  const runsPath_ = runsStorePath(workspaceId);
  await withPathLock(runsPath_, async () => {
    const data = normalizeRunsStore(await readJsonPath(runsPath_, null));
    if (!Array.isArray(data.runs[id])) {
      data.runs[id] = [];
    }
    data.runs[id].unshift(run);
    data.runs[id] = data.runs[id].slice(0, MAX_RUNS);
    await writeJsonPath(runsPath_, data);
  });

  // Update nextRun on the agent
  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const agent_ = data.agents.find((a) => a.id === id);
    if (agent_) {
      agent_.lastRunAt = run.createdAt;
      agent_.nextRun = await computeNextRun(agent_.cron);
      await writeJsonPath(path, data);
    }
  });

  try { disposeRunCostAccumulator(runId); } catch { /* best-effort */ }

  return { runId: run.runId, response: run.response, tokens: run.tokens, duration: run.duration, error: run.error, status: run.status };
}

/**
 * Get run history for a scheduled agent.
 * @param {string} workspaceId
 * @param {string} id
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
export async function getScheduledAgentRuns(workspaceId, id, limit = 50) {
  const ws = sanitizeWorkspace(workspaceId);
  const runsPath_ = runsStorePath(ws);
  const data = normalizeRunsStore(await readJsonPath(runsPath_, null));
  const runs = data.runs[id] || [];
  return runs.slice(0, Math.min(limit, MAX_RUNS));
}

/**
 * Update the cross-run notes for a scheduled agent.
 * @param {string} workspaceId
 * @param {string} id
 * @param {string} notes
 * @returns {Promise<object|null>}
 */
export async function updateCrossRunNotes(workspaceId, id, notes) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let updated = null;

  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const idx = data.agents.findIndex((a) => a.id === id);
    if (idx === -1) return;
    data.agents[idx].crossRunNotes = typeof notes === "string" ? notes.slice(0, 20000) : "";
    data.agents[idx].updatedAt = new Date().toISOString();
    await writeJsonPath(path, data);
    updated = data.agents[idx];
  });

  return updated;
}

/**
 * Get the cross-run notes for a scheduled agent.
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function getCrossRunNotes(workspaceId, id) {
  const agent = await getScheduledAgent(workspaceId, id);
  return agent?.crossRunNotes || "";
}

/**
 * Build the cross-run notes injection string for system prompt.
 * @param {string} notes
 * @returns {string}
 */
export function buildCrossRunNotesInjection(notes) {
  if (!notes || typeof notes !== "string" || !notes.trim()) return "";
  return `\n\n## Notes from previous runs\n${notes}`;
}
