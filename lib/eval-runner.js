/**
 * Phase 32: Evaluation harness for SiskelBot.
 * Runs eval sets against chat/task APIs and checks criteria.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { checkGoldenTrace } from "./eval-golden-trace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Check criteria against output.
 * @param {object} c - Case with expectedContains?, expectedPattern?, expectedJson?
 * @param {string} output - Raw output text
 * @param {object} parsed - Parsed object (for task API; used with expectedJson)
 * @returns {{ pass: boolean, reason?: string }}
 */
export function checkCriteria(c, output, parsed = null) {
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
  return { pass: true };
}

/**
 * Call chat completions API.
 * @param {string} baseUrl - Base URL (e.g. http://localhost:3000)
 * @param {object} opts - { model, messages, systemPrompt?, apiKey? }
 * @returns {{ content: string, error?: string }}
 */
async function callChat(baseUrl, opts) {
  const { model, messages, systemPrompt, apiKey } = opts;
  const msgs = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    ...(apiKey && { "x-api-key": apiKey }),
  };
  try {
    const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || "llama3.2",
        messages: msgs,
        stream: false,
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      return { content: "", error: `HTTP ${r.status}: ${(err || "").slice(0, 200)}` };
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.message?.content ?? "";
    return { content: typeof content === "string" ? content : String(content) };
  } catch (e) {
    return { content: "", error: e.message };
  }
}

/**
 * Call task planning API.
 * @param {string} baseUrl - Base URL
 * @param {object} opts - { model, messages, apiKey? }
 * @returns {{ content: string, parsed?: object, error?: string }}
 */
async function callTask(baseUrl, opts) {
  const { model, messages, apiKey } = opts;
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    ...(apiKey && { "x-api-key": apiKey }),
  };
  try {
    const url = baseUrl.replace(/\/$/, "") + "/v1/tasks/plan";
    const r = await fetch(url, {
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
 * @returns {Promise<{ results: Array<{ caseId, pass, output, error?, reason? }>, passed, total, durationMs }>}
 */
export async function runEvalSet(evalSet, opts = {}) {
  const { model, backend, baseUrl, apiKey, fetchFn } = opts;
  const base = baseUrl || "http://localhost:3000";
  const start = Date.now();
  const cases = evalSet.cases || [];
  const results = [];

  for (const c of cases) {
    const target = c.target || "chat";

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

    const messages = [{ role: "user", content: c.prompt || "" }];
    let content = "";
    let parsed = null;
    let err = null;

    if (target === "task") {
      const res = await callTask(base, { model, messages, apiKey });
      content = res.content;
      parsed = res.parsed;
      err = res.error;
    } else {
      const res = await callChat(base, {
        model,
        messages,
        systemPrompt: c.systemPrompt,
        apiKey,
      });
      content = res.content;
      err = res.error;
    }

    let pass = !err;
    let reason = err ? err : undefined;

    if (pass) {
      const check = checkCriteria(c, content, parsed);
      pass = check.pass;
      reason = check.reason;
    }

    results.push({
      caseId: c.id,
      pass,
      output: content?.slice(0, 500) ?? "",
      error: err || undefined,
      reason: reason || undefined,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    passed,
    total: results.length,
    durationMs: Date.now() - start,
  };
}
