// @ts-check
/**
 * Phase 54.5: Document layout parsing.
 *
 * Parse tables, figures, form fields, headers/footers, and reading order
 * from plain text. When caller provides optional layout hints (per-line
 * bounding boxes produced by an OCR pipeline elsewhere) we thread those
 * through so downstream callers can render annotated views; when no hints
 * are present we synthesize zero-based line/column "bboxes".
 *
 * The parser is heuristic: it doesn't require OCR, PDF.js, or any other
 * dependency. It works well on text extracted from PDF/Word exports.
 *
 * Exposed API:
 *
 *   - `parseLayout(text, opts)`        -- high-level parse, returns all regions
 *   - `extractTables(text, opts)`      -- pipe / aligned-column / markdown tables
 *   - `extractFigures(text, opts)`     -- "Figure N:" captions and placeholders
 *   - `extractFormFields(text, opts)`  -- "Label: value" and "[ ] checkbox" rows
 *   - `extractReadingOrder(text, opts)`-- paragraph-level reading order
 *
 * Each region includes a `bbox` (`{ line, col, width, height }`) so callers
 * can re-layer these on top of the original document.
 *
 * @module doc-layout
 */

const HEADER_FOOTER_MAX_LINES = 4;
const MIN_TABLE_ROWS = 2;

/* -------------------------------------------------------------------------- */
/* Top-level                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} BBox
 * @property {number} line
 * @property {number} col
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} LayoutResult
 * @property {Array<object>} tables
 * @property {Array<object>} figures
 * @property {Array<object>} formFields
 * @property {Array<object>} readingOrder
 * @property {Array<object>} headers
 * @property {Array<object>} footers
 * @property {number} totalLines
 */

/**
 * Top-level layout parse.
 *
 * @param {string} text
 * @param {{ hints?: BBox[] }} [opts]
 * @returns {LayoutResult}
 */
