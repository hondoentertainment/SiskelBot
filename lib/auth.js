/**
 * Phase 14: User authentication middleware.
 * Supports API key auth via USER_API_KEYS env or users.json.
 * When no auth is configured, falls back to "anonymous" user.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANONYMOUS_USER = "anonymous";
const USERS_JSON_PATH = join(process.cwd(), "data", "users.json");

/** @type {Map<string, string>} key -> userId */
let keyToUser = null;

function loadKeyMappings() {
  if (keyToUser !== null) return keyToUser;
  keyToUser = new Map();

  // 1. USER_API_KEYS env: key1:user1,key2:user2
  const envKeys = process.env.USER_API_KEYS;
  if (envKeys && typeof envKeys === "string") {
    for (const pair of envKeys.split(",")) {
      const [key, userId] = pair.trim().split(":").map((s) => s?.trim());
      if (key && userId) keyToUser.set(key, userId);
    }
  }

  // 2. Fallback: users.json { "key1": "user1", "key2": "user2" } or { "users": [ { "apiKey": "k", "userId": "u" } ] }
  if (keyToUser.size === 0 && existsSync(USERS_JSON_PATH)) {
    try {
      const raw = readFileSync(USERS_JSON_PATH, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          if (u?.apiKey && u?.userId) keyToUser.set(String(u.apiKey), String(u.userId));
        }
      } else if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string") keyToUser.set(k, v);
        }
      }
    } catch (e) {
      console.warn("[auth] Failed to load users.json:", e.message);
    }
  }

  return keyToUser;
}

/**
 * Reset key cache (for tests). Call before loading with different USER_API_KEYS.
 */
export function _resetForTesting() {
  keyToUser = null;
}

/**
 * Check if user auth is configured (USER_API_KEYS or users.json with keys, or OAuth).
 */
export function isAuthConfigured() {
  if (loadKeyMappings().size > 0) return true;
  const hasGitHub = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return hasGitHub || hasGoogle;
}

/**
 * Resolve userId from API key. Returns userId or null if invalid.
 */
export function resolveUserId(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  const trimmed = apiKey.trim();
  if (!trimmed) return null;
  const map = loadKeyMappings();
  return map.get(trimmed) || null;
}

/**
 * Optional user auth middleware. Attaches req.userId (or "anonymous" when no auth configured).
 * Session takes precedence over API key when both present (Phase 19).
 * When auth IS configured and neither session nor valid key: 401.
 */
export function userAuth(req, res, next) {
  // Phase 19: Session takes precedence over API key
  if (req.session?.userId) {
    req.userId = req.session.userId;
    return next();
  }

  const map = loadKeyMappings();
  if (map.size === 0) {
    req.userId = ANONYMOUS_USER;
    return next();
  }

  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7).trim()
    : null;
  const xKey = req.headers["x-user-api-key"];
  const key = bearer || xKey;

  if (!key) {
    return res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
      hint: "Sign in via OAuth, or send Authorization: Bearer <key> or x-user-api-key header.",
    });
  }

  const userId = resolveUserId(key);
  if (!userId) {
    return res.status(401).json({
      error: "Invalid API key",
      code: "AUTH_INVALID",
      hint: "Check your user API key.",
    });
  }

  req.userId = userId;
  next();
}
