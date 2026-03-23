/**
 * Phase 70: Archive execution audit log to S3-compatible object storage (optional SSE).
 */
import { readFileSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { trimAuditEntries } from "./audit-trim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const AUDIT_LOG_PATH = join(PROJECT_ROOT, "data", "execution-audit.json");

function statusPath() {
  return join(getDataDir(), "audit-archive-status.json");
}

function isConfigured() {
  return Boolean(process.env.AUDIT_S3_BUCKET?.trim() && process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());
}

/**
 * @returns {Promise<{ configured: boolean, lastArchive?: object, history?: object[] }>}
 */
export async function getAuditArchiveStatus() {
  const data = await readJsonPath(statusPath(), { _version: 1, lastArchive: null, history: [] });
  return {
    configured: isConfigured(),
    lastArchive: data.lastArchive || null,
    history: Array.isArray(data.history) ? data.history.slice(-20) : [],
  };
}

/**
 * Upload current execution-audit.json (gzipped) to S3. Updates status file.
 * @returns {Promise<{ ok: boolean, key?: string, error?: string }>}
 */
export async function archiveExecutionAuditToS3() {
  if (!isConfigured()) {
    return { ok: false, error: "AUDIT_S3_BUCKET and AWS credentials not set" };
  }
  if (!existsSync(AUDIT_LOG_PATH)) {
    return { ok: false, error: "No local audit file" };
  }

  let raw;
  try {
    raw = readFileSync(AUDIT_LOG_PATH);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const body = gzipSync(raw);
  const prefix = (process.env.AUDIT_S3_PREFIX || "siskelbot-audit/").replace(/\/?$/, "/");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${prefix}execution-audit-${ts}.json.gz`;

  try {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const region = process.env.AWS_REGION || "us-east-1";
    const endpoint = process.env.AUDIT_S3_ENDPOINT?.trim() || undefined;
    const client = new S3Client({
      region,
      endpoint,
      forcePathStyle: process.env.AUDIT_S3_FORCE_PATH_STYLE === "1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const cmd = new PutObjectCommand({
      Bucket: process.env.AUDIT_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
      ...(process.env.AUDIT_S3_SSE === "AES256" && { ServerSideEncryption: "AES256" }),
    });
    await client.send(cmd);
  } catch (e) {
    console.warn("[audit-s3] Upload failed:", e.message);
    return { ok: false, error: e.message };
  }

  const entry = {
    key,
    at: new Date().toISOString(),
    bytes: body.length,
    bucket: process.env.AUDIT_S3_BUCKET,
  };

  await withPathLock(statusPath(), async () => {
    const data = await readJsonPath(statusPath(), { _version: 1, lastArchive: null, history: [] });
    data.lastArchive = entry;
    data.history = Array.isArray(data.history) ? [...data.history, entry].slice(-50) : [entry];
    await writeJsonPath(statusPath(), data);
  });

  if (process.env.AUDIT_ARCHIVE_TRIM_LOCAL === "1") {
    try {
      const max = Math.max(10, Number(process.env.AUDIT_MAX_ENTRIES) || 1000);
      const days = process.env.AUDIT_RETENTION_DAYS ? Number(process.env.AUDIT_RETENTION_DAYS) : null;
      const parsed = JSON.parse(raw.toString("utf8"));
      const arr = Array.isArray(parsed) ? parsed : [];
      const trimmed = trimAuditEntries(arr, max, days);
      const { writeFileSync, mkdirSync } = await import("fs");
      mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
      writeFileSync(AUDIT_LOG_PATH, JSON.stringify(trimmed, null, 0), "utf8");
    } catch (e) {
      console.warn("[audit-s3] Local trim after archive failed:", e.message);
    }
  }

  return { ok: true, key };
}
