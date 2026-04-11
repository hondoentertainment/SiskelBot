/**
 * Phase 70.3: Keyboard navigation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-kn-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerShortcut,
  listShortcuts,
  auditTabOrder,
  resolveConflicts,
  exportBindings,
  normalizeShortcut,
} = await import("../lib/keyboard-nav.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeShortcut canonicalizes modifier order and case", () => {
  assert.equal(normalizeShortcut("Ctrl+S"), "ctrl+s");
  assert.equal(normalizeShortcut("cmd + shift + P"), "shift+meta+p");
  assert.equal(normalizeShortcut("alt+ctrl+x"), "ctrl+alt+x");
});

test("normalizeShortcut rejects invalid input", () => {
  assert.throws(() => normalizeShortcut(""));
  assert.throws(() => normalizeShortcut("ctrl+shift"));
  assert.throws(() => normalizeShortcut(null));
});

test("registerShortcut stores a shortcut", async () => {
  const rec = await registerShortcut({ id: "save", keys: "Ctrl+S", description: "Save" });
  assert.equal(rec.id, "save");
  assert.equal(rec.keys, "ctrl+s");
  assert.equal(rec.description, "Save");
});

test("registerShortcut validates input", async () => {
  await assert.rejects(() => registerShortcut(null));
  await assert.rejects(() => registerShortcut({ id: "x", keys: "" }));
  await assert.rejects(() => registerShortcut({ id: "", keys: "Ctrl+S" }));
});

test("listShortcuts returns all and filters by scope", async () => {
  await registerShortcut({ id: "s1", keys: "Ctrl+1", scope: "editor" });
  await registerShortcut({ id: "s2", keys: "Ctrl+2", scope: "global" });
  const all = await listShortcuts();
  assert.ok(all.length >= 2);
  const editor = await listShortcuts({ scope: "editor" });
  assert.ok(editor.every((s) => s.scope === "editor"));
});

test("resolveConflicts finds same-scope collisions", async () => {
  await registerShortcut({ id: "a1", keys: "Ctrl+Shift+K", scope: "global" });
  await registerShortcut({ id: "a2", keys: "ctrl+shift+k", scope: "global" });
  const conflicts = await resolveConflicts();
  const found = conflicts.find((c) => c.keys === "ctrl+shift+k" && c.scope === "global");
  assert.ok(found);
  assert.ok(found.ids.includes("a1"));
  assert.ok(found.ids.includes("a2"));
});

test("resolveConflicts ignores cross-scope duplicates", async () => {
  await registerShortcut({ id: "cs1", keys: "Ctrl+X", scope: "chat" });
  await registerShortcut({ id: "cs2", keys: "Ctrl+X", scope: "nav" });
  const conflicts = await resolveConflicts();
  // Cross-scope pair is allowed.
  const found = conflicts.find((c) => c.keys === "ctrl+x" && c.ids.includes("cs1") && c.ids.includes("cs2"));
  assert.equal(found, undefined);
});

test("auditTabOrder flags positive tabindex", () => {
  const r = auditTabOrder([
    { tag: "button", tabIndex: 3 },
    { tag: "input", tabIndex: 0 },
  ]);
  assert.ok(r.issues.some((i) => i.message.includes("positive tabindex")));
});

test("auditTabOrder flags click-only divs", () => {
  const r = auditTabOrder([
    { tag: "div", onClick: true },
    { tag: "span", onClick: true, tabIndex: 0 },
  ]);
  const errs = r.issues.filter((i) => i.severity === "error");
  assert.equal(errs.length, 1);
  assert.ok(errs[0].message.includes("not keyboard focusable"));
});

test("auditTabOrder handles empty input", () => {
  assert.deepEqual(auditTabOrder(null).issues, []);
  assert.deepEqual(auditTabOrder([]).issues, []);
});

test("exportBindings returns grouped scopes", async () => {
  await registerShortcut({ id: "eb1", keys: "Ctrl+E", scope: "global" });
  await registerShortcut({ id: "eb2", keys: "Ctrl+F", scope: "editor" });
  const out = await exportBindings();
  assert.ok(out.scopes.global);
  assert.ok(out.scopes.editor);
  assert.ok(out.count >= 2);
  assert.ok(out.generatedAt);
});
