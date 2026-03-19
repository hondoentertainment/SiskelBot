/**
 * Phase 14 + 30: User authentication middleware.
 * Supports API key auth via USER_API_KEYS env, users.json, or data/api-keys.json.
 * Phase 30: Keys can have scopes (read, write, admin, embed). Format: key:userId:scopes
 * When no auth is configured, falls back to "anonymous" user.
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { findKeyByRaw, loadApiKeys } from "./api-keys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ANONYMOUS_USER = "anonymous";
const DEFAULT_SCOPES = ["read", "write"];
const USERS_JSON_PATH = join(process.cwd(), "data", "users.json");

/** @type {Map<string, { userId: string, scopes: string[] }>} key -> { userId, scopes } */
let keyToInfo = null;

function parseEnvKeyEntry(pair) {
  const parts = pair.trim().split(":").map((s) => s?.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const [key, userId] = parts;
  let scopes = DEFAULT_SCOPES;
  if (parts.length >= 3 && parts[2]) {
    scopes = parts[2].split(",").map((s) => s.trim().toLowerCase()).filter((s) => ["read", "write", "admin", "embed"].includes(s));
    if (scopes.length === 0) scopes = DEFAULT_SCOPES;
  }
  return { key, userId, scopes };
}

function loadKeyMappings() {
  if (keyToInfo !== null) return keyToInfo;
  keyToInfo = new Map();

  // 1. USER_API_KEYS env: key1:user1, key2:user2:read,write, key3:user3:admin
  const envKeys = process.env.USER_API_KEYS;
  if (envKeys && typeof envKeys === "string") {
    for (const pair of envKeys.split(",")) {
      const entry = parseEnvKeyEntry(pair);
      if (entry) keyToInfo.set(entry.key, { userId: entry.userId, scopes: entry.scopes });
    }
  }

  // 2. Fallback: users.json
  if (keyToInfo.size === 0 && existsSync(USERS_JSON_PATH)) {
    try {
      const raw = readFileSync(USERS_JSON_PATH, "utf8");
      const data = JSON.parse(raw);
      const defaultScopes = DEFAULT_SCOPES;
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          if (u?.apiKey && u?.userId) {
            const scopes = Array.isArray(u.scopes) ? u.scopes : defaultScopes;
            keyToInfo.set(String(u.apiKey), { userId: String(u.userId), scopes });
          }
        }
      } else if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === "string") keyToInfo.set(k, { userId: v, scopes: defaultScopes });
        }
      }
    } catch (e) {
      console.warn("[auth] Failed to load users.json:", e.message);
    }
  }

  return keyToInfo;
}

/**
 * Reset key cache (for tests). Call before loading with different USER_API_KEYS.
 */
export function _resetForTesting() {
  keyToInfo = null;
}

/**
 * Check if user auth is configured (USER_API_KEYS, users.json, api-keys.json, or OAuth).
 */
export function isAuthConfigured() {
  if (loadKeyMappings().size > 0) return true;
  if (loadApiKeys().length > 0) return true;
  const hasGitHub = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  return hasGitHub || hasGoogle;
}

/**
 * Resolve userId from API key. Returns userId or null if invalid.
 */
export function resolveUserId(apiKey) {
  const info = resolveKeyInfo(apiKey);
  return info ? info.userId : null;
}

/**
 * Phase 30: Resolve full key info (userId, scopes, keyId) from API key.
 * Checks data/api-keys.json first, then USER_API_KEYS, then users.json.
 * @returns {{ userId: string, scopes: string[], keyId?: string } | null}
 */
export function resolveKeyInfo(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return null;
  const trimmed = apiKey.trim();
  if (!trimmed) return null;

  // 1. data/api-keys.json (admin-managed keys)
  try {
    const fromStore = findKeyByRaw(trimmed);
    if (fromStore) return { userId: fromStore.userId, scopes: fromStore.scopes, keyId: fromStore.id };
  } catch {
    // ignore
  }

  // 2. USER_API_KEYS or users.json
  const map = loadKeyMappings();
  const entry = map.get(trimmed);
  if (entry) return { userId: entry.userId, scopes: entry.scopes };
  return null;
}

/**
 * Optional user auth middleware. Attaches req.userId, req.apiKeyScopes, req.apiKeyId when using API key.
 * Session takes precedence over API key when both present (Phase 19).
 * When auth IS configured and neither session nor valid key: 401.
 */
export function userAuth(req, res, next) {
  // Phase 19: Session takes precedence over API key
  if (req.session?.userId) {
    req.userId = req.session.userId;
    return next();
  }

  // Phase 30: Deployment API_KEY already validated by apiKeyAuth; set userId and continue
  if (req.authenticatedViaDeploymentKey) {
    req.userId = ANONYMOUS_USER;
    return next();
  }

  const map = loadKeyMappings();
  const hasEnvOrUsersKeys = map.size > 0;
  const hasStoreKeys = loadApiKeys().length > 0;
  const hasAnyKeys = hasEnvOrUsersKeys || hasStoreKeys;

  if (!hasAnyKeys) {
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

  const info = resolveKeyInfo(key);
  if (!info) {
    return res.status(401).json({
      error: "Invalid API key",
      code: "AUTH_INVALID",
      hint: "Check your user API key.",
    });
  }

  req.userId = info.userId;
  req.apiKeyScopes = info.scopes;
  if (info.keyId) req.apiKeyId = info.keyId;
  next();
}
