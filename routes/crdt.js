/**
 * Phase 41.1: CRDT document sync routes.
 *
 * GET    /api/v1/crdt/docs/:id          — get current document state
 * POST   /api/v1/crdt/docs/:id/ops      — apply a CRDT operation
 * GET    /api/v1/crdt/docs/:id/ops      — list ops since a timestamp
 *
 * Documents are scoped per workspace and held in memory. The intent is
 * realtime collaboration with WebSocket fan-out via lib/realtime.js
 * (broadcastCrdtOp). Persistence is delegated to the caller via the
 * snapshot endpoint.
 */
import { createCRDTDocument, HybridLogicalClock } from "../lib/crdt.js";
import { broadcastCrdtOp } from "../lib/realtime.js";

/** @type {Map<string, ReturnType<typeof createCRDTDocument>>} key = `${workspace}:${docId}` */
const docs = new Map();

function docKey(workspace, docId) {
  return `${workspace}:${docId}`;
}

function getOrCreateDoc(workspace, docId) {
  const key = docKey(workspace, docId);
  let doc = docs.get(key);
  if (!doc) {
    doc = createCRDTDocument(docId);
    docs.set(key, doc);
  }
  return doc;
}

/** Test helper: clear in-memory state. */
export function _resetCrdtStore() {
  docs.clear();
}

export function mountCrdtRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
  } = deps;

  // GET /api/v1/crdt/docs/:id — current snapshot
  apiRoute(
    "get",
    "/crdt/docs/:id",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace);
        const docId = String(req.params.id || "").slice(0, 200);
        if (!docId) {
          return apiError(res, 400, "VALIDATION_ERROR", "doc id is required");
        }
        const doc = getOrCreateDoc(workspace, docId);
        res.json({ _version: 1, workspace, doc: doc.snapshot() });
      } catch (err) {
        console.error("[crdt] get doc error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // POST /api/v1/crdt/docs/:id/ops — apply an op
  apiRoute(
    "post",
    "/crdt/docs/:id/ops",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
        const docId = String(req.params.id || "").slice(0, 200);
        if (!docId) {
          return apiError(res, 400, "VALIDATION_ERROR", "doc id is required");
        }
        const op = req.body?.op;
        if (!op || typeof op !== "object" || typeof op.kind !== "string" || typeof op.field !== "string") {
          return apiError(res, 400, "VALIDATION_ERROR", "op { kind, field, ... } is required");
        }
        const doc = getOrCreateDoc(workspace, docId);
        const changed = doc.applyOp(op);
        if (changed) {
          try {
            broadcastCrdtOp(workspace, docId, op, req.userId || undefined);
          } catch (e) {
            console.warn("[crdt] broadcast failed:", e.message);
          }
        }
        res.status(changed ? 201 : 200).json({
          _version: 1,
          workspace,
          docId,
          changed,
          state: doc.snapshot(),
        });
      } catch (err) {
        console.error("[crdt] apply op error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/crdt/docs/:id/ops?since=... — fetch ops since a timestamp
  apiRoute(
    "get",
    "/crdt/docs/:id/ops",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace);
        const docId = String(req.params.id || "").slice(0, 200);
        if (!docId) {
          return apiError(res, 400, "VALIDATION_ERROR", "doc id is required");
        }
        let since = null;
        const raw = req.query?.since;
        if (raw) {
          if (typeof raw === "string" && raw.includes("|")) {
            const [physical, logical, node] = raw.split("|");
            since = {
              physical: Number(physical) || 0,
              logical: Number(logical) || 0,
              node: node || "",
            };
          } else {
            const ms = Number(raw);
            if (!Number.isNaN(ms)) since = { physical: ms, logical: 0, node: "" };
          }
        }
        const doc = getOrCreateDoc(workspace, docId);
        const ops = doc.getOps(since);
        // Sort deterministically by clock so consumers can replay in order.
        ops.sort((a, b) => HybridLogicalClock.compare(a.clock, b.clock));
        res.json({ _version: 1, workspace, docId, count: ops.length, ops });
      } catch (err) {
        console.error("[crdt] list ops error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );
}

export default mountCrdtRoutes;
