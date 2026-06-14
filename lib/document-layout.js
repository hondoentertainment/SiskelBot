// @ts-check
/**
 * Phase 54.5: Document layout parsing.
 *
 * Groups word-level OCR output into structured layout blocks (title, paragraph,
 * table, figure, form field, header, footer, list) with bounding boxes, and
 * provides table/form/reading-order extraction on top of the block structure.
 *
 * All algorithms are geometry-based and run in-process with no external deps.
 * Input is array of words: { text, bbox: [x1,y1,x2,y2], confidence }.
 *
 * Storage: JSON-backed via json-path-store so layouts persist across restarts.
 *
 * @module document-layout
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

const VALID_BLOCK_TYPES = new Set([
  "title",
  "paragraph",
  "table",
  "figure",
  "header",
  "footer",
  "list",
  "form_field",
]);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function validBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function normalizeBbox(bbox) {
  if (!validBbox(bbox)) return [0, 0, 0, 0];
  let [x1, y1, x2, y2] = bbox;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  return [x1, y1, x2, y2];
}

export class LayoutBlock {
  constructor({ id, type, bbox, text, confidence, metadata } = {}) {
    this.id = id || `block_${randomUUID()}`;
    this.type = VALID_BLOCK_TYPES.has(type) ? type : "paragraph";
    this.bbox = normalizeBbox(bbox);
    this.text = typeof text === "string" ? text : "";
    this.confidence =
      typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 1;
    this.metadata = metadata && typeof metadata === "object" ? metadata : {};
  }

  /**
   * Check whether a point lies inside this block's bounding box (inclusive).
   * @param {[number, number]} point
   */
  contains(point) {
    if (!Array.isArray(point) || point.length !== 2) return false;
    const [px, py] = point;
    const [x1, y1, x2, y2] = this.bbox;
    return px >= x1 && px <= x2 && py >= y1 && py <= y2;
  }

  /**
   * Check whether this block's bbox overlaps another block's bbox.
   * @param {LayoutBlock | { bbox: number[] }} other
   */
  overlaps(other) {
    if (!other || !Array.isArray(other.bbox) || other.bbox.length !== 4) return false;
    const [ax1, ay1, ax2, ay2] = this.bbox;
    const [bx1, by1, bx2, by2] = other.bbox;
    return !(ax2 < bx1 || bx2 < ax1 || ay2 < by1 || by2 < ay1);
  }

  /** @returns {number} */
  area() {
    const [x1, y1, x2, y2] = this.bbox;
    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);
    return w * h;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      bbox: [...this.bbox],
      text: this.text,
      confidence: this.confidence,
      metadata: { ...this.metadata },
    };
  }
}

export class DocumentLayout {
  constructor({ id, pageNumber, width, height, blocks } = {}) {
    this.id = id || `layout_${randomUUID()}`;
    this.pageNumber = Number.isFinite(pageNumber) ? pageNumber : 1;
    this.width = Number.isFinite(width) ? width : 0;
    this.height = Number.isFinite(height) ? height : 0;
    this.blocks = Array.isArray(blocks)
      ? blocks.map((b) => (b instanceof LayoutBlock ? b : new LayoutBlock(b)))
      : [];
  }

  /**
   * @param {string|null} type
   * @returns {LayoutBlock[]}
   */
  getBlocks(type = null) {
    if (!type) return [...this.blocks];
    return this.blocks.filter((b) => b.type === type);
  }

  /**
   * @param {[number, number]} point
   * @returns {LayoutBlock|null}
   */
  findBlockAt(point) {
    for (const block of this.blocks) {
      if (block.contains(point)) return block;
    }
    return null;
  }

