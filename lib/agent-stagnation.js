/**
 * N-cycle rolling window stagnation detector.
 *
 * Replaces the original 2-iteration fingerprint comparison with a configurable
 * window that catches repeated subsequences, partial repetitions, and
 * low-diversity tool-call patterns.
 */

const DEFAULT_WINDOW = Number(process.env.AGENT_STAGNATION_WINDOW) || 5;
const PARTIAL_REPEAT_THRESHOLD = 0.6;
const LOW_DIVERSITY_THRESHOLD = 0.4;

function makeResult({ stagnant, reason, confidence, cycleLength }) {
  return {
    stagnant,
    confidence,
    ...(reason != null && { reason }),
    ...(cycleLength != null && { cycleLength }),
  };
}

/**
 * Compute a deterministic fingerprint for a set of tool calls in one iteration.
 * The fingerprint is independent of argument key ordering.
 *
 * @param {Array<{ name?: string; args?: object }>} toolCalls
 * @returns {string}
 */
export function computeFingerprint(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return JSON.stringify(
    toolCalls
      .map((tc) => {
        const name = tc.name || "";
        const sortedKeys = tc.args && typeof tc.args === "object" && !Array.isArray(tc.args)
          ? Object.keys(tc.args).sort()
          : [];
        return name + ":" + JSON.stringify(sortedKeys);
      })
      .sort()
  );
}

/**
 * Detect stagnation in a rolling window of iteration fingerprints.
 *
 * Checks for:
 * 1. Exact cycle detection -- repeated subsequences (e.g. [A,B,A,B] is a 2-cycle).
 * 2. Partial repetition -- > 60% of the window shares the same fingerprint.
 * 3. Low diversity -- fewer than 40% unique fingerprints in the window.
 *
 * Also supports legacy call signature: if `history` contains objects with `name`/`args`
 * (the old toolCallsLog format), it converts them internally.
 *
 * @param {Array<{ fingerprint: string; iteration: number }> | Array<{ name?: string; args?: object; iteration?: number; validationError?: boolean }>} history
 * @param {{ windowSize?: number }} [opts]
 * @returns {{ stagnant: boolean; reason?: string; confidence: number; cycleLength?: number }}
 */
export function detectStagnation(history, opts) {
  if (!Array.isArray(history) || history.length === 0) {
    return makeResult({ stagnant: false, confidence: 0 });
  }

  // Legacy support: if the first entry has `name` (old toolCallsLog format),
  // convert to the new {fingerprint, iteration} format and return a boolean
  // to preserve backward compatibility with callers that expect `true`/`false`.
  if (history.length > 0 && typeof history[0].name === "string" && !("fingerprint" in history[0])) {
    return _detectFromLegacyLog(history, opts).stagnant;
  }

  const windowSize = opts?.windowSize || DEFAULT_WINDOW;
  const fingerprints = history.map((h) => h.fingerprint).filter((f) => typeof f === "string" && f !== "");

  if (fingerprints.length < 2) {
    return makeResult({ stagnant: false, confidence: 0 });
  }

  const window = fingerprints.slice(-windowSize);

  // 1. Exact cycle detection: for cycle lengths 1..floor(window.length/2),
  //    check if the last `cycleLen` fingerprints equal the preceding `cycleLen`.
  const maxCycleLen = Math.floor(window.length / 2);
  for (let cycleLen = 1; cycleLen <= maxCycleLen; cycleLen++) {
    const tail = window.slice(-cycleLen);
    const preceding = window.slice(-cycleLen * 2, -cycleLen);
    if (preceding.length === cycleLen && tail.every((fp, i) => fp === preceding[i])) {
      return makeResult({
        stagnant: true,
        reason: `exact_cycle: ${cycleLen}-cycle detected in last ${cycleLen * 2} iterations`,
        confidence: 1.0,
        cycleLength: cycleLen,
      });
    }
  }

  // 2. Partial repetition: if > 60% of the window shares the same fingerprint.
  if (window.length >= 3) {
    const freqMap = new Map();
    for (const fp of window) {
      freqMap.set(fp, (freqMap.get(fp) || 0) + 1);
    }
    let maxFreq = 0;
    for (const count of freqMap.values()) {
      if (count > maxFreq) maxFreq = count;
    }
    const ratio = maxFreq / window.length;
    if (ratio > PARTIAL_REPEAT_THRESHOLD) {
      return makeResult({
        stagnant: true,
        reason: `partial_repetition: ${maxFreq}/${window.length} iterations share the same pattern (${(ratio * 100).toFixed(0)}%)`,
        confidence: ratio,
      });
    }
  }

  // 3. Low diversity: uniqueFingerprints / windowSize < 0.4.
  if (window.length >= 3) {
    const unique = new Set(window).size;
    const diversity = unique / window.length;
    if (diversity < LOW_DIVERSITY_THRESHOLD) {
      return makeResult({
        stagnant: true,
        reason: `low_diversity: only ${unique} unique patterns in ${window.length} iterations (diversity=${diversity.toFixed(2)})`,
        confidence: 1 - diversity,
      });
    }
  }

  return makeResult({ stagnant: false, confidence: 0 });
}

/**
 * Convert legacy toolCallsLog to fingerprint history and run detection.
 * @param {Array<{ name?: string; args?: object; iteration?: number; validationError?: boolean }>} toolCallsLog
 * @param {{ windowSize?: number }} [opts]
 * @returns {{ stagnant: boolean; reason?: string; confidence: number; cycleLength?: number }}
 */
function _detectFromLegacyLog(toolCallsLog, opts) {
  const iterations = [
    ...new Set(
      toolCallsLog
        .map((t) => t.iteration)
        .filter((n) => typeof n === "number")
    ),
  ].sort((a, b) => a - b);

  if (iterations.length < 2) return makeResult({ stagnant: false, confidence: 0 });

  const history = iterations.map((it) => {
    const calls = toolCallsLog.filter((t) => t.iteration === it && !t.validationError);
    return {
      fingerprint: computeFingerprint(calls),
      iteration: it,
    };
  });

  return detectStagnation(history, opts);
}

/**
 * Create a stateful stagnation history tracker for use across agent iterations.
 *
 * @returns {{ append: (fingerprint: string, iteration: number) => void; check: (opts?: { windowSize?: number }) => { stagnant: boolean; reason?: string; confidence: number; cycleLength?: number }; getHistory: () => Array<{ fingerprint: string; iteration: number }> }}
 */
export function buildStagnationHistory() {
  /** @type {Array<{ fingerprint: string; iteration: number }>} */
  const history = [];

  return {
    append(fingerprint, iteration) {
      history.push({ fingerprint, iteration });
    },
    check(opts) {
      return detectStagnation(history, opts);
    },
    getHistory() {
      return [...history];
    },
  };
}

export function stagnationDetectionEnabled() {
  return process.env.AGENT_STAGNATION_STOP !== "0";
}

export function stagnationRecoveryEnabled() {
  return process.env.AGENT_STAGNATION_RECOVERY === "1";
}
