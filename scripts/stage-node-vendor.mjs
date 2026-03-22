/**
 * Copy vendor/node-win-<arch>/node.exe → vendor/node-win/node.exe for electron-builder extraResources.
 *
 * Usage: node scripts/stage-node-vendor.mjs x64|arm64
 */
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arch = (process.argv[2] || "").toLowerCase();

if (arch !== "x64" && arch !== "arm64") {
  console.error("Usage: node scripts/stage-node-vendor.mjs x64|arm64");
  process.exit(1);
}

const src = join(ROOT, "vendor", `node-win-${arch}`, "node.exe");
const destDir = join(ROOT, "vendor", "node-win");
const dest = join(destDir, "node.exe");

if (!existsSync(src)) {
  console.error("[stage-node-vendor] Missing", src, "— run: node scripts/ensure-node-vendor.mjs", arch);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[stage-node-vendor]", arch, "→", dest);
