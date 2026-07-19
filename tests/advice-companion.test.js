import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAdviceSystemPrompt,
  isAdviceCompanionPrompt,
  captureThought,
  listThoughts,
  resurfaceThoughts,
  formatThoughtsHint,
  enableAdviceMode,
  disableAdviceMode,
  getAdviceModeStatus,
  updateThought,
  ADVICE_MODE_SENTINEL,
} from "../lib/advice-companion.js";

describe("advice companion", () => {
  let dir;
  const prev = process.env.STORAGE_PATH;
  const user = "advice-user";
  const ws = "advice-ws";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "siskel-advice-"));
    process.env.STORAGE_PATH = dir;
  });

  after(() => {
    if (prev === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("builds honest + challenge prompts", () => {
    const base = buildAdviceSystemPrompt();
    assert.ok(isAdviceCompanionPrompt(base));
    assert.ok(base.includes(ADVICE_MODE_SENTINEL));
    const ch = buildAdviceSystemPrompt({ challenge: true });
    assert.match(ch, /Challenge mode is ON/i);
  });

  it("captures and lists thoughts", async () => {
    const t = await captureThought(user, ws, {
      content: "I want to quit my job but I'm scared",
      kind: "decision",
    });
    assert.ok(t.id);
    const { thoughts } = await listThoughts(user, ws, { limit: 10 });
    assert.ok(thoughts.some((x) => x.id === t.id));
  });

  it("resurfaces due reminders and formats hint", async () => {
    await captureThought(user, ws, {
      content: "Call Mom this weekend",
      kind: "reminder",
      resurfaceAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { thoughts, dueCount } = await resurfaceThoughts(user, ws, { limit: 5 });
    assert.ok(dueCount >= 1);
    assert.ok(thoughts.length >= 1);
    const hint = formatThoughtsHint(thoughts);
    assert.match(hint, /Personal thoughts/);
    assert.match(hint, /Call Mom/);
  });

  it("enables and disables advice mode on workspace settings", async () => {
    const r = await enableAdviceMode(user, ws, { challenge: true });
    assert.equal(r.ok, true);
    assert.equal(r.challenge, true);
    const status = await getAdviceModeStatus(user, ws);
    assert.equal(status.enabled, true);
    assert.equal(status.challenge, true);
    const off = await disableAdviceMode(user, ws);
    assert.equal(off.ok, true);
    const after = await getAdviceModeStatus(user, ws);
    assert.equal(after.enabled, false);
  });

  it("updates thought content and kind", async () => {
    const t = await captureThought(user, ws, { content: "draft idea", kind: "idea" });
    const u = await updateThought(user, ws, t.id, {
      content: "refined idea",
      kind: "decision",
      importance: 5,
    });
    assert.equal(u.ok, true);
    assert.equal(u.memory.content, "refined idea");
    assert.equal(u.memory.metadata.thoughtKind, "decision");
    assert.equal(u.memory.importance, 5);
  });
});
