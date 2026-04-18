/**
 * Admin routes for per-run agent trace viewer.
 *
 * Surfaces trajectories captured by lib/agent-trajectory.js so operators can
 * inspect individual runs (tool calls with args/results, replan nudges,
 * stagnation signals, cost, timing). The list endpoint is workspace-scoped;
 * the detail endpoint exposes the full iteration-grouped trace, with
 * individual message/content strings truncated defensively.
 *
 * Requires admin auth. Mounted at /api/admin/traces*.
 */

import { listTrajectories, loadTrajectory } from "../lib/agent-trajectory.js";

const MAX_CONTENT_CHARS = 10000;
const TRUNCATION_MARKER = "…[truncated]";

function truncate(str) {
  if (typeof str !== "string") return str;
  if (str.length <= MAX_CONTENT_CHARS) return str;
  return str.slice(0, MAX_CONTENT_CHARS) + TRUNCATION_MARKER;
}

/** @returns {number} ms */
function stepTimeMs(step) {
  if (!step || typeof step !== "object") return 0;
  const t = step.at || step.timestamp;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Best-effort iteration key for a step. */
function stepIteration(step) {
  if (!step || typeof step !== "object") return 0;
  if (Number.isFinite(step.iteration)) return Number(step.iteration);
  return 0;
}

/**
 * Summarize a raw trajectory payload for the list view.
 * @param {string} runId
 * @param {object} payload
 */
function summarizeTrajectory(runId, payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  let startMs = 0;
  let stopReason = null;
  let iterationCount = 0;
  let toolCallCount = 0;
  let totalCostUsd = 0;

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const t = stepTimeMs(step);
    if (t && (!startMs || t < startMs)) startMs = t;
    if (step.type === "start") {
      if (t) startMs = t;
    } else if (step.type === "stop") {
      if (typeof step.reason === "string") stopReason = step.reason;
      if (Number.isFinite(step.iterations)) iterationCount = Math.max(iterationCount, Number(step.iterations));
    } else if (step.type === "iteration") {
      const it = stepIteration(step);
      if (it > iterationCount) iterationCount = it;
    } else if (step.type === "tool_call") {
      toolCallCount += 1;
    }
    if (Number.isFinite(step.costDelta)) totalCostUsd += Number(step.costDelta);
    if (step.cost && Number.isFinite(step.cost.usd)) totalCostUsd += Number(step.cost.usd);
  }

  return {
    runId,
    sessionId: payload?.sessionId || payload?.agentSessionId || null,
    workspace: payload?.workspace || "default",
    startedAt: startMs ? new Date(startMs).toISOString() : payload?.recordedAt || null,
    stopReason,
    iterationCount,
    toolCallCount,
    totalCostUsd: Number(totalCostUsd.toFixed(6)) || 0,
  };
}

/**
 * Parse a tool_call step's argsPreview JSON if possible.
 */
function safeParseArgs(argsPreview) {
  if (!argsPreview) return null;
  if (typeof argsPreview !== "string") return argsPreview;
  try {
    return JSON.parse(argsPreview);
  } catch {
    return argsPreview;
  }
}

/**
 * Group flat trajectory steps into per-iteration cards.
 * @param {Array<object>} steps
 */
