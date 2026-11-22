/**
 * Extract a zip without following symlinks or writing outside the destination.
 * extract-zip follows symlink entries, so user archives and backup restores use this instead.
 */
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");

function openZip(zipPath) {
  return new Promise((resolveZip, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(err);
      else resolveZip(zip);
    });
  });
}

function isSymlink(entry) {
  const mode = (entry.externalFileAttributes >> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function safeTarget(root, name) {
  const value = String(name || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || value.includes("\0")) return null;
  const parts = value.split("/");
  if (parts.some((part) => part === "..")) return null;
  const target = resolve(root, ...parts);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return { target, directory: value.endsWith("/") };
}

export async function extractZipSafe(zipPath, destDir, opts = {}) {
  const root = resolve(destDir);
  const maxFiles = Math.max(1, Number(opts.maxFiles) || 500);
  const maxBytes = Math.max(1, Number(opts.maxBytes) || 50_000_000);
  await mkdir(root, { recursive: true });
  const zip = await openZip(zipPath);
  let files = 0;
  let bytes = 0;
  try {
    await new Promise((done, reject) => {
      const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
      zip.on("error", fail);
      zip.on("end", () => done());
      zip.on("entry", (entry) => {
        const placed = safeTarget(root, entry.fileName);
        if (!placed) return fail(new Error("zip entry path is not allowed"));
        if (isSymlink(entry)) return fail(new Error("zip symlinks are not allowed"));
        if (placed.directory) {
          mkdir(placed.target, { recursive: true }).then(() => zip.readEntry()).catch(fail);
          return;
        }
        files += 1;
        if (files > maxFiles) return fail(new Error("zip has too many files"));
        mkdir(dirname(placed.target), { recursive: true }).then(() => {
          zip.openReadStream(entry, (err, stream) => {
            if (err) return fail(err);
            const out = createWriteStream(placed.target, { flags: "wx" });
            stream.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                stream.destroy();
                fail(new Error("zip exceeds the size cap"));
              }
            });
            stream.on("error", fail);
            out.on("error", fail);
            out.on("finish", () => zip.readEntry());
            stream.pipe(out);
          });
        }).catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
