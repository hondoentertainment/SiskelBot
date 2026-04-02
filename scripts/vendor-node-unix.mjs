/**
 * Download official Node.js tarballs (macOS / Linux, x64 or arm64)
 * into vendor/node-{platform}-{arch}/ for bundling with the desktop installer.
 *
 * Usage: node scripts/vendor-node-unix.mjs <platform-arch>
 *   e.g. node scripts/vendor-node-unix.mjs darwin-x64
 *        node scripts/vendor-node-unix.mjs linux-arm64
 * Env: NODE_VENDOR_VERSION=20.18.1
 */
import { createWriteStream, mkdirSync, existsSync, rmSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const VERSION = process.env.NODE_VENDOR_VERSION || "20.18.1";

const VALID = new Set([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);

const arg = (process.argv[2] || "").toLowerCase();
if (!VALID.has(arg)) {
  console.error(
    "Usage: node scripts/vendor-node-unix.mjs <darwin-x64|darwin-arm64|linux-x64|linux-arm64>"
  );
  process.exit(1);
}

const [platform, arch] = arg.split("-");

async function downloadForTarget(platform, arch) {
  const tarName = `node-v${VERSION}-${platform}-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/v${VERSION}/${tarName}`;
  const vendorDir = join(ROOT, "vendor", `node-${platform}-${arch}`);
  const tarPath = join(ROOT, "vendor", "node-download.tar.gz");
  const extractDir = join(ROOT, "vendor", "node-extract");

  console.log("[vendor-node-unix] Downloading", url);
  mkdirSync(join(ROOT, "vendor"), { recursive: true });
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `Failed to download ${url}: ${res.status} ${res.statusText}`
    );
  await pipeline(res.body, createWriteStream(tarPath));

  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  // Extract tarball
  execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: "inherit" });

  const inner = join(extractDir, `node-v${VERSION}-${platform}-${arch}`);
  const nodeBin = join(inner, "bin", "node");
  if (!existsSync(nodeBin)) {
    throw new Error(
      `Expected ${nodeBin} after extract — check NODE_VENDOR_VERSION and target ${platform}-${arch}`
    );
  }

  mkdirSync(vendorDir, { recursive: true });
  const dest = join(vendorDir, "node");
  // Use cp to preserve or set the binary
  execSync(`cp "${nodeBin}" "${dest}"`);
  chmodSync(dest, 0o755);

  rmSync(tarPath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  console.log("[vendor-node-unix] Wrote", dest);
}

async function main() {
  await downloadForTarget(platform, arch);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
