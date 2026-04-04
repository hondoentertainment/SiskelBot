/**
 * In-process agent run limits and session-scoped AbortSignal for cancellation.
 * Concurrency is per workspace when AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE > 0.
 */

const MAX_CONCURRENT = Math.max(0, Math.floor(Number(process.env.AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE) || 0));

/** @type {Map<string, number>} */
const activeRunsByWorkspace = new Map();

/** @type {Map<string, AbortController>} */
const sessionAbortControllers = new Map();

export function getMaxConcurrentRunsPerWorkspace() {
  return MAX_CONCURRENT;
}

/**
 * @param {string} workspace
 * @returns {{ ok: true } | { ok: false, code: string, max: number }}
 */
export function tryBeginWorkspaceAgentRun(workspace) {
  if (MAX_CONCURRENT <= 0) return { ok: true };
  const ws = String(workspace || "default");
  const n = activeRunsByWorkspace.get(ws) || 0;
  if (n >= MAX_CONCURRENT) {
    return { ok: false, code: "AGENT_RUN_CONCURRENCY", max: MAX_CONCURRENT };
  }
  activeRunsByWorkspace.set(ws, n + 1);
  return { ok: true };
}

/**
 * @param {string} workspace
 */
export function endWorkspaceAgentRun(workspace) {
  if (MAX_CONCURRENT <= 0) return;
  const ws = String(workspace || "default");
  const n = (activeRunsByWorkspace.get(ws) || 0) - 1;
  activeRunsByWorkspace.set(ws, Math.max(0, n));
}

/**
 * Latest agent run for this session wins; starting a new run aborts a stuck prior fetch.
 * @param {string} sessionId
 */
export function bindSessionAbortController(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    return { controller: null, release: () => {} };
  }
  const prev = sessionAbortControllers.get(sid);
  if (prev) {
    try {
      prev.abort();
    } catch (_) {
      /* ignore */
    }
  }
  const ac = new AbortController();
  sessionAbortControllers.set(sid, ac);
  return {
    controller: ac,
    release: () => {
      if (sessionAbortControllers.get(sid) === ac) sessionAbortControllers.delete(sid);
    },
  };
}

/**
 * @param {string} sessionId
 */
export function cancelAgentSessionRun(sessionId) {
  const sid = String(sessionId || "").trim();
  const ac = sessionAbortControllers.get(sid);
  if (!ac) return { ok: false, code: "NO_ACTIVE_RUN" };
  try {
    ac.abort();
  } catch (_) {
    /* ignore */
  }
  return { ok: true };
}
