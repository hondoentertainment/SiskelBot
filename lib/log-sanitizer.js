/**
 * Phase 36: Log sanitization – redact secrets from objects before logging.
 * Prevents API keys, tokens, passwords from appearing in logs.
 */

const REDACT_PLACEHOLDER = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "apiKey",
  "authorization",
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "session_secret",
  "x-api-key",
  "x-admin-api-key",
  "x-user-api-key",
  "x-backup-admin-key",
  "bearer",
  "cookie",
  "session",
]);

/**
 * Recursively redact sensitive keys from an object.
 * @param {unknown} obj - Object, string, or primitive
 * @returns {unknown} - Sanitized copy (objects/arrays cloned)
 */
export function sanitizeForLog(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForLog(item));
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase().replace(/-/g, "_").replace(/^x_/, "");
    const isSensitive =
      SENSITIVE_KEYS.has(k) ||
      SENSITIVE_KEYS.has(keyLower) ||
      /^(x-)?(api-?key|auth|token|secret|password|cookie|bearer)/i.test(k);

    if (isSensitive && v != null) {
      out[k] = REDACT_PLACEHOLDER;
    } else {
      out[k] = sanitizeForLog(v);
    }
  }
  return out;
}

/**
 * Sanitize request object for logging (headers, body).
 * @param {object} req - Express request
 * @returns {object} - Sanitized { method, path, headers?, body? }
 */
export function sanitizeRequestForLog(req) {
  if (!req) return {};
  const out = {
    method: req.method,
    path: req.path,
  };
  if (req.headers && typeof req.headers === "object") {
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (
        lower.includes("auth") ||
        lower.includes("key") ||
        lower.includes("token") ||
        lower.includes("cookie") ||
        lower.includes("secret") ||
        lower.includes("password")
      ) {
        headers[k] = REDACT_PLACEHOLDER;
      }
    }
    out.headers = headers;
  }
  if (req.body && typeof req.body === "object") {
    out.body = sanitizeForLog(req.body);
  }
  return out;
}
