/**
 * Phase 62.3: Response drafter tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-response-drafter-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  draftResponse,
  previewDraft,
  listTones,
  listDrafts,
  getDraft,
  stubGenerate,
  TONES,
  _internals,
} = await import("../lib/response-drafter.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("listTones returns the four supported tones", () => {
  const tones = listTones();
  const names = tones.map((t) => t.name).sort();
  assert.deepEqual(names, ["concise", "empathetic", "formal", "friendly"]);
});

test("stubGenerate uses the opener and closer for the requested tone", () => {
  const formal = stubGenerate({ tone: "formal", subject: "Issue", body: "Details." });
  assert.ok(formal.text.startsWith(TONES.formal.openers[0]));
  assert.ok(formal.text.includes("Sincerely"));
  const friendly = stubGenerate({ tone: "friendly", subject: "Hello", body: "Hi." });
  assert.ok(friendly.text.includes("thanks for reaching out"));
});

test("stubGenerate varies style per tone (exclamations only for friendly)", () => {
  const friendly = stubGenerate({ tone: "friendly", subject: "Hi", body: "Body" });
  assert.ok(friendly.text.endsWith("!\n\nCheers,\nThe Support Crew"));
  const formal = stubGenerate({ tone: "formal", subject: "Hi", body: "Body" });
  assert.ok(formal.text.includes("Sincerely"));
  assert.ok(!/!/.test(formal.text.split("\n\n")[1] || ""));
});

test("draftResponse persists a draft and returns it", async () => {
  const draft = await draftResponse({
    tone: "friendly",
    subject: "Question",
    body: "How do I reset my password?",
    ticketId: "t-123",
  });
  assert.equal(draft.tone, "friendly");
  assert.equal(draft.ticketId, "t-123");
  assert.ok(draft.id);
  const fetched = await getDraft(draft.id);
  assert.equal(fetched.id, draft.id);
});

test("draftResponse defaults tone to friendly", async () => {
  const draft = await draftResponse({ subject: "X", body: "Y" });
  assert.equal(draft.tone, "friendly");
});

test("draftResponse rejects unknown tones", async () => {
  await assert.rejects(
    () => draftResponse({ tone: "shouty", subject: "X", body: "Y" }),
    (err) => err.code === "INVALID_TONE",
  );
});

test("draftResponse invokes an injected generator when provided", async () => {
  let seenTone;
  const gen = ({ tone }) => {
    seenTone = tone;
    return { text: `injected for ${tone}`, tone };
  };
  const draft = await draftResponse({
    tone: "empathetic",
    subject: "A",
    body: "B",
    generate: gen,
  });
  assert.equal(seenTone, "empathetic");
  assert.equal(draft.text, "injected for empathetic");
});

test("previewDraft does NOT persist the result", async () => {
  const before = await listDrafts();
  const result = await previewDraft({
    tone: "concise",
    subject: "Outage",
    body: "Everything exploded.",
  });
  assert.ok(result.text.length > 0);
  const after = await listDrafts();
  assert.equal(after.length, before.length);
});

test("previewDraft accepts an injected generator too", async () => {
  const result = await previewDraft({
    tone: "formal",
    subject: "S",
    body: "B",
    generate: async () => ({ text: "preview-only", tone: "formal" }),
  });
  assert.equal(result.text, "preview-only");
});

test("listDrafts returns drafts in reverse-chronological order", async () => {
  const a = await draftResponse({ tone: "friendly", subject: "A", body: "A" });
  const b = await draftResponse({ tone: "friendly", subject: "B", body: "B" });
  const drafts = await listDrafts(10);
  // `b` should come before `a` since it was inserted later.
  const aIdx = drafts.findIndex((d) => d.id === a.id);
  const bIdx = drafts.findIndex((d) => d.id === b.id);
  assert.ok(bIdx < aIdx);
});

test("_internals.summariseBody truncates long bodies", () => {
  const summary = _internals.summariseBody("One. Two. Three. Four. Five.");
  const sentences = summary.split(".").filter((s) => s.trim());
  assert.ok(sentences.length <= 3);
});

test("draftResponse throws when generator returns no text", async () => {
  await assert.rejects(
    () => draftResponse({
      tone: "friendly",
      subject: "X",
      body: "Y",
      generate: () => ({ text: null, tone: "friendly" }),
    }),
    /no text/,
  );
});
