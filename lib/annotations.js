/**
 * Phase 41.4: Collaborative annotations — inline comments, replies, reactions.
 *
 * Storage: data/annotations/{workspaceId}.json
 *
 * Annotations are inline discussions attached to messages, documents, recipes,
 * or conversations. Each annotation can have a parent (forming reply threads),
 * an anchor (text range within the target), reactions (emoji toggles per user),
 * a resolved flag, and a per-user "read" set for unread tracking.
 *
 * A WebSocket broadcaster can be installed via setBroadcaster() so create/update/
 * delete/reaction events are pushed to all workspace members in real time.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_ANNOTATIONS_PER_WORKSPACE = 50_000;
const MAX_TEXT_LEN = 8_000;
const VALID_TARGET_TYPES = new Set(["message", "document", "recipe", "conversation"]);

/** @type {((workspaceId: string, message: object) => void) | null} */
let broadcaster = null;

/**
 * Install a WebSocket broadcaster used to push annotation events to workspace
 * members. The function should accept (workspaceId, message) and forward the
 * message to all sockets connected to that workspace.
 * @param {(workspaceId: string, message: object) => void} fn
 */
export function setBroadcaster(fn) {
  broadcaster = typeof fn === "function" ? fn : null;
}

function emit(workspaceId, message) {
  if (!broadcaster || !workspaceId) return;
  try {
    broadcaster(workspaceId, message);
  } catch (e) {
    console.warn("[annotations] broadcast error:", e && e.message);
  }
}

function sanitizeWs(ws) {
  if (typeof ws !== "string" || !ws.trim()) return "default";
  return ws.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
}

function annotationsPath(workspaceId) {
  const ws = sanitizeWs(workspaceId);
  return join(getDataDir(), "annotations", `${ws}.json`);
}

async function loadAll(workspaceId) {
  const path = annotationsPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveAll(workspaceId, items) {
  const path = annotationsPath(workspaceId);
  const trimmed = items.length > MAX_ANNOTATIONS_PER_WORKSPACE
    ? items.slice(-MAX_ANNOTATIONS_PER_WORKSPACE)
    : items;
  await writeJsonPath(path, { _version: 1, items: trimmed });
}

function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, MAX_TEXT_LEN);
}

function normalizeAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const start = Number(anchor.start);
  const end = Number(anchor.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < 0 || end < start) return null;
  return { start, end };
}

function normalizeTargetType(t) {
  const s = typeof t === "string" ? t.trim() : "";
  if (!VALID_TARGET_TYPES.has(s)) return null;
  return s;
}

function normalizeTargetId(id) {
  if (typeof id !== "string") return "";
  return id.trim().slice(0, 200);
}

function publicView(annotation) {
  if (!annotation) return null;
  return {
    id: annotation.id,
    workspaceId: annotation.workspaceId,
    targetType: annotation.targetType,
    targetId: annotation.targetId,
    userId: annotation.userId,
    text: annotation.text,
    anchor: annotation.anchor || null,
    parentId: annotation.parentId || null,
    reactions: annotation.reactions || {},
    resolved: !!annotation.resolved,
    resolvedBy: annotation.resolvedBy || null,
    resolvedAt: annotation.resolvedAt || null,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    readBy: Array.isArray(annotation.readBy) ? annotation.readBy : [],
    deleted: !!annotation.deleted,
  };
}

function findActive(items, id) {
  return items.find((a) => String(a.id) === String(id) && !a.deleted);
}

/**
 * Create a new annotation on a target.
 * @param {string} targetType - "message" | "document" | "recipe" | "conversation"
 * @param {string} targetId
 * @param {{ workspaceId?: string, userId: string, text: string, anchor?: { start: number, end: number }, parentId?: string, reactions?: object }} annotation
 * @returns {Promise<object>}
 */
export async function createAnnotation(targetType, targetId, annotation) {
  const tt = normalizeTargetType(targetType);
  if (!tt) {
    throw new Error(`targetType must be one of: ${Array.from(VALID_TARGET_TYPES).join(", ")}`);
  }
  const tid = normalizeTargetId(targetId);
  if (!tid) {
    throw new Error("targetId is required");
  }
  if (!annotation || typeof annotation !== "object") {
    throw new Error("annotation payload is required");
  }
  const text = normalizeText(annotation.text);
  if (!text) {
    throw new Error("text is required");
  }
  const userId = typeof annotation.userId === "string" && annotation.userId.trim()
    ? annotation.userId.trim()
    : "anonymous";

  const workspaceId = sanitizeWs(annotation.workspaceId);
  const path = annotationsPath(workspaceId);

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    workspaceId,
    targetType: tt,
    targetId: tid,
    userId,
    text,
    anchor: normalizeAnchor(annotation.anchor),
    parentId: typeof annotation.parentId === "string" && annotation.parentId.trim()
      ? annotation.parentId.trim()
      : null,
    reactions: annotation.reactions && typeof annotation.reactions === "object"
      ? annotation.reactions
      : {},
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    readBy: [userId],
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };

  await withPathLock(path, async () => {
    const items = await loadAll(workspaceId);
    // If parentId is set, validate it exists.
    if (entry.parentId) {
      const parent = findActive(items, entry.parentId);
      if (!parent) {
        throw new Error(`parentId not found: ${entry.parentId}`);
      }
      // Inherit target from parent for replies.
      entry.targetType = parent.targetType;
      entry.targetId = parent.targetId;
    }
    items.push(entry);
    await saveAll(workspaceId, items);
  });

  const view = publicView(entry);
  emit(workspaceId, { type: "annotation_created", annotation: view });
  return view;
}

