/**
 * Unit tests for lib/benchmark-real-agent.js.
 *
 * Uses a mocked fetch implementation — never hits the network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRealAgent,
  extractCode,
  composeBenchmarkPrompt,
} from "../lib/benchmark-real-agent.js";

/* ─── helpers ───────────────────────────────────────────────────────────── */

function jsonResponse(data, { status = 200, statusText = "OK" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

function textResponse(text, { status = 500, statusText = "Internal Server Error" } = {}) {
  return {
    ok: false,
    status,
    statusText,
    async json() { throw new Error("not json"); },
    async text() { return text; },
  };
}

function makeFetchSpy(responder) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    return await responder(url, init);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

/* ─── extractCode ───────────────────────────────────────────────────────── */

test("extractCode handles ```javascript fence", () => {
  const raw = "Sure! Here you go:\n\n```javascript\nexport function f() { return 1; }\n```\nEnjoy.";
  assert.equal(extractCode(raw), "export function f() { return 1; }");
});

test("extractCode handles ```js alias", () => {
  const raw = "```js\nexport const x = 42;\n```";
  assert.equal(extractCode(raw), "export const x = 42;");
});

test("extractCode handles bare ``` fence (no language tag)", () => {
  const raw = "```\nexport function bare() { return 7; }\n```";
  assert.equal(extractCode(raw), "export function bare() { return 7; }");
});

test("extractCode falls back to raw when no fence but looks like code", () => {
  const raw = "export function naked() { return 42; }";
  assert.equal(extractCode(raw), raw);
});

test("extractCode throws when response is empty", () => {
  assert.throws(() => extractCode(""), /no code block/);
  assert.throws(() => extractCode("   "), /no code block/);
});

test("extractCode throws when response has no code and no code-like keywords", () => {
  assert.throws(
    () => extractCode("I cannot help with that."),
    /no code block/
  );
});

test("extractCode picks the longest JS-fenced block when multiple are present", () => {
  const raw = "```js\nfoo\n```\n```javascript\nexport function bigger() { return 99; }\n```";
  assert.match(extractCode(raw), /bigger/);
});

/* ─── composeBenchmarkPrompt ────────────────────────────────────────────── */

test("composeBenchmarkPrompt includes the task prompt and directive", () => {
  const { system, user } = composeBenchmarkPrompt({
    prompt: "Write a function `sumEvens(arr)`.",
  });
  assert.match(system, /code generation assistant/i);
  assert.match(user, /sumEvens/);
  assert.match(user, /JavaScript code block/i);
});

test("composeBenchmarkPrompt includes starter code when provided", () => {
  const { user } = composeBenchmarkPrompt({
    prompt: "Implement foo",
    starterCode: "export function foo() { /* TODO */ }",
  });
  assert.match(user, /Starter code/);
  assert.match(user, /TODO/);
});

test("composeBenchmarkPrompt throws on invalid task", () => {
  assert.throws(() => composeBenchmarkPrompt(null), /task\.prompt required/);
  assert.throws(() => composeBenchmarkPrompt({}), /task\.prompt required/);
});

/* ─── OpenAI backend ────────────────────────────────────────────────────── */

test("buildRealAgent(openai) sends correct headers and body, parses response", async () => {
  const fetchImpl = makeFetchSpy(() =>
    jsonResponse({ choices: [{ message: { content: "```javascript\nexport function f(){return 1}\n```" } }] })
  );
  const agent = buildRealAgent({
    backend: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-TEST-KEY-DO-NOT-LEAK",
    fetchImpl,
  });
  const code = await agent("Write function f");
  assert.equal(code, "export function f(){return 1}");

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/v1\/chat\/completions$/);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["authorization"], "Bearer sk-TEST-KEY-DO-NOT-LEAK");
  assert.equal(call.init.headers["content-type"], "application/json");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.stream, false);
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].role, "user");
  assert.ok(typeof body.max_tokens === "number");
});

test("buildRealAgent(openai) throws on non-200", async () => {
  const fetchImpl = makeFetchSpy(() => textResponse("boom", { status: 500 }));
  const agent = buildRealAgent({
    backend: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-x",
    fetchImpl,
  });
  await assert.rejects(() => agent("prompt"), /HTTP 500/);
});

test("buildRealAgent(openai) throws on unexpected shape", async () => {
  const fetchImpl = makeFetchSpy(() => jsonResponse({ unexpected: true }));
  const agent = buildRealAgent({
    backend: "openai",
    model: "m",
    apiKey: "k",
    fetchImpl,
  });
  await assert.rejects(() => agent("prompt"), /unexpected openai response shape/);
});

test("buildRealAgent(openai) honors timeout via AbortController", async () => {
  const fetchImpl = async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }
    });
  };
  const agent = buildRealAgent({
    backend: "openai",
    model: "m",
    apiKey: "k",
    timeoutMs: 10,
    fetchImpl,
  });
  await assert.rejects(() => agent("prompt"), /timed out after 10ms/);
});

/* ─── Anthropic backend ─────────────────────────────────────────────────── */

