/**
 * Tool argument auto-repair.
 *
 * When semantic validation rejects a tool call, optionally invoke a cheap LLM
 * "repair" call that takes the failing args + the repair hint and returns
 * fixed args. The caller (tool-validation.js via validateToolCallWithRepair)
 * then re-validates once with the repaired args and, if that passes, proceeds
 * with the tool call. If repair still fails, the original failure is surfaced
 * so we fall back to today's re-plan loop.
 *
 * This module is intentionally callFn-based (no direct HTTP) so unit tests
 * can stub the LLM call. The env gate is checked via toolArgRepairEnabled()
 * and defaults to OFF since repair costs an extra LLM call.
 *
 * @module tool-arg-repair
 */

/**
 * Build the focused repair prompt shown to the model.
 *
 * The prompt is intentionally small: tool name, the args that failed, the
 * validator's repair hint, and an instruction to return ONLY a JSON object.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {string} repairHint
 * @returns {string}
 */
export function buildRepairPrompt(toolName, args, repairHint) {
  let argsPreview;
  try {
    argsPreview = JSON.stringify(args ?? {}, null, 2);
  } catch {
    argsPreview = String(args);
  }
  const hint = typeof repairHint === "string" && repairHint.trim()
    ? repairHint.trim()
    : "(no hint provided)";
  return [
    "The following tool call failed validation.",
    `Tool: ${toolName}`,
    "Your arguments:",
    argsPreview,
    `Validation error: ${hint}`,
    "",
    "Return ONLY a JSON object with corrected arguments.",
    "Do not include any prose, markdown, or explanation. Output just the JSON object.",
  ].join("\n");
}

/**
 * Strip ```json ... ``` or ``` ... ``` fences from LLM output, trim whitespace.
 * Returns the raw string if no fences were found.
 * @param {string} text
 * @returns {string}
 */
function stripFences(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * Parse the repair response as a JSON object. Returns null when the text is
 * not valid JSON or does not parse to a plain object.
 * @param {string} text
 * @returns {object | null}
 */
function parseRepairedArgs(text) {
  const inner = stripFences(text);
  if (!inner) return null;
  try {
    const parsed = JSON.parse(inner);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run callFn(prompt) with a timeout. Rejects with a timeout error if the
 * promise does not settle in time. Uses Promise.race rather than AbortController
 * so callFn implementations that don't accept a signal still time out cleanly.
 *
 * @param {(prompt: string) => Promise<string>} callFn
 * @param {string} prompt
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function callWithTimeout(callFn, prompt, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`repair call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([
    Promise.resolve().then(() => callFn(prompt)).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

/**
 * Repair a failing tool call's arguments by asking a cheap LLM to fix them.
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {object} params.args
 * @param {string} params.repairHint
 * @param {(prompt: string) => Promise<string>} params.callFn
 * @param {number} [params.timeoutMs=10000]
 * @returns {Promise<{ ok: boolean, repairedArgs?: object, error?: string, rawResponse?: string }>}
 */
export async function repairToolArgs({ toolName, args, repairHint, callFn, timeoutMs = 10000 }) {
  if (typeof callFn !== "function") {
    return { ok: false, error: "callFn is required" };
  }
  const prompt = buildRepairPrompt(toolName, args, repairHint);

  let rawResponse;
  try {
    rawResponse = await callWithTimeout(callFn, prompt, timeoutMs);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  if (typeof rawResponse !== "string" || !rawResponse.trim()) {
    return { ok: false, error: "empty repair response", rawResponse };
  }

  const repairedArgs = parseRepairedArgs(rawResponse);
  if (!repairedArgs) {
    return {
      ok: false,
      error: "repair response was not a valid JSON object",
      rawResponse,
    };
  }
  return { ok: true, repairedArgs, rawResponse };
}

/**
 * Whether inline tool-arg repair is enabled. OFF by default (an extra LLM
 * call per failure is opt-in).
 * @returns {boolean}
 */
export function toolArgRepairEnabled() {
  return process.env.AGENT_TOOL_ARG_REPAIR === "1";
}