export function parseLayout(text, opts = {}) {
  const lines = splitLines(text);
  return {
    tables: extractTables(text, opts),
    figures: extractFigures(text, opts),
    formFields: extractFormFields(text, opts),
    readingOrder: extractReadingOrder(text, opts),
    headers: extractHeaders(lines, opts),
    footers: extractFooters(lines, opts),
    totalLines: lines.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function splitLines(text) {
  if (text == null) return [];
  const s = String(text);
  return s.split(/\r\n|\r|\n/);
}

function bboxForLines(startLine, endLine, lines) {
  const slice = lines.slice(startLine, endLine + 1);
  const width = slice.reduce((w, l) => Math.max(w, l.length), 0);
  return {
    line: startLine,
    col: 0,
    width,
    height: endLine - startLine + 1,
  };
}

function hintFor(lineIdx, hints) {
  if (!Array.isArray(hints)) return null;
  for (const h of hints) {
    if (h && typeof h === "object" && h.line === lineIdx) return h;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract tables from the text. Detects three forms:
 *
 *   1. Pipe tables: `| col1 | col2 |` -- GitHub-flavored markdown
 *   2. Whitespace-aligned columns with repeated 2-space gaps
 *   3. Simple CSV-like rows when the caller opted in via `opts.allowCsv`
 *
 * @param {string} text
 * @param {{ hints?: BBox[], allowCsv?: boolean }} [opts]
 * @returns {Array<{ type: string, rows: string[][], bbox: BBox, startLine: number, endLine: number }>}
 */
export function extractTables(text, opts = {}) {
  const lines = splitLines(text);
  const out = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || "";
    // Pipe table
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const start = i;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const stripped = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "");
        const cells = stripped.split("|").map((c) => c.trim());
        // Skip separator rows like "---|---"
        if (cells.every((c) => /^:?-+:?$/.test(c))) {
          i += 1;
          continue;
        }
        rows.push(cells);
        i += 1;
      }
      if (rows.length >= MIN_TABLE_ROWS) {
        out.push({
          type: "pipe_table",
          rows,
          startLine: start,
          endLine: i - 1,
          bbox: bboxForLines(start, i - 1, lines),
        });
      }
      continue;
    }

    // Aligned columns: at least two consecutive lines with >=2-space gaps.
    if (/\S\s{2,}\S/.test(line)) {
      const start = i;
      const rawRows = [];
      while (i < lines.length && /\S\s{2,}\S/.test(lines[i])) {
        rawRows.push(lines[i]);
        i += 1;
      }
      if (rawRows.length >= MIN_TABLE_ROWS) {
        const rows = rawRows.map((r) => r.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean));
        const widthOk = rows.every((r) => r.length >= 2);
        if (widthOk) {
          out.push({
            type: "aligned_columns",
            rows,
            startLine: start,
            endLine: i - 1,
            bbox: bboxForLines(start, i - 1, lines),
          });
          continue;
        }
      } else {
        // Not enough rows; rewind.
      }
    }

    // CSV fallback (opt-in): look for runs of comma-delimited lines.
    if (opts.allowCsv && /,/.test(line)) {
      const start = i;
      const rawRows = [];
      while (i < lines.length && /,/.test(lines[i]) && lines[i].split(",").length >= 2) {
        rawRows.push(lines[i]);
        i += 1;
      }
      if (rawRows.length >= MIN_TABLE_ROWS) {
        const rows = rawRows.map((r) => r.split(",").map((c) => c.trim()));
        out.push({
          type: "csv_block",
          rows,
          startLine: start,
          endLine: i - 1,
          bbox: bboxForLines(start, i - 1, lines),
        });
        continue;
      }
    }

    i += 1;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Figures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Detect figure captions like "Figure 1: ..." or "Fig. 2 - ...", plus image
 * placeholders such as "[IMAGE: foo.png]".
 *
 * @param {string} text
 * @param {{ hints?: BBox[] }} [opts]
 * @returns {Array<{ number?: number, caption: string, kind: string, bbox: BBox, line: number }>}
 */
export function extractFigures(text, opts = {}) {
  const lines = splitLines(text);
  const out = [];
  const re = /^\s*(fig(?:ure)?\.?\s*(\d+))\s*[:\-–]\s*(.+)$/i;
  const placeholderRe = /\[(image|figure|chart)\s*:?\s*([^\]]+)\]/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const m = line.match(re);
    if (m) {
      const hint = hintFor(i, opts.hints);
      out.push({
        kind: "caption",
        number: Number(m[2]),
        caption: m[3].trim(),
        bbox: hint || { line: i, col: 0, width: line.length, height: 1 },
        line: i,
      });
      continue;
    }
    const ph = line.match(placeholderRe);
    if (ph) {
      const hint = hintFor(i, opts.hints);
      out.push({
        kind: "placeholder",
        caption: ph[2].trim(),
        bbox: hint || { line: i, col: 0, width: line.length, height: 1 },
        line: i,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Extract form-field-like rows. Recognized shapes:
 *
 *   - "Label: value"              -> { label, value }
 *   - "Label .........: value"    -> { label, value }
 *   - "[ ] label"                 -> checkbox, unchecked
 *   - "[x] label"                 -> checkbox, checked
 *
 * @param {string} text
 * @param {{ hints?: BBox[] }} [opts]
 * @returns {Array<{ label: string, value: string|null, kind: string, checked?: boolean, bbox: BBox, line: number }>}
 */
export function extractFormFields(text, opts = {}) {
  const lines = splitLines(text);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] || "";
    const line = raw.trim();
    if (!line) continue;

    const check = line.match(/^\[\s*([xX ])\s*\]\s*(.+)$/);
    if (check) {
      const hint = hintFor(i, opts.hints);
      out.push({
        kind: "checkbox",
        label: check[2].trim(),
        value: null,
        checked: check[1].toLowerCase() === "x",
        bbox: hint || { line: i, col: 0, width: raw.length, height: 1 },
        line: i,
      });
      continue;
    }

    const kv = line.match(/^([A-Za-z][A-Za-z0-9 _#\-\/]{0,60}?)\s*(?:\.{2,}\s*:?|:)\s*(.+)$/);
    if (kv) {
      const label = kv[1].trim();
      const value = kv[2].trim();
      // Reject lines that look like sentences (end with punctuation, long).
      if (label.length > 40 || /[.!?]$/.test(value)) {
        if (!(value.length < 80 && /^[A-Za-z][A-Za-z0-9 _#\-\/]{0,40}$/.test(label))) {
          continue;
        }
      }
      const hint = hintFor(i, opts.hints);
      out.push({
        kind: "field",
        label,
        value,
        bbox: hint || { line: i, col: 0, width: raw.length, height: 1 },
        line: i,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Headers / footers                                                          */
/* -------------------------------------------------------------------------- */

function extractHeaders(lines, opts = {}) {
  const out = [];
  const upper = Math.min(lines.length, HEADER_FOOTER_MAX_LINES);
  for (let i = 0; i < upper; i += 1) {
    const l = (lines[i] || "").trim();
    if (!l) continue;
    if (looksLikeHeaderFooter(l)) {
      out.push({
        text: l,
        line: i,
        bbox: hintFor(i, opts.hints) || { line: i, col: 0, width: l.length, height: 1 },
      });
    }
  }
  return out;
}

function extractFooters(lines, opts = {}) {
  const out = [];
  const start = Math.max(0, lines.length - HEADER_FOOTER_MAX_LINES);
  for (let i = start; i < lines.length; i += 1) {
    const l = (lines[i] || "").trim();
    if (!l) continue;
    if (looksLikeHeaderFooter(l)) {
      out.push({
        text: l,
        line: i,
        bbox: hintFor(i, opts.hints) || { line: i, col: 0, width: l.length, height: 1 },
      });
    }
  }
  return out;
}

function looksLikeHeaderFooter(line) {
  if (!line) return false;
  if (line.length > 120) return false;
  if (/^page\s+\d+/i.test(line)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(line)) return true;
  if (/^\d+$/.test(line)) return true;
  if (/^chapter\s+\d+/i.test(line)) return true;
  if (/confidential/i.test(line)) return true;
  if (/\brev\.?\s*[\d.]+\b/i.test(line)) return true;
  if (/copyright/i.test(line) || /©/.test(line)) return true;
  if (/^[-_=]{5,}$/.test(line)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Reading order                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Group lines into paragraph-ish "blocks" separated by blank lines, preserving
 * original source line numbers so the caller can reconstruct reading order.
 *
 * @param {string} text
 * @param {{ hints?: BBox[] }} [opts]
 * @returns {Array<{ order: number, text: string, startLine: number, endLine: number, bbox: BBox }>}
 */
export function extractReadingOrder(text, opts = {}) {
  const lines = splitLines(text);
  const out = [];
  let order = 0;
  let start = -1;
  let buf = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] || "";
    if (l.trim() === "") {
      if (buf.length > 0) {
        out.push({
          order,
          text: buf.join("\n"),
          startLine: start,
          endLine: i - 1,
          bbox: bboxForLines(start, i - 1, lines),
        });
        order += 1;
        buf = [];
        start = -1;
      }
      continue;
    }
    if (start === -1) start = i;
    buf.push(l);
  }
  if (buf.length > 0 && start !== -1) {
    out.push({
      order,
      text: buf.join("\n"),
      startLine: start,
      endLine: lines.length - 1,
      bbox: bboxForLines(start, lines.length - 1, lines),
    });
  }
  // Tag each block with hint bboxes when available.
  if (Array.isArray(opts.hints) && opts.hints.length > 0) {
    for (const block of out) {
      const h = hintFor(block.startLine, opts.hints);
      if (h) block.bbox = h;
    }
  }
  return out;
}
