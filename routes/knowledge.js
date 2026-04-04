import express from "express";
import { validate } from "../lib/validate.js";

export default function mountKnowledgeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    chatAuth,
    requireScope,
    embeddingsRateLimiter,
    knowledgeIndexRateLimiter,
    storageRateLimiter,
    userAuth,
    sanitizeWorkspace,
    storage,
    // knowledge-store
import multer from "multer";

export function mountKnowledgeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    chatAuth,
    requireScope,
    logRequest,
    embeddingsRateLimiter,
    knowledgeIndexRateLimiter,
    readRateLimiter,
    storageRateLimiter,
    multimodalRateLimiter,
    sanitizeWorkspace,
    embeddingsAvailable,
    embed,
    embedBatch,
    indexDocument,
    knowledgeSearch,
    knowledgeSemanticSearch,
    knowledgeList,
    reindexKnowledgeEmbeddingsInWorkspace,
    fetchTextFromAllowedUrl,
    // teams
    logActivity,
  } = deps;

  const KNOWLEDGE_MAX_DOC_BYTES = Number(process.env.KNOWLEDGE_MAX_DOC_BYTES) || 1024 * 1024;

    OPENAI_API_KEY,
    KNOWLEDGE_MAX_DOC_BYTES,
  } = deps;

  // POST /api/embeddings
  apiRoute("post", "/embeddings", embeddingsRateLimiter, chatAuth, requireScope("embed"), logRequest, async (req, res) => {
    try {
      if (!embeddingsAvailable()) {
        return apiError(res, 503, "EMBEDDINGS_UNAVAILABLE", "Embeddings API unavailable", "Set OPENAI_API_KEY to enable embeddings.");
      }
      const body = req.body || {};
      const text = typeof body.text === "string" ? body.text.trim() : undefined;
      const texts = Array.isArray(body.texts) ? body.texts.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : undefined;

      if (text !== undefined && text !== "") {
        const vec = await embed(text);
        if (!vec) return apiError(res, 502, "EMBEDDING_FAILED", "Embedding request failed", "Check OPENAI_API_KEY and network.");
        return res.json({ embedding: vec });
      }
      if (texts !== undefined && texts.length > 0) {
        const vecs = await embedBatch(texts);
        if (!vecs) return apiError(res, 502, "EMBEDDING_FAILED", "Embedding request failed", "Check OPENAI_API_KEY and network.");
        return res.json({ embeddings: vecs });
      }
      return apiError(res, 400, "INVALID_BODY", "text or texts required", "Send { text: string } or { texts: string[] }.");
    } catch (err) {
      console.error("Embeddings API error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/knowledge/index",
    knowledgeIndexRateLimiter,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const text = body.text;
        const workspace = sanitizeWorkspace(body.workspace);
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : undefined;
        const computeEmbedding = body.computeEmbedding === true;

        if (typeof text !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "text is required", "Send { text: string, workspace?: string, title?: string, computeEmbedding?: boolean } in the request body.");
        }

        const textBytes = Buffer.byteLength(text, "utf8");
        if (textBytes > KNOWLEDGE_MAX_DOC_BYTES) {
          return apiError(res, 413, "DOC_TOO_LARGE", `Document exceeds max size (${KNOWLEDGE_MAX_DOC_BYTES} bytes)`, `Reduce document size. Max ${Math.round(KNOWLEDGE_MAX_DOC_BYTES / 1024)}KB per document.`);
        }

        let embedding;
        if (computeEmbedding && embeddingsAvailable()) {
          embedding = await embed(text.trim());
        }
        const result = await indexDocument({ text, workspace, title, embedding });
        if (result.error) {
          return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
        }
        res.status(201).json(result);
      } catch (err) {
        console.error("Knowledge index error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
      }
    }
  );

  apiRoute("get", "/knowledge/search", requireScope("read"), logRequest, async (req, res) => {
  // GET /api/knowledge/search
  apiRoute("get", "/knowledge/search", readRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const q = (req.query?.q ?? "").toString();
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const semantic = req.query?.semantic === "1" || req.query?.semantic === "true";
      const result = semantic
        ? await knowledgeSemanticSearch({ query: q, workspace })
        : knowledgeSearch({ query: q, workspace });
      if (result.error) {
        const status = result.code === "EMBEDDINGS_UNAVAILABLE" ? 503 : 400;
        return res.status(status).json({ error: result.error, code: result.code, hint: result.hint });
      }
      res.json(result);
    } catch (err) {
      console.error("Knowledge search error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
    }
  });

  apiRoute("get", "/knowledge/status", requireScope("read"), logRequest, (req, res) => {
  // GET /api/knowledge/status
  apiRoute("get", "/knowledge/status", readRateLimiter, requireScope("read"), logRequest, (req, res) => {
    const workspace = String(req.query.workspace || "default").trim();
    const result = knowledgeList({ workspace });
    if (result.error) {
      return apiError(res, 400, result.code || "INVALID_INPUT", result.error, result.hint || "");
    }
    res.json({
      workspace,
      documentCount: Array.isArray(result.items) ? result.items.length : 0,
    });
  });

  apiRoute("get", "/knowledge/list", requireScope("read"), logRequest, (req, res) => {
  // GET /api/knowledge/list
  apiRoute("get", "/knowledge/list", readRateLimiter, requireScope("read"), logRequest, (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const result = knowledgeList({ workspace });
      if (result.error) {
        return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
      }
      res.json(result);
    } catch (err) {
      console.error("Knowledge list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
    }
  });

  apiRoute("post", "/knowledge/reindex", embeddingsRateLimiter, requireScope("embed"), logRequest, async (req, res) => {
    try {
      if (!embeddingsAvailable()) {
        return apiError(res, 503, "EMBEDDINGS_UNAVAILABLE", "OPENAI_API_KEY required for reindex", "Set OPENAI_API_KEY or skip semantic refresh.");
      }
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const result = await reindexKnowledgeEmbeddingsInWorkspace(workspace);
      if (result.error) {
        return res.status(400).json({ error: result.error, code: result.code });
      }
      res.json(result);
    } catch (err) {
      console.error("Knowledge reindex error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RAG_PIPELINE_V2.md.");
    }
  });

  apiRoute("post", "/knowledge/fetch", knowledgeIndexRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : undefined;
      const computeEmbedding = req.body?.computeEmbedding === true;

      if (!url) {
        return apiError(res, 400, "INVALID_INPUT", "url is required", "Send { url, workspace?, title?, computeEmbedding? }.");
      }

      const fetched = await fetchTextFromAllowedUrl(url);
      if (fetched.error) {
        const st =
          fetched.code === "ALLOWLIST_REQUIRED" || fetched.code === "URL_NOT_ALLOWED"
            ? 403
            : fetched.code === "DOC_TOO_LARGE"
              ? 413
              : fetched.code === "UNSUPPORTED_MEDIA"
                ? 415
                : 502;
        return res.status(st).json({ error: fetched.error, code: fetched.code });
      }

      let embedding;
      if (computeEmbedding && embeddingsAvailable()) {
        embedding = await embed(fetched.text.slice(0, 8000));
      }

      const docTitle = title || fetched.finalUrl;
      const result = await indexDocument({ text: fetched.text, workspace, title: docTitle, embedding });
      if (result.error) {
        return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
      }
      res.status(201).json({ ...result, sourceUrl: fetched.finalUrl });
    } catch (err) {
      console.error("Knowledge fetch error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RAG_PIPELINE_V2.md.");
    }
  });

  // Context CRUD lives in routes/context.js (mountContextRoutes).

  const validateCreateContext = validate({ body: { title: "string", content: "string" } });

  apiRoute("post", "/context", storageRateLimiter, requireScope("write"), logRequest, validateCreateContext, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      if (typeof title !== "string" || !title.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "title required", "Send { title: string, content?: string }.");
      }
      const { randomUUID } = await import("crypto");
      const id = (req.body?.id && String(req.body.id).trim()) || randomUUID();
      const doc = {
        id,
        title: title.trim().slice(0, 500),
        content: typeof content === "string" ? content : "",
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("context", workspace, [doc]);
      const item = merged.find((x) => x.id === id) || doc;
      await logActivity(workspace, "context_added", req.userId || "anonymous", { title: doc.title, id: doc.id });
      res.status(201).json(item);
    } catch (err) {
      console.error("Storage context add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/context/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("context", req.params.id, workspace);
      if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(item);
    } catch (err) {
      console.error("Storage context get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      const updated = await storage.updateItem("context", req.params.id, workspace, (existing) => {
        if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 500);
        if (content !== undefined) existing.content = typeof content === "string" ? content : "";
        return existing;
      });
      if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(updated);
    } catch (err) {
      console.error("Storage context update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("context", req.params.id, workspace);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Storage context delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/context/sync", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const valid = items.filter((x) => x && x.id && typeof x.title === "string");
      const merged = await storage.mergeItems("context", workspace, valid);
      res.json({ _version: 1, items: merged });
    } catch (err) {
      console.error("Storage context sync error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
  // --- Multimodal: Vision, Documents, OCR ---
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const DOC_MAX_BYTES = 2 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const ALLOWED_DOC_TYPES = [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];

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
      else cb(new Error(`Invalid document type. Allowed: PDF, plain text, Markdown, CSV, HTML, DOCX, XLSX`), false);
    },
  });

  function sanitizeText(str, maxLen = 50_000) {
    if (typeof str !== "string") return "";
    return str.slice(0, maxLen).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  }

  // POST /api/vision/describe
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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe this image in detail. Be concise." },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
            max_tokens: 500,
          }),
        });

        if (!r.ok) {
          const err = await r.text();
          return res.status(r.status).json({
            error: "Vision API error",
            code: "BACKEND_ERROR",
            hint: (err || `HTTP ${r.status}`).slice(0, 500),
          });
        }
        const data = await r.json();
        const description = data.choices?.[0]?.message?.content || "No description.";
        return res.json({ description: sanitizeText(description) });
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check OPENAI_API_KEY and network.");
      }
    }
  );

  // POST /api/documents/extract
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

        const { SUPPORTED_DOCUMENT_MIMES, parseDocument: parsDoc } = await import("../lib/knowledge-parsers.js");
        if (SUPPORTED_DOCUMENT_MIMES.includes(mime)) {
          try {
            const { text: parsedText, metadata } = await parsDoc(buffer, mime, req.file.originalname);
            return res.json({ text: sanitizeText(parsedText), type: mime.split("/").pop(), metadata });
          } catch (e) {
            return apiError(res, 500, "EXTRACT_FAILED", `Document extraction failed: ${e.message}`, "Check the file format.");
          }
        }

        const text = buffer.toString("utf8");
        return res.json({ text: sanitizeText(text), type: "text" });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // POST /api/ocr
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