  sortTopToBottom() {
    this.blocks.sort((a, b) => {
      if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1];
      return a.bbox[0] - b.bbox[0];
    });
    return this;
  }

  /**
   * Merge blocks by id into one block covering their bounding boxes and
   * concatenating their text.
   * @param {string[]} blockIds
   * @returns {LayoutBlock|null}
   */
  mergeBlocks(blockIds) {
    if (!Array.isArray(blockIds) || blockIds.length === 0) return null;
    const toMerge = this.blocks.filter((b) => blockIds.includes(b.id));
    if (toMerge.length === 0) return null;

    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    const texts = [];
    let confSum = 0;
    for (const b of toMerge) {
      x1 = Math.min(x1, b.bbox[0]);
      y1 = Math.min(y1, b.bbox[1]);
      x2 = Math.max(x2, b.bbox[2]);
      y2 = Math.max(y2, b.bbox[3]);
      if (b.text) texts.push(b.text);
      confSum += b.confidence;
    }

    const merged = new LayoutBlock({
      type: toMerge[0].type,
      bbox: [x1, y1, x2, y2],
      text: texts.join(" "),
      confidence: confSum / toMerge.length,
      metadata: { mergedFrom: toMerge.map((b) => b.id) },
    });

    this.blocks = this.blocks.filter((b) => !blockIds.includes(b.id));
    this.blocks.push(merged);
    return merged;
  }

  toJSON() {
    return {
      id: this.id,
      pageNumber: this.pageNumber,
      width: this.width,
      height: this.height,
      blocks: this.blocks.map((b) => b.toJSON()),
    };
  }
}

// ---------------------------------------------------------------------------
// Structure extraction from OCR-like word input
// ---------------------------------------------------------------------------

function bboxFromWords(words) {
  if (!words || words.length === 0) return [0, 0, 0, 0];
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const w of words) {
    const b = w.bbox;
    if (!validBbox(b)) continue;
    if (b[0] < x1) x1 = b[0];
    if (b[1] < y1) y1 = b[1];
    if (b[2] > x2) x2 = b[2];
    if (b[3] > y2) y2 = b[3];
  }
  if (!Number.isFinite(x1)) return [0, 0, 0, 0];
  return [x1, y1, x2, y2];
}

function avgConfidence(words) {
  if (!words || words.length === 0) return 1;
  let sum = 0;
  let n = 0;
  for (const w of words) {
    if (typeof w.confidence === "number") {
      sum += w.confidence;
      n++;
    }
  }
  return n === 0 ? 1 : sum / n;
}

/**
 * Group word-level records into logical lines based on y-center proximity.
 *
 * @param {Array<{text:string,bbox:number[],confidence?:number}>} words
 * @param {number} yTolerance
 * @returns {Array<{words:any[], bbox:number[], text:string, yCenter:number}>}
 */
export function groupWordsIntoLines(words, yTolerance = 3) {
  if (!Array.isArray(words) || words.length === 0) return [];

  // Sort by yCenter then x so stable top-to-bottom, left-to-right ordering.
  const valid = words.filter((w) => validBbox(w.bbox));
  const enriched = valid.map((w) => ({
    ...w,
    yCenter: (w.bbox[1] + w.bbox[3]) / 2,
    xStart: w.bbox[0],
  }));
  enriched.sort((a, b) => a.yCenter - b.yCenter || a.xStart - b.xStart);

  const lines = [];
  for (const w of enriched) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.yCenter - w.yCenter) <= yTolerance) {
      current.words.push(w);
      // Running average of yCenter to stabilize grouping.
      current.yCenter =
        (current.yCenter * (current.words.length - 1) + w.yCenter) / current.words.length;
    } else {
      lines.push({ yCenter: w.yCenter, words: [w] });
    }
  }

  return lines.map((line) => {
    line.words.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const bbox = bboxFromWords(line.words);
    const text = line.words.map((w) => w.text).join(" ");
    return { words: line.words, bbox, text, yCenter: line.yCenter };
  });
}

/**
 * Group lines into paragraph-like blocks based on vertical gap.
 *
 * @param {ReturnType<typeof groupWordsIntoLines>} lines
 * @param {number} ySpacing - max vertical gap between lines in a single block
 * @returns {Array<{lines:any[], bbox:number[], text:string}>}
 */
export function groupLinesIntoBlocks(lines, ySpacing = 10) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1]);

  const blocks = [];
  let current = null;
  for (const line of sorted) {
    if (!current) {
      current = { lines: [line] };
      continue;
    }
    const last = current.lines[current.lines.length - 1];
    const gap = line.bbox[1] - last.bbox[3];
    if (gap <= ySpacing) {
      current.lines.push(line);
    } else {
      blocks.push(current);
      current = { lines: [line] };
    }
  }
  if (current) blocks.push(current);

  return blocks.map((block) => {
    const allWords = block.lines.flatMap((l) => l.words || []);
    const bbox = bboxFromWords(allWords);
    const text = block.lines.map((l) => l.text).join("\n");
    return { lines: block.lines, bbox, text };
  });
}

