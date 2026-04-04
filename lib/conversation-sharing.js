/**
 * Conversation sharing with optional password protection and expiration.
 * Share links are stored via the storage abstraction under type "conversations"
 * using a dedicated shared-conversations storage key pattern.
 */
import { randomUUID, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getSharesPath() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "shared-conversations.json");
}

function loadShares() {
  const p = getSharesPath();
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch { /* empty */ }
  return { shares: [] };
}

function saveShares(data) {
  const p = getSharesPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 0), "utf8");
}

function hashPassword(password) {
  return createHash("sha256").update(String(password)).digest("hex");
}

/**
 * Create a share link for a conversation.
 * @param {string} conversationId
 * @param {string} userId
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {number} [options.expiresIn] - Hours until expiration
 * @param {string} [options.password] - Optional password protection
 * @returns {Promise<{shareId: string, url: string, expiresAt: string|null}>}
 */
export async function createShareLink(conversationId, userId, workspaceId, options = {}) {
  const { expiresIn, password } = options;
  const shareId = randomUUID();
  const now = new Date();
  const expiresAt = typeof expiresIn === "number" && expiresIn > 0
    ? new Date(now.getTime() + expiresIn * 3600000).toISOString()
    : null;

  const share = {
    shareId,
    conversationId,
    userId,
    workspaceId,
    passwordHash: password ? hashPassword(password) : null,
    expiresAt,
    createdAt: now.toISOString(),
    revoked: false,
  };

  const data = loadShares();
  data.shares.push(share);
  saveShares(data);

  return {
    shareId,
    url: `/shared.html?id=${shareId}`,
    expiresAt,
  };
}

/**
 * Get a shared conversation by share ID. Validates expiration and password.
 * @param {string} shareId
 * @param {string} [password]
 * @returns {Promise<{share: object, needsPassword: boolean}|null>}
 */
export async function getSharedConversation(shareId, password) {
  const data = loadShares();
  const share = data.shares.find((s) => s.shareId === shareId && !s.revoked);
  if (!share) return null;

  if (share.expiresAt && new Date(share.expiresAt) < new Date()) return null;

  if (share.passwordHash) {
    if (!password) return { share: { shareId: share.shareId, conversationId: share.conversationId }, needsPassword: true };
    if (hashPassword(password) !== share.passwordHash) return null;
  }

  // Load the actual conversation from storage
  const storageModule = await import("./storage.js");
  const conversation = await storageModule.get("conversations", share.conversationId, share.workspaceId, share.userId);
  if (!conversation) return null;

  return {
    share: {
      shareId: share.shareId,
      conversationId: share.conversationId,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    },
    conversation,
    needsPassword: false,
  };
}

/**
 * Revoke (delete) a share link. Only the owner can revoke.
 * @param {string} shareId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function revokeShareLink(shareId, userId) {
  const data = loadShares();
  const share = data.shares.find((s) => s.shareId === shareId && s.userId === userId && !s.revoked);
  if (!share) return false;
  share.revoked = true;
  saveShares(data);
  return true;
}

/**
 * List all active share links for a user/workspace.
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<object[]>}
 */
export async function listShareLinks(userId, workspaceId) {
  const data = loadShares();
  const now = new Date();
  return data.shares
    .filter((s) =>
      s.userId === userId &&
      s.workspaceId === workspaceId &&
      !s.revoked &&
      (!s.expiresAt || new Date(s.expiresAt) > now)
    )
    .map((s) => ({
      shareId: s.shareId,
      conversationId: s.conversationId,
      url: `/shared.html?id=${s.shareId}`,
      expiresAt: s.expiresAt,
      createdAt: s.createdAt,
      hasPassword: !!s.passwordHash,
    }));
}
