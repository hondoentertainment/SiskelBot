/**
 * Phase 25: Admin authentication middleware.
 * Protects /admin and /api/admin/* via ADMIN_API_KEY or userId in QUOTA_ADMIN_USER_IDS.
 */
const ADMIN_API_KEY = process.env.ADMIN_API_KEY?.trim() || null;
const QUOTA_ADMIN_USER_IDS_RAW = process.env.QUOTA_ADMIN_USER_IDS || "";
const ADMIN_USER_IDS = new Set(
  QUOTA_ADMIN_USER_IDS_RAW.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * Check if admin access is configured.
 */
export function isAdminConfigured() {
  return Boolean(ADMIN_API_KEY) || ADMIN_USER_IDS.size > 0;
}

/**
 * Admin auth middleware. Returns 401 when not admin.
 * Checks: Authorization: Bearer <ADMIN_API_KEY>, x-admin-api-key, or req.session.userId in QUOTA_ADMIN_USER_IDS.
 */
export function adminAuth(req, res, next) {
  if (!isAdminConfigured()) {
    return res.status(401).json({
      error: "Admin access not configured",
      code: "ADMIN_NOT_CONFIGURED",
      hint: "Set ADMIN_API_KEY or QUOTA_ADMIN_USER_IDS to enable admin routes.",
    });
  }

  // 1. Session user in QUOTA_ADMIN_USER_IDS (OAuth or API key login)
  if (req.session?.userId && ADMIN_USER_IDS.has(req.session.userId)) {
    return next();
  }

  // 2. ADMIN_API_KEY via Bearer or header
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : null;
  const xKey = req.headers["x-admin-api-key"];
  const key = bearer || xKey;

  if (key && key === ADMIN_API_KEY) {
    return next();
  }

  return res.status(401).json({
    error: "Admin access required",
    code: "ADMIN_REQUIRED",
    hint: "Use ADMIN_API_KEY (Bearer or x-admin-api-key) or sign in as a user in QUOTA_ADMIN_USER_IDS.",
  });
}
