// Multimodal routes: vision/describe, documents/extract, OCR
// Extracted from server.js

import multer from "multer";

export default function mountMultimodalRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    OPENAI_API_KEY,
    rateLimit,
  } = deps;

  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const DOC_MAX_BYTES = 2 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const ALLOWED_DOC_TYPES = ["application/pdf", "text/plain", "text/markdown", "text/csv"];

  const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: IMAGE_MAX_BYTES },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Invalid image type. Allowed: ${ALLOWED_IMAGE_TYPES.join(", ")}`), false);
    },
  });

  const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: DOC_MAX_BYTES },
    fileFilter: (req, file, cb) => {
      if (ALLOWED_DOC_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Invalid document type. Allowed: PDF, plain text`), false);
    },
  });

  const multimodalRateLimiter = deps.rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  function sanitizeText(str, maxLen = 50_000) {
    if (typeof str !== "string") return "";
    return str.slice(0, maxLen).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  }

  apiRoute("post", "/vision/describe",
    multimodalRateLimiter,
    (req, res, next) => {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        const { image } = req.body || {};
        if (!image) return apiError(res, 400, "INVALID_BODY", "image required (base64 or multipart)", "Send image as base64 in JSON body or multipart/form-data.");
        const match = /^data:([^;]+);base64,(.+)$/.exec(image);
        const base64 = match ? match[2] : image;
        try {
          req.visionBuffer = Buffer.from(base64, "base64");
          if (req.visionBuffer.length > IMAGE_MAX_BYTES)
            return apiError(res, 400, "FILE_TOO_LARGE", `Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce image size.");
          next();
        } catch (e) {
          return apiError(res, 400, "INVALID_BASE64", "Invalid base64 image", "Provide valid base64-encoded image data.");
        }
        return;
      }
      imageUpload.single("image")(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE")
              return apiError(res, 400, "FILE_TOO_LARGE", `Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce image size.");
            if (err.code === "LIMIT_UNEXPECTED_FILE")
              return apiError(res, 400, "INVALID_BODY", "Use field name 'image' for multipart upload", null);
          }
          return apiError(res, 400, "INVALID_FILE", err.message || "Invalid image upload", null);
        }
        if (!req.file?.buffer)
          return apiError(res, 400, "INVALID_BODY", "image required (base64 or multipart)", null);
        req.visionBuffer = req.file.buffer;
        next();
      });
    },
    logRequest,
    async (req, res) => {
      try {
        if (!OPENAI_API_KEY) {
          return res.status(200).json({ description: "Vision requires OpenAI backend.", hint: "Set OPENAI_API_KEY to use image description." });
        }
        const buffer = req.visionBuffer;
        const base64 = buffer.toString("base64");
        const mime = buffer[0] === 0x89 ? "image/png" : buffer[1] === 0xff && buffer[2] === 0xd8 ? "image/jpeg" : "image/webp";
        const dataUrl = `data:${mime};base64,${base64}`;
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: [{ type: "text", text: "Describe this image in detail. Be concise." }, { type: "image_url", image_url: { url: dataUrl } }] }],
            max_tokens: 500,
          }),
        });
        if (!r.ok) {
          const err = await r.text();
          return res.status(r.status).json({ error: "Vision API error", code: "BACKEND_ERROR", hint: (err || `HTTP ${r.status}`).slice(0, 500) });
        }
        const data = await r.json();
        const description = data.choices?.[0]?.message?.content || "No description.";
        return res.json({ description: sanitizeText(description) });
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check OPENAI_API_KEY and network.");
      }
    }
  );

  apiRoute("post", "/documents/extract",
    multimodalRateLimiter,
    (req, res, next) => {
      docUpload.single("file")(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE")
              return apiError(res, 400, "FILE_TOO_LARGE", `Document exceeds ${DOC_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce file size.");
            if (err.code === "LIMIT_UNEXPECTED_FILE")
              return apiError(res, 400, "INVALID_BODY", "Use field name 'file' for multipart upload", null);
          }
          return apiError(res, 400, "INVALID_FILE", err.message || "Invalid file upload", null);
        }
        next();
      });
    },
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer)
          return apiError(res, 400, "INVALID_BODY", "file required (multipart/form-data)", "Upload a PDF or plain text file with field name 'file'.");
        const mime = req.file.mimetype || "";
        const buffer = req.file.buffer;
        if (mime === "application/pdf") {
          try {
            const { PDFParse } = await import("pdf-parse");
            const parser = new PDFParse({ data: buffer });
            const result = await parser.getText();
            await parser.destroy?.();
            const text = (result?.text ?? result?.pages?.map((p) => p?.text).filter(Boolean).join("\n\n") ?? "").trim();
            return res.json({ text: sanitizeText(text), type: "pdf" });
          } catch (e) {
            return apiError(res, 500, "EXTRACT_FAILED", "PDF extraction failed", (e?.message || "See docs/RUNBOOK.md.").slice(0, 300));
          }
        }
        const text = buffer.toString("utf8");
        return res.json({ text: sanitizeText(text), type: "text" });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  const OCR_MAX_BYTES = 20 * 1024 * 1024;
  const ALLOWED_OCR_TYPES = ["image/png", "image/jpeg", "image/tiff", "image/bmp", "application/pdf"];

  const ocrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: OCR_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_OCR_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error("Unsupported file type. Accepted: PNG, JPG, TIFF, BMP, PDF."));
    },
  });

  apiRoute("post", "/ocr",
    multimodalRateLimiter,
    (req, res, next) => {
      ocrUpload.single("file")(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE")
              return apiError(res, 400, "FILE_TOO_LARGE", `File exceeds ${OCR_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce file size.");
            if (err.code === "LIMIT_UNEXPECTED_FILE")
              return apiError(res, 400, "INVALID_BODY", "Use field name 'file' for multipart upload", null);
          }
          if (err.message && err.message.includes("Unsupported file type"))
            return apiError(res, 415, "UNSUPPORTED_FORMAT", err.message, "Accepted formats: PNG, JPG, TIFF, BMP, PDF.");
          return apiError(res, 400, "INVALID_FILE", err.message || "Invalid file upload", null);
        }
        next();
      });
    },
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer)
          return apiError(res, 400, "INVALID_BODY", "file required (multipart/form-data)", "Upload an image or PDF with field name 'file'.");
        const { extractText } = await import("../lib/ocr.js");
        const mime = req.file.mimetype || "";
        const { text, confidence } = await extractText(req.file.buffer, mime);
        return res.json({ text: sanitizeText(text), pages: 1, confidence });
      } catch (err) {
        if (err.code === "UNSUPPORTED_FORMAT")
          return apiError(res, 415, "UNSUPPORTED_FORMAT", err.message, "Accepted formats: PNG, JPG, TIFF, BMP, PDF.");
        return apiError(res, 500, "OCR_FAILED", err.message || "OCR processing failed", "See docs/RUNBOOK.md.");
      }
    }
  );
}
