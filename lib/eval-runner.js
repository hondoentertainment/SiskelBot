/**
 * Phase 32: Evaluation harness for SiskelBot.
 * Runs eval sets against chat/task APIs and checks criteria.
 * Phase 93: Eval chat cases can exercise real agent/swarm requests; SSE agent_activity
 * assertions, skip cases, passed/skipped counts, optional agentActivityHint on results.
 */
import { checkGoldenTrace } from "./eval-golden-trace.js";
import { runEvalJudge } from "./eval-judge.js";
import {
  checkAgentActivityCriteria,
  collectToolNamesFromAgentActivity,
  collectSwarmStepLabels,
} from "./eval-agent-activity.js";
import {
  resolveStagingTracePath,
  loadStagingTraceRecord,
  evaluateStagingTraceCase,
} from "./eval-staging-trace.js";

export { checkAgentActivityCriteria };

const CHAT_REQUEST_OVERRIDE_KEYS = [
  "agentMode",
  "swarmMode",
  "agentOptions",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_tokens",
  "stream",
];

function pickAllowedFields(source, keys) {
  const out = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function buildChatRequest(opts) {
  const {
    model,
    messages,
    systemPrompt,
    evalSet,
    evalCase,
  } = opts;
  const msgs = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;
  return {
    model: model || "llama3.2",
    messages: msgs,
    stream: false,
    ...pickAllowedFields(evalSet?.chatRequestDefaults, CHAT_REQUEST_OVERRIDE_KEYS),
    ...pickAllowedFields(evalCase, CHAT_REQUEST_OVERRIDE_KEYS),
    ...(evalCase?.chatRequest && typeof evalCase.chatRequest === "object" ? evalCase.chatRequest : {}),
  };
}

function extractChatContent(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta?.content;
  const message = choice?.message?.content;
  const root = payload?.message?.content;
  if (typeof delta === "string") return delta;
  if (typeof message === "string") return message;
  if (typeof root === "string") return root;
  return "";
}

/**
 * Parse SSE from /v1/chat/completions (normal stream or agent path).
 * Collects assistant text from choice deltas and the last agent_activity payload if present.
 * @param {string} raw
 * @returns {{ content: string, agentActivity: object | null }}
 */
export function parseSseEvalResponse(raw) {
  let content = "";
  let agentActivity = null;
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && parsed.type === "agent_activity") {
        agentActivity = parsed;
        continue;
      }
      if (parsed && parsed.type === "agent_progress") {
        continue;
      }
      content += extractChatContent(parsed);
    } catch (_) {
      // Ignore non-JSON SSE side-channel events.
    }
  }
  return { content, agentActivity };
}

const AGENT_ACTIVITY_HINT_MAX = 160;

/**
 * Short string for eval UI / API (tool names + swarm step labels).
 * @param {object | null} agentActivity
 * @returns {string|undefined}
 */
function buildAgentActivityHint(agentActivity) {
  if (!agentActivity || typeof agentActivity !== "object") return undefined;
  const tools = collectToolNamesFromAgentActivity(agentActivity);
  const swarm = collectSwarmStepLabels(agentActivity);
  const parts = [];
  if (tools.length) parts.push(`tools: ${tools.join(", ")}`);
  if (swarm.length) parts.push(`swarm: ${swarm.join(", ")}`);
  if (agentActivity.stopReason) parts.push(`stop: ${agentActivity.stopReason}`);
  if (!parts.length) return undefined;
  let s = parts.join(" | ");
  if (s.length > AGENT_ACTIVITY_HINT_MAX) {
    s = `${s.slice(0, AGENT_ACTIVITY_HINT_MAX - 3)}...`;
  }
  return s;
}

/**
 * Check criteria against output.
 * @param {object} c - Case with expectedContains?, expectedPattern?, expectedJson?, agent_activity expectations
 * @param {string} output - Raw output text
 * @param {object} parsed - Parsed object (for task API; used with expectedJson)
 * @param {object | null} agentActivity - SSE agent_activity payload when present
 * @returns {{ pass: boolean, reason?: string }}
 */
