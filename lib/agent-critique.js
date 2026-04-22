/**
 * Mid-loop self-critique. When AGENT_MID_LOOP_CRITIQUE=1, every N iterations
 * the loop injects a brief critique prompt asking the LLM to assess progress
 * and decide whether to adjust its approach. This is complementary to the
 * post-hoc reflection in agent-reflection.js.
 *
 * The critique is cheap: one short LLM call that emits a JSON verdict. When
 * the verdict indicates lack of progress, a terse system hint is added to
 * the message array to nudge the agent toward a different path.
 */

const DEFAULT_INTERVAL = 3;
const DEFAULT_MAX_TOKENS = 200;

export function critiqueEnabled() {
  return process.env.AGENT_MID_LOOP_CRITIQUE === "1";
}

export function getCritiqueInterval() {
  const v = Number(process.env.AGENT_CRITIQUE_INTERVAL);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INTERVAL;
}

/**
 * Decide whether to run critique this iteration.
 * @param {number} iteration
 * @param {{ stagnant?: boolean }} [stagnation]
 */
export function shouldCritique(iteration, stagnation) {
  if (!critiqueEnabled()) return false;
  if (stagnation?.stagnant) return true;
  const interval = getCritiqueInterval();
  return iteration > 0 && iteration % interval === 0;
}

const CRITIQUE_PROMPT = `You are a critique agent evaluating an in-flight agent run. Briefly assess whether the agent is making progress toward the user's goal. Reply with a JSON object:
{
  "on_track": true|false,
  "stuck_reason": "one sentence if off-track, else empty",
  "suggestion": "one short actionable nudge if off-track, else empty"
}
Keep fields under 30 words each. Only suggest if clearly off-track.`;

/**
 * Run a critique pass. Returns either null (critique failed / skipped) or a
 * verdict object.
 *
 * @param {{
 *   messages: Array<{ role: string, content: string }>,
 *   userGoal: string,
 *   backendFetch: Function,
 *   url: string,
 *   model: string,
 *   headers?: object,
 *   maxTokens?: number,
 * }} params
 * @returns {Promise<{ on_track: boolean, stuck_reason?: string, suggestion?: string } | null>}
 */
export async function runMidLoopCritique({
  messages,
  userGoal,
  backendFetch,
  url,
  model,
  headers = {},
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (typeof backendFetch !== "function" || !url || !model) return null;

  const recentTrace = (Array.isArray(messages) ? messages : [])
    .slice(-10)
    .map((m) => {
      const role = m?.role || "?";
      let preview = "";
      if (typeof m?.content === "string") preview = m.content.slice(0, 200);
      else if (Array.isArray(m?.tool_calls)) {
        preview = "tool_calls: " + m.tool_calls.map((tc) => tc?.function?.name).filter(Boolean).join(", ");
      }
      return `[${role}] ${preview}`;
    })
    .join("\n");

  const body = {
    model,
    messages: [
      { role: "system", content: CRITIQUE_PROMPT },
      { role: "user", content: `User goal: ${String(userGoal || "").slice(0, 500)}\n\nRecent trace:\n${recentTrace}` },
    ],
    stream: false,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };

  try {
    const resp = await backendFetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp?.ok) return null;
    const data = await resp.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    let parsed;
    try { parsed = JSON.parse(content); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    return {
      on_track: parsed.on_track !== false,
      stuck_reason: typeof parsed.stuck_reason === "string" ? parsed.stuck_reason.slice(0, 300) : "",
      suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}

/**
 * Format a critique verdict as a system nudge message.
 * Returns empty string when no nudge should be injected.
 * @param {{ on_track: boolean, stuck_reason?: string, suggestion?: string }} verdict
 */
export function formatCritiqueNudge(verdict) {
  if (!verdict || verdict.on_track) return "";
  const parts = ["## Self-critique"];
  if (verdict.stuck_reason) parts.push(`Reason: ${verdict.stuck_reason}`);
  if (verdict.suggestion) parts.push(`Suggestion: ${verdict.suggestion}`);
  parts.push("Adjust your approach accordingly before issuing the next tool call.");
  return parts.join("\n");
}
