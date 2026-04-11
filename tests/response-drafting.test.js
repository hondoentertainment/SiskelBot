/**
 * Phase 62.3: Response drafting tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-response-drafting-"));
process.env.STORAGE_PATH = TMP;

const {
  createTemplate,
  listTemplates,
  setTone,
  preview,
  draftResponse,
  extractVariables,
  renderTemplate,
  applyTone,
  listTones,
} = await import("../lib/response-drafting.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("extractVariables finds placeholder names", () => {
  const vars = extractVariables("Hello {{name}}, your order {{orderId}} is ready");
  assert.deepEqual(vars.sort(), ["name", "orderId"]);
});

test("renderTemplate substitutes placeholders", () => {
  const out = renderTemplate("Hi {{name}}", { name: "Alice" });
  assert.equal(out, "Hi Alice");
});

test("renderTemplate leaves unknown placeholders intact", () => {
  const out = renderTemplate("Hi {{name}}", {});
  assert.ok(out.includes("{{name}}"));
});

test("applyTone substitutes __GREETING__ markers", () => {
  const out = applyTone("__GREETING__ Alice", "formal");
  assert.equal(out, "Dear Alice");
  const friendly = applyTone("__GREETING__ Alice", "friendly");
  assert.equal(friendly, "Hi Alice");
});

test("listTones returns supported tones", () => {
  const tones = listTones();
  assert.ok(tones.includes("formal"));
  assert.ok(tones.includes("friendly"));
  assert.ok(tones.includes("empathetic"));
});

test("createTemplate persists a template", async () => {
  const t = await createTemplate("refund_ack", "__GREETING__ {{name}}, __APOLOGY__ about the {{issue}}.", { tone: "empathetic" });
  assert.equal(t.name, "refund_ack");
  assert.equal(t.tone, "empathetic");
  assert.ok(t.variables.includes("name"));
  assert.ok(t.variables.includes("issue"));
});

test("createTemplate rejects invalid input", async () => {
  await assert.rejects(() => createTemplate("", "body"));
  await assert.rejects(() => createTemplate("n", /** @type {any} */ (null)));
});

test("listTemplates returns stored templates", async () => {
  await createTemplate("greeting_tmpl", "__GREETING__ {{name}}!");
  const list = await listTemplates();
  const names = list.map((t) => t.name);
  assert.ok(names.includes("refund_ack"));
  assert.ok(names.includes("greeting_tmpl"));
});

test("setTone updates a template tone", async () => {
  const updated = await setTone("refund_ack", "formal");
  assert.equal(updated.tone, "formal");
});

test("setTone rejects unknown tone", async () => {
  await assert.rejects(() => setTone("refund_ack", "sarcastic"));
});

test("preview renders with vars and reports missing", async () => {
  const out = await preview("refund_ack", { name: "Alice" });
  assert.ok(out.text.includes("Alice"));
  assert.ok(out.missingVars.includes("issue"));
  assert.equal(out.tone, "formal");
});

test("draftResponse renders a template with all vars", async () => {
  const out = await draftResponse({
    templateName: "refund_ack",
    vars: { name: "Alice", issue: "double charge" },
  });
  assert.ok(out.text.includes("Alice"));
  assert.ok(out.text.includes("double charge"));
  assert.equal(out.polished, false);
});

test("draftResponse supports inline body", async () => {
  const out = await draftResponse({
    body: "Hello {{name}}",
    tone: "friendly",
    vars: { name: "Bob" },
  });
  assert.equal(out.text, "Hello Bob");
});

test("draftResponse uses llm callback when provided", async () => {
  const out = await draftResponse({
    body: "Hi {{name}}",
    tone: "friendly",
    vars: { name: "Eve" },
    llm: async (text) => `POLISHED: ${text}`,
  });
  assert.ok(out.polished);
  assert.ok(out.text.startsWith("POLISHED:"));
});

test("draftResponse rejects when no template or body given", async () => {
  await assert.rejects(() => draftResponse({}));
});
