#!/usr/bin/env node
/**
 * Print SHA-256 hex digest for a signed marketplace manifest (unsigned canonical JSON).
 * Usage: node scripts/marketplace-manifest-digest.mjs path/to/manifest.json
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeUnsignedManifestDigestHex } from "../lib/marketplace-registry.js";

const p = process.argv[2];
if (!p) {
  console.error("Usage: node scripts/marketplace-manifest-digest.mjs <manifest.json>");
  process.exit(1);
}
const raw = readFileSync(resolve(p), "utf8");
const manifest = JSON.parse(raw);
const digest = computeUnsignedManifestDigestHex(manifest);
if (!digest) {
  console.error("Invalid manifest object");
  process.exit(1);
}
console.log(digest);
