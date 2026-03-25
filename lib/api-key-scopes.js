/**
 * Phase 30: API key scope parsing and checking utilities.
 *
 * Key format: key:userId:scopes (scopes comma-separated, e.g. "read,write").
 * Legacy formats (key or key:userId) default to all scopes for backward compatibility.
 */

const ALL_SCOPES = ["read", "write", "admin", "embed"];
const VALID_SCOPES = new Set(ALL_SCOPES);

/**
 * Parse a key string in the format key:userId:scopes.
 * - "mykey123"                  → { key: "mykey123", userId: null, scopes: ALL_SCOPES }
 * - "mykey123:user1"            → { key: "mykey123", userId: "user1", scopes: ALL_SCOPES }
 * - "mykey123:user1:read,write" → { key: "mykey123", userId: "user1", scopes: ["read","write"] }
 *
 * Keys without scopes (legacy) get all scopes for backward compatibility.
 *
 * @param {string} keyString
 * @returns {{ key: string, userId: string|null, scopes: string[] } | null}
 */
export function parseApiKey(keyString) {
  if (!keyString || typeof keyString !== "string") return null;
  const trimmed = keyString.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map((s) => s.trim());

  const key = parts[0];
  if (!key) return null;

  const userId = parts.length >= 2 && parts[1] ? parts[1] : null;

  // If scopes segment present, parse it; otherwise default to all scopes
  if (parts.length >= 3 && parts[2]) {
    const scopes = parts[2]
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_SCOPES.has(s));
    // If all specified scopes were invalid, default to all scopes
    return { key, userId, scopes: scopes.length > 0 ? scopes : [...ALL_SCOPES] };
  }

  return { key, userId, scopes: [...ALL_SCOPES] };
}

/**
 * Check if a parsed key has a required scope.
 * @param {{ scopes: string[] }} parsedKey - Object with scopes array (from parseApiKey or req.apiKeyScopes)
 * @param {string} requiredScope - The scope to check for
 * @returns {boolean}
 */
export function hasScope(parsedKey, requiredScope) {
  if (!parsedKey || !Array.isArray(parsedKey.scopes)) return false;
  return parsedKey.scopes.includes(requiredScope);
}

/**
 * Express middleware factory that checks the current request's API key has the required scope.
 * Must run AFTER auth middleware that sets req.apiKeyScopes.
 *
 * - If req.apiKeyScopes is not set (e.g. session auth, anonymous), allows through.
 * - If req.apiKeyScopes is set but missing the required scope, returns 403.
 *
 * @param {string} scope - Required scope (read, write, admin, embed)
 * @returns {import("express").RequestHandler}
 */
export function requireScope(scope) {
  return (req, res, next) => {
    // If no apiKeyScopes attached, auth was via session/anonymous — allow through
    const scopes = req.apiKeyScopes;
    if (!scopes) return next();

    if (Array.isArray(scopes) && scopes.includes(scope)) {
      return next();
    }

    return res.status(403).json({
      error: `Insufficient scope: requires '${scope}'`,
      code: "SCOPE_INSUFFICIENT",
      requiredScope: scope,
      hint: `Your API key does not have the '${scope}' scope. Contact your admin to update key permissions.`,
    });
  };
}

export { ALL_SCOPES, VALID_SCOPES };
