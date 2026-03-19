/**
 * Phase 24: Backup & Restore for SiskelBot.
 * Zips data/ to backups/YYYY-MM-DD_HH-mm-ss.zip; supports list and restore.
 */
import { createWriteStream, readdirSync, statSync, rmSync, mkdirSync, cpSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";
import extract from "extract-zip";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const BACKUPS_DIR = join(process.cwd(), "backups");
const BACKUP_MAX_RETAINED = Math.max(1, Number(process.env.BACKUP_MAX_RETAINED) || 7);

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Create a backup: zip data/ to backups/YYYY-MM-DD_HH-mm-ss.zip
 * @returns {{ id: string, path: string, createdAt: string }}
 */
export async function createBackup() {
  ensureDir(BACKUPS_DIR);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `${ts}.zip`;
  const zipPath = join(BACKUPS_DIR, filename);

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => {
      pruneOldBackups();
      resolve({
        id: ts,
        path: zipPath,
        filename,
        createdAt: now.toISOString(),
      });
    });

    archive.on("error", (err) => {
      output.close();
      reject(err);
    });

    archive.pipe(output);

    ensureDir(DATA_DIR);
    archive.directory(DATA_DIR, "data");

    archive.finalize();
  });
}

/**
 * List backups in backups/ (newest first)
 * @returns {{ id: string, filename: string, createdAt: string, sizeBytes?: number }[]}
 */
export function listBackups() {
  ensureDir(BACKUPS_DIR);
  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => {
      const path = join(BACKUPS_DIR, f);
      const stat = statSync(path);
      const id = f.replace(/\.zip$/, "");
      return {
        id,
        filename: f,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return files;
}

/**
 * Restore from backup by id (filename without .zip)
 * @param {string} id - backup id (e.g. "2025-03-18_14-30-00")
 * @throws {Error} if backup not found or restore fails
 */
export async function restoreBackup(id) {
  const safeId = String(id || "").replace(/[^a-zA-Z0-9\-_]/g, "");
  if (!safeId) throw new Error("Backup id required");

  const filename = `${safeId}.zip`;
  const zipPath = join(BACKUPS_DIR, filename);

  if (!existsSync(zipPath)) {
    throw new Error(`Backup not found: ${id}`);
  }

  const tempDir = join(BACKUPS_DIR, `_restore_${randomUUID()}`);
  ensureDir(tempDir);

  try {
    await extract(zipPath, { dir: tempDir });

    const extractedData = join(tempDir, "data");
    if (!existsSync(extractedData)) {
      throw new Error("Backup archive missing data/ directory");
    }

    ensureDir(DATA_DIR);

    const toRemove = readdirSync(DATA_DIR);
    for (const name of toRemove) {
      const target = join(DATA_DIR, name);
      try {
        rmSync(target, { recursive: true });
      } catch (e) {
        console.warn("[backup] Could not remove", target, e.message);
      }
    }

    const toCopy = readdirSync(extractedData);
    for (const name of toCopy) {
      const src = join(extractedData, name);
      const dest = join(DATA_DIR, name);
      cpSync(src, dest, { recursive: true });
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true });
    } catch (e) {
      console.warn("[backup] Could not remove temp dir", tempDir, e.message);
    }
  }
}

function pruneOldBackups() {
  const list = listBackups();
  if (list.length <= BACKUP_MAX_RETAINED) return;

  const toRemove = list.slice(BACKUP_MAX_RETAINED);
  for (const b of toRemove) {
    try {
      rmSync(join(BACKUPS_DIR, b.filename));
    } catch (e) {
      console.warn("[backup] Could not prune", b.filename, e.message);
    }
  }
}
