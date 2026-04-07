/**
 * Document format parsers for the knowledge pipeline.
 * Extracts plain text from various document formats.
 * Phase 17: Enhanced parsers with heading preservation, frontmatter, and JSON support.
 *
 * Supported: DOCX, XLSX, HTML, Markdown, CSV, JSON, plain text
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";

/**
 * Parse document buffer and extract text based on MIME type.
 * @param {Buffer} buffer - Document content
 * @param {string} mimeType - MIME type of the document
 * @param {string} [filename] - Original filename (for format detection fallback)
 * @returns {Promise<{ text: string, metadata: object }>}
 */
export async function parseDocument(buffer, mimeType, filename) {
  const mime = (mimeType || "").toLowerCase();
  const ext = filename ? filename.split(".").pop()?.toLowerCase() : "";

  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return parseDocx(buffer);
  }

  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx"
  ) {
    return parseXlsx(buffer);
  }

  if (mime === "text/html" || ext === "html" || ext === "htm") {
    return parseHtml(buffer);
  }

  if (mime === "text/markdown" || ext === "md" || ext === "markdown") {
    return parseMarkdown(buffer);
  }

  if (mime === "text/csv" || ext === "csv") {
    return parseCsv(buffer);
  }

  if (mime === "application/json" || ext === "json") {
    return parseJson(buffer);
  }

  // Fallback: treat as plain text
  if (mime === "text/plain" || mime === "" || ext === "txt") {
    const text = buffer.toString("utf8").trim();
    return { text, metadata: {} };
  }

  throw Object.assign(
    new Error(`Unsupported document format: ${mimeType || "unknown"}`),
    { code: "UNSUPPORTED_FORMAT" },
  );
}

/**
 * MIME types supported by the document parser.
 */
export const SUPPORTED_DOCUMENT_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/plain",
];

// ---------------------------------------------------------------------------
// DOCX parser
// ---------------------------------------------------------------------------

async function parseDocx(buffer) {
  const files = await extractZipEntries(buffer);
  const metadata = {};

  // Extract metadata from docProps/core.xml
  const corePath = "docProps/core.xml";
  if (files[corePath]) {
    const coreXml = files[corePath].toString("utf8");
    const titleMatch = coreXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/);
    if (titleMatch) metadata.title = decodeXmlEntities(titleMatch[1].trim());
    const authorMatch = coreXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/);
    if (authorMatch) metadata.author = decodeXmlEntities(authorMatch[1].trim());
    const dateMatch = coreXml.match(/<dcterms:created[^>]*>([\s\S]*?)<\/dcterms:created>/);
    if (dateMatch) metadata.created = dateMatch[1].trim();
  }

  // Extract text from word/document.xml
  const docPath = "word/document.xml";
  if (!files[docPath]) {
    throw Object.assign(new Error("Invalid DOCX: missing word/document.xml"), {
      code: "INVALID_DOCUMENT",
    });
  }

  const docXml = files[docPath].toString("utf8");
  const text = extractDocxText(docXml);
  return { text, metadata };
}

