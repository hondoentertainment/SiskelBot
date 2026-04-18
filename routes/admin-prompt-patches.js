/**
 * Admin routes for prompt-tuner patch review.
 *
 * Surfaces the data managed by lib/agent-prompt-tuner.js: per-workspace
 * synthesized system-prompt patches with pending/applied/rejected status.
 * Admins can list, inspect, diff, synthesize, apply, or reject patches.
 *
 * Requires admin auth. Mounted at /api/admin/prompt-patches/*.
 */

import {
  listPatches,
  getActivePatch,
  setPatchStatus,
  autoTuneAndApply,
} from "../lib/agent-prompt-tuner.js";

/**
 * Minimal line-level diff: classifies each line as unchanged, removed, or
 * added by walking the LCS (longest common subsequence) of the two line
 * arrays. No dependencies, bounded O(N*M) which is fine for patches capped
 * at ~1500 chars.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Array<{type: "added"|"removed"|"unchanged", text: string}>}
 */
function lineDiff(from, to) {
  const a = String(from || "").split("\n");
  const b = String(to || "").split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
      else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "unchanged", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "removed", text: a[i] });
      i++;
    } else {
      out.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "removed", text: a[i++] });
  while (j < m) out.push({ type: "added", text: b[j++] });
  return out;
}

export default function mountAdminPromptPatchesRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/prompt-patches?workspace=X&limit=20 */
  app.get(
    "/api/admin/prompt-patches",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 20));
        const [patches, active] = await Promise.all([
          listPatches(workspace, { limit }),
          getActivePatch(workspace),
        ]);
        return res.json({ workspace, active: active || null, patches });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/prompt-patches/diff?workspace=X&from=VER_A&to=VER_B */
  app.get(
    "/api/admin/prompt-patches/diff",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const fromVer = String(req.query?.from || "");
        const toVer = String(req.query?.to || "");
        if (!fromVer || !toVer) {
          return apiError(res, 400, "BAD_REQUEST", "from and to query params required");
        }
        const patches = await listPatches(workspace, { limit: 500 });
        const fromPatch = patches.find((p) => p.version === fromVer);
        const toPatch = patches.find((p) => p.version === toVer);
        if (!fromPatch) return apiError(res, 404, "NOT_FOUND", `patch "${fromVer}" not found`);
        if (!toPatch) return apiError(res, 404, "NOT_FOUND", `patch "${toVer}" not found`);
        const diff = lineDiff(fromPatch.content || "", toPatch.content || "");
        return res.json({ from: fromVer, to: toVer, diff });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/prompt-patches/synthesize?workspace=X */
  app.post(
    "/api/admin/prompt-patches/synthesize",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const body = req.body || {};
        const autoApply = body.autoApply === true;
        const patch = await autoTuneAndApply(workspace, { autoApply });
        if (!patch) return res.json({ patch: null, reason: "no signal" });
        return res.json({ patch });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/prompt-patches/:version?workspace=X */
  app.get(
    "/api/admin/prompt-patches/:version",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const version = String(req.params.version || "");
        const patches = await listPatches(workspace, { limit: 500 });
        const patch = patches.find((p) => p.version === version);
        if (!patch) return apiError(res, 404, "NOT_FOUND", `patch "${version}" not found`);
        return res.json({ patch });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/prompt-patches/:version/apply?workspace=X */
  app.post(
    "/api/admin/prompt-patches/:version/apply",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const version = String(req.params.version || "");
        const body = req.body || {};
        const adminId = typeof body.adminId === "string" && body.adminId.length > 0
          ? body.adminId
          : "admin";
        const patch = await setPatchStatus(workspace, version, "applied", adminId);
        return res.json({ patch });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/unknown patch version/i.test(msg)) {
          return apiError(res, 404, "NOT_FOUND", msg);
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );

  /** POST /api/admin/prompt-patches/:version/reject?workspace=X */
  app.post(
    "/api/admin/prompt-patches/:version/reject",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const version = String(req.params.version || "");
        const body = req.body || {};
        const adminId = typeof body.adminId === "string" && body.adminId.length > 0
          ? body.adminId
          : "admin";
        const patch = await setPatchStatus(workspace, version, "rejected", adminId);
        return res.json({ patch });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/unknown patch version/i.test(msg)) {
          return apiError(res, 404, "NOT_FOUND", msg);
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );
}
