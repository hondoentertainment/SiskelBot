/**
 * Phase 30: API key usage audit log.
 * Logs keyId (masked), timestamp, path to data/api-key-audit.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const AUDIT_PATH = join(DATA_DIR, "api-key-audit.json");
const AUDIT_MAX_ENTRIES = 5000;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Log API key usage.
 * @param {{ keyId: string, path: string, method?: string }} entry
 */
export function logKeyUsage(entry) {
  if (!entry?.keyId || !entry?.path) return;
  try {
    ensureDataDir();
    let log = [];
    if (existsSync(AUDIT_PATH)) {
      try {
        const raw = readFileSync(AUDIT_PATH, "utf8");
        log = JSON.parse(raw);
        if (!Array.isArray(log)) log = [];
      } catch {
        log = [];
      }
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
    writeFileSync(AUDIT_PATH, JSON.stringify(log, null, 2), "utf8");
  } catch (e) {
    console.warn("[api-key-audit] Failed to log:", e.message);
  }
}
