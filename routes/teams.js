export default function mountTeamRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    storage,
    canAccessWorkspace,
    joinByInviteCode,
    createInviteCode,
    getWorkspaceMembers,
    getWorkspaceActivity,
  } = deps;

  apiRoute("post", "/workspaces/join", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const code = req.body?.code?.trim?.();
      if (!code) return apiError(res, 400, "INVALID_INPUT", "code required", "Send { code: string }.");
      const result = await joinByInviteCode(code, req.userId);
      if (!result.ok) {
        if (result.code === "PLAN_LIMIT") {
          return apiError(res, 402, "PLAN_UPGRADE_REQUIRED", result.error, "Upgrade the workspace plan to add more members.");
        }
        const status = result.error?.includes("Invalid") || result.error?.includes("expired") ? 400 : 409;
        return res.status(status).json({ error: result.error, code: "JOIN_FAILED" });
      }
      const members = await getWorkspaceMembers(result.workspaceId);
      const ownerId = members?.ownerId || req.userId;
      const ws = (await storage.getWorkspaceById(ownerId, result.workspaceId)) || {
        id: result.workspaceId,
        name: result.workspaceName || "Team Workspace",
      };
      res.status(200).json({ ok: true, workspace: { id: result.workspaceId, name: ws.name || result.workspaceName } });
    } catch (err) {
      console.error("Workspace join error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/invite", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed || (access.role !== "admin" && access.role !== "member")) {
        return apiError(res, 403, "FORBIDDEN", "Admin or member role required to create invites", null);
      }
      // const ownerId = access.ownerId || req.userId;
      const opts = {};
      if (req.body?.expiresInHours != null) opts.expiresInHours = Number(req.body.expiresInHours);
      if (req.body?.maxUses != null) opts.maxUses = Number(req.body.maxUses);
      const inv = await createInviteCode(workspaceId, req.userId, opts);
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host") || "localhost"}`;
      res.status(201).json({ code: inv.code, inviteLink: `${baseUrl}?join=${inv.code}`, expiresAt: inv.expiresAt, maxUses: inv.maxUses });
    } catch (err) {
      console.error("Invite create error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/members", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
      const entry = await getWorkspaceMembers(workspaceId);
      if (!entry) return res.json({ ownerId: null, members: [] });
      res.json({ ownerId: entry.ownerId, members: entry.members || [] });
    } catch (err) {
      console.error("Members list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/activity", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
      const items = await getWorkspaceActivity(workspaceId, limit);
      res.json({ items });
    } catch (err) {
      console.error("Activity list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
