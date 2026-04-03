/**
 * Enhanced audit archival with automated lifecycle policies.
 * Moves old entries to S3 archive prefix, purges expired entries.
 * Falls back to local data/audit-archive/ when S3 is not configured.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const DATA_DIR = process.env.STORAGE_PATH || join(PROJECT_ROOT, "data");
const AUDIT_LOG_PATH = join(DATA_DIR, "execution-audit.json");

function localArchiveDir() {
  const dir = join(DATA_DIR, "audit-archive");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function s3Configured() {
  return Boolean(
    process.env.AUDIT_S3_BUCKET?.trim() &&
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
    process.env.AWS_SECRET_ACCESS_KEY?.trim()
  );
}

function buildS3Client() {
  const region = process.env.AUDIT_S3_REGION || process.env.AWS_REGION || "us-east-1";
  const endpoint = process.env.AUDIT_S3_ENDPOINT?.trim() || undefined;
  // Lazy-import to keep S3 optional
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

function s3Bucket() {
  return process.env.AUDIT_S3_BUCKET;
}

function s3Prefix() {
  return (process.env.AUDIT_S3_PREFIX || "siskelbot-audit/").replace(/\/?$/, "/");
}

export class AuditLifecycle {
  constructor() {
    this._policy = {
      retentionDays: Number(process.env.AUDIT_RETENTION_DAYS) || 90,
      archiveAfterDays: Number(process.env.AUDIT_ARCHIVE_AFTER_DAYS) || 30,
      deleteAfterDays: Number(process.env.AUDIT_DELETE_AFTER_DAYS) || 365,
      bucketName: process.env.AUDIT_S3_BUCKET || null,
    };
  }

  /**
   * Set retention policy.
   * @param {{ retentionDays?: number, archiveAfterDays?: number, deleteAfterDays?: number, bucketName?: string }} options
   */
  configure(options) {
    if (options.retentionDays != null) this._policy.retentionDays = Math.max(1, Number(options.retentionDays) || 90);
    if (options.archiveAfterDays != null) this._policy.archiveAfterDays = Math.max(1, Number(options.archiveAfterDays) || 30);
    if (options.deleteAfterDays != null) this._policy.deleteAfterDays = Math.max(1, Number(options.deleteAfterDays) || 365);
    if (options.bucketName !== undefined) this._policy.bucketName = options.bucketName || null;
  }

  /**
   * Return current retention policy.
   */
  getRetentionPolicy() {
    return { ...this._policy };
  }

  /**
   * Move entries older than archiveAfterDays from active storage to archive (S3 or local).
   * Returns { archived: number, remaining: number, key?: string }
   */
  async archiveOldEntries() {
    if (!existsSync(AUDIT_LOG_PATH)) {
      return { archived: 0, remaining: 0 };
    }

    let entries;
    try {
      const raw = readFileSync(AUDIT_LOG_PATH, "utf8");
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) entries = [];
    } catch {
      return { archived: 0, remaining: 0 };
    }

    const cutoff = Date.now() - this._policy.archiveAfterDays * 24 * 60 * 60 * 1000;
    const toArchive = [];
    const toKeep = [];

    for (const entry of entries) {
      const t = entry?.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(t) && t < cutoff) {
        toArchive.push(entry);
      } else {
        toKeep.push(entry);
      }
    }

    if (toArchive.length === 0) {
      return { archived: 0, remaining: toKeep.length };
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePayload = JSON.stringify(toArchive);
    const compressed = gzipSync(Buffer.from(archivePayload, "utf8"));
    let key;

    if (s3Configured()) {
      const prefix = s3Prefix() + "archive/";
      key = `${prefix}audit-${ts}.json.gz`;
      try {
        const client = await buildS3Client();
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        await client.send(new PutObjectCommand({
          Bucket: s3Bucket(),
          Key: key,
          Body: compressed,
          ContentType: "application/gzip",
        }));
      } catch (err) {
        console.warn("[audit-lifecycle] S3 archive upload failed:", err.message);
        return { archived: 0, remaining: entries.length, error: err.message };
      }
    } else {
      // Local fallback
      const dir = localArchiveDir();
      key = `audit-${ts}.json.gz`;
      writeFileSync(join(dir, key), compressed);
    }

    // Update active log with remaining entries
    const logDir = dirname(AUDIT_LOG_PATH);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(AUDIT_LOG_PATH, JSON.stringify(toKeep, null, 0), "utf8");

    return { archived: toArchive.length, remaining: toKeep.length, key };
  }

  /**
   * Delete archived entries older than deleteAfterDays.
   * Returns { purged: number }
   */
  async purgeExpired() {
    const cutoff = Date.now() - this._policy.deleteAfterDays * 24 * 60 * 60 * 1000;
    let purged = 0;

    if (s3Configured()) {
      try {
        const client = await buildS3Client();
        const { ListObjectsV2Command, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const prefix = s3Prefix() + "archive/";
        let continuationToken;

        do {
          const resp = await client.send(new ListObjectsV2Command({
            Bucket: s3Bucket(),
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }));
          const objects = resp.Contents || [];
          for (const obj of objects) {
            if (obj.LastModified && obj.LastModified.getTime() < cutoff) {
              await client.send(new DeleteObjectCommand({
                Bucket: s3Bucket(),
                Key: obj.Key,
              }));
              purged++;
            }
          }
          continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (err) {
        console.warn("[audit-lifecycle] S3 purge failed:", err.message);
        return { purged, error: err.message };
      }
    } else {
      // Local fallback
      const dir = localArchiveDir();
      if (!existsSync(dir)) return { purged: 0 };
      for (const file of readdirSync(dir)) {
        if (!file.startsWith("audit-") || !file.endsWith(".json.gz")) continue;
        // Parse timestamp from filename: audit-YYYY-MM-DDTHH-MM-SS-sssZ.json.gz
        const match = file.match(/^audit-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json\.gz$/);
        if (!match) continue;
        const fileDate = Date.parse(match[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z"));
        if (!Number.isNaN(fileDate) && fileDate < cutoff) {
          try {
            unlinkSync(join(dir, file));
            purged++;
          } catch {
            // skip
          }
        }
      }
    }

    return { purged };
  }
}

/**
 * Set up a daily cron job to run archive + purge.
 * @returns {{ stop: () => void }}
 */
export function scheduleLifecycle() {
  const lifecycle = new AuditLifecycle();

  // Import node-cron (already a project dependency)
  let task;
  import("node-cron").then((cron) => {
    const schedule = cron.default?.schedule || cron.schedule;
    // Run daily at 02:00 UTC
    task = schedule("0 2 * * *", async () => {
      try {
        const archiveResult = await lifecycle.archiveOldEntries();
        console.log("[audit-lifecycle] Archive:", archiveResult);
        const purgeResult = await lifecycle.purgeExpired();
        console.log("[audit-lifecycle] Purge:", purgeResult);
      } catch (err) {
        console.warn("[audit-lifecycle] Scheduled run failed:", err.message);
      }
    }, { scheduled: true });
    console.log("[audit-lifecycle] Daily lifecycle scheduled (02:00 UTC)");
  }).catch((err) => {
    console.warn("[audit-lifecycle] Failed to schedule cron:", err.message);
  });

  return {
    stop() {
      if (task) task.stop();
    },
    lifecycle,
  };
}