/**
 * Detect table blocks from existing layout blocks by looking for grid-aligned
 * text. A block is considered a table if it has >= 2 lines with >= 2 columns
 * whose x starts line up across rows within a tolerance.
 *
 * @param {LayoutBlock[]} blocks
 * @returns {LayoutBlock[]} the subset of blocks classified as tables
 */
export function detectTables(blocks) {
  if (!Array.isArray(blocks)) return [];
  const tables = [];
  for (const block of blocks) {
    const lines = block?.metadata?.lines;
    if (!Array.isArray(lines) || lines.length < 2) continue;

    // Each line must contain multiple word clusters separated by wide gaps.
    const wordCountsPerLine = lines.map((l) => (l.words || []).length);
    const minCols = Math.min(...wordCountsPerLine);
    if (minCols < 2) continue;

    // Check column x-alignment across rows within ± tolerance.
    const cols = lines[0].words.map((w) => w.bbox[0]);
    const tolerance = 8;
    let aligned = true;
    for (let r = 1; r < lines.length; r++) {
      const row = lines[r].words || [];
      if (row.length < cols.length) {
        aligned = false;
        break;
      }
      for (let c = 0; c < cols.length; c++) {
        if (Math.abs(row[c].bbox[0] - cols[c]) > tolerance) {
          aligned = false;
          break;
        }
      }
      if (!aligned) break;
    }
    if (aligned) {
      block.type = "table";
      block.metadata.columns = cols.length;
      tables.push(block);
    }
  }
  return tables;
}

/**
 * Detect form fields in a list of blocks. A form field is a short block of
 * text that ends with ":" (a label) potentially followed by another short
 * block or blank space on the same line.
 *
 * @param {LayoutBlock[]} blocks
 * @returns {LayoutBlock[]}
 */
export function detectFormFields(blocks) {
  if (!Array.isArray(blocks)) return [];
  const detected = [];
  for (const block of blocks) {
    const text = (block.text || "").trim();
    // Simple label pattern: ends with ":" or looks like "Name: ____"
    if (/[A-Za-z0-9][^:\n]{0,60}:\s*[^\n]*$/m.test(text) || /_{3,}/.test(text)) {
      block.type = "form_field";
      const match = text.match(/^([^:]{1,60}):\s*(.*)$/);
      if (match) {
        block.metadata.label = match[1].trim();
        block.metadata.value = (match[2] || "").replace(/_+/g, "").trim();
      }
      detected.push(block);
    }
  }
  return detected;
}

/**
 * Identify figure regions. Optionally uses user-supplied imageRegions: any
 * block overlapping one of the regions is classified as a figure.
 *
 * @param {LayoutBlock[]} blocks
 * @param {Array<{bbox:number[]}>} imageRegions
 */
export function detectFigures(blocks, imageRegions = []) {
  if (!Array.isArray(blocks)) return [];
  const figures = [];
  const regions = Array.isArray(imageRegions) ? imageRegions : [];
  for (const block of blocks) {
    for (const region of regions) {
      if (!region || !validBbox(region.bbox)) continue;
      const probe = new LayoutBlock({ bbox: region.bbox });
      if (block.overlaps(probe)) {
        block.type = "figure";
        block.metadata.region = [...region.bbox];
        figures.push(block);
        break;
      }
    }
  }
  return figures;
}

/**
 * Main layout extraction entry point.
 *
 * @param {Array<{text:string,bbox:number[],confidence?:number}>} words
 * @param {{ yTolerance?: number, ySpacing?: number, imageRegions?: Array<{bbox:number[]}> }} [options]
 * @returns {LayoutBlock[]}
 */
