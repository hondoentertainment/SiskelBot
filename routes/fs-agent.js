/**
 * Phase 55.4: Filesystem agent routes.
 *
 * Path-guarded FS operations backed by lib/fs-agent.js.
 *
 * POST   /api/v1/fs/read                 body: { path, maxBytes, encoding }
 * POST   /api/v1/fs/write                body: { path, content, dryRun, atomic, encoding }
 * POST   /api/v1/fs/append               body: { path, content }
 * DELETE /api/v1/fs/file                 query: ?path=
 * POST   /api/v1/fs/rename               body: { src, dest }
 * POST   /api/v1/fs/copy                 body: { src, dest }
 * POST   /api/v1/fs/mkdir                body: { path }
 * GET    /api/v1/fs/list                 query: ?path=
 * GET    /api/v1/fs/stats                query: ?path=
 * POST   /api/v1/fs/find                 body: { root, pattern, maxResults }
 * POST   /api/v1/fs/search                body: { root, pattern, maxMatches, regex }
 * POST   /api/v1/fs/preview              body: { operation }
 * POST   /api/v1/fs/backup               body: { path }
 * POST   /api/v1/fs/restore              body: { backupId }
 * POST   /api/v1/fs/session              body: { name }
 * GET    /api/v1/fs/session/:id/history
 * POST   /api/v1/fs/session/:id/undo
 */
import {
  PathGuard,
  readFile,
  writeFile,
  appendFile,
  deleteFile,
  renameFile,
  copyFile,
  createDir,
  listDir,
  getStats,
  findFiles,
  searchInFiles,
  previewOperation,
  backupFile,
  restoreBackup,
  createFsSession,
  getFsHistory,
  undoLastFsOperation,
} from "../lib/fs-agent.js";

function makeGuard() {
  return new PathGuard();
}

