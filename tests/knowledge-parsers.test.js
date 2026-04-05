/**
 * Tests for knowledge-parsers.js document format parsers.
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

const { parseDocument, SUPPORTED_DOCUMENT_MIMES } = await import("../lib/knowledge-parsers.js");

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
// SUPPORTED_DOCUMENT_MIMES
// ---------------------------------------------------------------------------

test("SUPPORTED_DOCUMENT_MIMES includes all expected types", () => {
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/html"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/markdown"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/csv"));
  assert.ok(SUPPORTED_DOCUMENT_MIMES.includes("text/plain"));
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
