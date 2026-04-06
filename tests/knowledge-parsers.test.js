/**
 * Tests for knowledge-parsers.js document format parsers.
 * Phase 17: Added JSON parser, frontmatter, heading preservation, chunking strategy tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import archiver from "archiver";

/** Cross-platform ZIP (CI + Windows dev); avoids shell `zip` binary. */
async function zipDirectoryToBuffer(absDir) {
  const outZip = join(tmpdir(), `knowledge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outZip);
    const archive = archiver("zip", { zlib: { level: 5 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(absDir, false);
    archive.finalize();
  });
  const buf = readFileSync(outZip);
  rmSync(outZip, { force: true });
  return buf;
}

const {
  parseDocument,
  SUPPORTED_DOCUMENT_MIMES,
  parseHtmlString,
  parseCsvString,
  parseMarkdownString,
  parseJsonString,
  autoDetectAndParse,
} = await import("../lib/knowledge-parsers.js");

const {
  chunkPlainText,
  chunkByFixed,
  chunkBySentence,
  chunkByParagraph,
  chunkByHeading,
  chunkWithStrategy,
} = await import("../lib/knowledge-chunking.js");

// ---------------------------------------------------------------------------
// HTML tests
// ---------------------------------------------------------------------------

test("parseDocument HTML: strips tags and extracts text", async () => {
  const html = Buffer.from(
    "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World &amp; friends</p></body></html>",
  );
  const result = await parseDocument(html, "text/html", "test.html");
  assert.ok(result.text.includes("Hello"));
  assert.ok(result.text.includes("World & friends"));
  assert.equal(result.metadata.title, "Test Page");
});

test("parseDocument HTML: strips script and style blocks", async () => {
  const html = Buffer.from(
    "<html><body><script>alert('xss')</script><style>.x{color:red}</style><p>Safe content</p></body></html>",
  );
  const result = await parseDocument(html, "text/html");
  assert.ok(result.text.includes("Safe content"));
  assert.ok(!result.text.includes("alert"));
  assert.ok(!result.text.includes("color:red"));
});

test("parseDocument HTML: handles common entities", async () => {
  const html = Buffer.from("<p>&lt;tag&gt; &quot;quoted&quot; &amp; &nbsp;space</p>");
  const result = await parseDocument(html, "text/html");
  assert.ok(result.text.includes('<tag> "quoted" &'));
  assert.ok(result.text.includes("space"));
});

test("parseDocument HTML: extracts meta description", async () => {
  const html = Buffer.from(
    '<html><head><meta name="description" content="A test description"></head><body>Body</body></html>',
  );
  const result = await parseDocument(html, "text/html");
  assert.equal(result.metadata.description, "A test description");
});

// ---------------------------------------------------------------------------
// Markdown tests
// ---------------------------------------------------------------------------

test("parseDocument Markdown: strips header markers", async () => {
  const md = Buffer.from("# Title\n\n## Subtitle\n\nSome paragraph text.\n");
  const result = await parseDocument(md, "text/markdown", "doc.md");
  assert.ok(result.text.includes("Title"));
  assert.ok(result.text.includes("Subtitle"));
  assert.ok(result.text.includes("Some paragraph text."));
  assert.ok(!result.text.includes("# "));
});

test("parseDocument Markdown: strips links and images", async () => {
  const md = Buffer.from("[Click here](http://example.com) and ![alt](img.png)");
  const result = await parseDocument(md, "text/markdown");
  assert.ok(result.text.includes("Click here"));
  assert.ok(result.text.includes("alt"));
  assert.ok(!result.text.includes("http://example.com"));
  assert.ok(!result.text.includes("img.png"));
});

test("parseDocument Markdown: strips code fences but preserves content", async () => {
  const md = Buffer.from("```js\nconsole.log('hello');\n```\n\nOutside code.");
  const result = await parseDocument(md, "text/markdown");
  assert.ok(result.text.includes("console.log"));
  assert.ok(result.text.includes("Outside code."));
});

test("parseDocument Markdown: strips bold/italic markers", async () => {
  const md = Buffer.from("**bold** and *italic* and ***both***");
  const result = await parseDocument(md, "text/markdown");
  assert.ok(result.text.includes("bold"));
  assert.ok(result.text.includes("italic"));
  assert.ok(!result.text.includes("**"));
  assert.ok(!result.text.includes("*italic*"));
});

// ---------------------------------------------------------------------------
// CSV tests
// ---------------------------------------------------------------------------

test("parseDocument CSV: parses rows with header detection", async () => {
  const csv = Buffer.from("Name,Age,City\nAlice,30,NYC\nBob,25,LA\n");
  const result = await parseDocument(csv, "text/csv", "data.csv");
  assert.ok(result.text.includes("Name: Alice"));
  assert.ok(result.text.includes("Age: 30"));
  assert.ok(result.text.includes("City: NYC"));
  assert.ok(result.text.includes("Name: Bob"));
  assert.equal(result.metadata.columns, 3);
  assert.equal(result.metadata.rows, 2);
});

test("parseDocument CSV: handles quoted fields", async () => {
  const csv = Buffer.from('Name,Description\nItem,"A ""quoted"" value"\n');
  const result = await parseDocument(csv, "text/csv");
  assert.ok(result.text.includes('A "quoted" value'));
});

test("parseDocument CSV: headers only", async () => {
  const csv = Buffer.from("Col1,Col2,Col3\n");
  const result = await parseDocument(csv, "text/csv");
  assert.ok(result.text.includes("Col1"));
  assert.equal(result.metadata.columns, 3);
});

// ---------------------------------------------------------------------------
// DOCX tests (minimal in-memory DOCX = ZIP with XML)
// ---------------------------------------------------------------------------

/**
 * Build a minimal DOCX buffer (ZIP with word/document.xml and optional docProps).
 */
async function buildMinimalDocx(bodyText, metadata = {}) {
  const dir = mkdtempSync(join(tmpdir(), "docx-build-"));
  try {
    // Create word/document.xml
    mkdirSync(join(dir, "word"), { recursive: true });
    writeFileSync(
      join(dir, "word", "document.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    );

    if (metadata.title || metadata.author) {
      mkdirSync(join(dir, "docProps"), { recursive: true });
      writeFileSync(
        join(dir, "docProps", "core.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/">
  ${metadata.title ? `<dc:title>${metadata.title}</dc:title>` : ""}
  ${metadata.author ? `<dc:creator>${metadata.author}</dc:creator>` : ""}
</cp:coreProperties>`,
      );
    }

    writeFileSync(
      join(dir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
    );

    return await zipDirectoryToBuffer(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseDocument DOCX: extracts text from minimal docx", async () => {
  const buffer = await buildMinimalDocx("Hello from DOCX");
  const result = await parseDocument(
    buffer,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "test.docx",
  );
  assert.ok(result.text.includes("Hello from DOCX"), `Expected text to contain "Hello from DOCX", got: ${result.text}`);
});

