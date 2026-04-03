/**
 * Workspace-specific chunking strategy configuration.
 * Stored in-memory alongside agent settings. Persisted via json-path-store.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath } from "./json-path-store.js";

const DEFAULT_DATA_DIR = join(process.cwd(), "data", "knowledge");

/** @typedef {{ chunkSize: number, chunkOverlap: number, metadataExtraction: boolean, preserveStructure: boolean }} ChunkingConfig */

export const DEFAULT_CHUNKING_CONFIG = {
  chunkSize: 512,           // tokens (mapped to ~2048 chars at ~4 chars/token)
  chunkOverlap: 50,         // tokens overlap between chunks (~200 chars)
  metadataExtraction: true,
  preserveStructure: true,  // preserve paragraph/section boundaries
};

const WORKSPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;

/** @type {Map<string, ChunkingConfig>} */
const configCache = new Map();

function getConfigPath(dataDir, workspaceId) {
  const safe = String(workspaceId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
  return join(dataDir, `${safe}-chunking.json`);
}

/**
 * Validate and clamp a chunking config object.
 * @param {object} raw
 * @returns {ChunkingConfig}
 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    chunkSize: Math.min(4096, Math.max(64, Number(c.chunkSize) || DEFAULT_CHUNKING_CONFIG.chunkSize)),
    chunkOverlap: Math.min(512, Math.max(0, Number(c.chunkOverlap) || DEFAULT_CHUNKING_CONFIG.chunkOverlap)),
    metadataExtraction: typeof c.metadataExtraction === "boolean" ? c.metadataExtraction : DEFAULT_CHUNKING_CONFIG.metadataExtraction,
    preserveStructure: typeof c.preserveStructure === "boolean" ? c.preserveStructure : DEFAULT_CHUNKING_CONFIG.preserveStructure,
  };
}

/**
 * Get chunking config for a workspace.
 * @param {string} workspaceId
 * @param {string} [dataDir]
 * @returns {Promise<ChunkingConfig>}
 */
export async function getWorkspaceChunkingConfig(workspaceId, dataDir) {
  const ws = workspaceId || "default";
  if (!WORKSPACE_PATTERN.test(ws)) {
    return { ...DEFAULT_CHUNKING_CONFIG };
  }

  if (configCache.has(ws)) {
    return { ...configCache.get(ws) };
  }

  const dir = dataDir || process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR;
  const configPath = getConfigPath(dir, ws);
  try {
    const stored = await readJsonPath(configPath, null);
    if (stored && typeof stored === "object" && stored.chunkSize != null) {
      const config = normalizeConfig(stored);
      configCache.set(ws, config);
      return { ...config };
    }
  } catch {
    // file doesn't exist yet - use defaults
  }
  return { ...DEFAULT_CHUNKING_CONFIG };
}

/**
 * Set chunking config for a workspace.
 * @param {string} workspaceId
 * @param {object} config - Partial config to merge with defaults
 * @param {string} [dataDir]
 * @returns {Promise<ChunkingConfig>}
 */
export async function setWorkspaceChunkingConfig(workspaceId, config, dataDir) {
  const ws = workspaceId || "default";
  if (!WORKSPACE_PATTERN.test(ws)) {
    throw Object.assign(new Error("Invalid workspace"), { code: "INVALID_INPUT" });
  }

  const merged = normalizeConfig({ ...DEFAULT_CHUNKING_CONFIG, ...config });
  const dir = dataDir || process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR;
  const configPath = getConfigPath(dir, ws);
  await writeJsonPath(configPath, { ...merged, _updated: new Date().toISOString() });
  configCache.set(ws, merged);
  return { ...merged };
}

/**
 * Convert token-based chunking config to character-based params for chunkPlainText.
 * Approximation: 1 token ~ 4 characters.
 * @param {ChunkingConfig} config
 * @returns {{ maxChars: number, overlap: number }}
 */
export function chunkingConfigToCharParams(config) {
  const charsPerToken = 4;
  return {
    maxChars: (config.chunkSize || DEFAULT_CHUNKING_CONFIG.chunkSize) * charsPerToken,
    overlap: (config.chunkOverlap || DEFAULT_CHUNKING_CONFIG.chunkOverlap) * charsPerToken,
  };
}
