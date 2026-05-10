/**
 * Upfront task decomposition. When AGENT_UPFRONT_PLAN=1, the loop runs a
 * planning pass at iteration 0 that produces a short task DAG before any
 * tools fire. The plan is injected as a system message so the LLM has an
 * explicit scaffold to follow, reducing wasted tool calls and stagnation.
 *
 * When `agentOptions.sessionId` is set and `AGENT_PERSIST_UPFRONT_PLAN` is not
 * `0`, `runUpfrontPlanHook` also writes `planDag` / `planSummary` onto that
 * agent session (see `lib/agent-loop-hooks.js`).
 */

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_TOKENS = 400;

export function planningEnabled() {
  return process.env.AGENT_UPFRONT_PLAN === "1";
}

const PLANNING_PROMPT = `You are a planner. Given the user's request, produce a short ordered plan (maximum ${DEFAULT_MAX_STEPS} steps) describing what tool-based sub-tasks are required before a final answer can be given. Output a JSON object:
{
  "steps": [{"id": 1, "goal": "short goal", "tool_hint": "optional tool name", "depends_on": []}],
  "done_criteria": "one sentence describing when the task is complete"
}
Keep each step's goal under 15 words. Do not invent tools — only suggest ones relevant to the user's task. If the request is trivial and no tools are needed, return {"steps": [], "done_criteria": "..."}.`;

/**
 * Produce a plan for the user's task by calling the LLM with a planning prompt.
 * Returns null if planning fails or is disabled.
 *
 * @param {{
 *   userMessage: string,
 *   backendFetch: Function,
 *   url: string,
 *   model: string,
 *   headers?: object,
 *   maxSteps?: number,
 *   maxTokens?: number,
 * }} params
 * @returns {Promise<{ steps: Array<{id:number,goal:string,tool_hint?:string,depends_on?:number[]}>, done_criteria: string } | null>}
 */
export async function buildUpfrontPlan({
  userMessage,
  backendFetch,
  url,
  model,
  headers = {},
  maxSteps = DEFAULT_MAX_STEPS,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  if (typeof userMessage !== "string" || !userMessage.trim()) return null;
  if (typeof backendFetch !== "function" || !url || !model) return null;

  const body = {
    model,
    messages: [
      { role: "system", content: PLANNING_PROMPT.replace(`${DEFAULT_MAX_STEPS}`, String(maxSteps)) },
      { role: "user", content: userMessage.slice(0, 2000) },
    ],
    stream: false,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };

  try {
    const resp = await backendFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp?.ok) return null;
    const data = await resp.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.slice(0, maxSteps).map((s, i) => ({
          id: Number.isFinite(s.id) ? s.id : i + 1,
          goal: String(s.goal || "").slice(0, 200),
          ...(s.tool_hint && { tool_hint: String(s.tool_hint).slice(0, 64) }),
          ...(Array.isArray(s.depends_on) && { depends_on: s.depends_on.filter((n) => Number.isFinite(n)) }),
        }))
      : [];
    return {
      steps,
      done_criteria: String(parsed.done_criteria || "").slice(0, 500),
    };
  } catch {
    return null;
  }
}

/**
 * Format a plan as a system message that the agent can follow.
 * @param {{ steps: Array<{id:number,goal:string,tool_hint?:string}>, done_criteria: string }} plan
 * @returns {string}
 */
export function formatPlanAsSystemMessage(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return "";
  }
  const lines = [
    "## Task Plan",
    "Follow this plan. Call tools to satisfy each step before producing a final answer.",
    "",
  ];
  for (const s of plan.steps) {
    const hint = s.tool_hint ? ` (suggested tool: ${s.tool_hint})` : "";
    const deps = s.depends_on?.length ? ` [after: ${s.depends_on.join(", ")}]` : "";
    lines.push(`${s.id}. ${s.goal}${hint}${deps}`);
  }
  if (plan.done_criteria) {
    lines.push("", `Done when: ${plan.done_criteria}`);
  }
  return lines.join("\n");
}