/**
 * Get annotations for a target.
 * @param {string} targetType
 * @param {string} targetId
 * @param {{ workspaceId?: string, includeReplies?: boolean, includeResolved?: boolean, userId?: string }} [options]
 * @returns {Promise<object[]>}
 */
export async function getAnnotations(targetType, targetId, options = {}) {
  const tt = normalizeTargetType(targetType);
  if (!tt) {
    throw new Error(`targetType must be one of: ${Array.from(VALID_TARGET_TYPES).join(", ")}`);
  }
  const tid = normalizeTargetId(targetId);
  if (!tid) return [];
  const workspaceId = sanitizeWs(options.workspaceId);
  const includeReplies = options.includeReplies !== false; // default true
  const includeResolved = !!options.includeResolved;

  const items = await loadAll(workspaceId);
  let filtered = items.filter(
    (a) => !a.deleted && a.targetType === tt && a.targetId === tid
  );
  if (!includeResolved) {
    filtered = filtered.filter((a) => !a.resolved);
  }
  if (!includeReplies) {
    filtered = filtered.filter((a) => !a.parentId);
  }
  return filtered.map(publicView);
}

/**
 * Update annotation text. Only the author can update.
 * @param {string} annotationId
 * @param {string} text
 * @param {string} userId
 * @param {string} [workspaceId]
 * @returns {Promise<object>}
 */
export async function updateAnnotation(annotationId, text, userId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  const newText = normalizeText(text);
  if (!newText) {
    throw new Error("text is required");
  }
  let updated = null;
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const ann = findActive(items, annotationId);
    if (!ann) throw new Error("annotation not found");
    if (ann.userId !== userId) {
      throw new Error("only the author can update this annotation");
    }
    ann.text = newText;
    const now = new Date().toISOString();
    ann.updatedAt = now > ann.createdAt ? now : new Date(new Date(ann.createdAt).getTime() + 1).toISOString();
    updated = ann;
    await saveAll(ws, items);
  });
  const view = publicView(updated);
  emit(ws, { type: "annotation_updated", annotation: view });
  return view;
}

/**
 * Delete an annotation. Only the author may delete (soft-delete).
 * Replies remain but become orphaned (parent marked deleted).
 * @param {string} annotationId
 * @param {string} userId
 * @param {string} [workspaceId]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteAnnotation(annotationId, userId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const ann = findActive(items, annotationId);
    if (!ann) throw new Error("annotation not found");
    if (ann.userId !== userId) {
      throw new Error("only the author can delete this annotation");
    }
    ann.deleted = true;
    ann.updatedAt = new Date().toISOString();
    await saveAll(ws, items);
  });
  emit(ws, { type: "annotation_deleted", annotationId });
  return { ok: true };
}

/**
 * Reply to an existing annotation. The reply inherits target from the parent.
 * @param {string} parentId
 * @param {{ workspaceId?: string, text: string }} reply
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function replyToAnnotation(parentId, reply, userId) {
  if (!reply || typeof reply !== "object") {
    throw new Error("reply payload is required");
  }
  const text = normalizeText(reply.text);
  if (!text) {
    throw new Error("text is required");
  }
  const ws = sanitizeWs(reply.workspaceId);
  const items = await loadAll(ws);
  const parent = findActive(items, parentId);
  if (!parent) {
    throw new Error("parent annotation not found");
  }
  return createAnnotation(parent.targetType, parent.targetId, {
    workspaceId: ws,
    userId,
    text,
    parentId,
  });
}

/**
 * Get all replies for an annotation (one level deep).
 * @param {string} parentId
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function getReplies(parentId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  return items
    .filter((a) => !a.deleted && a.parentId === parentId)
    .map(publicView);
}

/**
 * Toggle a reaction emoji on an annotation. If the user already reacted with
 * the same emoji, the reaction is removed; otherwise it is added.
 * @param {string} annotationId
 * @param {string} emoji
 * @param {string} userId
 * @param {string} [workspaceId]
 * @returns {Promise<{ reactions: object }>}
 */
