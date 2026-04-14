// Plugins and marketplace routes extracted from server.js

import {
  getInstallState as loaderGetInstallState,
  enable as loaderEnable,
  disable as loaderDisable,
  uninstall as loaderUninstall,
  install as loaderInstall,
  setLastError as loaderSetLastError,
} from "../lib/plugins-loader.js";

/**
 * In-memory install-job tracker. Jobs expire after 1h and the map is capped.
 * Exported for tests; do not rely on cross-process semantics.
 */
export const INSTALL_JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
const JOB_CAP = 500;

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of INSTALL_JOBS) {
    if (now - job.createdAt > JOB_TTL_MS) INSTALL_JOBS.delete(id);
  }
  if (INSTALL_JOBS.size > JOB_CAP) {
    // Drop oldest
    const entries = [...INSTALL_JOBS.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const drop = entries.slice(0, INSTALL_JOBS.size - JOB_CAP);
    for (const [id] of drop) INSTALL_JOBS.delete(id);
  }
}

function newJobId() {
  return "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Run an install in a microtask so the client sees pending -> running -> done.
 * Kept small and side-effect-free beyond the job map + loader.install call.
 */
function startInstallJob({ packId, workspaceId, installFn }) {
  cleanupJobs();
  const jobId = newJobId();
  const job = {
    jobId,
    packId,
    workspaceId,
    status: "pending",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  INSTALL_JOBS.set(jobId, job);

  // Defer execution so GET /jobs/:id is observable.
  setImmediate(async () => {
    try {
      job.status = "running";
      job.progress = 0.25;
      job.updatedAt = Date.now();

      const result = await Promise.resolve(installFn(packId, workspaceId));

      if (!result || !result.ok) {
        job.status = "error";
        job.progress = 1;
        job.error = (result && result.error) || "Install failed";
        job.updatedAt = Date.now();
        loaderSetLastError(packId, workspaceId, job.error);
        return;
      }

      job.status = "done";
      job.progress = 1;
      job.alreadyInstalled = !!result.alreadyInstalled;
      job.updatedAt = Date.now();
    } catch (err) {
      job.status = "error";
      job.progress = 1;
      job.error = err?.message || "Install crashed";
      job.updatedAt = Date.now();
      try { loaderSetLastError(packId, workspaceId, job.error); } catch { /* noop */ }
    }
  });

  return jobId;
}

export function mountPluginRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    logRequest,
    pluginsActionsRateLimiter,
    marketplaceRateLimiter,
    getRegisteredActions,
    listJsPlugins,
    execJsPlugin,
    marketplaceListAvailable,
    marketplaceRegistry,
    marketplaceInstallPack,
    marketplaceUninstallPack,
  } = deps;

  apiRoute("get", "/plugins/actions", pluginsActionsRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const actions = getRegisteredActions();
      res.json({ actions: [...actions].sort() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/plugins", pluginsActionsRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const plugins = listJsPlugins();
      res.json({ plugins });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGIN_API.md.");
    }
  });

  apiRoute("post", "/plugins/execute", pluginsActionsRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const { pluginId, input, workspaceId, config } = req.body || {};
      if (!pluginId || typeof pluginId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "pluginId is required", "Send { pluginId, input?, workspaceId?, config? }.");
      }
      const result = await execJsPlugin(pluginId.trim(), {
        input: typeof input === "string" ? input : "",
        workspaceId: workspaceId || null,
        userId: req.userId || null,
        config: config && typeof config === "object" ? config : {},
      });
      res.json({ ok: true, output: result.output, metadata: result.metadata });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  apiRoute("get", "/marketplace", marketplaceRateLimiter, logRequest, (req, res) => {
    try {
      const packs = marketplaceListAvailable();
      const category = req.query?.category;
      const filtered = category ? packs.filter((p) => p.category === category) : packs;
      res.json({ _version: 1, packs: filtered });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("get", "/marketplace/:packId", marketplaceRateLimiter, logRequest, (req, res) => {
    try {
      const packId = req.params.packId;
      const manifest = marketplaceRegistry.get(packId);
      if (!manifest) {
        return apiError(res, 404, "NOT_FOUND", `Pack not found: ${packId}`, "Use GET /api/marketplace to list available packs.");
      }
      res.json({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        category: manifest.category || "uncategorized",
        actions: manifest.actions,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("post", "/marketplace/:packId/install", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const packId = req.params.packId;
      const workspaceId = req.body?.workspaceId;
      if (!workspaceId || typeof workspaceId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId required", "Send { workspaceId: string }.");
      }
      const result = marketplaceInstallPack(packId, workspaceId);
      if (!result.ok) {
        return apiError(res, 400, "INSTALL_FAILED", result.error, "Check that the pack exists.");
      }
      res.json({ ok: true, packId, workspaceId, alreadyInstalled: result.alreadyInstalled || false });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("delete", "/marketplace/:packId/install", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const packId = req.params.packId;
      const workspaceId = req.body?.workspaceId || req.query?.workspaceId;
      if (!workspaceId || typeof workspaceId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId required", "Send { workspaceId: string } or ?workspaceId=.");
      }
      const result = marketplaceUninstallPack(packId, workspaceId);
      if (!result.ok) {
        return apiError(res, 400, "UNINSTALL_FAILED", result.error, "Check that the pack exists.");
      }
      res.json({ ok: true, packId, workspaceId });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/plugins", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const workspaceId = req.params.id;
      const packs = deps.marketplaceListInstalled(workspaceId);
      res.json({ _version: 1, workspaceId, packs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // --- Polished plugin install/state endpoints (Phase: marketplace UX) ---

  function resolveWorkspaceId(req) {
    return (
      (req.body && typeof req.body.workspaceId === "string" && req.body.workspaceId.trim()) ||
      (req.query && typeof req.query.workspaceId === "string" && req.query.workspaceId.trim()) ||
      "default"
    );
  }

  apiRoute("get", "/plugins/:id/state", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const pluginId = String(req.params.id || "").trim();
      if (!pluginId) {
        return apiError(res, 400, "INVALID_INPUT", "plugin id required", "Pass :id in the URL path.");
      }
      const workspaceId = resolveWorkspaceId(req);
      const state = loaderGetInstallState(pluginId, workspaceId);
      res.json({ _version: 1, pluginId, workspaceId, ...state });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("post", "/plugins/:id/install", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const pluginId = String(req.params.id || "").trim();
      if (!pluginId) {
        return apiError(res, 400, "INVALID_INPUT", "plugin id required", "Pass :id in the URL path.");
      }
      const workspaceId = resolveWorkspaceId(req);
      const existing = loaderGetInstallState(pluginId, workspaceId);
      if (existing.installed) {
        // Short-circuit: return a synthetic already-done job.
        cleanupJobs();
        const jobId = newJobId();
        INSTALL_JOBS.set(jobId, {
          jobId,
          packId: pluginId,
          workspaceId,
          status: "done",
          progress: 1,
          alreadyInstalled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return res.json({ ok: true, jobId, alreadyInstalled: true });
      }
      const installFn = typeof deps.marketplaceInstallPack === "function"
        ? deps.marketplaceInstallPack
        : loaderInstall;
      const jobId = startInstallJob({ packId: pluginId, workspaceId, installFn });
      res.json({ ok: true, jobId });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("get", "/plugins/jobs/:jobId", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const jobId = String(req.params.jobId || "").trim();
      const job = INSTALL_JOBS.get(jobId);
      if (!job) {
        return apiError(res, 404, "NOT_FOUND", `Job not found: ${jobId}`, "Jobs expire after 1h.");
      }
      const payload = {
        jobId: job.jobId,
        packId: job.packId,
        workspaceId: job.workspaceId,
        status: job.status,
        progress: job.progress,
      };
      if (job.error) payload.error = job.error;
      if (job.alreadyInstalled) payload.alreadyInstalled = true;
      res.json(payload);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("post", "/plugins/:id/enable", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const pluginId = String(req.params.id || "").trim();
      const workspaceId = resolveWorkspaceId(req);
      const state = loaderGetInstallState(pluginId, workspaceId);
      if (!state.installed) {
        return apiError(res, 404, "NOT_FOUND", `Plugin not installed: ${pluginId}`, "Install the plugin first.");
      }
      const result = loaderEnable(pluginId, workspaceId);
      if (!result.ok) {
        return apiError(res, 400, "ENABLE_FAILED", result.error, "Check that the plugin exists.");
      }
      res.json({ ok: true, pluginId, workspaceId, enabled: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("post", "/plugins/:id/disable", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const pluginId = String(req.params.id || "").trim();
      const workspaceId = resolveWorkspaceId(req);
      const state = loaderGetInstallState(pluginId, workspaceId);
      if (!state.installed) {
        return apiError(res, 404, "NOT_FOUND", `Plugin not installed: ${pluginId}`, "Install the plugin first.");
      }
      const result = loaderDisable(pluginId, workspaceId);
      if (!result.ok) {
        return apiError(res, 400, "DISABLE_FAILED", result.error, "Check that the plugin exists.");
      }
      res.json({ ok: true, pluginId, workspaceId, enabled: false });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  apiRoute("delete", "/plugins/:id", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
    try {
      const pluginId = String(req.params.id || "").trim();
      const workspaceId = resolveWorkspaceId(req);
      const state = loaderGetInstallState(pluginId, workspaceId);
      if (!state.installed) {
        return apiError(res, 404, "NOT_FOUND", `Plugin not installed: ${pluginId}`, "Nothing to uninstall.");
      }
      const uninstallFn = typeof deps.marketplaceUninstallPack === "function"
        ? (id, ws) => {
            const r = deps.marketplaceUninstallPack(id, ws);
            if (r && r.ok) loaderUninstall(id, ws); // clear local state too
            return r;
          }
        : loaderUninstall;
      const result = uninstallFn(pluginId, workspaceId);
      if (!result.ok) {
        return apiError(res, 400, "UNINSTALL_FAILED", result.error, "Check that the plugin exists.");
      }
      res.json({ ok: true, pluginId, workspaceId });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // Marketplace HTML page
  app.get("/marketplace", (req, res) => {
    const { join } = deps;
    res.sendFile(join(deps.__dirname, "client", "marketplace.html"));
  });
}
