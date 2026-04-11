/**
 * Tests for lib/fine-tuning.js and lib/fine-tune-providers/openai-ft.js.
 *
 * Covers:
 *   - format conversions (OpenAI/Alpaca/ShareGPT)
 *   - validation (bad JSONL, token over-limits, empty input, unknown shape)
 *   - export with filters (minRating, date range, maxExamples)
 *   - fine-tune job CRUD with mocked OpenAI fetch
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";

import {
  exportConversationsForFineTuning,
  convertToOpenAIFormat,
  convertToAlpacaFormat,
  convertToShareGPTFormat,
  validateTrainingData,
  createFineTuneJob,
  listFineTuneJobs,
  getFineTuneJob,
  cancelFineTuneJob,
  getFineTuneEvents,
  __resetJobsForTests,
  estimateTokens,
} from "../lib/fine-tuning.js";

import * as storage from "../lib/storage.js";
import { recordFeedback } from "../lib/feedback.js";

const TEST_WS = "test-ft-ws-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

// ─── format conversions ────────────────────────────────────────────────────

test("convertToOpenAIFormat wraps messages in a { messages } object", () => {
  const msgs = [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello!" },
  ];
  const out = convertToOpenAIFormat(msgs);
  assert.ok(Array.isArray(out.messages));
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[0], { role: "system", content: "you are helpful" });
});

test("convertToOpenAIFormat drops messages with disallowed roles", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "other", content: "nope" },
    { role: "assistant", content: "hey" },
  ];
  const out = convertToOpenAIFormat(msgs);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[1].role, "assistant");
});

test("convertToOpenAIFormat returns empty object for non-arrays", () => {
  const out = convertToOpenAIFormat(null);
  assert.deepEqual(out, { messages: [] });
});

test("convertToAlpacaFormat picks first user as instruction and first assistant as output", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "what is node?" },
    { role: "assistant", content: "a runtime" },
    { role: "user", content: "more?" },
    { role: "assistant", content: "ignored" },
  ];
  const out = convertToAlpacaFormat(msgs);
  assert.equal(out.instruction, "what is node?");
  assert.equal(out.input, "sys");
  assert.equal(out.output, "a runtime");
});

test("convertToAlpacaFormat returns empty strings when no messages", () => {
  const out = convertToAlpacaFormat([]);
  assert.deepEqual(out, { instruction: "", input: "", output: "" });
});

test("convertToShareGPTFormat maps roles to ShareGPT naming", () => {
  const msgs = [
    { role: "system", content: "sys" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
  ];
  const out = convertToShareGPTFormat(msgs);
  assert.equal(out.conversations.length, 3);
  assert.equal(out.conversations[0].from, "system");
  assert.equal(out.conversations[1].from, "human");
  assert.equal(out.conversations[2].from, "gpt");
});

test("convertToShareGPTFormat returns empty conversations for non-arrays", () => {
  const out = convertToShareGPTFormat(undefined);
  assert.deepEqual(out, { conversations: [] });
});

// ─── validation ────────────────────────────────────────────────────────────

test("validateTrainingData returns invalid on empty input", () => {
  const result = validateTrainingData("");
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validateTrainingData catches invalid JSON", () => {
  const result = validateTrainingData("not json\n{}");
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("invalid JSON")));
});

test("validateTrainingData requires at least 2 messages", () => {
  const jsonl = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("at least 2 entries")));
});

test("validateTrainingData requires at least one assistant message", () => {
  const jsonl = JSON.stringify({
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ],
  });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("assistant message is required")));
});

test("validateTrainingData accepts well-formed OpenAI records", () => {
  const lines = [
    JSON.stringify({ messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }] }),
    JSON.stringify({ messages: [{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }] }),
  ];
  const result = validateTrainingData(lines.join("\n"));
  assert.equal(result.valid, true);
  assert.equal(result.stats.exampleCount, 2);
  assert.ok(result.stats.totalTokens > 0);
});

test("validateTrainingData flags over-token examples as errors", () => {
  const bigContent = "x".repeat(200_000); // ~50k tokens
  const jsonl = JSON.stringify({
    messages: [
      { role: "user", content: bigContent },
      { role: "assistant", content: "ok" },
    ],
  });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("exceeds")));
});

test("validateTrainingData rejects invalid role", () => {
  const jsonl = JSON.stringify({
    messages: [
      { role: "wizard", content: "q" },
      { role: "assistant", content: "a" },
    ],
  });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("invalid role")));
});

test("validateTrainingData accepts Alpaca format", () => {
  const jsonl = JSON.stringify({ instruction: "summarize", input: "text", output: "summary" });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, true);
  assert.equal(result.stats.exampleCount, 1);
});

test("validateTrainingData rejects Alpaca records with empty output", () => {
  const jsonl = JSON.stringify({ instruction: "do it", input: "", output: "" });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
});

test("validateTrainingData accepts ShareGPT format", () => {
  const jsonl = JSON.stringify({
    conversations: [
      { from: "human", value: "hi" },
      { from: "gpt", value: "hello" },
    ],
  });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, true);
});

test("validateTrainingData rejects unknown record shapes", () => {
  const jsonl = JSON.stringify({ foo: "bar" });
  const result = validateTrainingData(jsonl);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("unknown record shape")));
});

test("estimateTokens returns roughly chars / 4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(16)), 4);
});

// ─── export with filters ───────────────────────────────────────────────────

async function seedConversation(ws, overrides = {}) {
  const id = overrides.id || randomUUID();
  const item = {
    id,
    title: overrides.title || "test conv",
    messages: overrides.messages || [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
    createdAt: overrides.createdAt || new Date().toISOString(),
    meta: {},
  };
  await storage.mergeItems("conversations", ws, [item]);
  return item;
}

test("exportConversationsForFineTuning exports positive-rated conversations only when minRating is set", async () => {
  const ws = TEST_WS + "-export-rating";

  const goodId = (await seedConversation(ws, { title: "good" })).id;
  const badId = (await seedConversation(ws, { title: "bad" })).id;

  // Record feedback: good gets rating 5, bad gets rating 2
  await recordFeedback(goodId, 0, 5, null, "u1", { workspaceId: ws });
  await recordFeedback(badId, 0, 2, null, "u1", { workspaceId: ws });

  const all = await exportConversationsForFineTuning(ws, { format: "openai" });
  assert.equal(all.exampleCount, 2);

  const positive = await exportConversationsForFineTuning(ws, { format: "openai", minRating: 4 });
  assert.equal(positive.exampleCount, 1);
  assert.ok(positive.jsonl.includes("hello"));
  assert.ok(!positive.jsonl.includes("bad"));
});

test("exportConversationsForFineTuning respects date range filters", async () => {
  const ws = TEST_WS + "-export-date";

  await seedConversation(ws, { title: "old", createdAt: "2020-01-01T00:00:00Z" });
  await seedConversation(ws, { title: "recent", createdAt: "2030-01-01T00:00:00Z" });

  const recent = await exportConversationsForFineTuning(ws, {
    format: "openai",
    dateFrom: "2025-01-01T00:00:00Z",
  });
  assert.equal(recent.exampleCount, 1);

  const old = await exportConversationsForFineTuning(ws, {
    format: "openai",
    dateTo: "2021-01-01T00:00:00Z",
  });
  assert.equal(old.exampleCount, 1);
});

test("exportConversationsForFineTuning respects maxExamples", async () => {
  const ws = TEST_WS + "-export-max";
  for (let i = 0; i < 5; i++) {
    await seedConversation(ws, { title: `c${i}` });
  }
  const out = await exportConversationsForFineTuning(ws, { format: "openai", maxExamples: 2 });
  assert.equal(out.exampleCount, 2);
});

test("exportConversationsForFineTuning supports alpaca and sharegpt formats", async () => {
  const ws = TEST_WS + "-export-formats";
  await seedConversation(ws, {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ],
  });

  const alpaca = await exportConversationsForFineTuning(ws, { format: "alpaca" });
  const alpacaRec = JSON.parse(alpaca.jsonl);
  assert.equal(alpacaRec.instruction, "q");
  assert.equal(alpacaRec.output, "a");

  const sharegpt = await exportConversationsForFineTuning(ws, { format: "sharegpt" });
  const sharegptRec = JSON.parse(sharegpt.jsonl);
  assert.equal(sharegptRec.conversations[1].from, "human");
  assert.equal(sharegptRec.conversations[2].from, "gpt");
});

test("exportConversationsForFineTuning rejects unsupported formats", async () => {
  await assert.rejects(
    () => exportConversationsForFineTuning(TEST_WS, { format: "unknown" }),
    /unsupported format/,
  );
});

test("exportConversationsForFineTuning skips conversations without user+assistant turns", async () => {
  const ws = TEST_WS + "-export-filter";
  await seedConversation(ws, {
    messages: [{ role: "user", content: "only user" }],
  });
  const out = await exportConversationsForFineTuning(ws, { format: "openai" });
  assert.equal(out.exampleCount, 0);
});

// ─── fine-tune job CRUD (mocked OpenAI) ───────────────────────────────────

function mockOpenAIFetch() {
  const calls = [];
  const original = globalThis.fetch;
  let fileSeq = 0;
  let jobSeq = 0;
  const jobs = new Map();

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || "GET").toUpperCase() });
    const u = String(url);

    if (u.endsWith("/files") && init.method === "POST") {
      fileSeq += 1;
      return new Response(JSON.stringify({ id: `file-${fileSeq}` }), { status: 200 });
    }
    if (u.endsWith("/fine_tuning/jobs") && init.method === "POST") {
      jobSeq += 1;
      const id = `ftjob-${jobSeq}`;
      const job = { id, status: "queued", fine_tuned_model: null };
      jobs.set(id, job);
      return new Response(JSON.stringify(job), { status: 200 });
    }
    const getMatch = u.match(/\/fine_tuning\/jobs\/([^/?]+)$/);
    if (getMatch && (!init.method || init.method === "GET")) {
      const job = jobs.get(getMatch[1]) || { id: getMatch[1], status: "running" };
      return new Response(JSON.stringify(job), { status: 200 });
    }
    const cancelMatch = u.match(/\/fine_tuning\/jobs\/([^/?]+)\/cancel$/);
    if (cancelMatch && init.method === "POST") {
      const job = jobs.get(cancelMatch[1]);
      if (job) job.status = "cancelled";
      return new Response(JSON.stringify({ id: cancelMatch[1], status: "cancelled" }), { status: 200 });
    }
    const eventsMatch = u.match(/\/fine_tuning\/jobs\/([^/?]+)\/events/);
    if (eventsMatch) {
      return new Response(
        JSON.stringify({ data: [{ id: "evt-1", message: "started", level: "info" }] }),
        { status: 200 },
      );
    }
    if (u.match(/\/fine_tuning\/jobs(?:\?|$)/)) {
      return new Response(JSON.stringify({ data: Array.from(jobs.values()) }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("createFineTuneJob (openai) uploads file and creates job with mocked API", async () => {
  const ws = TEST_WS + "-jobs";
  await __resetJobsForTests(ws);
  const mock = mockOpenAIFetch();
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const result = await createFineTuneJob(ws, {
      provider: "openai",
      model: "gpt-4o-mini",
      trainingFile: JSON.stringify({
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }],
      }),
      suffix: "myproj",
    });
    assert.ok(result.jobId);
    assert.equal(result.provider, "openai");
    assert.equal(result.status, "queued");

    // Ensure at least one upload + one job-create call was recorded
    const filesCalls = mock.calls.filter((c) => c.url.endsWith("/files") && c.method === "POST");
    const jobCalls = mock.calls.filter((c) => c.url.endsWith("/fine_tuning/jobs") && c.method === "POST");
    assert.equal(filesCalls.length, 1);
    assert.equal(jobCalls.length, 1);
  } finally {
    mock.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("createFineTuneJob throws without OPENAI_API_KEY for openai provider", async () => {
  const ws = TEST_WS + "-jobs-noauth";
  await __resetJobsForTests(ws);
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () =>
      createFineTuneJob(ws, {
        provider: "openai",
        model: "gpt-4o-mini",
        trainingFile: "{}\n",
      }),
    /OPENAI_API_KEY/,
  );
});

test("createFineTuneJob with provider=local stores a prepared job", async () => {
  const ws = TEST_WS + "-jobs-local";
  await __resetJobsForTests(ws);
  const result = await createFineTuneJob(ws, {
    provider: "local",
    model: "llama-3-8b",
    trainingFile: "{}\n",
  });
  assert.equal(result.provider, "local");
  assert.equal(result.status, "prepared");
});

test("listFineTuneJobs returns jobs created in the workspace", async () => {
  const ws = TEST_WS + "-jobs-list";
  await __resetJobsForTests(ws);
  await createFineTuneJob(ws, { provider: "local", model: "m1", trainingFile: "{}" });
  await createFineTuneJob(ws, { provider: "local", model: "m2", trainingFile: "{}" });
  const jobs = await listFineTuneJobs(ws);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((j) => j.workspaceId === ws));
});

test("getFineTuneJob refreshes remote status for openai-backed jobs", async () => {
  const ws = TEST_WS + "-jobs-refresh";
  await __resetJobsForTests(ws);
  const mock = mockOpenAIFetch();
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const created = await createFineTuneJob(ws, {
      provider: "openai",
      model: "gpt-4o-mini",
      trainingFile: JSON.stringify({ messages: [] }),
    });
    const fetched = await getFineTuneJob(created.jobId, { workspaceId: ws });
    assert.ok(fetched);
    assert.equal(fetched.provider, "openai");
    assert.equal(fetched.jobId, created.jobId);
  } finally {
    mock.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("getFineTuneJob returns null for unknown id", async () => {
  const job = await getFineTuneJob("does-not-exist-" + Date.now(), { workspaceId: TEST_WS });
  assert.equal(job, null);
});

test("cancelFineTuneJob marks local job as cancelled", async () => {
  const ws = TEST_WS + "-jobs-cancel";
  await __resetJobsForTests(ws);
  const created = await createFineTuneJob(ws, {
    provider: "local",
    model: "m1",
    trainingFile: "{}",
  });
  const result = await cancelFineTuneJob(created.jobId, { workspaceId: ws });
  assert.equal(result.status, "cancelled");
  const fetched = await getFineTuneJob(created.jobId, { workspaceId: ws });
  assert.equal(fetched.status, "cancelled");
});

test("cancelFineTuneJob throws for missing id", async () => {
  await assert.rejects(
    () => cancelFineTuneJob("missing-" + Date.now(), { workspaceId: TEST_WS }),
    /not found/,
  );
});

test("getFineTuneEvents returns events from OpenAI API for openai jobs", async () => {
  const ws = TEST_WS + "-jobs-events";
  await __resetJobsForTests(ws);
  const mock = mockOpenAIFetch();
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    const created = await createFineTuneJob(ws, {
      provider: "openai",
      model: "gpt-4o-mini",
      trainingFile: "{}",
    });
    const { events } = await getFineTuneEvents(created.jobId, { workspaceId: ws });
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "started");
  } finally {
    mock.restore();
    delete process.env.OPENAI_API_KEY;
  }
});

test("getFineTuneEvents returns a synthetic event for local jobs", async () => {
  const ws = TEST_WS + "-jobs-events-local";
  await __resetJobsForTests(ws);
  const created = await createFineTuneJob(ws, {
    provider: "local",
    model: "m1",
    trainingFile: "{}",
  });
  const { events } = await getFineTuneEvents(created.jobId, { workspaceId: ws });
  assert.ok(Array.isArray(events));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "status");
});
