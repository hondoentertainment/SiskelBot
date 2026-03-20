/**
 * Phase 56: Golden-trace eval — assert tool names / order / argument keys without a live LLM.
 */

/**
 * Normalize trace entries from eval cases.
 * @param {Array<{ name?: string; tool?: string; arguments?: object }>} trace
 * @returns {Array<{ name: string; args: object }>}
 */
export function normalizeTrace(trace) {
  if (!Array.isArray(trace)) return [];
  return trace
    .map((t) => ({
      name: String(t?.name || t?.tool || "").trim(),
      args: t?.arguments && typeof t.arguments === "object" ? t.arguments : t?.args && typeof t.args === "object" ? t.args : {},
    }))
    .filter((t) => t.name);
}

/**
 * @param {object} evalCase - expectedToolSequence?, expectedToolNames?, expectedToolCalls?
 * @param {Array<{ name?: string; tool?: string; arguments?: object; args?: object }>} trace
 * @returns {{ pass: boolean; reason?: string }}
 */
export function checkGoldenTrace(evalCase, trace) {
  const normalized = normalizeTrace(trace);
  const seq = evalCase.expectedToolSequence;
  if (Array.isArray(seq) && seq.length > 0) {
    const names = normalized.map((t) => t.name);
    if (names.length !== seq.length) {
      return {
        pass: false,
        reason: `expectedToolSequence length ${seq.length}, got ${names.length}`,
      };
    }
    for (let i = 0; i < seq.length; i++) {
      if (names[i] !== seq[i]) {
        return {
          pass: false,
          reason: `At index ${i} expected tool "${seq[i]}", got "${names[i]}"`,
        };
      }
    }
  }

  const multiset = evalCase.expectedToolNames;
  if (Array.isArray(multiset) && multiset.length > 0) {
    const names = normalized.map((t) => t.name).sort().join(",");
    const expected = [...multiset].map(String).sort().join(",");
    if (names !== expected) {
      return {
        pass: false,
        reason: `expectedToolNames multiset mismatch: expected [${multiset.join(",")}] vs got [${normalized.map((t) => t.name).join(",")}]`,
      };
    }
  }

  const detailed = evalCase.expectedToolCalls;
  if (Array.isArray(detailed) && detailed.length > 0) {
    if (normalized.length < detailed.length) {
      return {
        pass: false,
        reason: `expectedToolCalls wants ${detailed.length} calls, trace has ${normalized.length}`,
      };
    }
    for (let i = 0; i < detailed.length; i++) {
      const want = detailed[i];
      const got = normalized[i];
      const wantName = String(want?.name || "").trim();
      if (wantName && got.name !== wantName) {
        return { pass: false, reason: `Call ${i}: expected name "${wantName}", got "${got.name}"` };
      }
      const needKeys = want?.requiredArgKeys || want?.argKeys;
      if (Array.isArray(needKeys) && needKeys.length > 0) {
        for (const k of needKeys) {
          if (!(k in got.args) || got.args[k] == null || got.args[k] === "") {
            return { pass: false, reason: `Call ${i}: missing or empty argument "${k}"` };
          }
        }
      }
    }
  }

  if (
    (!seq || seq.length === 0) &&
    (!multiset || multiset.length === 0) &&
    (!detailed || detailed.length === 0)
  ) {
    return { pass: false, reason: "No golden-trace criteria (expectedToolSequence, expectedToolNames, or expectedToolCalls)" };
  }

  return { pass: true };
}
