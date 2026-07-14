/**
 * Resolve the durable JSON/file storage root (STORAGE_PATH).
 * On Vercel serverless the deployment filesystem is read-only except os.tmpdir(),
 * so we default there when STORAGE_PATH is unset to avoid mkdir EACCES during boot.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";

export function resolveStorageRoot() {
  const sp = typeof process.env.STORAGE_PATH === "string" ? process.env.STORAGE_PATH.trim() : "";
  if (sp) return sp;
  const onVercel =
    process.env.VERCEL === "1" ||
    process.env.VERCEL === "true" ||
    Boolean(process.env.VERCEL_ENV || process.env.VERCEL_URL);
  if (onVercel) return join(tmpdir(), "siskelbot-data");
  return join(process.cwd(), "data");
}

/** True when state survives restarts (not ephemeral serverless tmpdir). */
export function hasDurableStorage() {
  if (typeof process.env.STORAGE_PATH === "string" && process.env.STORAGE_PATH.trim()) {
    return true;
  }
  const backend = process.env.STORAGE_BACKEND?.trim()?.toLowerCase();
  if (backend === "postgres" && process.env.DATABASE_URL?.trim()) return true;
  if (backend === "redis" && (process.env.REDIS_URL?.trim() || process.env.UPSTASH_REDIS_URL?.trim() || process.env.KV_URL?.trim())) {
    return true;
  }
  if (backend === "sqlite") return true;
  const onVercel =
    process.env.VERCEL === "1" ||
    process.env.VERCEL === "true" ||
    Boolean(process.env.VERCEL_ENV || process.env.VERCEL_URL);
  return !onVercel;
}
