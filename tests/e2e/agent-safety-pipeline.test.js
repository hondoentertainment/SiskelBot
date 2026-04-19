/**
 * E2E: safety pipeline.
 *
 * A tool returns content that embeds AWS + Anthropic API keys. We verify:
 *   1. The content scrubber redacts the secrets BEFORE those secrets are
 *      handed to the next LLM round (either the judge prompt or the main
 *      agent-loop round-2 call).
 *   2. No raw secret makes it into any outbound request body.
 *   3. [REDACTED_*] markers DO appear in the round-2 messages.
 *
 * The test uses the real `search_context` tool backed by a real document
 * containing secret-laden text. This drives the full agent-loop path
 * (runTool -> scrubber -> judge -> next LLM round). It does NOT stub the
 * scrubber; only the backendFetch (LLM HTTP call) is mocked.
 *
 * Integration point verified by code-search: lib/agent-loop.js calls
 * scrubContent() immediately after runTool() and BEFORE the judge prompt is
 * built (lines 636-644 then 648+). If the order ever regresses (e.g., judge
 * called before scrub), this test will fail because the judge prompt body
 * would contain the unredacted secret strings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "e2e-safety-"));
const KB_DIR = join(TMP_ROOT, "knowledge");

const savedEnv = {
  STORAGE_PATH: process.env.STORAGE_PATH,
  KNOWLEDGE_DATA_DIR: process.env.KNOWLEDGE_DATA_DIR,
  AGENT_CONTENT_SCRUB: process.env.AGENT_CONTENT_SCRUB,
  AGENT_TOOL_RESULT_JUDGE: process.env.AGENT_TOOL_RESULT_JUDGE,
  AGENT_GENEALOGY_HINT: process.env.AGENT_GENEALOGY_HINT,
  AGENT_PROMPT_PATCH: process.env.AGENT_PROMPT_PATCH,
};
process.env.STORAGE_PATH = TMP_ROOT;
process.env.KNOWLEDGE_DATA_DIR = KB_DIR;
// Scrubber ON (default) and judge ON to exercise the ordering invariant.
delete process.env.AGENT_CONTENT_SCRUB;
process.env.AGENT_TOOL_RESULT_JUDGE = "1";
// Other noise off.
process.env.AGENT_GENEALOGY_HINT = "0";
process.env.AGENT_PROMPT_PATCH = "0";

const { indexDocument } = await import("../../lib/knowledge-store.js");
const { runAgentLoop } = await import("../../lib/agent-loop.js");
const { scrubContent } = await import("../../lib/content-scrubber.js");

test.after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const ANTHROPIC_KEY = "sk-ant-1234567890abcdef1234567890abcdef";

test("safety-pipeline: sanity: scrubContent redacts AKIA and sk-ant keys", () => {
  const input = `creds: ${AWS_KEY} and ${ANTHROPIC_KEY} end`;
  const r = scrubContent(input);
  assert.ok(r.modified, "scrubber should mark input as modified");
  assert.ok(!r.scrubbed.includes(AWS_KEY), "AWS key should be redacted");
  assert.ok(!r.scrubbed.includes(ANTHROPIC_KEY), "Anthropic key should be redacted");
  assert.match(r.scrubbed, /\[REDACTED_AWS_ACCESS_KEY_ID\]/);
  assert.match(r.scrubbed, /\[REDACTED_ANTHROPIC_KEY\]/);
});

test("safety-pipeline: secrets returned by a tool are redacted BEFORE reaching the next LLM round", async () => {
  const workspace = "e2esafe";

  // Seed a knowledge doc whose body contains both secrets. A search_context
  // call must surface them in its snippets.
  const secretDoc = [
    "INTERNAL CREDENTIALS NOTE — DO NOT COMMIT",
    `AWS access key id: ${AWS_KEY}`,
    `Anthropic API key: ${ANTHROPIC_KEY}`,
    "Rotate both immediately if leaked.",
  ].join("\n");

  const indexed = await indexDocument({
    text: secretDoc,
    workspace,
    title: "credentials-leak",
  });
  assert.ok(indexed && indexed.id, `indexDocument should succeed: ${JSON.stringify(indexed)}`);

  // Mock backend: records every outbound body; script one tool_call then
  // final text. Judge prompts are answered with JSON.
  const captured = [];
  let agentRound = 0;
  const scenario = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_sec1",
                type: "function",
                function: {
                  name: "search_context",
                  arguments: JSON.stringify({ query: "credentials" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    { choices: [{ message: { role: "assistant", content: "Found some notes." } }] },
  ];
  const backendFetch = async (_url, opts) => {
    let body;
    try { body = JSON.parse(opts.body); } catch { body = {}; }
    captured.push(body);
    const isJudge =
      Array.isArray(body.messages) &&
      body.messages.some(
        (m) => m.role === "system" && /JSON-only judge/i.test(m.content || ""),
      );
    if (isJudge) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [
            { message: { role: "assistant", content: '{"satisfactory": true, "confidence": 0.9}' } },
          ],
        }),
      };
    }
    const entry = scenario[Math.min(agentRound, scenario.length - 1)];
    agentRound++;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => entry,
    };
  };

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "what credentials are in the docs?" }],
      agentOptions: { workspace, allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);
  assert.equal(result.stopReason, "model_finished");

  // GUARDS: the raw secrets MUST NOT appear in ANY outbound request body
  // sent to the backend (neither judge prompt nor round-2 messages).
  assert.ok(captured.length >= 2, `expected >= 2 backend calls, got ${captured.length}`);
  for (const body of captured) {
    const text = JSON.stringify(body);
    assert.ok(
      !text.includes(AWS_KEY),
      "raw AWS key must NEVER appear in any outbound LLM body (agent or judge)",
    );
    assert.ok(
      !text.includes(ANTHROPIC_KEY),
      "raw Anthropic key must NEVER appear in any outbound LLM body (agent or judge)",
    );
  }

  // The round-2 agent body (i.e., the first non-judge body after round-1)
  // must contain [REDACTED_*] markers in its tool-role message content.
  const agentBodies = captured.filter(
    (b) =>
      !(Array.isArray(b.messages) &&
        b.messages.some((m) => m.role === "system" && /JSON-only judge/i.test(m.content || ""))),
  );
  assert.ok(agentBodies.length >= 2, "expected >= 2 agent-round bodies");
  const round2 = agentBodies[1];
  const toolMsgs = (round2.messages || []).filter((m) => m.role === "tool");
  assert.ok(toolMsgs.length >= 1, "round 2 should carry a tool-role message");
  const joinedToolContent = toolMsgs.map((m) => String(m.content || "")).join("\n");
  assert.match(
    joinedToolContent,
    /\[REDACTED_AWS_ACCESS_KEY_ID\]/,
    "tool-role message should carry AWS-redaction marker",
  );
  assert.match(
    joinedToolContent,
    /\[REDACTED_ANTHROPIC_KEY\]/,
    "tool-role message should carry Anthropic-redaction marker",
  );

  // Extra: verify judge prompts, specifically, also did not see the secrets.
  const judgeBodies = captured.filter(
    (b) =>
      Array.isArray(b.messages) &&
      b.messages.some((m) => m.role === "system" && /JSON-only judge/i.test(m.content || "")),
  );
  for (const b of judgeBodies) {
    const t = JSON.stringify(b);
    assert.ok(!t.includes(AWS_KEY), "judge prompt must not contain AWS key");
    assert.ok(!t.includes(ANTHROPIC_KEY), "judge prompt must not contain Anthropic key");
  }
});
