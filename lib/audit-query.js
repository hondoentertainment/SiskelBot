/**
 * Query interface for archived and active audit logs.
 * Searches both the active execution-audit.json and S3/local archives.
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { gunzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATA_DIR = process.env.STORAGE_PATH || join(PROJECT_ROOT, "data");
const AUDIT_LOG_PATH = join(DATA_DIR, "execution-audit.json");

function localArchiveDir() {
  return join(DATA_DIR, "audit-archive");
}

function s3Configured() {
  return Boolean(
    process.env.AUDIT_S3_BUCKET?.trim() &&
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
    process.env.AWS_SECRET_ACCESS_KEY?.trim()
  );
}

function s3Bucket() {
  return process.env.AUDIT_S3_BUCKET;
}

function s3Prefix() {
  return (process.env.AUDIT_S3_PREFIX || "siskelbot-audit/").replace(/\/?$/, "/");
}

function buildS3Client() {
  const region = process.env.AUDIT_S3_REGION || process.env.AWS_REGION || "us-east-1";
  const endpoint = process.env.AUDIT_S3_ENDPOINT?.trim() || undefined;
  return import("@aws-sdk/client-s3").then(({ S3Client }) => {
    return new S3Client({
      region,
      endpoint,
      forcePathStyle: process.env.AUDIT_S3_FORCE_PATH_STYLE === "1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  });
}

/**
 * Load active audit entries from execution-audit.json.
 * @returns {Array<object>}
 */
function loadActiveEntries() {
  if (!existsSync(AUDIT_LOG_PATH)) return [];
  try {
    const raw = readFileSync(AUDIT_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Load archived entries from local disk.
 * @returns {Array<object>}
 */
function loadLocalArchiveEntries() {
  const dir = localArchiveDir();
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json.gz")) continue;
    try {
      const compressed = readFileSync(join(dir, file));
      const raw = gunzipSync(compressed).toString("utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries.push(...parsed);
    } catch {
      // skip corrupt archives
    }
  }
  return entries;
}

/**
 * Load archived entries from S3.
 * @returns {Promise<Array<object>>}
 */
async function loadS3ArchiveEntries() {
  if (!s3Configured()) return [];
  try {
    const client = await buildS3Client();
    const { ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const prefix = s3Prefix() + "archive/";
    const entries = [];
    let continuationToken;

    do {
      const resp = await client.send(new ListObjectsV2Command({
        Bucket: s3Bucket(),
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      const objects = resp.Contents || [];
      for (const obj of objects) {
        if (!obj.Key.endsWith(".json.gz")) continue;
        try {
          const getResp = await client.send(new GetObjectCommand({
            Bucket: s3Bucket(),
            Key: obj.Key,
          }));
          const chunks = [];
          for await (const chunk of getResp.Body) {
            chunks.push(chunk);
          }
          const compressed = Buffer.concat(chunks);
          const raw = gunzipSync(compressed).toString("utf8");
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) entries.push(...parsed);
        } catch {
          // skip unreadable objects
        }
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    return entries;
  } catch (err) {
    console.warn("[audit-query] Failed to load S3 archives:", err.message);
    return [];
  }
}

/**
 * Apply filters to an array of audit entries.
 * @param {Array<object>} entries
 * @param {object} filters
 * @returns {Array<object>}
 */
function applyFilters(entries, filters) {
  let result = entries;

  if (filters.dateRange) {
    const { start, end } = filters.dateRange;
    if (start) {
      const startMs = Date.parse(start);
      if (!Number.isNaN(startMs)) {
        result = result.filter(e => {
          const t = e?.timestamp ? Date.parse(e.timestamp) : NaN;
          return Number.isNaN(t) || t >= startMs;
        });
      }
    }
    if (end) {
      const endMs = Date.parse(end);
      if (!Number.isNaN(endMs)) {
        result = result.filter(e => {
          const t = e?.timestamp ? Date.parse(e.timestamp) : NaN;
          return Number.isNaN(t) || t <= endMs;
        });
      }
    }
  }

  if (filters.userId) {
    result = result.filter(e => e.userId === filters.userId);
  }

  if (filters.action) {
    result = result.filter(e => e.action === filters.action);
  }

  if (filters.workspaceId) {
    result = result.filter(e => e.workspaceId === filters.workspaceId);
  }

  if (filters.level) {
    result = result.filter(e => e.level === filters.level);
  }

  return result;
}

/**
 * Query audit logs with filters and pagination.
 * @param {object} options
 * @param {{ start?: string, end?: string }} [options.dateRange]
 * @param {string} [options.userId]
 * @param {string} [options.action]
 * @param {string} [options.workspaceId]
 * @param {string} [options.level]
 * @param {number} [options.cursor] - offset for pagination (default 0)
 * @param {number} [options.limit] - max results (default 50, max 500)
 * @returns {Promise<{ entries: Array<object>, total: number, cursor: number|null }>}
 */
export async function queryAudit(options = {}) {
  const limit = Math.min(Math.max(1, Number(options.limit) || 50), 500);
  const cursor = Math.max(0, Number(options.cursor) || 0);

  // Gather entries from active + archives
  const active = loadActiveEntries();
  let archived;
  if (s3Configured()) {
    archived = await loadS3ArchiveEntries();
  } else {
    archived = loadLocalArchiveEntries();
  }

  // Merge: archives first (older), then active (newer), sort by timestamp descending
  const all = [...archived, ...active].sort((a, b) => {
    const ta = a?.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b?.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta; // newest first
  });

  const filtered = applyFilters(all, options);
  const total = filtered.length;
  const page = filtered.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < total ? cursor + limit : null;

  return { entries: page, total, cursor: nextCursor };
}

/**
 * Export audit query results as JSON or CSV.
 * @param {object} options - same as queryAudit options (but limit defaults to 10000)
 * @param {"json"|"csv"} format
 * @returns {Promise<{ data: string, contentType: string, filename: string }>}
 */
export async function exportAudit(options = {}, format = "json") {
  // For export, use a high limit
  const exportOptions = { ...options, limit: options.limit || 10000, cursor: 0 };
  const { entries } = await queryAudit(exportOptions);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  if (format === "csv") {
    const columns = ["timestamp", "action", "ok", "error", "userId", "workspaceId", "level", "source", "recipeId", "recipeName"];
    const header = columns.join(",");
    const rows = entries.map(e => {
      return columns.map(col => {
        const val = e?.[col];
        if (val === undefined || val === null) return "";
        const str = String(val);
        // Escape CSV: wrap in quotes if contains comma, quote, or newline
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(",");
    });
    return {
      data: [header, ...rows].join("\n"),
      contentType: "text/csv",
      filename: `audit-export-${ts}.csv`,
    };
  }

  // Default: JSON
  return {
    data: JSON.stringify(entries, null, 2),
    contentType: "application/json",
    filename: `audit-export-${ts}.json`,
  };
}
