/**
 * Phase 72.2: Model card generator.
 *
 * Produces per-model metadata documents that pair declarative model info
 * (provider, version, intended use, limitations) with observed runtime stats
 * (latency, error rate, safety classifier triggers). Supports markdown export
 * for publishing model cards in governance/compliance repositories.
 *
 * Storage layout:
 *   data/model-cards/cards.json  — { [modelId]: card }
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

const EDITABLE_FIELDS = Object.freeze([
  "displayName",
  "provider",
  "version",
  "trainingData",
  "intendedUse",
  "limitations",
  "evalScores",
  "owner",
  "safetyClassifiers",
  "usageMetrics",
]);

function storePath() {
  return join(getDataDir(), "model-cards", "cards.json");
}

async function loadAll() {
  return readJsonPath(storePath(), { cards: {} });
}

function defaultCard(modelId) {
  return {
    modelId,
    displayName: modelId,
    provider: null,
    version: null,
    trainingData: null,
    intendedUse: null,
    limitations: null,
    evalScores: {},
    owner: null,
    safetyClassifiers: [],
    usageMetrics: { requestCount: 0, tokenCount: 0, errorCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function generateCard({ modelId, metadata = {} } = {}) {
  if (!modelId || typeof modelId !== "string") {
    throw new Error("modelId is required");
  }
  const id = sanitizeId(modelId);
  const file = storePath();
  let saved;
  await withPathLock(file, async () => {
    const data = await loadAll();
    data.cards = data.cards && typeof data.cards === "object" ? data.cards : {};
    const existing = data.cards[id] || defaultCard(id);
    const merged = { ...existing };
    for (const key of EDITABLE_FIELDS) {
      if (metadata[key] !== undefined) merged[key] = metadata[key];
    }
    merged.modelId = id;
    merged.createdAt = existing.createdAt || Date.now();
    merged.updatedAt = Date.now();
    data.cards[id] = merged;
    await writeJsonPath(file, data);
    saved = merged;
  });
  return saved;
}

export async function updateCardField({ modelId, field, value } = {}) {
  if (!modelId) throw new Error("modelId is required");
  if (!field || !EDITABLE_FIELDS.includes(field)) {
    throw new Error(`field must be one of ${EDITABLE_FIELDS.join(", ")}`);
  }
  const id = sanitizeId(modelId);
  const file = storePath();
  let saved;
  await withPathLock(file, async () => {
    const data = await loadAll();
    data.cards = data.cards && typeof data.cards === "object" ? data.cards : {};
    const existing = data.cards[id];
    if (!existing) throw new Error(`model card not found: ${id}`);
    existing[field] = value;
    existing.updatedAt = Date.now();
    data.cards[id] = existing;
    await writeJsonPath(file, data);
    saved = existing;
  });
  return saved;
}

export async function getCard(modelId) {
  const id = sanitizeId(modelId || "");
  const data = await loadAll();
  return data.cards?.[id] || null;
}

export async function listCards() {
  const data = await loadAll();
  return Object.values(data.cards || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function mdLine(label, value) {
  if (value === null || value === undefined || value === "") return `- **${label}:** _not set_`;
  if (typeof value === "object") {
    try {
      return `- **${label}:**\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
    } catch {
      return `- **${label}:** ${String(value)}`;
    }
  }
  return `- **${label}:** ${String(value)}`;
}

export async function exportCardMarkdown(modelId) {
  const card = await getCard(modelId);
  if (!card) return null;
  const parts = [];
  parts.push(`# Model Card: ${card.displayName || card.modelId}`);
  parts.push("");
  parts.push("## Overview");
  parts.push(mdLine("Model ID", card.modelId));
  parts.push(mdLine("Provider", card.provider));
  parts.push(mdLine("Version", card.version));
  parts.push(mdLine("Owner", card.owner));
  parts.push("");
  parts.push("## Intended use");
  parts.push(mdLine("Intended use", card.intendedUse));
  parts.push(mdLine("Limitations", card.limitations));
  parts.push("");
  parts.push("## Training data");
  parts.push(mdLine("Training data", card.trainingData));
  parts.push("");
  parts.push("## Evaluation scores");
  parts.push(mdLine("Eval scores", card.evalScores || {}));
  parts.push("");
  parts.push("## Safety classifiers");
  parts.push(mdLine("Safety classifiers", card.safetyClassifiers || []));
  parts.push("");
  parts.push("## Usage metrics");
  parts.push(mdLine("Usage metrics", card.usageMetrics || {}));
  parts.push("");
  parts.push("## Metadata");
  parts.push(mdLine("Created at", card.createdAt ? new Date(card.createdAt).toISOString() : null));
  parts.push(mdLine("Updated at", card.updatedAt ? new Date(card.updatedAt).toISOString() : null));
  return parts.join("\n");
}

export async function _reset() {
  await writeJsonPath(storePath(), { cards: {} });
}

export const _internals = { sanitizeId, storePath, EDITABLE_FIELDS };
