/**
 * Phase 54.5: Document layout parsing tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// doc-layout doesn't persist anything, but we still isolate STORAGE_PATH to
// match the repo convention and stay deterministic.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-doc-layout-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  parseLayout,
  extractTables,
  extractFigures,
  extractFormFields,
  extractReadingOrder,
} = await import("../lib/doc-layout.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

test("extractTables parses a markdown pipe table", () => {
  const text = [
    "| name | role |",
    "|------|------|",
    "| Ada  | Eng  |",
    "| Bob  | PM   |",
  ].join("\n");
  const tables = extractTables(text);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].type, "pipe_table");
  assert.equal(tables[0].rows.length, 3);
  assert.deepEqual(tables[0].rows[1], ["Ada", "Eng"]);
  assert.ok(tables[0].bbox.height >= 3);
});

test("extractTables parses whitespace-aligned columns", () => {
  const text = [
    "Name      Role      Salary",
    "Ada       Eng       100",
    "Bob       PM        120",
  ].join("\n");
  const tables = extractTables(text);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].type, "aligned_columns");
  assert.equal(tables[0].rows.length, 3);
});

test("extractTables parses CSV when allowCsv is true", () => {
  const text = ["a,b,c", "1,2,3", "4,5,6"].join("\n");
  const none = extractTables(text);
  assert.equal(none.length, 0);
  const yes = extractTables(text, { allowCsv: true });
  assert.equal(yes.length, 1);
  assert.equal(yes[0].type, "csv_block");
});

test("extractTables returns empty for prose", () => {
  const text = "This is prose. No tables here.\nJust words and sentences.";
  assert.deepEqual(extractTables(text), []);
});

/* -------------------------------------------------------------------------- */
/* Figures                                                                    */
/* -------------------------------------------------------------------------- */

test("extractFigures picks up captions", () => {
  const text = [
    "Figure 1: The architecture diagram",
    "Some intervening text",
    "Fig. 2 - Deployment topology",
  ].join("\n");
  const figs = extractFigures(text);
  assert.equal(figs.length, 2);
  assert.equal(figs[0].number, 1);
  assert.equal(figs[0].caption, "The architecture diagram");
  assert.equal(figs[1].number, 2);
});

test("extractFigures picks up image placeholders", () => {
  const text = "paragraph\n[IMAGE: diagram.png]\nmore text";
  const figs = extractFigures(text);
  assert.equal(figs.length, 1);
  assert.equal(figs[0].kind, "placeholder");
  assert.equal(figs[0].caption, "diagram.png");
});

test("extractFigures returns empty for plain prose", () => {
  assert.deepEqual(extractFigures("just words"), []);
});

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

test("extractFormFields handles label:value rows", () => {
  const text = [
    "Name: Ada Lovelace",
    "Email: ada@example.com",
    "Role: Engineer",
  ].join("\n");
  const fields = extractFormFields(text);
  assert.equal(fields.length, 3);
  assert.equal(fields[0].label, "Name");
  assert.equal(fields[0].value, "Ada Lovelace");
  assert.equal(fields[1].label, "Email");
});

test("extractFormFields handles dotted-leader rows", () => {
  const text = "Amount ............: $100.00";
  const fields = extractFormFields(text);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].label, "Amount");
  assert.equal(fields[0].value, "$100.00");
});

test("extractFormFields handles checkboxes", () => {
  const text = ["[ ] Option A", "[x] Option B", "[X] Option C"].join("\n");
  const fields = extractFormFields(text);
  assert.equal(fields.length, 3);
  assert.equal(fields[0].checked, false);
  assert.equal(fields[1].checked, true);
  assert.equal(fields[2].checked, true);
});

test("extractFormFields ignores prose sentences", () => {
  const fields = extractFormFields("This is just a sentence.");
  assert.deepEqual(fields, []);
});

/* -------------------------------------------------------------------------- */
/* Reading order                                                              */
/* -------------------------------------------------------------------------- */

test("extractReadingOrder groups paragraphs", () => {
  const text = [
    "First paragraph.",
    "With two lines.",
    "",
    "Second paragraph.",
    "",
    "Third paragraph.",
  ].join("\n");
  const blocks = extractReadingOrder(text);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].order, 0);
  assert.ok(blocks[0].text.includes("First paragraph"));
  assert.equal(blocks[1].text, "Second paragraph.");
});

test("extractReadingOrder returns empty for blank input", () => {
  assert.deepEqual(extractReadingOrder(""), []);
  assert.deepEqual(extractReadingOrder("   \n\n\n"), []);
});

test("extractReadingOrder threads bbox hints when provided", () => {
  const text = "First block\n\nSecond block";
  const hints = [{ line: 0, col: 5, width: 11, height: 1 }];
  const blocks = extractReadingOrder(text, { hints });
  assert.equal(blocks[0].bbox.col, 5);
});

/* -------------------------------------------------------------------------- */
/* parseLayout                                                                */
/* -------------------------------------------------------------------------- */

test("parseLayout aggregates all regions", () => {
  const text = [
    "Page 1",
    "",
    "| col1 | col2 |",
    "|------|------|",
    "| a    | b    |",
    "",
    "Figure 1: Diagram",
    "Name: Ada",
    "[ ] Opt",
    "",
    "Body paragraph describing the situation.",
    "",
    "Page 1 / 2",
  ].join("\n");
  const r = parseLayout(text);
  assert.equal(r.tables.length, 1);
  assert.equal(r.figures.length, 1);
  assert.ok(r.formFields.length >= 1);
  assert.ok(r.readingOrder.length >= 2);
  assert.ok(r.headers.length >= 1);
  assert.ok(r.footers.length >= 1);
  assert.ok(r.totalLines > 0);
});

test("parseLayout handles empty input", () => {
  const r = parseLayout("");
  assert.deepEqual(r.tables, []);
  assert.deepEqual(r.figures, []);
  assert.deepEqual(r.formFields, []);
  assert.deepEqual(r.readingOrder, []);
});
