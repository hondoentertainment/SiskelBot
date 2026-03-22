/**
 * Ensure vendor/node-win-<arch>/node.exe exists (download via vendor-node-win.mjs if missing).
 *
 * Usage: node scripts/ensure-node-vendor.mjs [x64|arm64|all]
 */
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (process.argv[2] || "x64").toLowerCase();

if (!["x64", "arm64", "all"].includes(arg)) {
  console.error("Usage: node scripts/ensure-node-vendor.mjs [x64|arm64|all]");
  process.exit(1);
}

function has(arch) {
  return existsSync(join(ROOT, "vendor", `node-win-${arch}`, "node.exe"));
}

if (arg === "all") {
  if (has("x64") && has("arm64")) process.exit(0);
} else if (has(arg)) {
  process.exit(0);
}

console.log("[desktop] Bundled node.exe missing; downloading Node.js for Windows...");
const r = spawnSync(process.execPath, [join(ROOT, "scripts", "vendor-node-win.mjs"), arg === "all" ? "all" : arg], {
  stdio: "inherit",
  cwd: ROOT,
});
process.exit(r.status ?? 1);
