// Agent-run artifacts HTTP surface.
//
// Surface:
//   GET    /agent/sessions/:id/artifacts         — list artifacts for a session
//   POST   /agent/sessions/:id/artifacts         — create an artifact (JSON or multipart)
//   GET    /agent/artifacts/:artifactId          — stream artifact content
//   DELETE /agent/artifacts/:artifactId          — remove an artifact
//
// Auth / access follows routes/agent-sessions.js: userAuth + requireScope +
// workspace-access gate via getWorkspaceAgentAccess. Only the owning storage
// user of a session can read or mutate its artifacts.

import multer from "multer";
import { agentSessionApiEnabled, getAgentSession } from "../lib/agent-session.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";
import {
  createArtifact,
  listArtifactsForSession,
  getArtifactRecord,
  getArtifactContent,
  deleteArtifact,
  getArtifactLimits,
} from "../lib/agent-artifacts.js";

function coerceContent({ contentBase64, content }) {
  if (typeof contentBase64 === "string" && contentBase64.length) {
    try { return Buffer.from(contentBase64, "base64"); }
    catch { return null; }
  }
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return null;
}

async function assertOwnerAccess(req, session, apiError, res) {
  const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
  if (!access.allowed) {
    apiError(res, 403, "FORBIDDEN", "Access denied", "Join the workspace first.");
    return false;
  }
  const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
  if (session.ownerStorageUserId !== storageUserId) {
    apiError(res, 403, "FORBIDDEN", "Session belongs to another user", "Only the owner can access artifacts.");
    return false;
  }
  return storageUserId;
}

function handleStoreError(err, apiError, res) {
  const code = err?.code;
  if (
    code === "INVALID_NAME" ||
    code === "INVALID_MIME" ||
    code === "INVALID_CONTENT" ||
    code === "INVALID"
  ) {
    return apiError(res, 400, code, err.message || "Invalid input", "Fix the request and retry.");
  }
  if (code === "ARTIFACT_TOO_LARGE") {
    return apiError(res, 413, code, err.message || "Artifact too large", "Reduce the payload size.");
  }
  if (code === "ARTIFACT_QUOTA_EXCEEDED") {
    return apiError(
      res,
      413,
      code,
      err.message || "Per-session artifact quota exceeded",
      "Delete older artifacts or request a larger quota.",
    );
  }
  return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Artifact op failed", "See server logs.");
}

export function mountAgentArtifactRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  const limits = getArtifactLimits();
  const uploader = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limits.perArtifact },
  });

  apiRoute(
    "get",
    "/agent/sessions/:sessionId/artifacts",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      if (!agentSessionApiEnabled()) {
        return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
      }
      const sessionId = String(req.params.sessionId || "").trim();
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Check the session id.");
      }
      try {
        const ok = await assertOwnerAccess(req, session, apiError, res);
        if (!ok) return;
        const items = await listArtifactsForSession(sessionId);
        res.json({ items, total: items.length, limits });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed", "See server logs.");
      }
    },
  );

  apiRoute(
    "post",
    "/agent/sessions/:sessionId/artifacts",
    logRequest,
    userAuth,
    requireScope("write"),
    (req, res, next) => {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (ct.startsWith("multipart/form-data")) {
        uploader.single("file")(req, res, (err) => {
          if (err) {
            if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
              return apiError(
                res,
                413,
                "ARTIFACT_TOO_LARGE",
                `artifact exceeds per-artifact cap of ${limits.perArtifact} bytes`,
                "Reduce the payload size.",
              );
            }
            return apiError(res, 400, "INVALID_BODY", err.message || "Invalid multipart body", null);
          }
          next();
        });
        return;
      }
      next();
    },
    async (req, res) => {
      if (!agentSessionApiEnabled()) {
        return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
      }
      const sessionId = String(req.params.sessionId || "").trim();
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Check the session id.");
      }
      try {
        const storageUserId = await assertOwnerAccess(req, session, apiError, res);
        if (!storageUserId) return;

        let name;
        let mime;
        let content;
        let runId;
        let meta;
        if (req.file && req.file.buffer) {
          const formName = typeof req.body?.name === "string" ? req.body.name : req.file.originalname;
          name = formName;
          mime = typeof req.body?.mime === "string" && req.body.mime
            ? req.body.mime
            : req.file.mimetype || "application/octet-stream";
          content = req.file.buffer;
          runId = typeof req.body?.runId === "string" ? req.body.runId : undefined;
          if (typeof req.body?.meta === "string") {
            try { meta = JSON.parse(req.body.meta); } catch { meta = undefined; }
          }
        } else {
          const body = req.body || {};
          name = body.name;
          mime = body.mime;
          content = coerceContent(body);
          runId = body.runId;
          if (body.meta && typeof body.meta === "object") meta = body.meta;
        }

        if (!content) {
          return apiError(
            res,
            400,
            "INVALID_CONTENT",
            "content required (provide contentBase64, content, or a multipart file field named 'file')",
            "",
          );
        }

        const record = await createArtifact({
          sessionId,
          runId,
          name,
          mime,
          content,
          createdBy: storageUserId,
          meta,
        });
        res.status(201).json(record);
      } catch (err) {
        return handleStoreError(err, apiError, res);
      }
    },
  );

  apiRoute(
    "get",
    "/agent/artifacts/:artifactId",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      if (!agentSessionApiEnabled()) {
        return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
      }
      const artifactId = String(req.params.artifactId || "").trim();
      const rec = await getArtifactRecord(artifactId);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "Artifact not found", "Check the id.");
      const session = await getAgentSession(rec.sessionId);
      if (!session) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
      try {
        const ok = await assertOwnerAccess(req, session, apiError, res);
        if (!ok) return;
        const buf = await getArtifactContent(artifactId);
        if (!buf) return apiError(res, 404, "NOT_FOUND", "Artifact content missing", "");
        res.setHeader("Content-Type", rec.mime || "application/octet-stream");
        res.setHeader("Content-Length", String(buf.length));
        const safeName = String(rec.name || artifactId).replace(/[\r\n"]/g, "");
        res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
        res.setHeader("X-Artifact-Id", artifactId);
        res.status(200).end(buf);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Read failed", "See server logs.");
      }
    },
  );

  apiRoute(
    "delete",
    "/agent/artifacts/:artifactId",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      if (!agentSessionApiEnabled()) {
        return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
      }
      const artifactId = String(req.params.artifactId || "").trim();
      const rec = await getArtifactRecord(artifactId);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "Artifact not found", "");
      const session = await getAgentSession(rec.sessionId);
      if (!session) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
      try {
        const ok = await assertOwnerAccess(req, session, apiError, res);
        if (!ok) return;
        const removed = await deleteArtifact(artifactId);
        if (!removed) return apiError(res, 404, "NOT_FOUND", "Artifact not found", "");
        res.json({ ok: true, id: artifactId });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Delete failed", "See server logs.");
      }
    },
  );
}

export default mountAgentArtifactRoutes;