test("buildRealAgent(anthropic) sends x-api-key + anthropic-version, parses content[]", async () => {
  const fetchImpl = makeFetchSpy(() =>
    jsonResponse({
      content: [
        { type: "text", text: "```javascript\nexport function g(){return 2}\n```" },
      ],
    })
  );
  const agent = buildRealAgent({
    backend: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "sk-ant-TEST",
    fetchImpl,
  });
  const code = await agent("Write g");
  assert.equal(code, "export function g(){return 2}");

  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/v1\/messages$/);
  assert.equal(call.init.headers["x-api-key"], "sk-ant-TEST");
  assert.equal(call.init.headers["anthropic-version"], "2023-06-01");
  assert.ok(!call.init.headers["authorization"], "anthropic must not send bearer auth header");

  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.ok(typeof body.max_tokens === "number");
  assert.equal(typeof body.system, "string");
  // Anthropic messages should NOT include a system-role entry (system is top-level).
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

test("buildRealAgent(anthropic) throws on non-200", async () => {
  const fetchImpl = makeFetchSpy(() => textResponse("rate limited", { status: 429 }));
  const agent = buildRealAgent({
    backend: "anthropic",
    model: "m",
    apiKey: "k",
    fetchImpl,
  });
  await assert.rejects(() => agent("p"), /HTTP 429/);
});

test("buildRealAgent(anthropic) throws on unexpected shape", async () => {
  const fetchImpl = makeFetchSpy(() => jsonResponse({ choices: [{}] }));
  const agent = buildRealAgent({
    backend: "anthropic",
    model: "m",
    apiKey: "k",
    fetchImpl,
  });
  await assert.rejects(() => agent("p"), /unexpected anthropic response shape/);
});

/* ─── Ollama backend ────────────────────────────────────────────────────── */

test("buildRealAgent(ollama) hits /api/chat and parses message.content", async () => {
  const fetchImpl = makeFetchSpy(() =>
    jsonResponse({ message: { content: "```js\nexport function h(){return 3}\n```" } })
  );
  const agent = buildRealAgent({
    backend: "ollama",
    model: "llama3:8b",
    fetchImpl,
  });
  const code = await agent("Write h");
  assert.equal(code, "export function h(){return 3}");

  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/api\/chat$/);
  assert.ok(!call.init.headers["authorization"], "ollama does not need bearer auth");
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, "llama3:8b");
  assert.equal(body.stream, false);
  assert.ok(body.options && typeof body.options.temperature === "number");
});

test("buildRealAgent(ollama) throws on unexpected shape", async () => {
  const fetchImpl = makeFetchSpy(() => jsonResponse({ no_message: true }));
  const agent = buildRealAgent({
    backend: "ollama",
    model: "llama3",
    fetchImpl,
  });
  await assert.rejects(() => agent("p"), /unexpected ollama response shape/);
});

/* ─── vLLM backend ──────────────────────────────────────────────────────── */

test("buildRealAgent(vllm) uses OpenAI-compatible /v1/chat/completions", async () => {
  const fetchImpl = makeFetchSpy(() =>
    jsonResponse({ choices: [{ message: { content: "```javascript\nexport function v(){return 4}\n```" } }] })
  );
  const agent = buildRealAgent({
    backend: "vllm",
    model: "meta-llama/Llama-3-8B",
    baseUrl: "http://custom-vllm:9000",
    apiKey: "vllm-key",
    fetchImpl,
  });
  const code = await agent("Write v");
  assert.equal(code, "export function v(){return 4}");

  const call = fetchImpl.calls[0];
  assert.equal(call.url, "http://custom-vllm:9000/v1/chat/completions");
  assert.equal(call.init.headers["authorization"], "Bearer vllm-key");
});

/* ─── siskelbot-proxy backend ───────────────────────────────────────────── */

test("buildRealAgent(siskelbot-proxy) uses OpenAI-compatible shape", async () => {
  const fetchImpl = makeFetchSpy(() =>
    jsonResponse({ choices: [{ message: { content: "```javascript\nexport function p(){return 5}\n```" } }] })
  );
  const agent = buildRealAgent({
    backend: "siskelbot-proxy",
    model: "gpt-4o",
    baseUrl: "http://localhost:3000",
    apiKey: "proxy-key",
    fetchImpl,
  });
  const code = await agent("Write p");
  assert.equal(code, "export function p(){return 5}");

  const call = fetchImpl.calls[0];
  assert.equal(call.url, "http://localhost:3000/v1/chat/completions");
  assert.equal(call.init.headers["authorization"], "Bearer proxy-key");
});

/* ─── API key is never logged ──────────────────────────────────────────── */

test("buildRealAgent never logs the API key to stdout/stderr", async () => {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const logged = [];
  console.log = (...a) => logged.push(a.join(" "));
  console.error = (...a) => logged.push(a.join(" "));
  console.warn = (...a) => logged.push(a.join(" "));

  const SECRET = "sk-SUPER-SECRET-DO-NOT-LEAK-42";
  try {
    const fetchImpl = makeFetchSpy(() =>
      jsonResponse({ choices: [{ message: { content: "```js\nexport function k(){return 1}\n```" } }] })
    );
    const agent = buildRealAgent({
      backend: "openai",
      model: "m",
      apiKey: SECRET,
      fetchImpl,
    });
    await agent("do thing");

    // Also trigger the error path to ensure errors don't include the key.
    const failFetch = makeFetchSpy(() => textResponse("server says no", { status: 500 }));
    const agent2 = buildRealAgent({
      backend: "openai",
      model: "m",
      apiKey: SECRET,
      fetchImpl: failFetch,
    });
    try { await agent2("x"); } catch (e) { logged.push(String(e.message)); }
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }

  for (const line of logged) {
    assert.ok(!line.includes(SECRET), `leaked API key in log line: ${line}`);
  }
});

/* ─── Config validation ────────────────────────────────────────────────── */

test("buildRealAgent rejects missing backend/model", () => {
  assert.throws(() => buildRealAgent({}), /backend required/);
  assert.throws(() => buildRealAgent({ backend: "openai" }), /model required/);
  assert.throws(() => buildRealAgent({ backend: "unknown", model: "m", fetchImpl: () => {} }), /unsupported backend/);
});
