import { validate } from "../lib/validate.js";
import { getWorkspaceChunkingConfig, setWorkspaceChunkingConfig, VALID_STRATEGIES } from "../lib/knowledge-chunking-config.js";
import { autoDetectAndParse } from "../lib/knowledge-parsers.js";
import { getWorkspaceKnowledgeGraph } from "../lib/knowledge-graph-store.js";
import { hybridSearch } from "../lib/hybrid-search.js";
import { globalEmbeddingCache } from "../lib/embedding-cache.js";
import {
  saveDocumentVersion,
  getDocumentHistory,
  getDocumentVersion,
  rollbackDocument,
  diffVersions,
} from "../lib/document-versioning.js";

export default function mountKnowledgeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    chatAuth,
    adminAuth,
    requireScope,
    embeddingsRateLimiter,
    knowledgeIndexRateLimiter,
    storageRateLimiter,
    userAuth,
    sanitizeWorkspace,
    storage,
    // knowledge-store
    indexDocument,
    knowledgeSearch,
    knowledgeSemanticSearch,
    knowledgeList,
    reindexKnowledgeEmbeddingsInWorkspace,
    // embeddings
    embed,
    embedBatch,
    embeddingsAvailable,
    // knowledge-url-fetch
    fetchTextFromAllowedUrl,
    // teams
    logActivity,
  } = deps;

  const KNOWLEDGE_MAX_DOC_BYTES = Number(process.env.KNOWLEDGE_MAX_DOC_BYTES) || 1024 * 1024;

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

  // Phase 35.2: GET /api/v1/embeddings/cache/stats — admin endpoint for embedding cache stats.
  apiRoute("get", "/embeddings/cache/stats", adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const stats = globalEmbeddingCache.stats();
      return res.json({ ok: true, stats });
    } catch (err) {
      console.error("Embedding cache stats error:", err.message);
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
    try {
      const q = (req.query?.q ?? "").toString();
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const mode = req.query?.mode || null;
      const semantic = req.query?.semantic === "1" || req.query?.semantic === "true";

      // Phase 27: Support mode=hybrid|keyword|semantic via hybridSearch
      if (mode === "hybrid" || mode === "keyword" || mode === "semantic") {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 10, 1), 50);
        const result = await hybridSearch(q, workspace, { mode, limit });
        if (result.error) {
          const status = result.code === "EMBEDDINGS_UNAVAILABLE" ? 503 : 400;
          return res.status(status).json({ error: result.error, code: result.code });
        }
        return res.json(result);
      }

      // Legacy: semantic=1 flag
      const result = semantic
        ? await knowledgeSemanticSearch({ query: q, workspace })
        : await knowledgeSearch({ query: q, workspace });
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

  // GET /api/v1/knowledge/chunking-config — get workspace chunking config
  apiRoute("get", "/knowledge/chunking-config", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const config = await getWorkspaceChunkingConfig(workspace);
      res.json({ workspace, config });
    } catch (err) {
      console.error("Chunking config get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RAG_PIPELINE_V2.md.");
    }
  });

  // PUT /api/v1/knowledge/chunking-config — update workspace chunking config
  apiRoute("put", "/knowledge/chunking-config", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { chunkSize, chunkOverlap, maxChunks, strategy, metadataExtraction, preserveStructure } = req.body || {};

      if (strategy && !VALID_STRATEGIES.includes(strategy)) {
        return apiError(res, 400, "INVALID_INPUT", `Invalid strategy: ${strategy}`, `Valid strategies: ${VALID_STRATEGIES.join(", ")}`);
      }

      const updates = {};
      if (chunkSize !== undefined) updates.chunkSize = chunkSize;
      if (chunkOverlap !== undefined) updates.chunkOverlap = chunkOverlap;
      if (maxChunks !== undefined) updates.maxChunks = maxChunks;
      if (strategy !== undefined) updates.strategy = strategy;
      if (metadataExtraction !== undefined) updates.metadataExtraction = metadataExtraction;
      if (preserveStructure !== undefined) updates.preserveStructure = preserveStructure;

      const config = await setWorkspaceChunkingConfig(workspace, updates);
      res.json({ workspace, config });
    } catch (err) {
      if (err.code === "INVALID_INPUT") {
        return apiError(res, 400, "INVALID_INPUT", err.message, "Workspace must be alphanumeric, 1-50 chars.");
      }
      console.error("Chunking config set error:", err.message);
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

  // Context CRUD
  apiRoute("get", "/context", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const data = await storage.listItems("context", workspace, req.userId);
      res.json({ _version: 1, items: data });
    } catch (err) {
      console.error("Storage context list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  const validateCreateContext = validate({ body: { title: "string", content: "string" } });

  apiRoute("post", "/context", storageRateLimiter, userAuth, requireScope("write"), logRequest, validateCreateContext, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      let { title, content } = req.body || {};
      if (typeof title !== "string" || !title.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "title required", "Send { title: string, content?: string }.");
      }

      // Phase 17: Auto-detect content type and parse if applicable
      const contentType = req.body?.contentType;
      if (typeof content === "string" && content.trim()) {
        const parsed = autoDetectAndParse(content, contentType);
        if (parsed.detectedType !== "text/plain") {
          content = parsed.text;
          // Use parsed title as fallback if original title is generic
          if (parsed.title && (!title.trim() || title.trim() === "Untitled")) {
            title = parsed.title;
          }
        }
      }

      const { randomUUID } = await import("crypto");
      const id = (req.body?.id && String(req.body.id).trim()) || randomUUID();
      const doc = {
        id,
        title: title.trim().slice(0, 500),
        content: typeof content === "string" ? content : "",
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("context", workspace, [doc], req.userId);
      const item = merged.find((x) => x.id === id) || doc;
      await logActivity(workspace, "context_added", req.userId, { title: doc.title, id: doc.id });
      res.status(201).json(item);
    } catch (err) {
      console.error("Storage context add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/context/:id", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("context", req.params.id, workspace, req.userId);
      if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(item);
    } catch (err) {
      console.error("Storage context get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/context/:id", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      const updated = await storage.updateItem("context", req.params.id, workspace, (existing) => {
        if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 500);
        if (content !== undefined) existing.content = typeof content === "string" ? content : "";
        return existing;
      }, req.userId);
      if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(updated);
    } catch (err) {
      console.error("Storage context update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/context/:id", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("context", req.params.id, workspace, req.userId);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Storage context delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/context/sync", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const valid = items.filter((x) => x && x.id && typeof x.title === "string");
      const merged = await storage.mergeItems("context", workspace, valid, req.userId);
      res.json({ _version: 1, items: merged });
    } catch (err) {
      console.error("Storage context sync error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Knowledge Graph endpoints ---

  // GET /api/v1/knowledge/graph/entities?type=&q= — search entities
  apiRoute("get", "/knowledge/graph/entities", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const query = {};
      if (req.query?.q) query.name = String(req.query.q);
      if (req.query?.type) query.type = String(req.query.type);
      const entities = graph.findEntities(query);
      res.json({ entities, count: entities.length });
    } catch (err) {
      console.error("Knowledge graph entities search error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/knowledge/graph/entities/:id — get entity with relations
  apiRoute("get", "/knowledge/graph/entities/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const entity = graph.getEntity(req.params.id);
      if (!entity) return res.status(404).json({ error: "Entity not found", code: "NOT_FOUND" });
      const relations = graph.getRelations(req.params.id);
      res.json({ entity, relations });
    } catch (err) {
      console.error("Knowledge graph entity get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/knowledge/graph/entities/:id/neighbors?depth=2 — get neighbors
  apiRoute("get", "/knowledge/graph/entities/:id/neighbors", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const depth = Math.max(1, Math.min(Number(req.query?.depth) || 1, 5));
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const entity = graph.getEntity(req.params.id);
      if (!entity) return res.status(404).json({ error: "Entity not found", code: "NOT_FOUND" });
      const result = graph.getNeighbors(req.params.id, depth);
      res.json(result);
    } catch (err) {
      console.error("Knowledge graph neighbors error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/knowledge/graph/stats — graph statistics
  apiRoute("get", "/knowledge/graph/stats", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const stats = graph.getStats();
      res.json(stats);
    } catch (err) {
      console.error("Knowledge graph stats error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/knowledge/graph/path?from=&to= — find path between entities
  apiRoute("get", "/knowledge/graph/path", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const fromId = req.query?.from;
      const toId = req.query?.to;
      if (!fromId || !toId) {
        return apiError(res, 400, "INVALID_INPUT", "from and to query params are required", "Use ?from=entityId&to=entityId.");
      }
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const result = graph.findPath(String(fromId), String(toId));
      if (!result.found) {
        return res.json({ found: false, path: [], relations: [] });
      }
      // Resolve entity objects for the path
      const pathEntities = result.path.map((id) => graph.getEntity(id)).filter(Boolean);
      res.json({ found: true, path: pathEntities, relations: result.relations });
    } catch (err) {
      console.error("Knowledge graph path error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Phase 27: Document versioning endpoints ---

  // GET /api/v1/documents/:id/versions — version history
  apiRoute("get", "/documents/:id/versions", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const docId = req.params.id;
      const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
      const history = await getDocumentHistory(docId, limit, { workspace });
      if (history.error) {
        return apiError(res, 400, history.code || "INVALID_INPUT", history.error);
      }
      res.json({ docId, versions: history });
    } catch (err) {
      console.error("Document versions list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/documents/:id/versions/:versionId — specific version
  apiRoute("get", "/documents/:id/versions/:versionId", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const result = await getDocumentVersion(req.params.id, req.params.versionId, { workspace });
      if (result.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      console.error("Document version get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/documents/:id/rollback — rollback to version
  apiRoute("post", "/documents/:id/rollback", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const versionId = req.body?.versionId;
      if (!versionId) {
        return apiError(res, 400, "INVALID_INPUT", "versionId is required in request body");
      }
      const result = await rollbackDocument(req.params.id, versionId, { workspace });
      if (result.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      console.error("Document rollback error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/documents/:id/diff?v1=...&v2=... — diff between versions
  apiRoute("get", "/documents/:id/diff", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const v1 = req.query?.v1;
      const v2 = req.query?.v2;
      if (!v1 || !v2) {
        return apiError(res, 400, "INVALID_INPUT", "v1 and v2 query params are required", "Use ?v1=versionId&v2=versionId.");
      }
      const result = await diffVersions(req.params.id, v1, v2, { workspace });
      if (result.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      console.error("Document diff error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
