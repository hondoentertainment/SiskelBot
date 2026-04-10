import test from "node:test";
import assert from "node:assert/strict";
import {
  REFLECTION_PROMPT,
  shouldReflect,
  reflectOnResponse,
  reviseResponse,
  _internals,
} from "../lib/agent-reflection.js";

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  })();
}

function makeFetch(responses) {
  // responses is either a single object or an array of sequential responses.
  let i = 0;
  const list = Array.isArray(responses) ? responses : [responses];
  return async () => {
    const spec = list[Math.min(i, list.length - 1)];
    i++;
    if (typeof spec === "function") return spec();
    if (spec instanceof Error) throw spec;
    return {
      ok: spec.ok !== false,
      status: spec.status ?? 200,
      json: async () => spec.body ?? {},
    };
  };
}

function makeChoice(content) {
  return { choices: [{ message: { content } }] };
}

test("REFLECTION_PROMPT exists and mentions JSON verdict", () => {
  assert.ok(typeof REFLECTION_PROMPT === "string" && REFLECTION_PROMPT.length > 10);
  assert.match(REFLECTION_PROMPT, /JSON/);
  assert.match(REFLECTION_PROMPT, /needsRevision/);
});

test("shouldReflect returns false when AGENT_REFLECTION is not set", () => {
  const prev = process.env.AGENT_REFLECTION;
  delete process.env.AGENT_REFLECTION;
  try {
    assert.equal(shouldReflect([], { agentMode: true, response: "a".repeat(500) }), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_REFLECTION = prev;
  }
});

test("shouldReflect returns true in agent mode with non-empty response", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    assert.equal(shouldReflect([], { agentMode: true, response: "Hello world" }), true);
  });
});

test("shouldReflect returns false in agent mode with empty response", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    assert.equal(shouldReflect([], { agentMode: true, response: "" }), false);
    assert.equal(shouldReflect([], { agentMode: true, response: "   " }), false);
  });
});

test("shouldReflect returns false for short responses outside agent mode", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    assert.equal(shouldReflect([{ role: "user", content: "hi" }], { response: "short" }), false);
  });
});

test("shouldReflect returns true on uncertainty markers", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    const messages = [{ role: "user", content: "Is node 22 LTS?" }];
    const response = "I'm not sure, but node 22 might be LTS now.";
    assert.equal(shouldReflect(messages, { response }), true);
  });
});

test("shouldReflect returns true for long responses with user context", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    const messages = [{ role: "user", content: "Tell me about databases." }];
    const response = "A".repeat(500);
    assert.equal(shouldReflect(messages, { response }), true);
  });
});

test("shouldReflect respects custom minResponseLen", async () => {
  await withEnv("AGENT_REFLECTION", "1", () => {
    const messages = [{ role: "user", content: "q" }];
    assert.equal(
      shouldReflect(messages, { response: "1234567890", minResponseLen: 5 }),
      true
    );
    assert.equal(
      shouldReflect(messages, { response: "1234", minResponseLen: 5 }),
      false
    );
  });
});

test("reflectOnResponse returns parsed verdict from a valid JSON response", async () => {
  await withEnv("AGENT_REFLECTION", "1", async () => {
    const fetchMock = makeFetch({
      body: makeChoice(
        JSON.stringify({
          needsRevision: true,
          issues: ["missing units", "unclear next step"],
          suggestedFix: "Add units to the numbers.",
        })
      ),
    });
    const out = await reflectOnResponse(
      "The answer is 42.",
      { messages: [{ role: "user", content: "What is the meaning?" }] },
      fetchMock,
      { baseUrl: "http://localhost:1234", path: "/v1/chat/completions", headers: {} },
      "test-model"
    );
    assert.equal(out.needsRevision, true);
    assert.deepEqual(out.issues, ["missing units", "unclear next step"]);
    assert.equal(out.suggestedFix, "Add units to the numbers.");
    assert.equal(typeof out.reflectionDurationMs, "number");
    assert.ok(out.reflectionDurationMs >= 0);
    assert.equal(out.error, undefined);
  });
});

