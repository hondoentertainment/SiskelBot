/**
 * Agent delegation unit tests.
 * Delegation to specialists, specialist listing, depth limits.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  delegateToSpecialist,
  getAvailableSpecialists,
} from "../lib/agent-delegation.js";

// --- Specialist listing ---

test("getAvailableSpecialists returns list of specialists", () => {
  const specialists = getAvailableSpecialists();
  assert.ok(Array.isArray(specialists));
  assert.ok(specialists.length >= 3);

  const names = specialists.map((s) => s.name);
  assert.ok(names.includes("researcher"));
  assert.ok(names.includes("executor"));
  assert.ok(names.includes("synthesizer"));
});

test("getAvailableSpecialists returns name, description, and tools", () => {
  const specialists = getAvailableSpecialists();
  for (const s of specialists) {
    assert.ok(typeof s.name === "string");
    assert.ok(typeof s.description === "string");
    assert.ok(Array.isArray(s.tools));
  }
});

// --- Delegation tests (dry-run, no backend) ---

test("delegateToSpecialist returns dry-run response when no backend", async () => {
  const result = await delegateToSpecialist(
    "parent-run-1",
    "researcher",
    "Find documents about Node.js"
  );

  assert.ok(result.runId);
  assert.ok(result.response.includes("dry-run"));
  assert.ok(result.response.includes("researcher"));
  assert.equal(result.specialist, "researcher");
  assert.equal(typeof result.duration, "number");
  assert.ok(Array.isArray(result.toolCalls));
});

test("delegateToSpecialist handles unknown specialist", async () => {
  const result = await delegateToSpecialist(
    "parent-run-2",
    "unknown-specialist",
    "Do something"
  );

  assert.ok(result.runId);
  assert.ok(result.response.includes("Unknown specialist"));
  assert.ok(result.response.includes("unknown-specialist"));
  assert.equal(result.specialist, "unknown-specialist");
});

test("delegateToSpecialist enforces max delegation depth", async () => {
  const result = await delegateToSpecialist(
    "parent-run-3",
    "researcher",
    "Deep delegation",
    { depth: 10 }
  );

  assert.ok(result.response.includes("delegation-limit"));
  assert.equal(result.toolCalls.length, 0);
});

test("delegateToSpecialist with depth 0 allows delegation", async () => {
  const result = await delegateToSpecialist(
    "parent-run-4",
    "synthesizer",
    "Summarize findings",
    { depth: 0 }
  );

  assert.ok(result.runId);
  assert.ok(result.response.includes("dry-run") || result.response.length > 0);
  assert.equal(result.specialist, "synthesizer");
});

// --- Delegation with mock backend ---

test("delegateToSpecialist with mock backend gets model response", async () => {
  const mockFetch = async (_url, _opts) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Research complete: found 5 relevant documents." } }],
    }),
  });

  const mockConfig = (_model) => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: { "Content-Type": "application/json" },
  });

  const result = await delegateToSpecialist(
    "parent-run-5",
    "researcher",
    "Find info about testing",
    {
      backendFetch: mockFetch,
      buildProxyConfig: mockConfig,
      model: "test-model",
    }
  );

  assert.equal(result.response, "Research complete: found 5 relevant documents.");
  assert.equal(result.specialist, "researcher");
  assert.ok(result.duration >= 0);
});

test("delegateToSpecialist handles backend error", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  });

  const mockConfig = () => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await delegateToSpecialist(
    "parent-run-6",
    "executor",
    "Run something",
    {
      backendFetch: mockFetch,
      buildProxyConfig: mockConfig,
    }
  );

  assert.ok(result.response.includes("backend-error"));
});

test("delegateToSpecialist with tool calls", async () => {
  let callCount = 0;
  const mockFetch = async (_url, opts) => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "tc-1",
                function: {
                  name: "search_context",
                  arguments: JSON.stringify({ query: "testing" }),
                },
              }],
            },
          }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Found results from search." } }],
      }),
    };
  };

  const mockConfig = () => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await delegateToSpecialist(
    "parent-run-7",
    "researcher",
    "Search for testing patterns",
    {
      backendFetch: mockFetch,
      buildProxyConfig: mockConfig,
    }
  );

  assert.equal(result.response, "Found results from search.");
  assert.ok(result.toolCalls.length >= 1);
  assert.equal(result.toolCalls[0].name, "search_context");
});

test("delegateToSpecialist handles fetch exceptions", async () => {
  const mockFetch = async () => {
    throw new Error("Network failure");
  };

  const mockConfig = () => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await delegateToSpecialist(
    "parent-run-8",
    "synthesizer",
    "Combine results",
    {
      backendFetch: mockFetch,
      buildProxyConfig: mockConfig,
    }
  );

  assert.ok(result.response.includes("delegation-error"));
  assert.ok(result.response.includes("Network failure"));
});