export async function addReaction(annotationId, emoji, userId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  if (typeof emoji !== "string" || !emoji.trim()) {
    throw new Error("emoji is required");
  }
  const e = emoji.trim().slice(0, 16);
  if (!userId) throw new Error("userId is required");

  let resultReactions = null;
  let action = "added";
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const ann = findActive(items, annotationId);
    if (!ann) throw new Error("annotation not found");
    if (!ann.reactions || typeof ann.reactions !== "object") ann.reactions = {};
    const list = Array.isArray(ann.reactions[e]) ? ann.reactions[e] : [];
    const idx = list.indexOf(userId);
    if (idx >= 0) {
      list.splice(idx, 1);
      action = "removed";
    } else {
      list.push(userId);
      action = "added";
    }
    if (list.length === 0) {
      delete ann.reactions[e];
    } else {
      ann.reactions[e] = list;
    }
    ann.updatedAt = new Date().toISOString();
    resultReactions = ann.reactions;
    await saveAll(ws, items);
  });

  emit(ws, {
    type: "annotation_reaction",
    annotationId,
    emoji: e,
    userId,
    action,
    reactions: resultReactions,
  });
  return { reactions: resultReactions };
}

/**
 * Get the reaction map for an annotation.
 * @param {string} annotationId
 * @param {string} [workspaceId]
 * @returns {Promise<object>}
 */
export async function getReactions(annotationId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  const ann = findActive(items, annotationId);
  if (!ann) return {};
  return ann.reactions || {};
}

/**
 * Mark an annotation as resolved.
 * @param {string} annotationId
 * @param {string} userId
 * @param {string} [workspaceId]
 * @returns {Promise<object>}
 */
export async function resolveAnnotation(annotationId, userId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  let view = null;
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const ann = findActive(items, annotationId);
    if (!ann) throw new Error("annotation not found");
    ann.resolved = true;
    ann.resolvedBy = userId || "anonymous";
    ann.resolvedAt = new Date().toISOString();
    ann.updatedAt = ann.resolvedAt;
    view = publicView(ann);
    await saveAll(ws, items);
  });
  emit(ws, { type: "annotation_updated", annotation: view });
  return view;
}

/**
 * Mark an annotation as unresolved.
 * @param {string} annotationId
 * @param {string} userId
 * @param {string} [workspaceId]
 * @returns {Promise<object>}
 */
export async function unresolveAnnotation(annotationId, userId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  let view = null;
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const ann = findActive(items, annotationId);
    if (!ann) throw new Error("annotation not found");
    ann.resolved = false;
    ann.resolvedBy = null;
    ann.resolvedAt = null;
    ann.updatedAt = new Date().toISOString();
    view = publicView(ann);
    await saveAll(ws, items);
  });
  emit(ws, { type: "annotation_updated", annotation: view });
  return view;
}

/**
 * Get unread annotations for a user in a workspace. An annotation is "unread"
 * for a user if the user has not been added to its readBy set.
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<object[]>}
 */
export async function getUnreadAnnotations(userId, workspaceId) {
  if (!userId) return [];
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  return items
    .filter((a) => !a.deleted && a.userId !== userId)
    .filter((a) => !Array.isArray(a.readBy) || !a.readBy.includes(userId))
    .map(publicView);
}

/**
 * Mark a list of annotations as read for a user.
 * @param {string} userId
 * @param {string[]} annotationIds
 * @param {string} [workspaceId]
 * @returns {Promise<{ ok: boolean, count: number }>}
 */
export async function markAnnotationsRead(userId, annotationIds, workspaceId = "default") {
  if (!userId) throw new Error("userId is required");
  if (!Array.isArray(annotationIds) || annotationIds.length === 0) {
    return { ok: true, count: 0 };
  }
  const ws = sanitizeWs(workspaceId);
  const path = annotationsPath(ws);
  let count = 0;
  await withPathLock(path, async () => {
    const items = await loadAll(ws);
    const idSet = new Set(annotationIds.map(String));
    for (const ann of items) {
      if (ann.deleted) continue;
      if (!idSet.has(String(ann.id))) continue;
      if (!Array.isArray(ann.readBy)) ann.readBy = [];
      if (!ann.readBy.includes(userId)) {
        ann.readBy.push(userId);
        count++;
      }
    }
    if (count > 0) await saveAll(ws, items);
  });
  return { ok: true, count };
}

/**
 * Get the full thread (annotation + all replies + reactions) for an annotation.
 * If the supplied id is a reply, the root is found and returned.
 * @param {string} annotationId
 * @param {string} [workspaceId]
 * @returns {Promise<{ annotation: object, replies: object[] } | null>}
 */
export async function getAnnotationThread(annotationId, workspaceId = "default") {
  const ws = sanitizeWs(workspaceId);
  const items = await loadAll(ws);
  let root = items.find((a) => String(a.id) === String(annotationId));
  if (!root) return null;
  // Walk up to root if this is a reply
  while (root && root.parentId) {
    const parent = items.find((a) => String(a.id) === String(root.parentId));
    if (!parent) break;
    root = parent;
  }
  if (!root || root.deleted) return null;
  const replies = items
    .filter((a) => !a.deleted && a.parentId === root.id)
    .map(publicView);
  return { annotation: publicView(root), replies };
}