test("reflectOnResponse tolerates fenced JSON code blocks", async () => {
  const fetchMock = makeFetch({
    body: makeChoice(
      "```json\n" +
        JSON.stringify({ needsRevision: false, issues: [], suggestedFix: "" }) +
        "\n```"
    ),
  });
  const out = await reflectOnResponse(
    "hello",
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.needsRevision, false);
  assert.deepEqual(out.issues, []);
  assert.equal(out.error, undefined);
});

test("reflectOnResponse handles JSON parse errors gracefully", async () => {
  const fetchMock = makeFetch({ body: makeChoice("not json at all :(") });
  const out = await reflectOnResponse(
    "hello",
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.needsRevision, false);
  assert.deepEqual(out.issues, []);
  assert.ok(typeof out.error === "string" && out.error.length > 0);
});

test("reflectOnResponse handles backend error status gracefully", async () => {
  const fetchMock = makeFetch({ ok: false, status: 500, body: {} });
  const out = await reflectOnResponse(
    "hello",
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.needsRevision, false);
  assert.ok(out.error);
});

test("reflectOnResponse handles thrown errors gracefully", async () => {
  const fetchMock = makeFetch(new Error("network down"));
  const out = await reflectOnResponse(
    "hello",
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.needsRevision, false);
  assert.match(out.error || "", /network down/);
});

test("reflectOnResponse honours a short timeout without hanging", async () => {
  const prev = process.env.AGENT_REFLECTION_TIMEOUT_MS;
  process.env.AGENT_REFLECTION_TIMEOUT_MS = "10";
  try {
    const slowFetch = (_url, opts) =>
      new Promise((_, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
      });
    const out = await reflectOnResponse(
      "hello",
      { messages: [] },
      slowFetch,
      { baseUrl: "http://x", path: "/p", headers: {} },
      "m"
    );
    assert.equal(out.needsRevision, false);
    assert.ok(out.error);
  } finally {
    if (prev === undefined) delete process.env.AGENT_REFLECTION_TIMEOUT_MS;
    else process.env.AGENT_REFLECTION_TIMEOUT_MS = prev;
  }
});

test("reviseResponse returns revised text from the backend", async () => {
  const fetchMock = makeFetch({ body: makeChoice("The answer is 42 meters.") });
  const out = await reviseResponse(
    "The answer is 42.",
    {
      needsRevision: true,
      issues: ["missing units"],
      suggestedFix: "Add units.",
    },
    { messages: [{ role: "user", content: "distance?" }] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.revised, "The answer is 42 meters.");
  assert.ok(typeof out.improvementSummary === "string");
  assert.equal(out.error, undefined);
});

test("reviseResponse falls back to original on empty revision", async () => {
  const fetchMock = makeFetch({ body: makeChoice("   ") });
  const out = await reviseResponse(
    "The answer is 42.",
    { needsRevision: true, issues: [], suggestedFix: "" },
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.revised, "The answer is 42.");
  assert.equal(out.error, "empty revision");
});

test("reviseResponse falls back to original on backend failure", async () => {
  const fetchMock = makeFetch(new Error("boom"));
  const out = await reviseResponse(
    "original",
    { needsRevision: true, issues: ["x"], suggestedFix: "y" },
    { messages: [] },
    fetchMock,
    { baseUrl: "http://x", path: "/p", headers: {} },
    "m"
  );
  assert.equal(out.revised, "original");
  assert.match(out.error || "", /boom/);
});

test("internal parseReflectionJson extracts JSON from surrounding text", () => {
  const { parseReflectionJson } = _internals;
  const parsed = parseReflectionJson(
    'Here is the verdict: {"needsRevision": false, "issues": [], "suggestedFix": ""} done.'
  );
  assert.equal(parsed.needsRevision, false);
});

test("internal normalizeVerdict coerces odd shapes", () => {
  const { normalizeVerdict } = _internals;
  const v = normalizeVerdict({ needsRevision: "yes", issues: [1, 2], suggestedFix: 42 });
  assert.equal(v.needsRevision, false); // only strict true is accepted
  assert.deepEqual(v.issues, ["1", "2"]);
  assert.equal(v.suggestedFix, "");
});
