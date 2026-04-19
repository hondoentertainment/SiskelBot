/**
 * E2E: feedback loop -> patch synthesis -> patch injection.
 *
 * Simulate 10 thumbs-down feedback events tagged "hallucination" in a
 * workspace. Run the prompt-tuner to synthesize a patch from that signal.
 * Mark the patch "applied". Then run a fresh agent request and verify the
 * patch content is injected into the outbound LLM request as a system message.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "e2e-feedback-loop-"));
const savedEnv = {
  STORAGE_PATH: process.env.STORAGE_PATH,
  AGENT_PROMPT_PATCH: process.env.AGENT_PROMPT_PATCH,
  AGENT_TOOL_RESULT_JUDGE: process.env.AGENT_TOOL_RESULT_JUDGE,
  AGENT_CONTENT_SCRUB: process.env.AGENT_CONTENT_SCRUB,
  AGENT_GENEALOGY_HINT: process.env.AGENT_GENEALOGY_HINT,
};
process.env.STORAGE_PATH = TMP_ROOT;
// Patch injection ON (the behaviour under test).
delete process.env.AGENT_PROMPT_PATCH;
// Other advisory features OFF so they don't muddy the outbound messages.
process.env.AGENT_TOOL_RESULT_JUDGE = "0";
process.env.AGENT_CONTENT_SCRUB = "0";
process.env.AGENT_GENEALOGY_HINT = "0";

const { recordFeedback } = await import("../../lib/agent-feedback-store.js");
const {
  synthesizePatch,
  savePatch,
  setPatchStatus,
  getActivePatchContent,
} = await import("../../lib/agent-prompt-tuner.js");
const { runAgentLoop } = await import("../../lib/agent-loop.js");

test.after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

test("feedback-loop: 10 thumbs-down -> patch synthesized -> applied -> next run injects patch", async () => {
  const workspace = "e2e-fb";

  // Simulate 10 thumbs-down events tagged "hallucination" (MIN_COMPLAINT_TAG_COUNT=3
  // means >=3 tagged hits surface as topComplaintTags; 10 exceeds the
  // MIN_FEEDBACK_SIGNAL_LINE=10 floor that triggers the "Human feedback signal"
  // section in the patch).
  for (let i = 0; i < 10; i++) {
    await recordFeedback(workspace, {
      runId: `run-${i}`,
      userId: "alice",
      rating: "down",
      tags: ["hallucination"],
      comment: "response invented facts",
      agentResponse: "The CVE is CVE-2099-9999. [fabricated]",
    });
  }

  // Synthesize a patch. With 10 down-votes + all tagged "hallucination" the
  // patch's basis should include the tag.
  const patch = await synthesizePatch(workspace);
  assert.ok(patch, "synthesizePatch should produce a patch from 10 tagged downvotes");
  assert.ok(patch.content.length > 0, "patch content should not be empty");
  assert.match(patch.content, /hallucination/i, "patch content should reference hallucination tag");
  assert.ok(
    Array.isArray(patch.basis.topComplaintTags) && patch.basis.topComplaintTags.length > 0,
    "patch basis should include topComplaintTags",
  );
  const found = patch.basis.topComplaintTags.find((t) => /hallucination/.test(t));
  assert.ok(found, `topComplaintTags should include a hallucination entry; got ${patch.basis.topComplaintTags.join(",")}`);
  // Confirm the "tag(count)" shape the synthesizer uses (e.g. "hallucination(10)").
  assert.match(found, /^hallucination\(\d+\)$/);

  // Persist as pending, then apply it.
  await savePatch(patch);
  await setPatchStatus(workspace, patch.version, "applied", "test");

  const activeContent = await getActivePatchContent(workspace);
  assert.equal(activeContent, patch.content, "active patch content should match saved patch");

  // Run a minimal agent request; mock backend returns final text immediately.
  const captured = [];
  const backendFetch = async (_url, opts) => {
    let body;
    try { body = JSON.parse(opts.body); } catch { body = {}; }
    captured.push(body);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "Hello, user." } }],
      }),
    };
  };

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "Explain something" }],
      agentOptions: { workspace, allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);
  assert.equal(result.stopReason, "model_finished");

  // The outbound request body MUST include the patch content as a system-role
  // message. This is the load-bearing wiring check: feedback flows into the
  // prompt on the very next run.
  assert.ok(captured.length >= 1, "backend should have received at least one agent call");
  const outbound = captured[0];
  const sysMsgs = (outbound.messages || []).filter((m) => m.role === "system");
  const patchInjected = sysMsgs.some(
    (m) => typeof m.content === "string" && m.content === patch.content,
  );
  assert.ok(
    patchInjected,
    "the applied patch content should be present as a system message in the next agent request",
  );
});
