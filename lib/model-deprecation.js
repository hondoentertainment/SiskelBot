/**
 * Phase 80.5: Model deprecation scheduler.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { setModelStatus } from "./model-registry.js";

function schedulePath() {
  return join(getDataDir(), "model-deprecations.json");
}

async function load() {
  return readJsonPath(schedulePath(), { _version: 1, items: [] });
}

/**
 * @param {{ modelId: string, version: string, deprecateAt: string, reason?: string }} entry
 */
export async function scheduleDeprecation(entry) {
  const modelId = String(entry.modelId || "").trim();
  const version = String(entry.version || "").trim();
  const deprecateAt = String(entry.deprecateAt || "").trim();
  if (!modelId || !version || !deprecateAt || Number.isNaN(Date.parse(deprecateAt))) {
    throw new Error("modelId, version, and valid deprecateAt ISO date required");
  }
  const item = {
    id: randomUUID(),
    modelId,
    version,
    deprecateAt: new Date(deprecateAt).toISOString(),
    reason: String(entry.reason || "").slice(0, 500),
    status: "scheduled",
    createdAt: new Date().toISOString(),
  };
  return withPathLock(schedulePath(), async () => {
    const data = await load();
    data.items = Array.isArray(data.items) ? data.items : [];
    data.items.push(item);
    await writeJsonPath(schedulePath(), data);
    return item;
  });
}

export async function listDeprecations() {
  const data = await load();
  return data.items || [];
}

/** Apply due deprecations (status → deprecated via model registry). */
export async function processDueDeprecations(now = new Date()) {
  const ts = now.getTime();
  return withPathLock(schedulePath(), async () => {
    const data = await load();
    const applied = [];
    for (const item of data.items || []) {
      if (item.status !== "scheduled") continue;
      if (Date.parse(item.deprecateAt) > ts) continue;
      try {
        await setModelStatus(item.modelId, item.version, "deprecated");
        item.status = "applied";
        item.appliedAt = new Date().toISOString();
        applied.push(item);
      } catch (e) {
        item.lastError = String(e?.message || e);
      }
    }
    await writeJsonPath(schedulePath(), data);
    return { applied, count: applied.length };
  });
}
