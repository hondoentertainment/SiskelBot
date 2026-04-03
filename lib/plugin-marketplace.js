/**
 * Phase 49: Plugin Marketplace
 * Curated action packs with signed manifests and discovery.
 * File-based: manifests stored on disk in plugins/packs/<packId>/manifest.json.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { createHmac } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PACKS_DIR = join(PROJECT_ROOT, "plugins", "packs");
const INSTALLED_PATH = join(PROJECT_ROOT, "data", "marketplace-installed.json");

/** Required manifest fields */
const REQUIRED_FIELDS = ["id", "name", "version", "description", "author", "actions"];
const ID_PATTERN = /^[a-z0-9-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VALID_ACTION_TYPES = ["webhook", "builtin"];

/**
 * In-memory registry of available plugin packs.
 * Keys are pack IDs, values are manifest objects.
 * @type {Map<string, object>}
 */
export const registry = new Map();

/**
 * Validate a manifest object against the schema.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["Manifest must be a non-null object"] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  if (typeof manifest.id === "string" && !ID_PATTERN.test(manifest.id)) {
    errors.push("id must be lowercase alphanumeric with hyphens only");
  }
  if (typeof manifest.version === "string" && !VERSION_PATTERN.test(manifest.version)) {
    errors.push("version must be semver (e.g. 1.0.0)");
  }
  if (manifest.actions !== undefined) {
    if (!Array.isArray(manifest.actions)) {
      errors.push("actions must be an array");
    } else if (manifest.actions.length === 0) {
      errors.push("actions must contain at least one action");
    } else {
      for (let i = 0; i < manifest.actions.length; i++) {
        const action = manifest.actions[i];
        if (!action || typeof action !== "object") {
          errors.push(`actions[${i}] must be an object`);
          continue;
        }
        if (!action.name || typeof action.name !== "string") {
          errors.push(`actions[${i}].name is required and must be a string`);
        }
        if (!action.type || typeof action.type !== "string") {
          errors.push(`actions[${i}].type is required and must be a string`);
        } else if (!VALID_ACTION_TYPES.includes(action.type)) {
          errors.push(`actions[${i}].type must be one of: ${VALID_ACTION_TYPES.join(", ")}`);
        }
      }
    }
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Load and validate a plugin pack manifest from a JSON file path.
 * Registers it in the registry on success.
 * @param {string} manifestPath - Absolute or relative path to manifest.json
 * @returns {{ ok: boolean, manifest?: object, errors?: string[] }}
 */
export function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`File not found: ${manifestPath}`] };
  }
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (e) {
    return { ok: false, errors: [`Failed to read file: ${e.message}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e.message}`] };
  }
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }
  registry.set(manifest.id, manifest);
  return { ok: true, manifest };
}

/**
 * Verify a manifest's HMAC-SHA256 signature using PLUGIN_SIGNING_KEY env var.
 * The signature is computed over the manifest JSON without the "signature" field.
 * @param {object} manifest - The manifest object
 * @param {string} signature - The hex-encoded HMAC-SHA256 signature
 * @returns {{ ok: boolean, error?: string }}
 */
export function verifyManifest(manifest, signature) {
  const signingKey = process.env.PLUGIN_SIGNING_KEY;
  if (!signingKey) {
    console.warn("[marketplace] PLUGIN_SIGNING_KEY not set; skipping signature verification");
    return { ok: true, skipped: true };
  }
  if (!signature || typeof signature !== "string") {
    return { ok: false, error: "Missing signature" };
  }
  // Build canonical JSON without the signature field
  const canonical = { ...manifest };
  delete canonical.signature;
  const payload = JSON.stringify(canonical);
  const expected = createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
  if (expected !== signature.toLowerCase()) {
    return { ok: false, error: "Signature mismatch" };
  }
  return { ok: true };
}

/**
 * Sign a manifest object with HMAC-SHA256. Returns the hex signature.
 * Useful for creating signed manifests.
 * @param {object} manifest - The manifest object (without signature field)
 * @param {string} signingKey - The HMAC key
 * @returns {string} Hex-encoded signature
 */
export function signManifest(manifest, signingKey) {
  const canonical = { ...manifest };
  delete canonical.signature;
  const payload = JSON.stringify(canonical);
  return createHmac("sha256", signingKey).update(payload, "utf8").digest("hex");
}

