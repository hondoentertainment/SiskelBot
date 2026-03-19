/**
 * Phase 32: Load eval sets from data/eval-sets/*.json or data/eval-sets.json
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

/**
 * List available eval sets (id, name).
 * @returns {Array<{ id: string, name: string }>}
 */
export function listEvalSets() {
  const dataDir = getDataDir();
  const setsDir = join(dataDir, "eval-sets");
  const singleFile = join(dataDir, "eval-sets.json");
  const result = [];

  if (existsSync(singleFile)) {
    try {
      const raw = readFileSync(singleFile, "utf8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : data.sets ? data.sets : [data];
      for (const s of items) {
        if (s && s.id) result.push({ id: s.id, name: s.name || s.id });
      }
    } catch (_) {}
  }

  if (existsSync(setsDir)) {
    try {
      const files = readdirSync(setsDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const path = join(setsDir, f);
          const raw = readFileSync(path, "utf8");
          const s = JSON.parse(raw);
          if (s && s.id && !result.some((r) => r.id === s.id)) {
            result.push({ id: s.id, name: s.name || s.id });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return result;
}

/**
 * Load eval set by id.
 * @param {string} id - Eval set id (filename without .json or id field)
 * @returns {object|null} Eval set or null
 */
export function loadEvalSet(id) {
  if (!id || typeof id !== "string") return null;
  const dataDir = getDataDir();
  const setsDir = join(dataDir, "eval-sets");
  const singleFile = join(dataDir, "eval-sets.json");

  if (existsSync(singleFile)) {
    try {
      const raw = readFileSync(singleFile, "utf8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : data.sets ? data.sets : [data];
      const found = items.find((s) => s && s.id === id);
      if (found) return found;
    } catch (_) {}
  }

  const path = join(setsDir, `${id}.json`);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw);
    } catch (_) {}
  }

  const pathNoExt = join(setsDir, id);
  if (existsSync(pathNoExt)) {
    try {
      const raw = readFileSync(pathNoExt, "utf8");
      return JSON.parse(raw);
    } catch (_) {}
  }

  return null;
}