export function extractLayout(words, options = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const yTolerance = Number.isFinite(options.yTolerance) ? options.yTolerance : 3;
  const ySpacing = Number.isFinite(options.ySpacing) ? options.ySpacing : 10;

  const lines = groupWordsIntoLines(words, yTolerance);
  const rawBlocks = groupLinesIntoBlocks(lines, ySpacing);

  const blocks = rawBlocks.map(
    (rb) =>
      new LayoutBlock({
        type: "paragraph",
        bbox: rb.bbox,
        text: rb.text,
        confidence: avgConfidence(rb.lines.flatMap((l) => l.words || [])),
        metadata: { lines: rb.lines.map((l) => ({ bbox: l.bbox, text: l.text, words: l.words })) },
      }),
  );

  // Classification passes: tables first, then form fields, then figures.
  detectTables(blocks);
  detectFormFields(blocks);
  if (Array.isArray(options.imageRegions) && options.imageRegions.length) {
    detectFigures(blocks, options.imageRegions);
  }

  // Heuristic: the single top-most short line on the page is a title.
  if (blocks.length > 0) {
    const topBlock = [...blocks].sort((a, b) => a.bbox[1] - b.bbox[1])[0];
    if (topBlock && topBlock.type === "paragraph") {
      const lineCount = (topBlock.metadata.lines || []).length;
      if (lineCount === 1 && topBlock.text.length < 80) {
        topBlock.type = "title";
      }
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

/**
 * Parse rows and cells from a table block. Uses the grouped line metadata if
 * present, otherwise falls back to splitting on runs of whitespace.
 *
 * @param {LayoutBlock} block
 * @returns {{ rows: string[][], headers: string[], metadata: object }}
 */
export function extractTable(block) {
  if (!block) return { rows: [], headers: [], metadata: {} };
  const lines = block?.metadata?.lines;
  const rows = [];
  if (Array.isArray(lines) && lines.length) {
    for (const line of lines) {
      const words = line.words || [];
      if (words.length === 0) continue;
      rows.push(words.map((w) => String(w.text ?? "")));
    }
  } else {
    const text = String(block.text || "");
    for (const rawLine of text.split(/\n+/)) {
      const row = rawLine.split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
      if (row.length) rows.push(row);
    }
  }
  const headers = rows.length > 0 ? rows[0] : [];
  const body = rows.slice(1);
  return {
    rows: body,
    headers,
    metadata: {
      rowCount: body.length,
      columnCount: headers.length,
      source: block.id,
    },
  };
}

export function tableToJson(table) {
  if (!table || !Array.isArray(table.rows)) return [];
  const headers = Array.isArray(table.headers) ? table.headers : [];
  return table.rows.map((row) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i] || `col${i}`] = row[i] != null ? row[i] : "";
    }
    return obj;
  });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function tableToCsv(table) {
  if (!table) return "";
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const lines = [];
  if (headers.length) lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\n");
}