export function checkCriteria(c, output, parsed = null, agentActivity = null) {
  const text = typeof output === "string" ? output : "";
  if (c.expectedContains != null) {
    const needle = String(c.expectedContains);
    if (!text.includes(needle)) {
      return { pass: false, reason: `Expected substring "${needle}" not found in output` };
    }
  }
  if (c.expectedPattern != null) {
    try {
      const re = new RegExp(String(c.expectedPattern));
      if (!re.test(text)) {
        return { pass: false, reason: `Output did not match pattern: ${c.expectedPattern}` };
      }
    } catch (e) {
      return { pass: false, reason: `Invalid regex: ${c.expectedPattern}` };
    }
  }
  if (c.expectedJson != null) {
    const obj = parsed ?? (() => {
      try {
        const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        const raw = jsonBlock ? jsonBlock[1].trim() : text.trim();
        return JSON.parse(raw || "{}");
      } catch (_) {
        return null;
      }
    })();
    if (!obj || typeof obj !== "object") {
      return { pass: false, reason: "No valid JSON found in output for expectedJson check" };
    }
    const keys = Array.isArray(c.expectedJson) ? c.expectedJson : [c.expectedJson];
    for (const k of keys) {
      const key = String(k);
      if (!(key in obj)) {
        return { pass: false, reason: `Expected JSON key "${key}" not present` };
      }
    }
  }

  const agentCheck = checkAgentActivityCriteria(c, agentActivity);
  if (!agentCheck.pass) return agentCheck;

  return { pass: true };
}

/**
 * Call chat completions API.
 * @param {string} baseUrl - Base URL (e.g. http://localhost:3000)
 * @param {object} opts - { model, messages, systemPrompt?, apiKey?, fetchFn?, evalSet?, evalCase? }
 * @returns {{ content: string, error?: string, agentActivity?: object | null, responseHeaders?: Record<string, string> }}
 */
async function callChat(baseUrl, opts) {
  const { apiKey, fetchFn } = opts;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    ...(apiKey && { "x-api-key": apiKey }),
  };
  const requestBody = buildChatRequest(opts);
  const doFetch = fetchFn || fetch;
  try {
    const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
    const r = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!r.ok) {
      const err = await r.text();
      return {
        content: "",
        error: `HTTP ${r.status}: ${(err || "").slice(0, 200)}`,
        agentActivity: null,
        responseHeaders: {},
      };
    }
    const responseHeaders = {};
    if (r.headers && typeof r.headers.forEach === "function") {
      r.headers.forEach((value, key) => {
        responseHeaders[String(key).toLowerCase()] = value;
      });
    }
    const contentType = String(r.headers?.get?.("content-type") || "");
    const raw = await r.text();
    if (contentType.includes("text/event-stream") || raw.includes("data: ")) {
      const { content, agentActivity } = parseSseEvalResponse(raw);
      return { content, agentActivity, responseHeaders };
    }
    try {
      const data = JSON.parse(raw);
      const content = extractChatContent(data);
      return {
        content: typeof content === "string" ? content : String(content),
        agentActivity: null,
        responseHeaders,
      };
    } catch (_) {
      return { content: raw, agentActivity: null, responseHeaders };
    }
  } catch (e) {
    return { content: "", error: e.message, agentActivity: null, responseHeaders: {} };
  }
}

/**
 * Call task planning API.
 * @param {string} baseUrl - Base URL
 * @param {object} opts - { model, messages, apiKey?, fetchFn? }
 * @returns {{ content: string, parsed?: object, error?: string }}
 */
async function callTask(baseUrl, opts) {
  const { model, messages, apiKey, fetchFn } = opts;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    ...(apiKey && { "x-api-key": apiKey }),
  };
  const doFetch = fetchFn || fetch;
  try {
    const url = baseUrl.replace(/\/$/, "") + "/v1/tasks/plan";
    const r = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "llama3.2",
        messages: messages || [{ role: "user", content: "" }],
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      return { content: "", error: `HTTP ${r.status}: ${(text || "").slice(0, 200)}` };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {}
    const content = parsed?.raw ?? parsed?.plan ? JSON.stringify(parsed.plan) : text;
    return { content, parsed: parsed?.plan ?? parsed, error: null };
  } catch (e) {
    return { content: "", error: e.message };
  }
}

/**
 * Run an eval set.
 * @param {object} evalSet - { id, name, cases: [{ id, prompt, systemPrompt?, target?, expectedContains?, expectedPattern?, expectedJson? }] }
 * @param {object} opts - { model?, backend?, baseUrl, apiKey?, fetchFn? }
 * @returns {Promise<{ results: Array<{ caseId, pass, output, error?, reason?, skipped?, agentActivityHint? }>, passed, total, skipped, durationMs }>}
 */
