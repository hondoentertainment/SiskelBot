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
  if (process.env.VERCEL === "1") return join(tmpdir(), "siskelbot-data");
  return join(process.cwd(), "data");
}
