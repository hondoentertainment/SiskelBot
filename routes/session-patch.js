import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "../lib/json-path-store.js";

function storePath(sessionId) {
  return join(getDataDir(), "session-patches", String(sessionId).trim().replace(/[^a-zA-Z0-9._-]/g, "") + ".json");
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.patches)) return raw;
  return { patches: [] };
}

export function mountSessionPatchRoutes(app, deps) {
  const { apiRoute, apiError } = deps;

  apiRoute("post", "/agent-sessions/:sessionId/patch", async (req, res) => {
    const { sessionId } = req.params;
    const { workspaceId, patches } = req.body || {};
    if (!Array.isArray(patches) || patches.length === 0) {
      return apiError(res, 400, "INVALID_INPUT", "patches array is required");
    }

    const appliedBy = req.userId || req.user?.id || "anonymous";
    const appliedAt = Date.now();
    const results = [];
    const errors = [];

    let workspaceWriteFile, workspacePatchFile;
    try {
      const fsMod = await import("../lib/workspace-fs-tools.js");
      workspaceWriteFile = fsMod.workspaceWriteFile;
      workspacePatchFile = fsMod.workspacePatchFile;
    } catch {
      // workspace-fs-tools not available; record patches without applying
    }

    for (const patch of patches) {
      const { relativePath, content, patchType = "full_replace" } = patch || {};
      if (!relativePath || content == null) {
        errors.push({ relativePath, error: "relativePath and content are required" });
        continue;
      }

      let linesChanged = null;
      let applyError = null;

      try {
        if (workspaceWriteFile && workspacePatchFile) {
          if (patchType === "unified_diff") {
            await workspacePatchFile(workspaceId || "default", relativePath, content);
          } else {
            await workspaceWriteFile(workspaceId || "default", relativePath, content);
            linesChanged = String(content).split("\n").length;
          }
        }
      } catch (err) {
        applyError = err.message;
        errors.push({ relativePath, error: applyError });
        continue;
      }

      const patchRecord = {
        patchId: randomUUID(),
        sessionId: String(sessionId),
        relativePath: String(relativePath),
        patchType: String(patchType),
        appliedAt,
        appliedBy: String(appliedBy),
        linesChanged,
      };

      const path = storePath(sessionId);
      await withPathLock(path, async () => {
        const data = normalizeStore(await readJsonPath(path, null));
        data.patches.push(patchRecord);
        await writeJsonPath(path, data);
      });

      results.push(patchRecord);
    }

    res.status(errors.length > 0 && results.length === 0 ? 400 : 200).json({
      ok: results.length > 0,
      applied: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  apiRoute("get", "/agent-sessions/:sessionId/patches", async (req, res) => {
    const { sessionId } = req.params;
    try {
      const path = storePath(sessionId);
      const data = normalizeStore(await readJsonPath(path, null));
      res.json({ ok: true, patches: data.patches });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