function groupByIteration(steps) {
  /** @type {Map<number, object>} */
  const byIter = new Map();
  function ensure(it) {
    if (!byIter.has(it)) {
      byIter.set(it, {
        iteration: it,
        timestamp: null,
        durationMs: 0,
        messages: [],
        toolCalls: [],
        signals: [],
        costDelta: 0,
      });
    }
    return byIter.get(it);
  }

  // Stash pending tool_call records by (iteration,name) so we can attach their tool_result / tool_error.
  /** @type {Map<string, object>} */
  const pending = new Map();
  const keyOf = (it, name) => it + "\u0000" + (name || "");

  let firstTsAtIter = new Map();

  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    const it = stepIteration(step);
    const card = ensure(it);
    const ts = step.at || step.timestamp || null;
    if (ts && !firstTsAtIter.has(it)) firstTsAtIter.set(it, ts);
    if (!card.timestamp && ts) card.timestamp = ts;

    if (step.type === "tool_call") {
      const tc = {
        name: step.name || "",
        args: safeParseArgs(step.argsPreview),
        result: null,
        ok: null,
        latencyMs: null,
        startedAt: ts,
      };
      card.toolCalls.push(tc);
      pending.set(keyOf(it, step.name), tc);
    } else if (step.type === "tool_result") {
      const tc = pending.get(keyOf(it, step.name));
      const preview = typeof step.preview === "string" ? truncate(step.preview) : step.preview;
      if (tc) {
        tc.result = preview;
        tc.ok = step.ok !== false;
        if (tc.startedAt && ts) {
          const d = new Date(ts).getTime() - new Date(tc.startedAt).getTime();
          if (Number.isFinite(d) && d >= 0) tc.latencyMs = d;
        }
        pending.delete(keyOf(it, step.name));
      } else {
        card.toolCalls.push({
          name: step.name || "",
          args: null,
          result: preview,
          ok: step.ok !== false,
          latencyMs: null,
        });
      }
    } else if (step.type === "tool_error") {
      const tc = pending.get(keyOf(it, step.name));
      const msg = typeof step.message === "string" ? truncate(step.message) : step.message;
      if (tc) {
        tc.result = msg;
        tc.ok = false;
        if (tc.startedAt && ts) {
          const d = new Date(ts).getTime() - new Date(tc.startedAt).getTime();
          if (Number.isFinite(d) && d >= 0) tc.latencyMs = d;
        }
        pending.delete(keyOf(it, step.name));
      } else {
        card.toolCalls.push({ name: step.name || "", args: null, result: msg, ok: false, latencyMs: null });
      }
    } else if (step.type === "message") {
      card.messages.push({ role: step.role || "assistant", content: truncate(step.content || "") });
    } else if (
      step.type === "replan" ||
      step.type === "replan_nudge" ||
      step.type === "stagnation" ||
      step.type === "stagnation_signal" ||
      step.type === "reflection" ||
      step.type === "reflection_revision" ||
      step.type === "reflection_error" ||
      step.type === "tool_validation_error" ||
      step.type === "tool_chain"
    ) {
      card.signals.push({
        kind: step.type,
        message: typeof step.message === "string" ? truncate(step.message) : null,
        reason: step.reason || null,
        details: step,
      });
    } else if (step.type === "stop") {
      card.signals.push({ kind: "stop", reason: step.reason || null, details: step });
    }

    if (Number.isFinite(step.costDelta)) card.costDelta += Number(step.costDelta);
    if (step.cost && Number.isFinite(step.cost.usd)) card.costDelta += Number(step.cost.usd);
  }

  // compute durationMs per iteration from first step -> last step timestamp
  const allTimestamps = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    const it = stepIteration(step);
    const t = stepTimeMs(step);
    if (!t) continue;
    const row = allTimestamps.get(it) || { min: t, max: t };
    if (t < row.min) row.min = t;
    if (t > row.max) row.max = t;
    allTimestamps.set(it, row);
  }
  for (const [it, r] of allTimestamps.entries()) {
    const card = byIter.get(it);
    if (card) {
      const d = r.max - r.min;
      if (Number.isFinite(d) && d >= 0) card.durationMs = d;
    }
  }

  return [...byIter.values()].sort((a, b) => a.iteration - b.iteration);
}

export default function mountAdminTracesRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/traces?workspace=X&limit=50 */
  app.get(
    "/api/admin/traces",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 50));
        const listing = await listTrajectories({ workspace, limit });
        const items = Array.isArray(listing?.items) ? listing.items : [];
        /** @type {object[]} */
        const traces = [];
        for (const row of items) {
          if (!row || !row.runId) continue;
          const payload = await loadTrajectory(row.runId);
          if (!payload) {
            traces.push({
              runId: row.runId,
              sessionId: null,
              workspace: row.workspace || workspace,
              startedAt: row.storedAt || null,
              stopReason: null,
              iterationCount: 0,
              toolCallCount: 0,
              totalCostUsd: 0,
            });
            continue;
          }
          traces.push(summarizeTrajectory(row.runId, payload));
          if (traces.length >= limit) break;
        }
        return res.json({ workspace, traces });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/traces/:runId */
  app.get(
    "/api/admin/traces/:runId",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const runId = String(req.params?.runId || "").trim();
        if (!runId) {
          return apiError(res, 400, "INVALID_RUN_ID", "runId is required");
        }
        const payload = await loadTrajectory(runId);
        if (!payload) {
          return apiError(res, 404, "NOT_FOUND", "Trace not found for runId " + runId);
        }
        const iterations = groupByIteration(payload.steps);
        return res.json({
          runId,
          sessionId: payload.sessionId || payload.agentSessionId || null,
          workspace: payload.workspace || "default",
          recordedAt: payload.recordedAt || null,
          stepCount: Array.isArray(payload.steps) ? payload.steps.length : 0,
          iterations,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
