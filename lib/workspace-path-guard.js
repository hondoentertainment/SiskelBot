/**
 * Resolve a user-supplied relative path inside a fixed workspace root.
 * Blocks path traversal, absolute paths, and obvious Windows device paths.
 */
import { resolve, normalize, sep } from "path";

const TRAVERSAL_PART = "..";

/**
 * @param {string} rootAbs - Absolute directory (server-side); must exist as configured root.
 * @param {string} relativePath - Path relative to root (may use / or \\).
 * @returns {{ ok: true, absPath: string } | { ok: false, code: string, error: string }}
 */
export function resolveWorkspacePath(rootAbs, relativePath) {
  const root = normalize(String(rootAbs || "").trim());
  if (!root) {
    return { ok: false, code: "WORKSPACE_ROOT_EMPTY", error: "Workspace root is not configured" };
  }
  const raw = String(relativePath ?? "").trim();
  if (!raw) {
    return { ok: false, code: "PATH_EMPTY", error: "Path is required" };
  }
  if (raw.includes("\0")) {
    return { ok: false, code: "PATH_INVALID", error: "Path contains null bytes" };
  }
  if (/^\\\\\?\\|^\\\\[^\\]/i.test(raw)) {
    return { ok: false, code: "PATH_ESCAPED_DEVICE", error: "Unsupported path prefix" };
  }

  const mixed = raw.replace(/\\/g, "/");
  if (mixed.startsWith("/") || /^[a-zA-Z]:/.test(mixed)) {
    return { ok: false, code: "PATH_NOT_RELATIVE", error: "Path must be relative to workspace root" };
  }

  const parts = mixed.split("/").filter((p) => p && p !== ".");
  for (const p of parts) {
    if (p === TRAVERSAL_PART) {
      return { ok: false, code: "PATH_TRAVERSAL", error: "Path traversal is not allowed" };
    }
  }

  const joined = parts.length > 0 ? resolve(root, ...parts) : root;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const normalizedJoined = normalize(joined);
  if (normalizedJoined !== root && !normalizedJoined.startsWith(rootWithSep)) {
    return { ok: false, code: "PATH_OUTSIDE_ROOT", error: "Resolved path escapes workspace root" };
  }

  return { ok: true, absPath: normalizedJoined };
}
