/**
 * One-command Windows desktop release flow:
 * 1) Ensure bundled node.exe for target arch
 * 2) Stage bundled node.exe for electron-builder resources
 * 3) Try NSIS installer build
 * 4) Fallback to portable build when NSIS fails
 * 5) Emit SHA256 sidecar for produced artifact
 *
 * Usage:
 *   node scripts/desktop-release-win.mjs [x64|arm64]
 */
import { existsSync, writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arch = (process.argv[2] || "x64").toLowerCase();
if (arch !== "x64" && arch !== "arm64") {
  console.error("Usage: node scripts/desktop-release-win.mjs [x64|arm64]");
  process.exit(1);
}
if (process.platform !== "win32") {
  console.error("[desktop-release] Windows-only script. Use on win32 host.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const productName = String(pkg.build?.productName || pkg.name || "app");
const artifactName = `${productName}-${version}-Windows-${arch}.exe`;
const artifactPath = join(ROOT, "release", artifactName);

if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
  console.warn(
    "[desktop-release] No code signing: CSC_LINK (or WIN_CSC_LINK) unset. SmartScreen may warn or block unsigned builds. See docs/DESKTOP.md (SmartScreen)."
  );
}

run("node", ["scripts/ensure-node-vendor.mjs", arch]);
run("node", ["scripts/stage-node-vendor.mjs", arch]);

const nsisArgs = arch === "x64" ? ["--win", "--x64"] : ["--win", "--arm64"];
const nsis = run("npx", ["electron-builder", ...nsisArgs], { allowFailure: true });
if (nsis.status !== 0) {
  console.warn(`[desktop-release] NSIS build failed for ${arch}; falling back to portable.`);
  const portableArgs = arch === "x64" ? ["--win", "portable", "--x64"] : ["--win", "portable", "--arm64"];
  run("npx", ["electron-builder", ...portableArgs]);
}

if (!existsSync(artifactPath)) {
  console.error(`[desktop-release] Expected artifact not found: ${artifactPath}`);
  process.exit(1);
}

const sum = sha256File(artifactPath);
const sidecar = `${artifactPath}.sha256`;
writeFileSync(sidecar, `${sum}  ${artifactName}\n`, "utf8");
console.log(`[desktop-release] Artifact: ${artifactPath}`);
console.log(`[desktop-release] SHA256:   ${sidecar}`);

function run(cmd, args, opts = {}) {
  const exe = process.platform === "win32" && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  const r = spawnSync(exe, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (!opts.allowFailure && (r.status ?? 1) !== 0) {
    process.exit(r.status ?? 1);
  }
  return { status: r.status ?? 1 };
}

function sha256File(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}
