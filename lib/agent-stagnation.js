/**
 * Phase 58: Detect repeated tool-call patterns across consecutive agent iterations (no progress).
 */

/**
 * Stable stringify for argument objects (sorted keys).
 * @param {unknown} obj
 */
function stableArgsKey(obj) {
  if (obj == null) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  const sorted = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/**
 * @param {Array<{ name?: string; args?: object; iteration?: number }>} toolCallsLog
 * @returns {boolean}
 */
export function detectStagnation(toolCallsLog) {
  if (!Array.isArray(toolCallsLog) || toolCallsLog.length < 2) return false;
  const iterations = [...new Set(toolCallsLog.map((t) => t.iteration).filter((n) => typeof n === "number"))].sort(
    (a, b) => a - b
  );
  if (iterations.length < 2) return false;

  const last = iterations[iterations.length - 1];
  const prev = iterations[iterations.length - 2];

  const fingerprint = (it) =>
    toolCallsLog
      .filter((t) => t.iteration === it && !t.validationError)
      .map((t) => `${t.name}:${stableArgsKey(t.args)}`)
      .sort()
      .join("|");

  const a = fingerprint(last);
  const b = fingerprint(prev);
  return a !== "" && a === b;
}

export function stagnationDetectionEnabled() {
  return process.env.AGENT_STAGNATION_STOP !== "0";
}
