/**
 * Phase 25: Admin authentication middleware.
 * Protects /admin and /api/admin/* via ADMIN_API_KEY or userId in QUOTA_ADMIN_USER_IDS.
 *
 * Secret rotation: ADMIN_API_KEY_PREVIOUS is accepted alongside the current key during
 * key rollover. When the previous key is used, a warning is logged so operators can track
 * clients that still need to be updated.
 */
function adminConfig() {
  const users = new Set(
    String(process.env.QUOTA_ADMIN_USER_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return {
    current: process.env.ADMIN_API_KEY?.trim() || null,
    previous: process.env.ADMIN_API_KEY_PREVIOUS?.trim() || null,
    users,
  };
}

/**
 * Check if admin access is configured.
 */
export function isAdminConfigured() {
  const config = adminConfig();
  return Boolean(config.current) || config.users.size > 0;
}

/**
 * Admin auth middleware. Returns 401 when not admin.
 * Checks: Authorization: Bearer <ADMIN_API_KEY>, x-admin-api-key, or req.session.userId in QUOTA_ADMIN_USER_IDS.
 */
export function adminAuth(req, res, next) {
  const config = adminConfig();
  if (!config.current && config.users.size === 0) {
    return res.status(401).json({
      error: "Admin access not configured",
      code: "ADMIN_NOT_CONFIGURED",
      hint: "Set ADMIN_API_KEY or QUOTA_ADMIN_USER_IDS to enable admin routes.",
    });
  }

  // 1. Session user in QUOTA_ADMIN_USER_IDS (OAuth or API key login)
  if (req.session?.userId && config.users.has(req.session.userId)) {
    req.adminUserId = req.session.userId;
    return next();
  }

  // 2. ADMIN_API_KEY via Bearer or header
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : null;
  const xKey = req.headers["x-admin-api-key"];
  const key = bearer || xKey;

  if (key && config.current && key === config.current) {
    req.adminUserId = "admin-key";
    return next();
  }
  if (key && config.previous && key === config.previous) {
    console.warn("[auth] Admin request authenticated with ADMIN_API_KEY_PREVIOUS. Rotate clients to new key.");
    req.adminUserId = "admin-key-previous";
    return next();
  }

  return res.status(401).json({
    error: "Admin access required",
    code: "ADMIN_REQUIRED",
    hint: "Use ADMIN_API_KEY (Bearer or x-admin-api-key) or sign in as a user in QUOTA_ADMIN_USER_IDS.",
  });
}
