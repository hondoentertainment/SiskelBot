/**
 * Phase 30: Scope-checking middleware for API key permissions.
 * requireScope(scope) - returns 403 if req.apiKeyScopes does not include the required scope.
 * Scope check is skipped when auth was via session (OAuth) - session users have full access.
 */
export function requireScope(scope) {
  return (req, res, next) => {
    // Session/OAuth users: full access, no scope check
    if (req.session?.userId && !req.apiKeyScopes) {
      return next();
    }
    // No scopes set (e.g. anonymous or legacy path): allow (other auth middleware would have rejected if needed)
    const scopes = req.apiKeyScopes;
    if (!scopes || !Array.isArray(scopes)) {
      return next();
    }
    const required = String(scope || "").trim().toLowerCase();
    if (!required) return next();
    if (scopes.includes(required)) return next();
    return res.status(403).json({
      error: "Insufficient permissions",
      code: "SCOPE_REQUIRED",
      hint: `This route requires scope "${required}". Your key has: ${scopes.join(", ")}`,
    });
  };
}
