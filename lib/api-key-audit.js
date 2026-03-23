/**
 * Phase 30: API key usage audit log.
 * Phase 68: data/api-key-audit.json via json-path-store.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const AUDIT_MAX_ENTRIES = 5000;

function auditPath() {
  return join(getDataDir(), "api-key-audit.json");
}

/**
 * Log API key usage (async; safe to fire-and-forget).
 * @param {{ keyId: string, path: string, method?: string }} entry
 */
export async function logKeyUsage(entry) {
  if (!entry?.keyId || !entry?.path) return;
  const path = auditPath();
  try {
    await withPathLock(path, async () => {
      const data = await readJsonPath(path, []);
      let log = Array.isArray(data) ? [...data] : [];
      if (!Array.isArray(data) && data && typeof data === "object" && Array.isArray(data.entries)) {
        log = [...data.entries];
      }
      log.push({
        keyId: entry.keyId,
        path: entry.path,
        method: entry.method || "GET",
        timestamp: new Date().toISOString(),
      });
      if (log.length > AUDIT_MAX_ENTRIES) {
        log = log.slice(-AUDIT_MAX_ENTRIES);
      }
      await writeJsonPath(path, log);
    });
  } catch (e) {
    console.warn("[api-key-audit] Failed to log:", e.message);
  }
}
