/**
 * Phase 54.5: Document layout parsing tests.
 *
 * Covers LayoutBlock geometry, DocumentLayout queries, word-to-layout
 * extraction pipeline, table/form/figure classification, table export
 * formats, reading order, column detection, and persisted storage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate storage before importing the module under test.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-doc-layout-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  LayoutBlock,
  DocumentLayout,
  extractLayout,
  groupWordsIntoLines,
  groupLinesIntoBlocks,
  detectTables,
  detectFormFields,
  detectFigures,
  extractTable,
  tableToJson,
  tableToCsv,
  tableToMarkdown,
  extractFormFields,
  computeReadingOrder,
  detectColumns,
  saveLayout,
  getLayout,
  listLayouts,
} = await import("../lib/document-layout.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- LayoutBlock ----------------------------------------------------------

test("LayoutBlock.contains detects points inside and outside the bbox", () => {
  const block = new LayoutBlock({ type: "paragraph", bbox: [10, 20, 100, 80] });
  assert.equal(block.contains([50, 50]), true);
  assert.equal(block.contains([10, 20]), true); // boundary inclusive
  assert.equal(block.contains([100, 80]), true);
  assert.equal(block.contains([5, 50]), false);
  assert.equal(block.contains([50, 90]), false);
  assert.equal(block.contains([150, 50]), false);
});

test("LayoutBlock.overlaps detects intersecting bboxes", () => {
  const a = new LayoutBlock({ bbox: [0, 0, 100, 100] });
  const b = new LayoutBlock({ bbox: [50, 50, 150, 150] });
  const c = new LayoutBlock({ bbox: [200, 200, 300, 300] });
  const d = new LayoutBlock({ bbox: [100, 100, 200, 200] }); // touches corner
  assert.equal(a.overlaps(b), true);
  assert.equal(a.overlaps(c), false);
  assert.equal(a.overlaps(d), true); // touching counts as overlap
});

test("LayoutBlock.area returns width*height", () => {
  const block = new LayoutBlock({ bbox: [10, 20, 60, 70] });
  assert.equal(block.area(), 50 * 50);
  const zero = new LayoutBlock({ bbox: [10, 10, 10, 10] });
  assert.equal(zero.area(), 0);
});

test("LayoutBlock normalizes swapped bbox coordinates", () => {
  const block = new LayoutBlock({ bbox: [100, 80, 10, 20] });
  assert.deepEqual(block.bbox, [10, 20, 100, 80]);
});

// ---- DocumentLayout -------------------------------------------------------

test("DocumentLayout.getBlocks filters by type", () => {
  const layout = new DocumentLayout({
    pageNumber: 1,
    width: 1000,
    height: 1500,
    blocks: [
      { type: "title", bbox: [0, 0, 200, 20], text: "Title" },
      { type: "paragraph", bbox: [0, 30, 200, 100], text: "Body" },
      { type: "paragraph", bbox: [0, 110, 200, 180], text: "More body" },
      { type: "table", bbox: [0, 200, 200, 400], text: "Table" },
    ],
  });
  assert.equal(layout.getBlocks().length, 4);
  assert.equal(layout.getBlocks("paragraph").length, 2);
  assert.equal(layout.getBlocks("table").length, 1);
  assert.equal(layout.getBlocks("figure").length, 0);
});

test("DocumentLayout.findBlockAt returns the first block containing a point", () => {
  const layout = new DocumentLayout({
    blocks: [
      { type: "paragraph", bbox: [0, 0, 100, 100] },
      { type: "paragraph", bbox: [200, 200, 300, 300] },
    ],
  });
  const hit = layout.findBlockAt([50, 50]);
  assert.ok(hit);
  assert.deepEqual(hit.bbox, [0, 0, 100, 100]);
  assert.equal(layout.findBlockAt([500, 500]), null);
});

test("DocumentLayout.mergeBlocks unions bboxes and joins text", () => {
  const layout = new DocumentLayout({
    blocks: [
      { id: "a", type: "paragraph", bbox: [0, 0, 50, 50], text: "Hello" },
      { id: "b", type: "paragraph", bbox: [60, 10, 120, 60], text: "World" },
      { id: "c", type: "paragraph", bbox: [0, 100, 50, 150], text: "Other" },
    ],
  });
  const merged = layout.mergeBlocks(["a", "b"]);
  assert.ok(merged);
  assert.deepEqual(merged.bbox, [0, 0, 120, 60]);
  assert.equal(merged.text, "Hello World");
  assert.equal(layout.blocks.length, 2); // merged + "c"
});

test("DocumentLayout.sortTopToBottom orders by y then x", () => {
  const layout = new DocumentLayout({
    blocks: [
      { id: "a", bbox: [100, 50, 200, 100] },
      { id: "b", bbox: [0, 0, 50, 20] },
      { id: "c", bbox: [0, 50, 50, 100] },
    ],
  });
  layout.sortTopToBottom();
  assert.deepEqual(layout.blocks.map((b) => b.id), ["b", "c", "a"]);
});

// ---- Word / line / block grouping ----------------------------------------

test("groupWordsIntoLines groups words within y tolerance", () => {
  const words = [
    { text: "Hello", bbox: [0, 0, 40, 10] },
    { text: "World", bbox: [50, 2, 100, 11] },
    { text: "Second", bbox: [0, 30, 60, 40] },
    { text: "line", bbox: [70, 31, 100, 41] },
  ];
  const lines = groupWordsIntoLines(words, 3);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Hello World");
  assert.equal(lines[1].text, "Second line");
});

test("groupWordsIntoLines respects a tight y tolerance", () => {
  const words = [
    { text: "A", bbox: [0, 0, 10, 10] },
    { text: "B", bbox: [20, 6, 30, 16] }, // y-center 11, prev y-center 5
  ];
  const loose = groupWordsIntoLines(words, 10);
  assert.equal(loose.length, 1);
  const strict = groupWordsIntoLines(words, 2);
  assert.equal(strict.length, 2);
});

test("groupLinesIntoBlocks splits on large vertical gaps", () => {
  const lines = [
    { bbox: [0, 0, 100, 10], text: "line1", words: [] },
    { bbox: [0, 15, 100, 25], text: "line2", words: [] },
    { bbox: [0, 80, 100, 90], text: "line3", words: [] }, // gap of 55
  ];
  const blocks = groupLinesIntoBlocks(lines, 10);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "line1\nline2");
  assert.equal(blocks[1].text, "line3");
});

// ---- extractLayout --------------------------------------------------------

test("extractLayout turns synthetic words into labeled blocks", () => {
  const words = [
    // Title line (short, top)
    { text: "My", bbox: [0, 0, 30, 15] },
    { text: "Title", bbox: [35, 0, 100, 15] },
    // Paragraph
    { text: "Hello", bbox: [0, 40, 50, 55] },
    { text: "world", bbox: [55, 40, 110, 55] },
    { text: "this", bbox: [0, 60, 40, 75] },
    { text: "is", bbox: [45, 60, 65, 75] },
    { text: "text", bbox: [70, 60, 110, 75] },
  ];
  const blocks = extractLayout(words);
  assert.ok(blocks.length >= 2);
  const title = blocks.find((b) => b.type === "title");
  assert.ok(title, "expected a title block");
  assert.equal(title.text, "My Title");
});

test("extractLayout returns empty array for empty input", () => {
  assert.deepEqual(extractLayout([]), []);
  assert.deepEqual(extractLayout(null), []);
});

// ---- detectTables ---------------------------------------------------------

test("detectTables classifies grid-aligned blocks as tables", () => {
  // Build synthetic words forming 3 rows x 3 columns.
  const cols = [0, 100, 200];
  const rows = [0, 20, 40];
  const words = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      words.push({
        text: `r${r}c${c}`,
        bbox: [cols[c], rows[r], cols[c] + 50, rows[r] + 10],
      });
    }
  }
  const blocks = extractLayout(words, { ySpacing: 20 });
  const tables = blocks.filter((b) => b.type === "table");
  assert.ok(tables.length >= 1, "expected at least one table block");
  assert.equal(tables[0].metadata.columns, 3);
});

// ---- detectFormFields -----------------------------------------------------

test("detectFormFields finds label+value patterns", () => {
  const blocks = [
    new LayoutBlock({ type: "paragraph", text: "Name: John Smith", bbox: [0, 0, 200, 20] }),
    new LayoutBlock({ type: "paragraph", text: "Email: ___________", bbox: [0, 30, 200, 50] }),
    new LayoutBlock({ type: "paragraph", text: "Just a regular paragraph.", bbox: [0, 60, 200, 80] }),
  ];
  const fields = detectFormFields(blocks);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].metadata.label, "Name");
  assert.equal(fields[0].metadata.value, "John Smith");
  assert.equal(fields[1].metadata.label, "Email");
});

test("detectFigures classifies blocks overlapping image regions", () => {
  const blocks = [
    new LayoutBlock({ type: "paragraph", bbox: [0, 0, 100, 100] }),
    new LayoutBlock({ type: "paragraph", bbox: [500, 500, 600, 600] }),
  ];
  const figures = detectFigures(blocks, [{ bbox: [450, 450, 700, 700] }]);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].type, "figure");
});

// ---- Table export ---------------------------------------------------------

test("extractTable produces rows and headers from lines metadata", () => {
  const block = new LayoutBlock({
    type: "table",
    bbox: [0, 0, 300, 50],
    metadata: {
      lines: [
        {
          bbox: [0, 0, 300, 10],
          text: "Name Age City",
          words: [
            { text: "Name", bbox: [0, 0, 40, 10] },
            { text: "Age", bbox: [100, 0, 140, 10] },
            { text: "City", bbox: [200, 0, 240, 10] },
          ],
        },
        {
          bbox: [0, 20, 300, 30],
          text: "Alice 30 NYC",
          words: [
            { text: "Alice", bbox: [0, 20, 40, 30] },
            { text: "30", bbox: [100, 20, 140, 30] },
            { text: "NYC", bbox: [200, 20, 240, 30] },
          ],
        },
        {
          bbox: [0, 40, 300, 50],
          text: "Bob 25 LA",
          words: [
            { text: "Bob", bbox: [0, 40, 40, 50] },
            { text: "25", bbox: [100, 40, 140, 50] },
            { text: "LA", bbox: [200, 40, 240, 50] },
          ],
        },
      ],
    },
  });
  const table = extractTable(block);
  assert.deepEqual(table.headers, ["Name", "Age", "City"]);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], ["Alice", "30", "NYC"]);
});

test("tableToJson converts rows into object records keyed by header", () => {
  const table = {
    headers: ["name", "age"],
    rows: [
      ["Alice", "30"],
      ["Bob", "25"],
    ],
  };
  assert.deepEqual(tableToJson(table), [
    { name: "Alice", age: "30" },
    { name: "Bob", age: "25" },
  ]);
});

test("tableToCsv escapes special characters", () => {
  const table = {
    headers: ["name", "note"],
    rows: [
      ["Alice", 'hello, "world"'],
      ["Bob", "plain"],
    ],
  };
  const csv = tableToCsv(table);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "name,note");
  assert.match(lines[1], /^Alice,"hello, ""world"""$/);
});

test("tableToMarkdown renders a pipe table", () => {
  const md = tableToMarkdown({
    headers: ["name", "age"],
    rows: [
      ["Alice", "30"],
      ["Bob", "25"],
    ],
  });
  const lines = md.split("\n");
  assert.equal(lines.length, 4); // header + separator + 2 rows
  assert.ok(lines[0].startsWith("| "));
  assert.ok(lines[1].includes("---"));
  assert.ok(lines[2].includes("Alice"));
});

// ---- extractFormFields ----------------------------------------------------

test("extractFormFields returns structured field records", () => {
  const layout = new DocumentLayout({
    blocks: [
      {
        type: "form_field",
        bbox: [0, 0, 200, 20],
        text: "Full Name: Alice Smith",
        metadata: { label: "Full Name", value: "Alice Smith" },
      },
      { type: "paragraph", bbox: [0, 30, 200, 50], text: "ignored" },
      {
        type: "form_field",
        bbox: [0, 60, 200, 80],
        text: "Email:",
        metadata: { label: "Email", value: "" },
      },
    ],
  });
  const fields = extractFormFields(layout);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].name, "full_name");
  assert.equal(fields[0].label, "Full Name");
  assert.equal(fields[0].value, "Alice Smith");
  assert.equal(fields[1].name, "email");
});

// ---- Reading order and columns -------------------------------------------

test("computeReadingOrder orders single-column blocks top-to-bottom", () => {
  const blocks = [
    new LayoutBlock({ id: "c", bbox: [0, 200, 400, 250] }),
    new LayoutBlock({ id: "a", bbox: [0, 0, 400, 50] }),
    new LayoutBlock({ id: "b", bbox: [0, 100, 400, 150] }),
  ];
  const ordered = computeReadingOrder(blocks);
  assert.deepEqual(ordered.map((b) => b.id), ["a", "b", "c"]);
});

test("detectColumns separates a two-column layout", () => {
  const blocks = [
    new LayoutBlock({ id: "L1", bbox: [0, 0, 200, 50] }),
    new LayoutBlock({ id: "L2", bbox: [0, 60, 200, 110] }),
    new LayoutBlock({ id: "R1", bbox: [300, 0, 500, 50] }),
    new LayoutBlock({ id: "R2", bbox: [300, 60, 500, 110] }),
  ];
  const cols = detectColumns(blocks);
  assert.equal(cols.length, 2);
  assert.equal(cols[0].blocks.length, 2);
  assert.equal(cols[1].blocks.length, 2);

  const ordered = computeReadingOrder(blocks);
  assert.deepEqual(ordered.map((b) => b.id), ["L1", "L2", "R1", "R2"]);
});

// ---- Storage --------------------------------------------------------------

test("saveLayout + getLayout roundtrips", async () => {
  const layout = new DocumentLayout({
    pageNumber: 1,
    width: 800,
    height: 1000,
    blocks: [
      { type: "title", bbox: [0, 0, 300, 30], text: "Doc" },
      { type: "paragraph", bbox: [0, 40, 300, 200], text: "Body text" },
    ],
  });
  await saveLayout("doc-1", layout, { workspaceId: "ws-test" });
  const loaded = await getLayout("doc-1");
  assert.ok(loaded instanceof DocumentLayout);
  assert.equal(loaded.blocks.length, 2);
  assert.equal(loaded.blocks[0].type, "title");
  assert.equal(loaded.blocks[1].text, "Body text");
});

test("listLayouts lists saved layouts and filters by workspace", async () => {
  await saveLayout(
    "doc-a",
    new DocumentLayout({ blocks: [{ type: "paragraph", bbox: [0, 0, 10, 10] }] }),
    { workspaceId: "alpha" },
  );
  await saveLayout(
    "doc-b",
    new DocumentLayout({ blocks: [{ type: "paragraph", bbox: [0, 0, 10, 10] }] }),
    { workspaceId: "beta" },
  );
  const all = await listLayouts();
  assert.ok(all.length >= 2);
  const alphaOnly = await listLayouts("alpha");
  assert.ok(alphaOnly.every((r) => r.workspaceId === "alpha"));
  assert.ok(alphaOnly.some((r) => r.docId === "doc-a"));
});

test("getLayout returns null for unknown docId", async () => {
  const loaded = await getLayout("does-not-exist");
  assert.equal(loaded, null);
});

// ---- Empty / invalid input handling ---------------------------------------

test("groupWordsIntoLines + groupLinesIntoBlocks handle empty input", () => {
  assert.deepEqual(groupWordsIntoLines([]), []);
  assert.deepEqual(groupLinesIntoBlocks([]), []);
  assert.deepEqual(detectTables([]), []);
  assert.deepEqual(detectFormFields([]), []);
  assert.deepEqual(detectFigures([]), []);
  assert.deepEqual(computeReadingOrder([]), []);
  assert.deepEqual(detectColumns([]), []);
});
