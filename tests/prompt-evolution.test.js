/**
 * Phase 32.2: prompt-evolution unit tests.
 * Uses a temp STORAGE_PATH so we don't touch the real data/ directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-prompt-evolution-"));
process.env.STORAGE_PATH = tempDir;

const {
  savePromptVersion,
  listPromptVersions,
  getActivePrompt,
  setActivePrompt,
  recordPromptUsage,
  generateCandidateVersions,
  runPromptABTest,
  autoPromotePrompts,
} = await import("../lib/prompt-evolution.js");

const { recordFeedback } = await import("../lib/feedback.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── save / list / active ─────────────────────────────────────────────────────

test("savePromptVersion persists a record and lists it", async () => {
  const ws = "ws-save-" + Date.now();
  const rec = await savePromptVersion(ws, "You are terse.", { source: "seed" });
  assert.ok(rec.id);
  assert.equal(rec.text, "You are terse.");
  assert.equal(rec.metadata.source, "seed");
  assert.ok(rec.stats);
  assert.equal(rec.stats.samples, 0);

  const versions = await listPromptVersions(ws);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, rec.id);
});

test("savePromptVersion rejects empty text", async () => {
  await assert.rejects(() => savePromptVersion("ws-x", "   "), /promptText is required/);
});

test("getActivePrompt returns default for fresh workspace", async () => {
  const ws = "ws-fresh-" + Date.now();
  const active = await getActivePrompt(ws);
  assert.ok(active.text);
  assert.equal(active.id, null);
  assert.equal(active.metadata.default, true);
});

test("first saved version becomes active automatically", async () => {
  const ws = "ws-auto-active-" + Date.now();
  const first = await savePromptVersion(ws, "Prompt A");
  const active = await getActivePrompt(ws);
  assert.equal(active.id, first.id);
});

test("setActivePrompt switches active and rejects unknown id", async () => {
  const ws = "ws-switch-" + Date.now();
  const a = await savePromptVersion(ws, "Prompt A");
  const b = await savePromptVersion(ws, "Prompt B");
  assert.equal((await getActivePrompt(ws)).id, a.id);

  const ok = await setActivePrompt(ws, b.id);
  assert.equal(ok.ok, true);
  assert.equal((await getActivePrompt(ws)).id, b.id);

  const bad = await setActivePrompt(ws, "does-not-exist");
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "version_not_found");
});

// ─── recordPromptUsage ─────────────────────────────────────────────────────────

test("recordPromptUsage updates uses, samples and avgRating", async () => {
  const ws = "ws-usage-" + Date.now();
  const rec = await savePromptVersion(ws, "Prompt usage test");

  await recordPromptUsage(ws, rec.id, null); // use without rating
  await recordPromptUsage(ws, rec.id, 5);
  await recordPromptUsage(ws, rec.id, 3);
  const snapshot = await recordPromptUsage(ws, rec.id, 4);

  assert.equal(snapshot.uses, 4);
  assert.equal(snapshot.samples, 3);
  assert.equal(snapshot.avgRating, 4); // (5+3+4)/3 = 4
});

test("recordPromptUsage ignores invalid rating", async () => {
  const ws = "ws-usage-bad-" + Date.now();
  const rec = await savePromptVersion(ws, "Prompt bad rating");
  const snap = await recordPromptUsage(ws, rec.id, 10); // out of range
  assert.equal(snap.uses, 1);
  assert.equal(snap.samples, 0);
  assert.equal(snap.avgRating, 0);
});

// ─── generateCandidateVersions ────────────────────────────────────────────────

test("generateCandidateVersions produces N saved candidates", async () => {
  const ws = "ws-gen-" + Date.now();
  await savePromptVersion(ws, "Base prompt for generation tests.");

  // Seed feedback that should trigger length + clarity heuristics.
  const conv = "conv-gen-" + Date.now();
  for (let i = 0; i < 3; i++) {
    await recordFeedback(conv, i, 2, "response was confusing and incomplete", "user", {
      workspaceId: ws,
      model: "modelA",
      response: "x".repeat(100),
    });
  }
  for (let i = 3; i < 6; i++) {
    await recordFeedback(conv, i, 5, "great", "user", {
      workspaceId: ws,
      model: "modelB",
      response: "y".repeat(2000),
    });
  }

  const candidates = await generateCandidateVersions(ws, 3);
  assert.equal(candidates.length, 3);
  for (const c of candidates) {
    assert.ok(c.id);
    assert.ok(c.text && c.text.length > 0);
    assert.ok(c.rationale);
  }

  // All candidates should have been persisted as versions.
  const allVersions = await listPromptVersions(ws);
  assert.ok(allVersions.length >= 4); // base + 3 candidates
});

// ─── runPromptABTest ──────────────────────────────────────────────────────────

test("runPromptABTest picks the version with the higher avgRating", async () => {
  const ws = "ws-ab-" + Date.now();
  const a = await savePromptVersion(ws, "Variant A");
  const b = await savePromptVersion(ws, "Variant B");

  // A: five ratings averaging ~3
  for (const r of [3, 3, 3, 3, 3]) await recordPromptUsage(ws, a.id, r);
  // B: five ratings averaging ~4.8
  for (const r of [5, 5, 5, 4, 5]) await recordPromptUsage(ws, b.id, r);

  const result = await runPromptABTest(ws, [a.id, b.id], 5);
  assert.equal(result.winner, b.id);
  assert.ok(result.scores[b.id] > result.scores[a.id]);
  assert.equal(result.samples[a.id], 5);
  assert.equal(result.samples[b.id], 5);
  assert.ok(result.confidence > 0);
});

test("runPromptABTest returns no winner when below min samples", async () => {
  const ws = "ws-ab-small-" + Date.now();
  const a = await savePromptVersion(ws, "Variant A small");
  const b = await savePromptVersion(ws, "Variant B small");
  await recordPromptUsage(ws, a.id, 3);
  await recordPromptUsage(ws, b.id, 5);
  const result = await runPromptABTest(ws, [a.id, b.id], 5);
  assert.equal(result.winner, null);
});

test("runPromptABTest requires at least two versionIds", async () => {
  await assert.rejects(
    () => runPromptABTest("ws-ab-err", ["only-one"], 1),
    /at least two versionIds/
  );
});

// ─── autoPromotePrompts ───────────────────────────────────────────────────────

test("autoPromotePrompts promotes a clearly better candidate", async () => {
  const ws = "ws-promote-yes-" + Date.now();
  const active = await savePromptVersion(ws, "Active prompt");
  const candidate = await savePromptVersion(ws, "Candidate prompt");

  // Active: 20 samples averaging 3.0
  for (let i = 0; i < 20; i++) await recordPromptUsage(ws, active.id, 3);
  // Candidate: 20 samples averaging ~4.5 (well above threshold of 0.3)
  for (let i = 0; i < 20; i++) await recordPromptUsage(ws, candidate.id, i < 10 ? 5 : 4);

  const result = await autoPromotePrompts(ws, { threshold: 0.3, minSamples: 20 });
  assert.equal(result.promoted, true, JSON.stringify(result));
  assert.equal(result.fromVersion, active.id);
  assert.equal(result.toVersion, candidate.id);
  assert.ok(result.improvement >= 0.3);

  // Active should now point at candidate
  const newActive = await getActivePrompt(ws);
  assert.equal(newActive.id, candidate.id);
});

test("autoPromotePrompts rejects when improvement is below threshold", async () => {
  const ws = "ws-promote-no-" + Date.now();
  const active = await savePromptVersion(ws, "Active prompt close");
  const candidate = await savePromptVersion(ws, "Candidate prompt close");

  // Active: 20 samples averaging 3.5
  for (let i = 0; i < 20; i++) await recordPromptUsage(ws, active.id, i < 10 ? 4 : 3);
  // Candidate: 20 samples averaging ~3.6 (only +0.1, below 0.3 threshold)
  for (let i = 0; i < 20; i++) await recordPromptUsage(ws, candidate.id, i < 12 ? 4 : 3);

  const result = await autoPromotePrompts(ws, { threshold: 0.3, minSamples: 20 });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "below_threshold");
  // Active prompt should remain unchanged.
  const stillActive = await getActivePrompt(ws);
  assert.equal(stillActive.id, active.id);
});

test("autoPromotePrompts rejects when candidate has too few samples", async () => {
  const ws = "ws-promote-fewsamples-" + Date.now();
  const active = await savePromptVersion(ws, "Active prompt few");
  const candidate = await savePromptVersion(ws, "Candidate prompt few");

  for (let i = 0; i < 20; i++) await recordPromptUsage(ws, active.id, 3);
  // Only 5 candidate samples
  for (let i = 0; i < 5; i++) await recordPromptUsage(ws, candidate.id, 5);

  const result = await autoPromotePrompts(ws, { threshold: 0.3, minSamples: 20 });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "no_candidate_with_samples");
});

test("autoPromotePrompts returns no_versions for empty workspace", async () => {
  const ws = "ws-promote-empty-" + Date.now();
  const result = await autoPromotePrompts(ws);
  assert.equal(result.promoted, false);
  assert.equal(result.reason, "no_versions");
});
