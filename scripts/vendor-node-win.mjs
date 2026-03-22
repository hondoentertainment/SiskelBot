/**
 * Download official Node.js Windows zip (x64 or arm64) into vendor/node-win-<arch>/
 * for bundling with the desktop installer.
 *
 * Usage: node scripts/vendor-node-win.mjs [x64|arm64|all]
 * Env: NODE_VENDOR_VERSION=20.18.1
 */
import { createWriteStream, mkdirSync, existsSync, copyFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const extractZip = require("extract-zip");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const VERSION = process.env.NODE_VENDOR_VERSION || "20.18.1";

const VALID = new Set(["x64", "arm64", "all"]);
const arg = (process.argv[2] || "x64").toLowerCase();
if (!VALID.has(arg)) {
  console.error("Usage: node scripts/vendor-node-win.mjs [x64|arm64|all]");
  process.exit(1);
}

const archList = arg === "all" ? ["x64", "arm64"] : [arg];

const zipPath = join(ROOT, "vendor", "node-download.zip");
const extractDir = join(ROOT, "vendor", "node-extract");

async function downloadForArch(arch) {
  const zipName = `node-v${VERSION}-win-${arch}.zip`;
  const url = `https://nodejs.org/dist/v${VERSION}/${zipName}`;
  const vendorDir = join(ROOT, "vendor", `node-win-${arch}`);

  console.log("[vendor-node-win] Downloading", url);
  mkdirSync(join(ROOT, "vendor"), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(zipPath));

  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await extractZip(zipPath, { dir: extractDir });

  const inner = join(extractDir, `node-v${VERSION}-win-${arch}`);
  const exe = join(inner, "node.exe");
  if (!existsSync(exe)) {
    throw new Error(`Expected ${exe} after extract — check NODE_VENDOR_VERSION and arch ${arch}`);
  }
  mkdirSync(vendorDir, { recursive: true });
  const dest = join(vendorDir, "node.exe");
  copyFileSync(exe, dest);
  rmSync(zipPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log("[vendor-node-win] Wrote", dest);
}

async function main() {
  for (const arch of archList) {
    await downloadForArch(arch);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
