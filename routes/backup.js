// Backup routes extracted from server.js

export function mountBackupRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    storageRateLimiter,
    backupAdminAuth,
    createBackup,
    listBackups,
    restoreBackup,
  } = deps;

  apiRoute("post", "/backup", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
    try {
      const result = await createBackup();
      res.status(201).json(result);
    } catch (err) {
      console.error("Backup create error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/backup", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
    try {
      const items = listBackups();
      res.json({ items });
    } catch (err) {
      console.error("Backup list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/backup/restore/:id", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
    try {
      await restoreBackup(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      if (err.message?.includes("not found") || err.message?.includes("Backup id required")) {
        return res.status(404).json({ error: err.message, code: "NOT_FOUND" });
      }
      console.error("Backup restore error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Backup cron
  app.get("/api/backup/cron", logRequest, async (req, res) => {
    const secret = process.env.BACKUP_ADMIN_KEY || process.env.CRON_SECRET;
    if (secret && req.query?.secret !== secret && req.headers["authorization"] !== `Bearer ${secret}`) {
      return apiError(res, 401, "UNAUTHORIZED", "Backup cron secret required", "Set BACKUP_ADMIN_KEY and pass via ?secret= or Authorization: Bearer.");
    }
    try {
      const result = await createBackup();
      res.json({ ok: true, id: result.id, createdAt: result.createdAt });
    } catch (err) {
      console.error("Backup cron error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
