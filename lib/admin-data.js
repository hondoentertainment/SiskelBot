/**
 * Phase 25: Admin dashboard data aggregation.
 * Collects users, workspaces, usage, quotas, health, and audit for admin UI.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import { getSummary } from "./usage-tracker.js";
import { getWorkspaceQuota, getWorkspaceTokensUsed, getQuotaOverrides, isQuotaConfigured } from "./quotas.js";
import * as storage from "./storage.js";

const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const OAUTH_USERS_PATH = join(DATA_DIR, "oauth-users.json");
const USERS_JSON_PATH = join(DATA_DIR, "users.json");
const AUDIT_LOG_PATH = join(DATA_DIR, "execution-audit.json");
const USERS_DIR = join(DATA_DIR, "users");

/**
 * List all users from data/users dir, oauth-users.json, and users.json.
 * @returns {Array<{ userId: string, source: string }>}
 */
export function listAllUsers() {
  const seen = new Set();
  const result = [];

  // 1. From data/users/ directories
  if (existsSync(USERS_DIR)) {
    for (const name of readdirSync(USERS_DIR)) {
      if (name.startsWith(".")) continue;
      const stat = statSync(join(USERS_DIR, name));
      if (stat.isDirectory() && !seen.has(name)) {
        seen.add(name);
        result.push({ userId: name, source: "storage" });
      }
    }
  }

  // 2. From oauth-users.json
  try {
    if (existsSync(OAUTH_USERS_PATH)) {
      const raw = readFileSync(OAUTH_USERS_PATH, "utf8");
      const data = JSON.parse(raw);
      const users = Array.isArray(data.users) ? data.users : [];
      for (const u of users) {
        const id = u?.userId;
        if (id && !seen.has(id)) {
          seen.add(id);
          result.push({ userId: id, source: "oauth", provider: u?.provider });
        }
      }
    }
  } catch (e) {
    console.warn("[admin-data] Failed to load oauth-users:", e.message);
  }

  // 3. From users.json (API key mappings)
  try {
    if (existsSync(USERS_JSON_PATH)) {
      const raw = readFileSync(USERS_JSON_PATH, "utf8");
      const data = JSON.parse(raw);
      const userIds = [];
      if (Array.isArray(data.users)) {
        for (const u of data.users) {
          if (u?.userId) userIds.push(u.userId);
        }
      } else if (data && typeof data === "object") {
        for (const v of Object.values(data)) {
          if (typeof v === "string") userIds.push(v);
        }
      }
      for (const id of userIds) {
        if (id && !seen.has(id)) {
          seen.add(id);
          result.push({ userId: id, source: "api-keys" });
        }
      }
    }
  } catch (e) {
    console.warn("[admin-data] Failed to load users.json:", e.message);
  }

  return result;
}

/**
 * List all workspaces across users.
 * @returns {Array<{ userId: string, workspace: object }>}
 */
export async function listAllWorkspaces() {
  const users = listAllUsers();
  const result = [];
  for (const { userId } of users) {
    const workspaces = await storage.listWorkspaces(userId);
    for (const ws of workspaces) {
      result.push({ userId, workspace: ws });
    }
  }
  return result;
}

/**
 * Get recent audit log entries.
 * @param {number} limit
 * @returns {Array<object>}
 */
export function getRecentAuditLog(limit = 50) {
  try {
    if (existsSync(AUDIT_LOG_PATH)) {
      const raw = readFileSync(AUDIT_LOG_PATH, "utf8");
      const entries = JSON.parse(raw);
      const arr = Array.isArray(entries) ? entries : [];
      return arr.slice(-limit).reverse();
    }
  } catch (e) {
    console.warn("[admin-data] Failed to load audit log:", e.message);
  }
  return [];
}
