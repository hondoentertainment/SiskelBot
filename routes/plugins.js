// Plugins and marketplace routes extracted from server.js

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
}
