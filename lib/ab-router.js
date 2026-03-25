/**
 * Multi-model A/B routing — weighted routing across multiple LLM backends
 * for comparison and evaluation.
 *
 * Config format (MODEL_ROUTING env var): "ollama:0.8,openai:0.2"
 */

import { isOpen } from "./circuit-breaker.js";

/** @type {Map<string, number>} */
const stats = new Map();

/**
 * Parse MODEL_ROUTING config string into an array of { backend, weight } entries.
 * Weights are normalised to sum to 1.
 * @param {string} configString - e.g. "ollama:0.8,openai:0.2"
 * @returns {{ backend: string; weight: number }[]}
 */
export function parseRoutingConfig(configString) {
  if (!configString || typeof configString !== "string") return [];
  const pairs = configString
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const entries = [];
  for (const pair of pairs) {
    const [backend, weightStr] = pair.split(":");
    if (!backend || !weightStr) continue;
    const weight = Number(weightStr);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    entries.push({ backend: backend.trim().toLowerCase(), weight });
  }

  if (entries.length === 0) return [];

  // Normalise weights to sum to 1
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  for (const e of entries) {
    e.weight = e.weight / total;
  }

  return entries;
}

/**
 * Deterministic weighted random selection based on requestId.
 * Uses a simple hash of the requestId to pick consistently.
 * @param {{ backend: string; weight: number }[]} routingConfig
 * @param {string} requestId
 * @returns {string} selected backend name
 */
export function selectBackend(routingConfig, requestId) {
  if (!routingConfig || routingConfig.length === 0) return null;
  if (routingConfig.length === 1) return routingConfig[0].backend;

  // Simple deterministic hash from requestId -> [0, 1)
  const hash = hashString(requestId);
  const rand = (hash >>> 0) / 0x100000000; // unsigned 32-bit -> [0,1)

  // Filter out backends whose circuit breaker is open
  const available = routingConfig.filter((e) => !isOpen(e.backend).open);

  if (available.length === 0) {
    // All circuits open — fall back to first configured backend anyway
    return routingConfig[0].backend;
  }

  // Re-normalise available weights
  const total = available.reduce((sum, e) => sum + e.weight, 0);

  let cumulative = 0;
  for (const entry of available) {
    cumulative += entry.weight / total;
    if (rand < cumulative) {
      return entry.backend;
    }
  }

  // Float precision fallback
  return available[available.length - 1].backend;
}

/**
 * Log a routing decision.
 * @param {string} requestId
 * @param {string} selectedBackend
 * @param {{ backend: string; weight: number }[]} allWeights
 */
export function logRouting(requestId, selectedBackend, allWeights) {
  // Increment stats
  stats.set(selectedBackend, (stats.get(selectedBackend) || 0) + 1);

  const weightMap = {};
  for (const e of allWeights) {
    weightMap[e.backend] = e.weight;
  }

  console.log(
    JSON.stringify({
      event: "ab_routing",
      requestId,
      selectedBackend,
      weights: weightMap,
      timestamp: new Date().toISOString(),
    })
  );
}

/**
 * Return request counts per backend.
 * @returns {Record<string, number>}
 */
export function getRoutingStats() {
  const result = {};
  for (const [backend, count] of stats) {
    result[backend] = count;
  }
  return result;
}

/**
 * Reset stats (for testing).
 */
export function resetStats() {
  stats.clear();
}

// --- internal ---

/**
 * Simple 32-bit FNV-1a hash.
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}
