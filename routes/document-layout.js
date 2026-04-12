/**
 * Phase 54.5: Document layout parsing routes.
 *
 *   POST /api/v1/layout/extract         — build layout blocks from word-level OCR
 *   POST /api/v1/layout/tables          — detect tables among provided blocks
 *   POST /api/v1/layout/forms           — extract form fields from a layout
 *   POST /api/v1/layout/reading-order   — compute reading order for blocks
 *   POST /api/v1/layout/columns         — detect columns in a block list
 *   POST /api/v1/layout/table/json      — convert a table block to JSON records
 *   POST /api/v1/layout/table/csv       — convert a table block to CSV
 *   POST /api/v1/layout/table/markdown  — convert a table block to Markdown
 *   GET  /api/v1/layout/:id             — fetch a saved layout by doc id
 *   GET  /api/v1/layout                 — list saved layouts (optional ?workspace=…)
 *   POST /api/v1/layout                 — save a layout for a doc id
 */

import {
  LayoutBlock,
  DocumentLayout,
  extractLayout,
  detectTables,
  detectColumns,
  extractTable,
  tableToJson,
  tableToCsv,
  tableToMarkdown,
  extractFormFields,
  computeReadingOrder,
  saveLayout,
  getLayout,
  listLayouts,
} from "../lib/document-layout.js";

function toBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => (b instanceof LayoutBlock ? b : new LayoutBlock(b)));
}

function toLayout(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw instanceof DocumentLayout) return raw;
  return new DocumentLayout(raw);
}

export function mountDocumentLayoutRoutes(app, deps) {
  const { apiRoute, apiError } = deps;

  const wsOf = (req) =>
    String(req.body?.workspace || req.query?.workspace || "default");

  // POST /api/v1/layout/extract
  apiRoute("post", "/layout/extract", async (req, res) => {
    try {
      const { words, options } = req.body || {};
      if (!Array.isArray(words)) {
        return apiError(res, 400, "INVALID_INPUT", "words (array) is required");
      }
      const blocks = extractLayout(words, options || {});
      res.json({ _version: 1, blocks: blocks.map((b) => b.toJSON()), count: blocks.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "extract failed");
    }
  });

  // POST /api/v1/layout/tables
  apiRoute("post", "/layout/tables", async (req, res) => {
    try {
      const { blocks } = req.body || {};
      if (!Array.isArray(blocks)) {
        return apiError(res, 400, "INVALID_INPUT", "blocks (array) is required");
      }
      const layoutBlocks = toBlocks(blocks);
      const tables = detectTables(layoutBlocks);
      res.json({ _version: 1, tables: tables.map((b) => b.toJSON()), count: tables.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tables failed");
    }
  });

  // POST /api/v1/layout/forms
  apiRoute("post", "/layout/forms", async (req, res) => {
    try {
      const { layout, blocks } = req.body || {};
      const input = layout ? toLayout(layout) : toBlocks(blocks || []);
      if (!input) {
        return apiError(res, 400, "INVALID_INPUT", "layout or blocks is required");
      }
      const fields = extractFormFields(input);
      res.json({ _version: 1, fields, count: fields.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "forms failed");
    }
  });

  // POST /api/v1/layout/reading-order
  apiRoute("post", "/layout/reading-order", async (req, res) => {
    try {
      const { blocks } = req.body || {};
      if (!Array.isArray(blocks)) {
        return apiError(res, 400, "INVALID_INPUT", "blocks (array) is required");
      }
      const ordered = computeReadingOrder(toBlocks(blocks));
      res.json({ _version: 1, blocks: ordered.map((b) => b.toJSON()), count: ordered.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "reading-order failed");
    }
  });

  // POST /api/v1/layout/columns
  apiRoute("post", "/layout/columns", async (req, res) => {
    try {
      const { blocks } = req.body || {};
      if (!Array.isArray(blocks)) {
        return apiError(res, 400, "INVALID_INPUT", "blocks (array) is required");
      }
      const cols = detectColumns(toBlocks(blocks));
      res.json({
        _version: 1,
        columns: cols.map((c) => ({
          x1: c.x1,
          x2: c.x2,
          blocks: c.blocks.map((b) => b.toJSON()),
        })),
        count: cols.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "columns failed");
    }
  });

  // POST /api/v1/layout/table/json
  apiRoute("post", "/layout/table/json", async (req, res) => {
    try {
      const { block } = req.body || {};
      if (!block || typeof block !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "block is required");
      }
      const layoutBlock = block instanceof LayoutBlock ? block : new LayoutBlock(block);
      const table = extractTable(layoutBlock);
      res.json({ _version: 1, table, records: tableToJson(table) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "table/json failed");
    }
  });

  // POST /api/v1/layout/table/csv
  apiRoute("post", "/layout/table/csv", async (req, res) => {
    try {
      const { block } = req.body || {};
      if (!block || typeof block !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "block is required");
      }
      const layoutBlock = block instanceof LayoutBlock ? block : new LayoutBlock(block);
      const table = extractTable(layoutBlock);
      res.json({ _version: 1, csv: tableToCsv(table) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "table/csv failed");
    }
  });

  // POST /api/v1/layout/table/markdown
  apiRoute("post", "/layout/table/markdown", async (req, res) => {
    try {
      const { block } = req.body || {};
      if (!block || typeof block !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "block is required");
      }
      const layoutBlock = block instanceof LayoutBlock ? block : new LayoutBlock(block);
      const table = extractTable(layoutBlock);
      res.json({ _version: 1, markdown: tableToMarkdown(table) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "table/markdown failed");
    }
  });

  // GET /api/v1/layout  (must be registered before /layout/:id via Express insertion order;
  //  here order is fine because Express matches literal paths first? No — both match.
  //  Since :id captures anything, we register /layout (list) above /layout/:id.)
  apiRoute("get", "/layout", async (req, res) => {
    try {
      const workspace = req.query?.workspace ? String(req.query.workspace) : null;
      const layouts = await listLayouts(workspace);
      res.json({ _version: 1, layouts, count: layouts.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });

  // POST /api/v1/layout
  apiRoute("post", "/layout", async (req, res) => {
    try {
      const { docId, layout, workspace } = req.body || {};
      if (!docId || typeof docId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "docId is required");
      }
      if (!layout || typeof layout !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "layout is required");
      }
      const doc = toLayout(layout);
      const record = await saveLayout(docId, doc, {
        workspaceId: workspace || wsOf(req),
      });
      res.status(201).json({ _version: 1, record });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "save failed");
    }
  });

  // GET /api/v1/layout/:id
  apiRoute("get", "/layout/:id", async (req, res) => {
    try {
      const doc = await getLayout(req.params.id);
      if (!doc) {
        return apiError(res, 404, "NOT_FOUND", `layout ${req.params.id} not found`);
      }
      res.json({ _version: 1, layout: doc.toJSON() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "get failed");
    }
  });
}

export default mountDocumentLayoutRoutes;