test("parseDocument DOCX: extracts metadata", async () => {
  const buffer = await buildMinimalDocx("Content", { title: "My Doc", author: "Jane" });
  const result = await parseDocument(buffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(result.metadata.title, "My Doc");
  assert.equal(result.metadata.author, "Jane");
});

// ---------------------------------------------------------------------------
// XLSX tests (minimal in-memory XLSX = ZIP with XML)
// ---------------------------------------------------------------------------

async function buildMinimalXlsx(rows) {
  const dir = mkdtempSync(join(tmpdir(), "xlsx-build-"));
  try {
    // Build shared strings
    const allStrings = [];
    for (const row of rows) {
      for (const cell of row) {
        if (typeof cell === "string" && !allStrings.includes(cell)) {
          allStrings.push(cell);
        }
      }
    }

    mkdirSync(join(dir, "xl", "worksheets"), { recursive: true });

    writeFileSync(
      join(dir, "xl", "sharedStrings.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allStrings.length}" uniqueCount="${allStrings.length}">
${allStrings.map((s) => `<si><t>${s}</t></si>`).join("\n")}
</sst>`,
    );

    const rowsXml = rows
      .map((row, ri) => {
        const cells = row
          .map((cell, ci) => {
            const ref = String.fromCharCode(65 + ci) + (ri + 1);
            if (typeof cell === "number") {
              return `<c r="${ref}"><v>${cell}</v></c>`;
            }
            const idx = allStrings.indexOf(cell);
            return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("\n");

    writeFileSync(
      join(dir, "xl", "worksheets", "sheet1.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`,
    );

    writeFileSync(
      join(dir, "xl", "workbook.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets>
</workbook>`,
    );

    writeFileSync(
      join(dir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
    );

    return await zipDirectoryToBuffer(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseDocument XLSX: extracts cell data with sheet name", async () => {
  const buffer = await buildMinimalXlsx([
    ["Name", "Score"],
    ["Alice", "95"],
    ["Bob", "87"],
  ]);
  const result = await parseDocument(
    buffer,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "data.xlsx",
  );
  assert.ok(result.text.includes("Data"), "Should include sheet name 'Data'");
  assert.ok(result.text.includes("Name"), "Should include header 'Name'");
  assert.ok(result.text.includes("Alice"), "Should include cell 'Alice'");
  assert.ok(result.text.includes("95"), "Should include cell '95'");
  assert.ok(result.text.includes("Bob"), "Should include cell 'Bob'");
});

// ---------------------------------------------------------------------------
// HTML heading preservation tests (Phase 17)
// ---------------------------------------------------------------------------

test("parseDocument HTML: preserves headings as section markers", async () => {
  const html = Buffer.from(
    "<html><body><h1>Main Title</h1><p>Intro text.</p><h2>Section One</h2><p>Content one.</p><h3>Subsection</h3><p>Details.</p></body></html>",
  );
  const result = await parseDocument(html, "text/html");
  assert.ok(result.text.includes("# Main Title"), "Should have h1 as # marker");
  assert.ok(result.text.includes("## Section One"), "Should have h2 as ## marker");
  assert.ok(result.text.includes("### Subsection"), "Should have h3 as ### marker");
  assert.ok(result.metadata.sections?.length >= 3, "Should extract sections metadata");
});

test("parseDocument HTML: extracts title from h1 when no title tag", async () => {
  const html = Buffer.from("<html><body><h1>Fallback Title</h1><p>Body text.</p></body></html>");
  const result = await parseDocument(html, "text/html");
  assert.equal(result.metadata.title, "Fallback Title");
});

// ---------------------------------------------------------------------------
// Markdown frontmatter tests (Phase 17)
// ---------------------------------------------------------------------------

test("parseDocument Markdown: extracts YAML frontmatter", async () => {
  const md = Buffer.from(`---
title: My Document
author: Jane Doe
date: 2024-01-15
---

# Introduction

Some content here.
`);
  const result = await parseDocument(md, "text/markdown", "doc.md");
  assert.equal(result.metadata.title, "My Document");
  assert.equal(result.metadata.author, "Jane Doe");
  assert.equal(result.metadata.date, "2024-01-15");
  assert.ok(result.text.includes("Introduction"));
  assert.ok(!result.text.includes("---"));
});

test("parseDocument Markdown: extracts section headings as metadata", async () => {
  const md = Buffer.from("# Title\n\n## Section A\n\nText A.\n\n## Section B\n\nText B.\n");
  const result = await parseDocument(md, "text/markdown", "doc.md");
  assert.ok(result.metadata.sections?.length >= 2, "Should extract heading sections");
});

// ---------------------------------------------------------------------------
// JSON parser tests (Phase 17)
// ---------------------------------------------------------------------------

test("parseDocument JSON: pretty-prints and extracts metadata", async () => {
  const json = Buffer.from(JSON.stringify({ title: "Test Doc", items: [1, 2, 3] }));
  const result = await parseDocument(json, "application/json", "data.json");
  assert.ok(result.text.includes('"title": "Test Doc"'), "Should pretty-print JSON");
  assert.ok(result.text.includes('"items"'), "Should include keys");
  assert.equal(result.metadata.title, "Test Doc");
  assert.equal(result.metadata.type, "object");
});

test("parseDocument JSON: handles arrays", async () => {
  const json = Buffer.from(JSON.stringify([{ name: "Alice" }, { name: "Bob" }]));
  const result = await parseDocument(json, "application/json", "list.json");
  assert.equal(result.metadata.type, "array");
  assert.equal(result.metadata.length, 2);
  assert.ok(result.text.includes("Alice"));
});

test("parseDocument JSON: extracts key paths", async () => {
  const json = Buffer.from(JSON.stringify({ user: { name: "Test", email: "test@example.com" } }));
  const result = await parseDocument(json, "application/json");
  assert.ok(result.metadata.keyPaths?.includes("user"));
  assert.ok(result.metadata.keyPaths?.includes("user.name"));
  assert.ok(result.metadata.keyPaths?.includes("user.email"));
});

test("parseDocument JSON: handles invalid JSON gracefully", async () => {
  const json = Buffer.from("{ invalid json }");
  const result = await parseDocument(json, "application/json");
  assert.ok(result.metadata.parseError, "Should flag parse error");
  assert.ok(result.text.includes("invalid json"));
});

test("parseDocument JSON: uses name/label as title fallback", async () => {
  const json = Buffer.from(JSON.stringify({ name: "My Config", version: "1.0" }));
  const result = await parseDocument(json, "application/json");
  assert.equal(result.metadata.title, "My Config");
});

// ---------------------------------------------------------------------------
// Standalone parser exports (Phase 17)
// ---------------------------------------------------------------------------

test("parseHtmlString: works with string input", () => {
  const result = parseHtmlString("<h1>Hello</h1><p>World</p>");
  assert.ok(result.text.includes("Hello"));
  assert.ok(result.text.includes("World"));
  assert.equal(result.title, "Hello");
});

test("parseCsvString: works with string input", () => {
  const result = parseCsvString("Name,Age\nAlice,30\n");
  assert.ok(result.text.includes("Name: Alice"));
  assert.equal(result.metadata.columns, 2);
});

test("parseMarkdownString: works with string input", () => {
  const result = parseMarkdownString("# Title\n\nParagraph text.");
  assert.ok(result.text.includes("Title"));
  assert.ok(result.text.includes("Paragraph text."));
});

test("parseJsonString: works with string input", () => {
  const result = parseJsonString('{"key": "value"}');
  assert.ok(result.text.includes('"key": "value"'));
});

// ---------------------------------------------------------------------------
// Auto-detect tests (Phase 17)
// ---------------------------------------------------------------------------

test("autoDetectAndParse: detects HTML", () => {
  const result = autoDetectAndParse("<html><body><p>Hello</p></body></html>");
  assert.equal(result.detectedType, "text/html");
  assert.ok(result.text.includes("Hello"));
});

test("autoDetectAndParse: detects JSON", () => {
  const result = autoDetectAndParse('{"key": "value"}');
  assert.equal(result.detectedType, "application/json");
});

test("autoDetectAndParse: detects Markdown", () => {
  const result = autoDetectAndParse("# Title\n\nSome content here.");
  assert.equal(result.detectedType, "text/markdown");
});

test("autoDetectAndParse: respects hint", () => {
  const result = autoDetectAndParse("Name,Age\nAlice,30", "csv");
  assert.equal(result.detectedType, "text/csv");
});

test("autoDetectAndParse: falls back to plain text", () => {
  const result = autoDetectAndParse("Just some plain text without special formatting.");
  assert.equal(result.detectedType, "text/plain");
});

// ---------------------------------------------------------------------------
// Chunking strategy tests (Phase 17)
// ---------------------------------------------------------------------------

test("chunkByFixed: works like chunkPlainText", () => {
  const text = "A".repeat(1000);
  const chunks = chunkByFixed(text, 300, 50);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 300);
  }
});

test("chunkBySentence: splits at sentence boundaries", () => {
  const sentences = [];
  for (let i = 0; i < 20; i++) {
    sentences.push(`This is sentence number ${i} with some extra words to make it longer.`);
  }
  const text = sentences.join(" ");
  const chunks = chunkBySentence(text, 300, 0);
  assert.ok(chunks.length > 1, "Should produce multiple chunks");
  for (const c of chunks) {
    assert.ok(c.length <= 300, `Chunk should be <= 300 chars, got ${c.length}`);
  }
});

test("chunkBySentence: handles overlap", () => {
  const text = "First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here.";
  const chunks = chunkBySentence(text, 60, 30);
  assert.ok(chunks.length >= 2, "Should produce multiple chunks");
});

test("chunkBySentence: returns single chunk for short text", () => {
  const chunks = chunkBySentence("Short text.", 4000, 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Short text.");
});

test("chunkByParagraph: splits at double newlines", () => {
  const paragraphs = [];
  for (let i = 0; i < 10; i++) {
    paragraphs.push(`This is paragraph ${i}. It has enough content to be meaningful and contribute to chunk size.`);
  }
  const text = paragraphs.join("\n\n");
  const chunks = chunkByParagraph(text, 300, 0);
  assert.ok(chunks.length > 1, "Should produce multiple chunks");
  for (const c of chunks) {
    assert.ok(c.length <= 300, `Chunk should be <= 300 chars, got ${c.length}`);
  }
});

test("chunkByParagraph: handles overlap", () => {
  const text = "Para one content.\n\nPara two content.\n\nPara three content.\n\nPara four content.";
  const chunks = chunkByParagraph(text, 50, 20);
  assert.ok(chunks.length >= 2);
});

test("chunkByHeading: splits at markdown headings", () => {
  const text = `# Introduction

Intro content here with some text.

## Section One

First section content that is detailed.

## Section Two

Second section content that is also detailed.

### Subsection

More content in subsection.`;
  const chunks = chunkByHeading(text, 200);
  assert.ok(chunks.length >= 2, `Should produce multiple chunks, got ${chunks.length}`);
  // First chunk should start with intro or heading
  assert.ok(chunks[0].includes("Introduction") || chunks[0].includes("Intro"));
});

test("chunkByHeading: returns single chunk for short text", () => {
  const text = "# Title\n\nShort content.";
  const chunks = chunkByHeading(text, 4000);
  assert.equal(chunks.length, 1);
});

test("chunkByHeading: sub-chunks large sections", () => {
  const text = "# Title\n\n" + "A".repeat(1000) + "\n\n## Next\n\nShort.";
  const chunks = chunkByHeading(text, 300);
  assert.ok(chunks.length >= 2, "Should sub-chunk large section");
});

test("chunkWithStrategy: dispatches to correct strategy", () => {
  const text = "Sentence one. Sentence two. Sentence three. Sentence four. Sentence five. Sentence six. Sentence seven. Sentence eight. Sentence nine. Sentence ten.";
  const fixed = chunkWithStrategy(text, { strategy: "fixed", maxChars: 60 });
  const sentence = chunkWithStrategy(text, { strategy: "sentence", maxChars: 60 });
  assert.ok(fixed.length > 0);
  assert.ok(sentence.length > 0);
});

test("chunkWithStrategy: handles empty text", () => {
  assert.deepEqual(chunkWithStrategy("", { strategy: "sentence" }), []);
  assert.deepEqual(chunkWithStrategy("", { strategy: "paragraph" }), []);
  assert.deepEqual(chunkWithStrategy("", { strategy: "heading" }), []);
});

// ---------------------------------------------------------------------------
// SUPPORTED_DOCUMENT_MIMES
// ---------------------------------------------------------------------------

test("SUPPORTED_DOCUMENT_MIMES includes all expected types", () => {
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/html"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/markdown"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/csv"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/plain"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("application/json"));
  assert.ok(
    SUPPORTED_DOCUMENT_MIMES.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
  );
  assert.ok(
    SUPPORTED_DOCUMENT_MIMES.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
  );
});

// ---------------------------------------------------------------------------
// Unsupported format
// ---------------------------------------------------------------------------

test("parseDocument throws on unsupported MIME type", async () => {
  await assert.rejects(
    () => parseDocument(Buffer.from("data"), "application/octet-stream", "file.bin"),
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_FORMAT");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Plain text fallback
// ---------------------------------------------------------------------------

test("parseDocument plain text passthrough", async () => {
  const buf = Buffer.from("Just plain text content.");
  const result = await parseDocument(buf, "text/plain", "notes.txt");
  assert.equal(result.text, "Just plain text content.");
  assert.deepEqual(result.metadata, {});
});
