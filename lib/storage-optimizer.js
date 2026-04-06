/**
 * Phase 23: Storage query optimization for JSON storage backend.
 * In-memory index, batch reads, and file-system change watching.
 */

import { readFileSync, existsSync, readdirSync, watch } from "fs";
import { join } from "path";

/**
 * In-memory index of item IDs to their collection/file location.
 * Avoids full directory scans on every read.
 */
export function createIndex(dataDir, collection) {
  /** @type {Map<string, { filePath: string, offset?: number }>} */
  const index = new Map();
  let built = false;

  function buildIndex() {
    index.clear();
    try {
      const usersDir = join(dataDir, "users");
      if (!existsSync(usersDir)) {
        built = true;
        return;
      }
      const users = readdirSync(usersDir, { withFileTypes: true });
      for (const userDir of users) {
        if (!userDir.isDirectory()) continue;
        const wsDir = join(usersDir, userDir.name, "workspaces");
        if (!existsSync(wsDir)) continue;
        const workspaces = readdirSync(wsDir, { withFileTypes: true });
        for (const ws of workspaces) {
          if (!ws.isDirectory()) continue;
          const filePath = join(wsDir, ws.name, `${collection}.json`);
          if (!existsSync(filePath)) continue;
          try {
            const data = JSON.parse(readFileSync(filePath, "utf8"));
            if (Array.isArray(data?.items)) {
              for (const item of data.items) {
                if (item?.id) {
                  index.set(item.id, { filePath });
                }
              }
            }
          } catch {
            // Skip corrupt files
          }
        }
      }
    } catch {
      // dataDir may not exist yet
    }
    built = true;
  }

  function lookup(id) {
    if (!built) buildIndex();
    return index.get(id) || null;
  }

  function invalidate() {
    built = false;
    index.clear();
  }

  function getSize() {
    if (!built) buildIndex();
    return index.size;
  }

  return { lookup, invalidate, rebuild: buildIndex, size: getSize };
}

/**
 * Read multiple items in parallel using Promise.all.
 *
 * @param {string} dataDir
 * @param {Array<{ filePath: string, id: string }>} keys
 * @returns {Promise<Map<string, any>>}
 */
export async function batchRead(dataDir, keys) {
  const results = new Map();
  const reads = keys.map(({ filePath, id }) =>
    new Promise((resolve) => {
      try {
        if (!existsSync(filePath)) {
          resolve(null);
          return;
        }
        const data = JSON.parse(readFileSync(filePath, "utf8"));
        if (Array.isArray(data?.items)) {
          const item = data.items.find((x) => x?.id === id);
          if (item) results.set(id, item);
        }
      } catch {
        // Skip errors
      }
      resolve(null);
    })
  );
  await Promise.all(reads);
  return results;
}

/**
 * Watch a data directory for changes and invoke callback on modification.
 * Returns an AbortController-style close function.
 *
 * @param {string} dataDir
 * @param {(eventType: string, filename: string) => void} callback
 * @returns {{ close: () => void }}
 */
export function watchForChanges(dataDir, callback) {
  if (!existsSync(dataDir)) {
    return { close() {} };
  }
  const watcher = watch(dataDir, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith(".json")) {
      callback(eventType, filename);
    }
  });
  return {
    close() {
      watcher.close();
    },
  };
}