export async function runEvalSet(evalSet, opts = {}) {
  const { model, baseUrl, apiKey, fetchFn, stagingTraceRoot: optsStagingRoot } = opts;
  const base = baseUrl || "http://localhost:3000";
  const start = Date.now();
  const cases = evalSet.cases || [];
  const results = [];

  for (const c of cases) {
    const target = c.target || "chat";

    if (c.skip === true) {
      results.push({
        caseId: c.id,
        pass: true,
        skipped: true,
        output: "",
        reason: c.skipReason ? String(c.skipReason) : "skipped",
      });
      continue;
    }

    if (target === "trace") {
      const trace = Array.isArray(c.trace) ? c.trace : [];
      const check = checkGoldenTrace(c, trace);
      results.push({
        caseId: c.id,
        pass: check.pass,
        output: JSON.stringify(trace).slice(0, 500),
        reason: check.reason,
      });
      continue;
    }

    if (target === "staging_trace") {
      const rel = c.stagingTraceFile || c.traceFile;
      if (!rel || !String(rel).trim()) {
        results.push({
          caseId: c.id,
          pass: false,
          output: "",
          reason: "staging_trace case requires stagingTraceFile (or traceFile) path",
        });
        continue;
      }
      const root =
        (optsStagingRoot && String(optsStagingRoot).trim()) ||
        (evalSet.stagingTraceRoot && String(evalSet.stagingTraceRoot).trim()) ||
        process.cwd();
      const abs = resolveStagingTracePath(root, rel);
      try {
        const record = await loadStagingTraceRecord(abs);
        const check = evaluateStagingTraceCase(c, record);
        results.push({
          caseId: c.id,
          pass: check.pass,
          output: JSON.stringify({ stagingTraceFile: abs }).slice(0, 500),
          reason: check.reason,
        });
      } catch (e) {
        results.push({
          caseId: c.id,
          pass: false,
          output: "",
          reason: `Failed to load staging trace: ${e?.message || String(e)}`,
        });
      }
      continue;
    }

    if (target === "judge") {
      const rubric = c.judgeRubric || c.rubric || "";
      if (!String(rubric).trim()) {
        results.push({
          caseId: c.id,
          pass: false,
          output: "",
          reason: "judge case requires judgeRubric (or rubric) string",
        });
        continue;
      }
      const messages = [{ role: "user", content: c.prompt || "" }];
      const resChat = await callChat(base, {
        model,
        messages,
        systemPrompt: c.systemPrompt,
        apiKey,
        fetchFn,
        evalSet,
        evalCase: c,
      });
      let pass = !resChat.error;
      let reason = resChat.error || undefined;
      if (pass) {
        const textCheck = checkCriteria(c, resChat.content, null, resChat.agentActivity ?? null);
        if (!textCheck.pass) {
          pass = false;
          reason = textCheck.reason;
        }
      }
      if (pass) {
        const j = await runEvalJudge(base, apiKey, model, resChat.content, rubric);
        pass = j.pass;
        reason = j.reason;
      }
      const hintJ = buildAgentActivityHint(resChat.agentActivity ?? null);
      results.push({
        caseId: c.id,
        pass,
        output: (resChat.content || "").slice(0, 500),
        error: resChat.error || undefined,
        reason: reason || undefined,
        ...(hintJ ? { agentActivityHint: hintJ } : {}),
      });
      continue;
    }

    const messages = [{ role: "user", content: c.prompt || "" }];
    let content;
    let parsed = null;
    let err;
    let agentActivityForCheck = null;

    if (target === "task") {
      const res = await callTask(base, { model, messages, apiKey, fetchFn });
      content = res.content;
      parsed = res.parsed;
      err = res.error;
    } else {
      const res = await callChat(base, {
        model,
        messages,
        systemPrompt: c.systemPrompt,
        apiKey,
        fetchFn,
        evalSet,
        evalCase: c,
      });
      content = res.content;
      err = res.error;
      agentActivityForCheck = res.agentActivity ?? null;
    }

    let pass = !err;
    let reason = err ? err : undefined;

    if (pass) {
      const check = checkCriteria(c, content, parsed, target === "chat" ? agentActivityForCheck : null);
      pass = check.pass;
      reason = check.reason;
    }

    const hint =
      target === "chat" ? buildAgentActivityHint(agentActivityForCheck) : undefined;
    results.push({
      caseId: c.id,
      pass,
      output: content?.slice(0, 500) ?? "",
      error: err || undefined,
      reason: reason || undefined,
      ...(hint ? { agentActivityHint: hint } : {}),
    });
  }

  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.pass && !r.skipped).length;
  return {
    results,
    passed,
    total: results.length,
    skipped,
    durationMs: Date.now() - start,
  };
}