/**
 * Load the installed-packs data from disk.
 * @returns {Record<string, string[]>} workspaceId -> array of packIds
 */
function loadInstalledData() {
  if (!existsSync(INSTALLED_PATH)) return {};
  try {
    const raw = readFileSync(INSTALLED_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * Save installed-packs data to disk.
 * @param {Record<string, string[]>} data
 */
function saveInstalledData(data) {
  const dir = dirname(INSTALLED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(INSTALLED_PATH, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Install a plugin pack into a workspace.
 * @param {string} packId
 * @param {string} workspaceId
 * @returns {{ ok: boolean, error?: string }}
 */
export function installPack(packId, workspaceId) {
  if (!packId || typeof packId !== "string") {
    return { ok: false, error: "packId is required" };
  }
  if (!workspaceId || typeof workspaceId !== "string") {
    return { ok: false, error: "workspaceId is required" };
  }
  if (!registry.has(packId)) {
    return { ok: false, error: `Pack not found: ${packId}` };
  }
  const data = loadInstalledData();
  if (!Array.isArray(data[workspaceId])) {
    data[workspaceId] = [];
  }
  if (data[workspaceId].includes(packId)) {
    return { ok: true, alreadyInstalled: true };
  }
  data[workspaceId].push(packId);
  saveInstalledData(data);
  return { ok: true };
}

/**
 * Uninstall a plugin pack from a workspace.
 * @param {string} packId
 * @param {string} workspaceId
 * @returns {{ ok: boolean, error?: string }}
 */
export function uninstallPack(packId, workspaceId) {
  if (!packId || typeof packId !== "string") {
    return { ok: false, error: "packId is required" };
  }
  if (!workspaceId || typeof workspaceId !== "string") {
    return { ok: false, error: "workspaceId is required" };
  }
  const data = loadInstalledData();
  if (!Array.isArray(data[workspaceId])) {
    return { ok: true };
  }
  const idx = data[workspaceId].indexOf(packId);
  if (idx === -1) {
    return { ok: true };
  }
  data[workspaceId].splice(idx, 1);
  if (data[workspaceId].length === 0) {
    delete data[workspaceId];
  }
  saveInstalledData(data);
  return { ok: true };
}

/**
 * List all available plugin packs with metadata.
 * @returns {Array<{ id: string, name: string, version: string, description: string, author: string, category?: string, actionCount: number }>}
 */
export function listAvailable() {
  return Array.from(registry.values()).map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    category: m.category || "uncategorized",
    actionCount: Array.isArray(m.actions) ? m.actions.length : 0,
  }));
}

/**
 * List installed packs for a workspace, with full metadata.
 * @param {string} workspaceId
 * @returns {Array<{ id: string, name: string, version: string, description: string, author: string, category?: string, actionCount: number }>}
 */
export function listInstalled(workspaceId) {
  const data = loadInstalledData();
  const packIds = Array.isArray(data[workspaceId]) ? data[workspaceId] : [];
  return packIds
    .filter((pid) => registry.has(pid))
    .map((pid) => {
      const m = registry.get(pid);
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        category: m.category || "uncategorized",
        actionCount: Array.isArray(m.actions) ? m.actions.length : 0,
      };
    });
}

/**
 * Discover and load all pack manifests from the plugins/packs/ directory.
 * Called at startup.
 */
export function discoverPacks() {
  if (!existsSync(PACKS_DIR)) return;
  let entries;
  try {
    entries = readdirSync(PACKS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PACKS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const result = loadManifest(manifestPath);
    if (result.ok) {
      // Verify signature if present
      const manifest = result.manifest;
      if (manifest.signature) {
        const vr = verifyManifest(manifest, manifest.signature);
        if (!vr.ok) {
          console.warn(`[marketplace] Pack "${manifest.id}" has invalid signature: ${vr.error}`);
          registry.delete(manifest.id);
          continue;
        }
      }
      console.log(`[marketplace] Discovered pack: ${manifest.id} v${manifest.version}`);
    } else {
      console.warn(`[marketplace] Failed to load pack from ${entry.name}:`, result.errors);
    }
  }
}
