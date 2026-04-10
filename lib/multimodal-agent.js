/**
 * Multi-modal agent tools: vision, document extraction, capability detection.
 * Extends agent tool surface with image understanding and document processing.
 * @module lib/multimodal-agent
 */

import { extractText, isSupportedMime } from "./ocr.js";
import { isVoiceConfigured } from "./voice.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4o";
const VISION_MAX_TOKENS = Number(process.env.VISION_MAX_TOKENS) || 1024;

const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const SUPPORTED_DOC_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
]);

/**
 * Describe an image using a vision-capable model (e.g. GPT-4o).
 * @param {Buffer} imageBuffer - Raw image data
 * @param {string} [prompt] - Custom prompt for the description
 * @returns {Promise<{ description: string, objects: string[], text: string }>}
 */
export async function describeImage(imageBuffer, prompt) {
  if (!OPENAI_API_KEY) {
    throw Object.assign(
      new Error("Vision not configured. Set OPENAI_API_KEY."),
      { code: "VISION_NOT_CONFIGURED" }
    );
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw Object.assign(
      new Error("Image buffer is required and must be non-empty"),
      { code: "INVALID_INPUT" }
    );
  }

  const base64 = imageBuffer.toString("base64");
  const mime = detectImageMime(imageBuffer);
  const dataUrl = `data:${mime};base64,${base64}`;

  const systemPrompt = "You are a vision analysis assistant. When describing images, provide: 1) A concise description, 2) A list of notable objects or elements, 3) Any visible text. Respond in JSON format with keys: description, objects (array), text (extracted text or empty string).";
  const userPrompt = prompt || "Describe this image in detail. Identify objects and extract any visible text.";

  const res = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: VISION_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Vision API error: HTTP ${res.status} ${body.slice(0, 300)}`),
      { code: "BACKEND_ERROR", status: res.status }
    );
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    const parsed = JSON.parse(content);
    return {
      description: parsed.description || "",
      objects: Array.isArray(parsed.objects) ? parsed.objects : [],
      text: parsed.text || "",
    };
  } catch {
    return {
      description: content,
      objects: [],
      text: "",
    };
  }
}

/**
 * Extract text content from a document (PDF, plain text, images via OCR).
 * @param {Buffer} fileBuffer - Raw file data
 * @param {string} mimeType - MIME type of the file
 * @returns {Promise<{ text: string, pages: number, metadata: object }>}
 */
export async function extractDocumentContent(fileBuffer, mimeType) {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw Object.assign(
      new Error("File buffer is required and must be non-empty"),
      { code: "INVALID_INPUT" }
    );
  }

  if (!mimeType || typeof mimeType !== "string") {
    throw Object.assign(
      new Error("MIME type is required"),
      { code: "INVALID_INPUT" }
    );
  }

  // Plain text and markdown: direct decode
  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/csv") {
    const text = fileBuffer.toString("utf8");
    const lines = text.split("\n").length;
    return {
      text,
      pages: 1,
      metadata: {
        mimeType,
        sizeBytes: fileBuffer.length,
        lines,
        encoding: "utf-8",
      },
    };
  }

  // PDF and images: use OCR module
  if (isSupportedMime(mimeType)) {
    const { text, confidence } = await extractText(fileBuffer, mimeType);
    const pages = mimeType === "application/pdf" ? estimatePdfPages(text) : 1;
    return {
      text,
      pages,
      metadata: {
        mimeType,
        sizeBytes: fileBuffer.length,
        confidence,
        extractionMethod: mimeType === "application/pdf" ? "pdf-parse" : "ocr",
      },
    };
  }

  throw Object.assign(
    new Error(`Unsupported document type: ${mimeType}. Supported: ${[...SUPPORTED_DOC_MIMES].join(", ")}`),
    { code: "UNSUPPORTED_FORMAT" }
  );
}

/**
 * Get the available multi-modal capabilities based on configuration.
 * @returns {{ vision: boolean, tts: boolean, stt: boolean, documentExtraction: boolean }}
 */
export function getMultimodalCapabilities() {
  const voice = isVoiceConfigured();
  return {
    vision: Boolean(OPENAI_API_KEY),
    tts: voice.tts,
    stt: voice.stt,
    documentExtraction: true, // always available (plain text fallback)
  };
}

function detectImageMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  return "image/png"; // default fallback
}

function estimatePdfPages(text) {
  if (!text) return 0;
  // Rough heuristic: ~3000 chars per page
  return Math.max(1, Math.ceil(text.length / 3000));
}
