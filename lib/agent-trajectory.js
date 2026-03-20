/**
 * Phase 59: Agent run trajectory (ordered steps) for debugging and replay-oriented tooling.
 */
const DEFAULT_TTL_MS = Number(process.env.AGENT_TRAJECTORY_TTL_MS) || 600_000;
const DEFAULT_MAX_ENTRIES = Math.max(10, Number(process.env.AGENT_TRAJECTORY_MAX_STORE) || 100);

/** @type {Map<string, { storedAt: number; payload: object }>} */
const trajectoryStore = new Map();

function pruneStore() {
  const now = Date.now();
  for (const [id, entry] of trajectoryStore.entries()) {
    if (now - entry.storedAt > DEFAULT_TTL_MS) trajectoryStore.delete(id);
  }
  if (trajectoryStore.size <= DEFAULT_MAX_ENTRIES) return;
  const sorted = [...trajectoryStore.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
  while (sorted.length > DEFAULT_MAX_ENTRIES) {
    const drop = sorted.shift();
    if (drop) trajectoryStore.delete(drop[0]);
  }
}

/**
 * @param {string} runId
 * @param {object} snapshot - from collector.getSnapshot()
 */
export function saveTrajectory(runId, snapshot) {
  if (!runId || typeof snapshot !== "object") return;
  pruneStore();
  trajectoryStore.set(runId, { storedAt: Date.now(), payload: snapshot });
}

/**
 * @param {string} runId
 * @returns {object|null}
 */
export function loadTrajectory(runId) {
  if (!runId) return null;
  pruneStore();
  const entry = trajectoryStore.get(runId);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > DEFAULT_TTL_MS) {
    trajectoryStore.delete(runId);
    return null;
  }
  return entry.payload;
}

/**
 * @param {object} meta - { runId, workspace?, userId? }
 */
export function createTrajectoryCollector(meta) {
  const steps = [];
  return {
    /**
     * @param {object} step
     */
    record(step) {
      steps.push({ ...step, at: new Date().toISOString() });
    },
    /**
     * @param {string} text
     * @param {number} max
     */
    truncate(text, max = 400) {
      const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
      return s.length <= max ? s : `${s.slice(0, max)}…`;
    },
    getSnapshot() {
      return {
        ...meta,
        recordedAt: new Date().toISOString(),
        stepCount: steps.length,
        steps,
      };
    },
  };
}

export function trajectoryApiEnabled() {
  return process.env.AGENT_TRAJECTORY_API !== "0";
}
