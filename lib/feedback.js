/**
 * User feedback collection and analytics.
 * Stores feedback per-workspace in data/feedback/{workspaceId}.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_ENTRIES = 50_000;

function feedbackPath(workspaceId) {
  const ws = typeof workspaceId === "string" && workspaceId.trim() ? workspaceId.trim() : "default";
  return join(getDataDir(), "feedback", `${ws}.json`);
}

async function loadFeedback(workspaceId) {
  const path = feedbackPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveFeedback(workspaceId, items) {
  const path = feedbackPath(workspaceId);
  const trimmed = items.length > MAX_ENTRIES ? items.slice(-MAX_ENTRIES) : items;
  await writeJsonPath(path, { _version: 1, items: trimmed });
}

/**
 * Record user feedback for a conversation message.
 * @param {string} conversationId
 * @param {number} messageIndex
 * @param {number} rating - 1-5
 * @param {string} [comment] - optional text
 * @param {string} [userId]
 * @param {{ workspaceId?: string, model?: string, prompt?: string, response?: string }} [meta]
 * @returns {Promise<{ id: string, createdAt: string }>}
 */
export async function recordFeedback(conversationId, messageIndex, rating, comment, userId, meta = {}) {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId is required");
  }
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    throw new Error("rating must be an integer between 1 and 5");
  }
  if (typeof messageIndex !== "number" || messageIndex < 0) {
    throw new Error("messageIndex must be a non-negative number");
  }

  const workspaceId = meta.workspaceId || "default";
  const path = feedbackPath(workspaceId);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const entry = {
    id,
    conversationId,
    messageIndex,
    rating: numRating,
    comment: typeof comment === "string" ? comment.trim().slice(0, 2000) : null,
    userId: userId || null,
    model: meta.model || null,
    prompt: typeof meta.prompt === "string" ? meta.prompt.slice(0, 5000) : null,
    response: typeof meta.response === "string" ? meta.response.slice(0, 5000) : null,
    createdAt,
  };

  await withPathLock(path, async () => {
    const items = await loadFeedback(workspaceId);
    items.push(entry);
    await saveFeedback(workspaceId, items);
  });

  return { id, createdAt };
}

/**
 * Get feedback statistics for a workspace.
 * @param {string} workspaceId
 * @param {string} [period] - e.g. "7d", "30d", "90d"
 * @returns {Promise<{ total: number, avgRating: number, distribution: Record<number, number>, byModel: Record<string, { total: number, avgRating: number }> }>}
 */
export async function getFeedbackStats(workspaceId, period) {
  const items = await loadFeedback(workspaceId || "default");

  const cutoff = parsePeriodCutoff(period);
  const filtered = cutoff
    ? items.filter((i) => new Date(i.createdAt).getTime() >= cutoff)
    : items;

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byModel = {};
  let sum = 0;

  for (const item of filtered) {
    const r = item.rating;
    distribution[r] = (distribution[r] || 0) + 1;
    sum += r;

    if (item.model) {
      if (!byModel[item.model]) {
        byModel[item.model] = { total: 0, sum: 0 };
      }
      byModel[item.model].total += 1;
      byModel[item.model].sum += r;
    }
  }

  const total = filtered.length;
  const avgRating = total > 0 ? Math.round((sum / total) * 100) / 100 : 0;

  const byModelResult = {};
  for (const [model, data] of Object.entries(byModel)) {
    byModelResult[model] = {
      total: data.total,
      avgRating: Math.round((data.sum / data.total) * 100) / 100,
    };
  }

  return { total, avgRating, distribution, byModel: byModelResult };
}

/**
 * Get feedback entries for a specific model.
 * @param {string} model
 * @param {number} [limit=50]
 * @param {string} [workspaceId]
 * @returns {Promise<Array<{ rating: number, comment: string|null, prompt: string|null, response: string|null, model: string }>>}
 */
export async function getFeedbackForModel(model, limit = 50, workspaceId) {
  const items = await loadFeedback(workspaceId || "default");
  const forModel = items
    .filter((i) => i.model === model)
    .slice(-Math.min(limit, 500))
    .map((i) => ({
      rating: i.rating,
      comment: i.comment,
      prompt: i.prompt,
      response: i.response,
      model: i.model,
      createdAt: i.createdAt,
    }));
  return forModel;
}

/**
 * Export feedback data in various formats for fine-tuning.
 * @param {string} workspaceId
 * @param {"json" | "csv" | "jsonl"} [format="json"]
 * @returns {Promise<{ data: string, contentType: string, filename: string }>}
 */
export async function exportFeedback(workspaceId, format = "json") {
  const items = await loadFeedback(workspaceId || "default");

  if (format === "csv") {
    const header = "id,conversationId,messageIndex,rating,comment,model,userId,createdAt";
    const rows = items.map((i) => {
      const comment = (i.comment || "").replace(/"/g, '""');
      return `${i.id},${i.conversationId},${i.messageIndex},${i.rating},"${comment}",${i.model || ""},${i.userId || ""},${i.createdAt}`;
    });
    return {
      data: [header, ...rows].join("\n"),
      contentType: "text/csv",
      filename: `feedback-${workspaceId || "default"}.csv`,
    };
  }

  if (format === "jsonl") {
    const lines = items.map((i) => JSON.stringify(i));
    return {
      data: lines.join("\n"),
      contentType: "application/x-ndjson",
      filename: `feedback-${workspaceId || "default"}.jsonl`,
    };
  }

  // Default: json
  return {
    data: JSON.stringify(items, null, 2),
    contentType: "application/json",
    filename: `feedback-${workspaceId || "default"}.json`,
  };
}

/**
 * Get all feedback entries for a workspace (raw).
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
export async function listFeedback(workspaceId) {
  return loadFeedback(workspaceId || "default");
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parsePeriodCutoff(period) {
  if (!period) return null;
  const match = String(period).match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  let ms;
  if (unit === "d") ms = n * 24 * 3_600_000;
  else if (unit === "h") ms = n * 3_600_000;
  else if (unit === "m") ms = n * 60_000;
  else return null;
  return Date.now() - ms;
}
