/**
 * OCR processing via Tesseract.js with PDF fallback using pdf-parse.
 *
 * @module lib/ocr
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
]);

const SUPPORTED_PDF_MIME = "application/pdf";

/**
 * Check whether a MIME type is supported for OCR.
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isSupportedMime(mimeType) {
  return SUPPORTED_IMAGE_MIMES.has(mimeType) || mimeType === SUPPORTED_PDF_MIME;
}

/**
 * Extract text from an image buffer using Tesseract.js, or from a PDF using pdf-parse.
 *
 * @param {Buffer} buffer  – file contents
 * @param {string} mimeType – MIME type of the file
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function extractText(buffer, mimeType) {
  if (mimeType === SUPPORTED_PDF_MIME) {
    return extractPdfText(buffer);
  }

  if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
    throw Object.assign(
      new Error(`Unsupported MIME type for OCR: ${mimeType}`),
      { code: "UNSUPPORTED_FORMAT" }
    );
  }

  return extractImageText(buffer);
}

/**
 * Resolve the local langPath for tesseract training data.
 * Falls back to letting Tesseract.js use its CDN default if the npm package is not installed.
 */
function resolveLangPath() {
  try {
    const require = createRequire(import.meta.url);
    const engPkg = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    return join(engPkg, "4.0.0_best_int");
  } catch {
    return undefined; // fall back to CDN
  }
}

/**
 * Run Tesseract OCR on an image buffer.
 */
async function extractImageText(buffer) {
  const Tesseract = await import("tesseract.js");
  const createWorker = Tesseract.createWorker || Tesseract.default?.createWorker;
  if (!createWorker) {
    throw new Error("Failed to load Tesseract.js createWorker function");
  }
  const langPath = resolveLangPath();
  const workerOpts = { gzip: true };
  if (langPath) workerOpts.langPath = langPath;

  const worker = await createWorker("eng", 1, workerOpts);
  try {
    const { data } = await worker.recognize(buffer);
    return {
      text: (data.text || "").trim(),
      confidence: Math.round((data.confidence ?? 0) / 100 * 100) / 100, // 0-1 scale, 2 decimal places
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Extract text from a PDF buffer using pdf-parse (fallback – not true OCR).
 */
async function extractPdfText(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  const text = (
    result?.text ??
    result?.pages?.map((p) => p?.text).filter(Boolean).join("\n\n") ??
    ""
  ).trim();
  return {
    text,
    confidence: text.length > 0 ? 1.0 : 0,
  };
}