function mapStatus(code) {
  if (code === "PATH_DENIED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "FILE_TOO_LARGE" || code === "NOT_A_FILE") return 400;
  if (code === "UNKNOWN_OP" || code === "INVALID_INPUT") return 400;
  return 500;
}

function errToApi(apiError, res, err, fallbackMsg) {
  const msg = err?.message || fallbackMsg || "fs error";
  const status = mapStatus(err?.code);
  const code = err?.code || "FS_ERROR";
  return apiError(res, status, code, msg);
}

export function mountFsAgentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  const BASE = "/fs";

  // POST /fs/read
  apiRoute("post", `${BASE}/read`, log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      const content = await readFile(body.path, {
        guard: makeGuard(),
        encoding: body.encoding || "utf8",
        maxBytes: body.maxBytes,
      });
      return res.json({ _version: 1, path: body.path, content });
    } catch (err) {
      return errToApi(apiError, res, err, "read failed");
    }
  });

  // POST /fs/write
  apiRoute("post", `${BASE}/write`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      if (body.content === undefined || body.content === null) {
        return apiError(res, 400, "INVALID_INPUT", "content is required");
      }
      const result = await writeFile(body.path, body.content, {
        guard: makeGuard(),
        dryRun: Boolean(body.dryRun),
        atomic: Boolean(body.atomic),
        encoding: body.encoding || "utf8",
        mode: body.mode,
      });
      return res.status(body.dryRun ? 200 : 201).json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "write failed");
    }
  });

  // POST /fs/append
  apiRoute("post", `${BASE}/append`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      if (body.content === undefined || body.content === null) {
        return apiError(res, 400, "INVALID_INPUT", "content is required");
      }
      const result = await appendFile(body.path, body.content, {
        guard: makeGuard(),
        dryRun: Boolean(body.dryRun),
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "append failed");
    }
  });

  // DELETE /fs/file?path=...
  apiRoute("delete", `${BASE}/file`, log, auth, scope("write"), async (req, res) => {
    try {
      const p = req.query?.path;
      if (!p) return apiError(res, 400, "INVALID_INPUT", "path query param is required");
      const result = await deleteFile(String(p), { guard: makeGuard() });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "delete failed");
    }
  });

  // POST /fs/rename
  apiRoute("post", `${BASE}/rename`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.src || !body.dest) {
        return apiError(res, 400, "INVALID_INPUT", "src and dest are required");
      }
      const result = await renameFile(body.src, body.dest, {
        guard: makeGuard(),
        dryRun: Boolean(body.dryRun),
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "rename failed");
    }
  });

  // POST /fs/copy
  apiRoute("post", `${BASE}/copy`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.src || !body.dest) {
        return apiError(res, 400, "INVALID_INPUT", "src and dest are required");
      }
      const result = await copyFile(body.src, body.dest, {
        guard: makeGuard(),
        dryRun: Boolean(body.dryRun),
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "copy failed");
    }
  });

  // POST /fs/mkdir
  apiRoute("post", `${BASE}/mkdir`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      const result = await createDir(body.path, {
        guard: makeGuard(),
        dryRun: Boolean(body.dryRun),
      });
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "mkdir failed");
    }
  });

  // GET /fs/list?path=...
  apiRoute("get", `${BASE}/list`, log, auth, scope("read"), async (req, res) => {
    try {
      const p = req.query?.path;
      if (!p) return apiError(res, 400, "INVALID_INPUT", "path query param is required");
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const result = await listDir(String(p), { guard: makeGuard(), limit });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "list failed");
    }
  });

  // GET /fs/stats?path=...
  apiRoute("get", `${BASE}/stats`, log, auth, scope("read"), async (req, res) => {
    try {
      const p = req.query?.path;
      if (!p) return apiError(res, 400, "INVALID_INPUT", "path query param is required");
      const stats = await getStats(String(p), { guard: makeGuard() });
      return res.json({ _version: 1, stats });
    } catch (err) {
      return errToApi(apiError, res, err, "stats failed");
    }
  });

  // POST /fs/find
  apiRoute("post", `${BASE}/find`, log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.root) return apiError(res, 400, "INVALID_INPUT", "root is required");
      if (!body.pattern) return apiError(res, 400, "INVALID_INPUT", "pattern is required");
      const result = await findFiles(body.root, body.pattern, {
        guard: makeGuard(),
        maxResults: body.maxResults,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "find failed");
    }
  });

  // POST /fs/search
  apiRoute("post", `${BASE}/search`, log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.root) return apiError(res, 400, "INVALID_INPUT", "root is required");
      if (!body.pattern) return apiError(res, 400, "INVALID_INPUT", "pattern is required");
      const result = await searchInFiles(body.root, body.pattern, {
        guard: makeGuard(),
        maxMatches: body.maxMatches,
        regex: Boolean(body.regex),
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "search failed");
    }
  });

  // POST /fs/preview
  apiRoute("post", `${BASE}/preview`, log, auth, scope("read"), async (req, res) => {
    try {
      const operation = req.body?.operation;
      if (!operation || typeof operation !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "operation is required");
      }
      const result = await previewOperation(operation, { guard: makeGuard() });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "preview failed");
    }
  });

  // POST /fs/backup
  apiRoute("post", `${BASE}/backup`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.path) return apiError(res, 400, "INVALID_INPUT", "path is required");
      const entry = await backupFile(body.path);
      return res.status(201).json({ _version: 1, entry });
    } catch (err) {
      return errToApi(apiError, res, err, "backup failed");
    }
  });

  // POST /fs/restore
  apiRoute("post", `${BASE}/restore`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.backupId) return apiError(res, 400, "INVALID_INPUT", "backupId is required");
      const result = await restoreBackup(body.backupId);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "restore failed");
    }
  });

  // POST /fs/session
  apiRoute("post", `${BASE}/session`, log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const session = await createFsSession(body.name || "unnamed", {
        allowedRoots: Array.isArray(body.allowedRoots) ? body.allowedRoots : null,
      });
      return res.status(201).json({ _version: 1, session });
    } catch (err) {
      return errToApi(apiError, res, err, "session create failed");
    }
  });

  // GET /fs/session/:id/history
  apiRoute("get", `${BASE}/session/:id/history`, log, auth, scope("read"), async (req, res) => {
    try {
      const history = await getFsHistory(req.params.id);
      return res.json({ _version: 1, sessionId: req.params.id, history, count: history.length });
    } catch (err) {
      return errToApi(apiError, res, err, "history failed");
    }
  });

  // POST /fs/session/:id/undo
  apiRoute("post", `${BASE}/session/:id/undo`, log, auth, scope("write"), async (req, res) => {
    try {
      const result = await undoLastFsOperation(req.params.id);
      return res.json({ _version: 1, sessionId: req.params.id, ...result });
    } catch (err) {
      return errToApi(apiError, res, err, "undo failed");
    }
  });
}

export default mountFsAgentRoutes;
