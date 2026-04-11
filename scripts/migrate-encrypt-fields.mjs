#!/usr/bin/env node
/**
 * Phase 36.4: Field-level encryption migration utility.
 *
 * Walks JSON storage on disk, identifies sensitive fields that should be
 * encrypted according to the current field-encryption config, and writes them
 * back as AES-256-GCM envelopes plus HMAC blind indexes under
 * `_blindIndex`.
 *
 * Usage:
 *   node scripts/migrate-encrypt-fields.mjs [--dry-run] [--verbose]
 *                                            [--storage-path=./data]
 *                                            [--type=context,recipes]
 *                                            [--fields=name1,name2]
 *
 * Environment:
 *   ENCRYPTION_SECRET  required; used as the AES + HMAC key source
 *   STORAGE_PATH       same meaning as in lib/storage.js (default: ./data)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function getArg(name, fallback = null) {
  for (const a of process.argv.slice(2)) {
    if (a === `--${name}`) return "true";
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

if (hasFlag("help") || hasFlag("h")) {
  console.log(`Usage: node scripts/migrate-encrypt-fields.mjs [options]

Options:
  --dry-run                Report what would change without writing
  --verbose                Print every inspected file
  --storage-path=<dir>     Override STORAGE_PATH (default: ./data)
  --type=<a,b,c>           Limit to comma-separated storage types
                           (e.g. context,recipes,conversations)
  --fields=<a,b,c>         Extra custom field names to encrypt on top of the
                           always-encrypted allowlist
  --help, -h               Show this help
`);
  process.exit(0);
}

const dryRun = hasFlag("dry-run");
const verbose = hasFlag("verbose");
const storagePath = getArg("storage-path") || process.env.STORAGE_PATH || join(PROJECT_ROOT, "data");
const typeFilter = (getArg("type") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const extraFields = (getArg("fields") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!process.env.ENCRYPTION_SECRET) {
  console.error("Error: ENCRYPTION_SECRET environment variable is required.");
  process.exit(1);
}

if (!existsSync(storagePath)) {
  console.error(`Error: storage path does not exist: ${storagePath}`);
  process.exit(1);
}

// Import the field-encryption utilities directly so we get the same envelope
// format and blind-index keys used at runtime.
const { encryptFields, computeBlindIndexes, isFieldEncrypted, shouldEncryptField } = await import(
  join(PROJECT_ROOT, "lib", "field-encryption.js")
).catch(async () => {
  // Fallback for when running outside of the repo layout.
  return import("../lib/field-encryption.js");
});

// Known storage file names (mirrors lib/storage.js `files` map).
const STORAGE_FILES = {
  context: "context.json",
  recipes: "recipes.json",
  conversations: "conversations.json",
};

const TARGET_FILES = new Set(
  (typeFilter.length ? typeFilter : Object.keys(STORAGE_FILES))
    .map((t) => STORAGE_FILES[t])
    .filter(Boolean)
);

// ---------------------------------------------------------------------------
// Walk the data directory
// ---------------------------------------------------------------------------

/** @returns {string[]} */
function walkJsonFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(full));
    } else if (entry.isFile() && TARGET_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

function countEncryptedFields(obj, seen = { count: 0 }) {
  if (obj == null) return seen.count;
  if (isFieldEncrypted(obj)) {
    seen.count++;
    return seen.count;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) countEncryptedFields(v, seen);
    return seen.count;
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj)) countEncryptedFields(v, seen);
  }
  return seen.count;
}

function countMatchingFields(obj, customFields, seen = { count: 0 }) {
  if (obj == null || typeof obj !== "object") return seen.count;
  if (Array.isArray(obj)) {
    for (const v of obj) countMatchingFields(v, customFields, seen);
    return seen.count;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (shouldEncryptField(k, customFields) && !isFieldEncrypted(v) && v != null) {
      seen.count++;
    } else if (v && typeof v === "object") {
      countMatchingFields(v, customFields, seen);
    }
  }
  return seen.count;
}

function migrateFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    console.warn(`[skip] ${filePath}: ${e.message}`);
    return { touched: false, migrated: 0 };
  }
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn(`[skip] ${filePath}: invalid JSON (${e.message})`);
    return { touched: false, migrated: 0 };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
    if (verbose) console.log(`[skip] ${filePath}: no items array`);
    return { touched: false, migrated: 0 };
  }

  const toMigrateBefore = countMatchingFields(data.items, extraFields);
  if (toMigrateBefore === 0) {
    if (verbose) console.log(`[ok]   ${filePath}: nothing to migrate`);
    return { touched: false, migrated: 0 };
  }

  const newItems = data.items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const indexes = computeBlindIndexes(item, extraFields);
    const encrypted = encryptFields(item, extraFields);
    if (encrypted && Object.keys(indexes).length > 0) {
      encrypted._blindIndex = { ...(encrypted._blindIndex || {}), ...indexes };
    }
    return encrypted;
  });

  const encryptedNow = countEncryptedFields({ items: newItems });
  const out = {
    ...data,
    items: newItems,
    _version: data._version || 1,
    _encrypted_fields: Array.from(
      new Set([...(Array.isArray(data._encrypted_fields) ? data._encrypted_fields : []), ...extraFields])
    ),
  };

  if (!dryRun) {
    writeFileSync(filePath, JSON.stringify(out, null, 0), "utf8");
  }
  console.log(
    `[${dryRun ? "dry" : "ok "}] ${filePath}: encrypted ${toMigrateBefore} field(s), total envelopes now: ${encryptedNow}`
  );
  return { touched: true, migrated: toMigrateBefore };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(
  `[migrate-encrypt-fields] scanning ${storagePath}${dryRun ? " (dry-run)" : ""}${
    extraFields.length ? ` custom=${extraFields.join(",")}` : ""
  }${typeFilter.length ? ` types=${typeFilter.join(",")}` : ""}`
);

let scanned = 0;
let changed = 0;
let encryptedFieldCount = 0;

try {
  const files = walkJsonFiles(storagePath);
  for (const file of files) {
    scanned++;
    const res = migrateFile(file);
    if (res.touched) changed++;
    encryptedFieldCount += res.migrated;
  }
} catch (e) {
  console.error(`[migrate-encrypt-fields] error: ${e.message}`);
  process.exit(1);
}

console.log(
  `[migrate-encrypt-fields] done. scanned=${scanned} changed=${changed} fieldsEncrypted=${encryptedFieldCount}${
    dryRun ? " (no writes performed)" : ""
  }`
);
