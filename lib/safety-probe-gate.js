/**
 * Safety probe gate. Wires the existing safety-probes/ modules into the
 * agent policy as pre-execution guards. When SAFETY_PROBE_GATE=1, tool
 * arguments are scanned for prompt-injection patterns, and tool results
 * are scanned for PII/secret leakage before being fed back to the LLM.
 *
 * The gate never throws — on detection it returns a verdict the caller can
 * use to block or sanitize. Inert when flag is off.
 */

import { scrubContent } from "./content-scrubber.js";

export function safetyGateEnabled() {
  return process.env.SAFETY_PROBE_GATE === "1";
}

/**
 * Scan incoming tool arguments for prompt-injection patterns. Uses the
 * shared scrubber with promptInjection=true.
 *
 * @param {object|string} args
 * @returns {{ safe: boolean, findings: Array<{category:string}>, reason?: string }}
 */
export function scanToolArgs(args) {
  if (!safetyGateEnabled()) return { safe: true, findings: [] };
  const text = typeof args === "string" ? args : JSON.stringify(args || {});
  try {
    const res = scrubContent(text, { secrets: false, pii: false, promptInjection: true });
    const injection = (res?.findings || []).filter((f) => f.category === "prompt_injection");
    if (injection.length > 0) {
      return {
        safe: false,
        findings: injection,
        reason: `prompt_injection detected in tool args (${injection.length} hit${injection.length > 1 ? "s" : ""})`,
      };
    }
    return { safe: true, findings: [] };
  } catch {
    return { safe: true, findings: [] };
  }
}

/**
 * Scan tool results for PII/secret leakage before feeding them back to the
 * LLM. Returns `{ safe, findings, sanitized }` where `sanitized` is the
 * scrubbed text with secrets/PII replaced by [REDACTED:type] markers when
 * findings are present.
 *
 * @param {string} content
 * @returns {{ safe: boolean, findings: Array, sanitized: string }}
 */
export function scanToolResult(content) {
  if (!safetyGateEnabled()) return { safe: true, findings: [], sanitized: content };
  const text = typeof content === "string" ? content : String(content ?? "");
  try {
    const res = scrubContent(text, { secrets: true, pii: true, promptInjection: false });
    const hits = (res?.findings || []).filter((f) => f.category === "secret" || f.category === "pii");
    if (hits.length === 0) {
      return { safe: true, findings: [], sanitized: text };
    }
    return {
      safe: false,
      findings: hits,
      sanitized: res?.scrubbed || text,
    };
  } catch {
    return { safe: true, findings: [], sanitized: content };
  }
}

/**
 * Compact summary string for logging/trajectory recording.
 * @param {{ findings: Array<{category:string,rule?:string}> }} verdict
 */
export function formatVerdict(verdict) {
  if (!verdict || !Array.isArray(verdict.findings) || verdict.findings.length === 0) return "";
  const byCat = {};
  for (const f of verdict.findings) {
    const c = f.category || "unknown";
    byCat[c] = (byCat[c] || 0) + 1;
  }
  return Object.entries(byCat).map(([c, n]) => `${c}=${n}`).join(",");
}