function extractDocxText(xml) {
  // Replace paragraph endings with newlines
  let text = xml.replace(/<\/w:p[^>]*>/gi, "\n");
  // Replace tabs
  text = text.replace(/<w:tab\/>/gi, "\t");
  // Replace line breaks
  text = text.replace(/<w:br[^>]*\/>/gi, "\n");
  // Strip all remaining XML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode XML entities
  text = decodeXmlEntities(text);
  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

// ---------------------------------------------------------------------------
// XLSX parser
// ---------------------------------------------------------------------------

async function parseXlsx(buffer) {
  const files = await extractZipEntries(buffer);
  const metadata = {};

  // Parse shared strings table
  const sharedStrings = [];
  const ssPath = "xl/sharedStrings.xml";
  if (files[ssPath]) {
    const ssXml = files[ssPath].toString("utf8");
    const siRegex = /<si>([\s\S]*?)<\/si>/gi;
    let match;
    while ((match = siRegex.exec(ssXml)) !== null) {
      // Extract text from <t> elements within <si>
      const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/gi;
      let fullText = "";
      let tMatch;
      while ((tMatch = tRegex.exec(match[1])) !== null) {
        fullText += decodeXmlEntities(tMatch[1]);
      }
      sharedStrings.push(fullText);
    }
  }

  // Discover sheets from workbook.xml
  const sheetNames = [];
  const wbPath = "xl/workbook.xml";
  if (files[wbPath]) {
    const wbXml = files[wbPath].toString("utf8");
    const sheetRegex = /<sheet\s+name="([^"]*)"[^>]*/gi;
    let m;
    while ((m = sheetRegex.exec(wbXml)) !== null) {
      sheetNames.push(decodeXmlEntities(m[1]));
    }
  }

  // Parse each sheet
  const sections = [];
  let sheetIndex = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) continue;
    const sheetName = sheetNames[sheetIndex] || `Sheet${sheetIndex + 1}`;
    sheetIndex++;

    const sheetXml = content.toString("utf8");
    const rows = parseSheetRows(sheetXml, sharedStrings);
    if (rows.length === 0) continue;

    const lines = rows.map((row) => row.join("\t"));
    sections.push(`## ${sheetName}\n${lines.join("\n")}`);
  }

  const text = sections.join("\n\n").trim();
  return { text, metadata };
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const cells = [];
    const cellRegex = /<c\s([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const isSharedString = /\bt="s"/.test(attrs);
      const isInlineString = /\bt="inlineStr"/.test(attrs);

      let value = "";
      if (isInlineString) {
        const tMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXmlEntities(tMatch[1]) : "";
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          if (isSharedString) {
            const idx = parseInt(vMatch[1], 10);
            value = sharedStrings[idx] ?? vMatch[1];
          } else {
            value = decodeXmlEntities(vMatch[1]);
          }
        }
      }
      cells.push(value);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// HTML parser
// ---------------------------------------------------------------------------

function parseHtml(buffer) {
  const html = buffer.toString("utf8");
  const metadata = {};

  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) metadata.title = decodeHtmlEntities(titleMatch[1].trim());

  // Fall back to first <h1> if no <title>
  if (!metadata.title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) metadata.title = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, "").trim());
  }

  // Extract <meta> description
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["'][^>]*>/i);
  if (descMatch) metadata.description = decodeHtmlEntities(descMatch[1].trim());
  if (!descMatch) {
    const descMatch2 = html.match(/<meta\s+content=["']([\s\S]*?)["']\s+name=["']description["'][^>]*>/i);
    if (descMatch2) metadata.description = decodeHtmlEntities(descMatch2[1].trim());
  }

  // Strip HTML to text, preserving headings as section markers
  let text = html;
  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Convert headings to markdown-style section markers
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n# ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n## ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n### ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `\n#### ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner) => `\n##### ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner) => `\n###### ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  // Replace block-level elements with newlines
  text = text.replace(/<\/(p|div|li|tr|blockquote|section|article|header|footer|br)[^>]*>/gi, "\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities
  text = decodeHtmlEntities(text);
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // Extract section headings for metadata
  const sections = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let m;
  while ((m = headingRegex.exec(text)) !== null) {
    sections.push({ level: m[1].length, title: m[2].trim() });
  }
  if (sections.length > 0) metadata.sections = sections;

  return { text, metadata };
}

// ---------------------------------------------------------------------------
// Markdown parser
// ---------------------------------------------------------------------------

function parseMarkdown(buffer) {
  let raw = buffer.toString("utf8");
  const metadata = {};

  // Extract YAML frontmatter (--- delimited block at start of file)
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (frontmatterMatch) {
    raw = raw.slice(frontmatterMatch[0].length);
    const yaml = frontmatterMatch[1];
    // Simple key: value parser for common frontmatter fields
    for (const line of yaml.split("\n")) {
      const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
      if (kv) {
        const key = kv[1].trim();
        let val = kv[2].trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        metadata[key] = val;
      }
    }
  }

  // Extract headings for section-aware chunking metadata
  const sections = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let hm;
  while ((hm = headingRegex.exec(raw)) !== null) {
    sections.push({ level: hm[1].length, title: hm[2].trim() });
  }
  if (sections.length > 0) metadata.sections = sections;

  let text = raw;
  // Strip code fences (preserve content)
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return inner;
  });
  // Strip inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");
  // Strip images
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Convert links to text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Strip header markers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Strip bold/italic markers
  text = text.replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, "$2");
  // Strip horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // Strip blockquote markers
  text = text.replace(/^>\s?/gm, "");

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  // Use frontmatter title if available
  if (metadata.title && !metadata.title.startsWith("{")) {
    // title already in metadata
  }

  return { text, metadata };
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

const CSV_MAX_ROWS = 10_000;

function parseCsv(buffer) {
  const raw = buffer.toString("utf8").trim();
  if (!raw) return { text: "", metadata: {} };

  const rows = parseCsvRows(raw);
  if (rows.length === 0) return { text: "", metadata: {} };

  const headers = rows[0];
  const dataRows = rows.slice(1, CSV_MAX_ROWS + 1);

  if (dataRows.length === 0) {
    // Only headers, no data
    return { text: headers.join(", "), metadata: { columns: headers.length } };
  }

  const lines = dataRows.map((row) => {
    return headers
      .map((h, i) => {
        const val = (row[i] ?? "").trim();
        return val ? `${h}: ${val}` : null;
      })
      .filter(Boolean)
      .join(", ");
  });

  const text = lines.join("\n").trim();
  return { text, metadata: { columns: headers.length, rows: dataRows.length } };
}

/**
 * Simple CSV row parser supporting quoted fields.
 */
function parseCsvRows(raw) {
  const rows = [];
  let i = 0;
  const len = raw.length;

  while (i < len) {
    const { row, nextIndex } = parseCsvRow(raw, i);
    rows.push(row);
    i = nextIndex;
    if (rows.length > CSV_MAX_ROWS + 1) break; // +1 for header
  }
  return rows;
}

function parseCsvRow(raw, start) {
  const fields = [];
  let i = start;
  const len = raw.length;

  while (i < len) {
    if (raw[i] === '"') {
      // Quoted field
      let value = "";
      i++; // skip opening quote
      while (i < len) {
        if (raw[i] === '"') {
          if (i + 1 < len && raw[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          value += raw[i];
          i++;
        }
      }
      fields.push(value);
      // Skip comma or newline after quoted field
      if (i < len && raw[i] === ",") {
        i++;
      } else if (i < len && (raw[i] === "\n" || raw[i] === "\r")) {
        if (raw[i] === "\r" && i + 1 < len && raw[i + 1] === "\n") i += 2;
        else i++;
        return { row: fields, nextIndex: i };
      }
    } else {
      // Unquoted field
      let value = "";
      while (i < len && raw[i] !== "," && raw[i] !== "\n" && raw[i] !== "\r") {
        value += raw[i];
        i++;
      }
      fields.push(value);
      if (i < len && raw[i] === ",") {
        i++;
      } else if (i < len && (raw[i] === "\n" || raw[i] === "\r")) {
        if (raw[i] === "\r" && i + 1 < len && raw[i + 1] === "\n") i += 2;
        else i++;
        return { row: fields, nextIndex: i };
      }
    }
  }
  return { row: fields, nextIndex: i };
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

const JSON_MAX_DEPTH = 10;

function parseJson(buffer) {
  const raw = buffer.toString("utf8").trim();
  const metadata = {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If JSON is invalid, treat as plain text
    return { text: raw, metadata: { parseError: true } };
  }

  // Pretty-print for readable text
  const prettyText = JSON.stringify(parsed, null, 2);

  // Extract key paths as searchable content
  const keyPaths = [];
  extractKeyPaths(parsed, "", keyPaths, 0);
  if (keyPaths.length > 0) metadata.keyPaths = keyPaths;

  // Try to extract a title from common fields
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const titleField = parsed.title || parsed.name || parsed.label || parsed.id;
    if (typeof titleField === "string" && titleField.trim()) {
      metadata.title = titleField.trim().slice(0, 200);
    }
  }

  metadata.type = Array.isArray(parsed) ? "array" : typeof parsed;
  if (Array.isArray(parsed)) metadata.length = parsed.length;

  return { text: prettyText, metadata };
}

function extractKeyPaths(obj, prefix, paths, depth) {
  if (depth > JSON_MAX_DEPTH || paths.length > 500) return;
  if (obj === null || typeof obj !== "object") return;

  const entries = Array.isArray(obj)
    ? obj.slice(0, 20).map((v, i) => [`[${i}]`, v])
    : Object.entries(obj);

  for (const [key, value] of entries) {
    const path = prefix ? (key.startsWith("[") ? `${prefix}${key}` : `${prefix}.${key}`) : key;
    paths.push(path);
    if (typeof value === "object" && value !== null) {
      extractKeyPaths(value, path, paths, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone parser exports (for direct use without Buffer wrapping)
// ---------------------------------------------------------------------------

/**
 * Parse HTML string directly.
 * @param {string} content - HTML content
 * @param {object} [options]
 * @returns {{ text: string, title?: string, metadata: object }}
 */
export function parseHtmlString(content, options = {}) {
  const result = parseHtml(Buffer.from(content, "utf8"), options);
  return { text: result.text, title: result.metadata?.title, metadata: result.metadata };
}

/**
 * Parse CSV string directly.
 * @param {string} content - CSV content
 * @param {object} [options]
 * @returns {{ text: string, title?: string, metadata: object }}
 */
export function parseCsvString(content) {
  const result = parseCsv(Buffer.from(content, "utf8"));
  return { text: result.text, title: undefined, metadata: result.metadata };
}

/**
 * Parse Markdown string directly.
 * @param {string} content - Markdown content
 * @param {object} [options]
 * @returns {{ text: string, title?: string, metadata: object }}
 */
export function parseMarkdownString(content) {
  const result = parseMarkdown(Buffer.from(content, "utf8"));
  return { text: result.text, title: result.metadata?.title, metadata: result.metadata };
}

/**
 * Parse JSON string directly.
 * @param {string} content - JSON content
 * @param {object} [options]
 * @returns {{ text: string, title?: string, metadata: object }}
 */
export function parseJsonString(content, options = {}) {
  const result = parseJson(Buffer.from(content, "utf8"));
  return { text: result.text, title: result.metadata?.title, metadata: result.metadata };
}

/**
 * Auto-detect content type from text content and return the appropriate parser result.
 * @param {string} content - Raw text content
 * @param {string} [hint] - Optional MIME type or extension hint
 * @returns {{ text: string, title?: string, metadata: object, detectedType: string }}
 */
export function autoDetectAndParse(content, hint) {
  if (typeof content !== "string" || !content.trim()) {
    return { text: "", metadata: {}, detectedType: "text/plain" };
  }

  const trimmed = content.trim();

  // Check hint first
  if (hint) {
    const h = hint.toLowerCase();
    if (h === "text/html" || h === "html" || h === "htm") {
      const r = parseHtmlString(trimmed);
      return { ...r, detectedType: "text/html" };
    }
    if (h === "text/csv" || h === "csv") {
      const r = parseCsvString(trimmed);
      return { ...r, detectedType: "text/csv" };
    }
    if (h === "text/markdown" || h === "markdown" || h === "md") {
      const r = parseMarkdownString(trimmed);
      return { ...r, detectedType: "text/markdown" };
    }
    if (h === "application/json" || h === "json") {
      const r = parseJsonString(trimmed);
      return { ...r, detectedType: "application/json" };
    }
  }

  // Auto-detect from content
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || /<\/?[a-z][\s\S]*>/i.test(trimmed.slice(0, 500))) {
    const r = parseHtmlString(trimmed);
    return { ...r, detectedType: "text/html" };
  }

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      const r = parseJsonString(trimmed);
      return { ...r, detectedType: "application/json" };
    } catch {
      // not valid JSON, fall through
    }
  }

  if (trimmed.startsWith("---\n") || /^#{1,6}\s+/m.test(trimmed)) {
    const r = parseMarkdownString(trimmed);
    return { ...r, detectedType: "text/markdown" };
  }

  // CSV heuristic: first line has commas, multiple lines
  const firstLine = trimmed.split("\n")[0];
  const lines = trimmed.split("\n").filter(Boolean);
  if (lines.length >= 2 && firstLine.includes(",") && !firstLine.includes("  ")) {
    const commaCount = (firstLine.match(/,/g) || []).length;
    if (commaCount >= 1 && commaCount <= 50) {
      const r = parseCsvString(trimmed);
      return { ...r, detectedType: "text/csv" };
    }
  }

  return { text: trimmed, metadata: {}, detectedType: "text/plain" };
}

// ---------------------------------------------------------------------------
// ZIP extraction using extract-zip
// ---------------------------------------------------------------------------

async function extractZipEntries(buffer) {
  const extractZip = (await import("extract-zip")).default;
  const tempDir = await mkdtemp(join(tmpdir(), "siskelbot-zip-"));
  const zipPath = join(tempDir, "archive.zip");
  const extractDir = join(tempDir, "out");

  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await writeFile(zipPath, buffer);
    await mkdir(extractDir, { recursive: true });
    await extractZip(zipPath, { dir: extractDir });

    // Walk the extracted directory and read files
    const entries = {};
    await walkDir(extractDir, extractDir, entries);
    return entries;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function walkDir(base, dir, entries) {
  const { readdir, stat } = await import("node:fs/promises");
  const items = await readdir(dir);
  for (const item of items) {
    const full = join(dir, item);
    const s = await stat(full);
    if (s.isDirectory()) {
      await walkDir(base, full, entries);
    } else {
      const relPath = full.slice(base.length + 1).replace(/\\/g, "/");
      entries[relPath] = await readFile(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Entity decoding helpers
// ---------------------------------------------------------------------------

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