export function tableToMarkdown(table) {
  if (!table) return "";
  const headers = Array.isArray(table.headers) ? table.headers : [];
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (!headers.length && !rows.length) return "";
  const widths = headers.map((h) => String(h ?? "").length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const w = String(row[i] ?? "").length;
      if (i >= widths.length) widths.push(w);
      else if (w > widths[i]) widths[i] = w;
    }
  }
  const pad = (v, i) => String(v ?? "").padEnd(widths[i] || 0, " ");
  const lines = [];
  if (headers.length) {
    lines.push(`| ${headers.map((h, i) => pad(h, i)).join(" | ")} |`);
    lines.push(`| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`);
  }
  for (const row of rows) {
    const padded = widths.map((_, i) => pad(row[i] ?? "", i));
    lines.push(`| ${padded.join(" | ")} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Form extraction
// ---------------------------------------------------------------------------

/**
 * Extract form fields from a DocumentLayout or array of blocks.
 *
 * @param {DocumentLayout | LayoutBlock[]} layout
 * @returns {Array<{ name:string, label:string, value:string, type:string, bbox:number[] }>}
 */
export function extractFormFields(layout) {
  const blocks = layout instanceof DocumentLayout ? layout.blocks : Array.isArray(layout) ? layout : [];
  const fields = [];
  for (const block of blocks) {
    if (block.type !== "form_field") continue;
    const label = (block.metadata && block.metadata.label) || "";
    const value = (block.metadata && block.metadata.value) || "";
    const name = label
      ? label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
      : block.id;
    fields.push({
      name,
      label,
      value,
      type: "text",
      bbox: [...block.bbox],
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Reading order and column detection
// ---------------------------------------------------------------------------

/**
 * Detect columns by clustering block x-centers into groups.
 *
 * @param {LayoutBlock[]} blocks
 * @returns {Array<{ x1:number, x2:number, blocks: LayoutBlock[] }>}
 */
export function detectColumns(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const sorted = [...blocks].sort((a, b) => a.bbox[0] - b.bbox[0]);
  // Build column groups from x-range non-overlap.
  const cols = [];
  for (const block of sorted) {
    const [x1, , x2] = block.bbox;
    const centerX = (x1 + x2) / 2;
    let placed = false;
    for (const col of cols) {
      // Consider them the same column if block center lies within col x-range
      // or they overlap horizontally substantially.
      const colCenter = (col.x1 + col.x2) / 2;
      const colWidth = col.x2 - col.x1;
      const blockWidth = x2 - x1;
      const overlap = Math.min(col.x2, x2) - Math.max(col.x1, x1);
      const minWidth = Math.min(colWidth, blockWidth);
      if (
        (minWidth > 0 && overlap / minWidth >= 0.5) ||
        Math.abs(colCenter - centerX) < Math.max(colWidth, blockWidth) * 0.3
      ) {
        col.blocks.push(block);
        col.x1 = Math.min(col.x1, x1);
        col.x2 = Math.max(col.x2, x2);
        placed = true;
        break;
      }
    }
    if (!placed) {
      cols.push({ x1, x2, blocks: [block] });
    }
  }
  // Sort columns left-to-right.
  cols.sort((a, b) => a.x1 - b.x1);
  return cols;
}

/**
 * Compute reading order: columns left-to-right, each column top-to-bottom.
 *
 * @param {LayoutBlock[]} blocks
 * @returns {LayoutBlock[]}
 */
export function computeReadingOrder(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const cols = detectColumns(blocks);
  if (cols.length <= 1) {
    return [...blocks].sort((a, b) => {
      if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1];
      return a.bbox[0] - b.bbox[0];
    });
  }
  const ordered = [];
  for (const col of cols) {
    const sorted = [...col.blocks].sort((a, b) => a.bbox[1] - b.bbox[1]);
    ordered.push(...sorted);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "document-layouts.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    layouts: base.layouts && typeof base.layouts === "object" ? base.layouts : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, layouts: {} }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

function layoutToRecord(layout) {
  const json = layout instanceof DocumentLayout ? layout.toJSON() : layout;
  return json && typeof json === "object" ? json : null;
}

/**
 * Save a layout for a document id. If a DocumentLayout instance is given, it
 * is serialized via toJSON().
 *
 * @param {string} docId
 * @param {DocumentLayout|object} layout
 * @param {{ workspaceId?: string }} [meta]
 */
export async function saveLayout(docId, layout, meta = {}) {
  if (!docId || typeof docId !== "string") {
    throw new Error("docId is required");
  }
  const record = layoutToRecord(layout);
  if (!record) {
    throw new Error("layout is required");
  }
  const workspaceId = meta && typeof meta.workspaceId === "string" ? meta.workspaceId : "default";
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.layouts[docId] = {
      docId,
      workspaceId,
      savedAt: Date.now(),
      layout: record,
    };
    await saveStore(store);
    return store.layouts[docId];
  });
}

/**
 * @param {string} docId
 * @returns {Promise<DocumentLayout|null>}
 */
export async function getLayout(docId) {
  if (!docId) return null;
  const store = await loadStore();
  const record = store.layouts[docId];
  if (!record) return null;
  return new DocumentLayout(record.layout);
}

/**
 * List layouts for a workspace (or all if none given).
 * @param {string|null} [workspaceId]
 */
export async function listLayouts(workspaceId = null) {
  const store = await loadStore();
  const all = Object.values(store.layouts);
  const filtered = workspaceId ? all.filter((r) => r.workspaceId === workspaceId) : all;
  return filtered.map((r) => ({
    docId: r.docId,
    workspaceId: r.workspaceId,
    savedAt: r.savedAt,
    pageNumber: r.layout?.pageNumber ?? 1,
    blockCount: Array.isArray(r.layout?.blocks) ? r.layout.blocks.length : 0,
  }));
}

export const _internals = {
  normalizeBbox,
  validBbox,
  avgConfidence,
};
