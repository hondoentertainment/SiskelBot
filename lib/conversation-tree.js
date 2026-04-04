/**
 * Conversation branching & forking.
 * Allows users to branch a conversation at any message to explore alternative agent paths.
 * Branch metadata is stored via the existing storage abstraction under type "conversations".
 * Branch records are stored as a separate storage type "conversation-branches".
 */
import { randomUUID } from "crypto";
import * as storage from "./storage.js";

const BRANCH_TYPE = "conversations";

// function loadBranches(workspace = "default", userId = "anonymous") {
//   const all = await storage.list(BRANCH_TYPE, workspace, userId);
//   return all.filter((c) => c._isBranch);
// }

/**
 * Create a new branch from an existing conversation at a specific message index.
 * Copies messages up to (and including) atMessageIndex into the new branch.
 *
 * @param {string} conversationId - The source conversation ID
 * @param {number} atMessageIndex - Branch point (messages 0..atMessageIndex are copied)
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.label] - Optional human-readable label
 * @param {string} [opts.workspace]
 * @returns {Promise<object>} The new branch conversation object
 */
export async function branchConversation(conversationId, atMessageIndex, userId = "anonymous", opts = {}) {
  const workspace = opts.workspace || "default";
  const label = typeof opts.label === "string" ? opts.label.trim().slice(0, 200) : "";

  // Load the source conversation
  const source = await storage.get(BRANCH_TYPE, conversationId, workspace, userId);
  if (!source) throw new Error("Source conversation not found");

  const sourceMessages = Array.isArray(source.messages) ? source.messages : [];
  if (atMessageIndex < 0 || atMessageIndex >= sourceMessages.length) {
    throw new Error(`Invalid branch point: ${atMessageIndex}. Conversation has ${sourceMessages.length} messages.`);
  }

  // Copy messages up to and including atMessageIndex
  const branchedMessages = sourceMessages.slice(0, atMessageIndex + 1);

  const branchId = randomUUID();
  const now = new Date().toISOString();

  const branch = {
    id: branchId,
    _isBranch: true,
    parentConversationId: conversationId,
    branchPoint: atMessageIndex,
    label: label || `Branch at message ${atMessageIndex}`,
    title: label || `Branch of: ${(source.title || "Untitled").slice(0, 100)}`,
    messages: branchedMessages,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    tags: Array.isArray(source.tags) ? [...source.tags] : [],
    workspace,
  };

  await storage.add(BRANCH_TYPE, branch, workspace, false, userId);
  return branch;
}

/**
 * Get the tree structure of a conversation and all its branches (recursive).
 *
 * @param {string} rootConversationId
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<object>} Tree node: { conversation, branches: [tree nodes] }
 */
export async function getConversationTree(rootConversationId, workspace = "default", userId = "anonymous") {
  const all = await storage.list(BRANCH_TYPE, workspace, userId);

  const root = all.find((c) => String(c.id) === String(rootConversationId));
  if (!root) return null;

  function buildTree(convId) {
    const conv = all.find((c) => String(c.id) === String(convId));
    if (!conv) return null;

    const childBranches = all.filter(
      (c) => c._isBranch && String(c.parentConversationId) === String(convId)
    );

    return {
      id: conv.id,
      title: conv.title || "Untitled",
      label: conv.label || null,
      parentConversationId: conv.parentConversationId || null,
      branchPoint: conv.branchPoint != null ? conv.branchPoint : null,
      messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
      createdAt: conv.createdAt,
      branches: childBranches.map((b) => buildTree(b.id)).filter(Boolean),
    };
  }

  return buildTree(rootConversationId);
}

/**
 * List all direct branches of a conversation.
 *
 * @param {string} conversationId
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<object[]>} Array of branch metadata (without full messages)
 */
export async function listBranches(conversationId, workspace = "default", userId = "anonymous") {
  const all = await storage.list(BRANCH_TYPE, workspace, userId);
  return all
    .filter((c) => c._isBranch && String(c.parentConversationId) === String(conversationId))
    .map((b) => ({
      id: b.id,
      parentConversationId: b.parentConversationId,
      branchPoint: b.branchPoint,
      label: b.label || "",
      title: b.title || "Untitled",
      messageCount: Array.isArray(b.messages) ? b.messages.length : 0,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    }));
}

/**
 * Get a specific branch by ID (returns full conversation data).
 *
 * @param {string} branchId
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<object|null>}
 */
export async function getBranch(branchId, workspace = "default", userId = "anonymous") {
  const item = await storage.get(BRANCH_TYPE, branchId, workspace, userId);
  if (!item || !item._isBranch) return null;
  return item;
}

/**
 * Delete a branch by ID. Also deletes any child branches recursively.
 *
 * @param {string} branchId
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<boolean>}
 */
export async function deleteBranch(branchId, workspace = "default", userId = "anonymous") {
  const branch = await storage.get(BRANCH_TYPE, branchId, workspace, userId);
  if (!branch || !branch._isBranch) return false;

  // Recursively delete child branches
  const children = await listBranches(branchId, workspace, userId);
  for (const child of children) {
    await deleteBranch(child.id, workspace, userId);
  }

  return storage.remove(BRANCH_TYPE, branchId, workspace, userId);
}
