#!/usr/bin/env node
/**
 * Generate placeholder app icons for Siskel Bot.
 * Creates SVG-based icons in build/ directory.
 * Replace these with final artwork before release.
 *
 * For production, convert to:
 *   - build/icon.ico   (Windows, 256x256 multi-size)
 *   - build/icon.icns  (macOS, 1024x1024)
 *   - build/icon.png   (Linux, 512x512)
 *
 * Tools: electron-icon-builder, or online converters.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
mkdirSync(buildDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#1a1a2e"/>
  <circle cx="256" cy="200" r="80" fill="#e94560"/>
  <rect x="156" y="320" width="200" height="30" rx="15" fill="#e94560"/>
  <rect x="186" y="370" width="140" height="20" rx="10" fill="#e94560" opacity="0.7"/>
  <text x="256" y="220" text-anchor="middle" fill="white" font-size="72" font-family="Arial, sans-serif" font-weight="bold">SB</text>
</svg>`;

writeFileSync(join(buildDir, "icon.svg"), svg);
console.log("Created build/icon.svg");
console.log("");
console.log("To generate platform icons from this SVG:");
console.log("  npx electron-icon-builder --input=build/icon.svg --output=build/");
console.log("");
console.log("Or manually create:");
console.log("  build/icon.ico   — Windows (256x256 multi-res)");
console.log("  build/icon.icns  — macOS (1024x1024)");
console.log("  build/icon.png   — Linux (512x512)");
