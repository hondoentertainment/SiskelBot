/**
 * Phase 27: Document versioning for the knowledge store.
 * Stores version history with diffs, supports rollback.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath } from "./json-path-store.js";

const DEFAULT_DATA_DIR = join(process.cwd(), "data", "knowledge");
const MAX_VERSIONS_PER_DOC = 100;

function getVersionsPath(dataDir, workspace, docId) {
  const safe = String(workspace).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
  return join(dataDir, `${safe}_versions_${docId}.json`);
}

/**
 * Compute a simple line-by-line diff between two strings.
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ additions: number, deletions: number, changes: Array<{ type: string, line: number, content: string }> }}
 */
export function computeDiff(oldText, newText) {
  const oldLines = (oldText || "").split("\n");
  const newLines = (newText || "").split("\n");
  const changes = [];
  let additions = 0;
  let deletions = 0;

  // Simple LCS-based diff using a two-pointer approach on matching lines
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0;
  let ni = 0;

  // Build a map of new lines for quick lookup
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi >= oldLines.length) {
      // Remaining new lines are additions
      changes.push({ type: "add", line: ni + 1, content: newLines[ni] });
      additions++;
      ni++;
    } else if (ni >= newLines.length) {
      // Remaining old lines are deletions
      changes.push({ type: "delete", line: oi + 1, content: oldLines[oi] });
      deletions++;
      oi++;
    } else if (oldLines[oi] === newLines[ni]) {
      // Lines match, advance both
      oi++;
      ni++;
    } else {
      // Check if the old line appears later in new (deletion) or new line appears later in old (addition)
      const oldInNew = newLines.indexOf(oldLines[oi], ni + 1);
      const newInOld = oldLines.indexOf(newLines[ni], oi + 1);

      if (newInOld >= 0 && (oldInNew < 0 || newInOld - oi <= oldInNew - ni)) {
        // Old line found later in old — current old line was deleted
        changes.push({ type: "delete", line: oi + 1, content: oldLines[oi] });
        deletions++;
        oi++;
      } else if (oldInNew >= 0) {
        // Old line found later in new — current new line was added
        changes.push({ type: "add", line: ni + 1, content: newLines[ni] });
        additions++;
        ni++;
      } else {
        // Neither found — treat as modify (delete old + add new)
        changes.push({ type: "delete", line: oi + 1, content: oldLines[oi] });
        changes.push({ type: "add", line: ni + 1, content: newLines[ni] });
        deletions++;
        additions++;
        oi++;
        ni++;
      }
    }
  }

  return { additions, deletions, changes };
}

/**
 * Save a new version of a document.
 * @param {string} docId - Document ID
 * @param {string} content - New document content
 * @param {object} [metadata] - Optional metadata
 * @param {object} [options]
 * @param {string} [options.workspace='default'] - Workspace
 * @param {string} [options.dataDir] - Override data directory
 * @returns {Promise<{ versionId: string, diff: object, createdAt: string }>}
 */
export async function saveDocumentVersion(docId, content, metadata = {}, options = {}) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = options;

  if (!docId || typeof docId !== "string") {
    return { error: "docId is required", code: "INVALID_INPUT" };
  }

  const versionsPath = getVersionsPath(dataDir, workspace, docId);
  const data = await readJsonPath(versionsPath, { versions: [] });
  const versions = Array.isArray(data.versions) ? data.versions : [];

  const versionId = randomUUID();
  const createdAt = new Date().toISOString();

  // Compute diff from previous version
  const previousContent = versions.length > 0 ? (versions[versions.length - 1].content || "") : "";
  const diff = computeDiff(previousContent, content || "");

  const version = {
    versionId,
    docId,
    content: content || "",
    metadata: metadata || {},
    diff: { additions: diff.additions, deletions: diff.deletions },
    createdAt,
  };

  versions.push(version);

  // Trim to max versions, keeping the most recent
  while (versions.length > MAX_VERSIONS_PER_DOC) {
    versions.shift();
  }

  await writeJsonPath(versionsPath, { versions, _updated: createdAt });

  return { versionId, diff, createdAt };
}

/**
 * Get version history for a document.
 * @param {string} docId - Document ID
 * @param {number} [limit=50] - Max versions to return
 * @param {object} [options]
 * @param {string} [options.workspace='default']
 * @param {string} [options.dataDir]
 * @returns {Promise<Array<{ versionId: string, createdAt: string, diffSummary: object }>>}
 */
export async function getDocumentHistory(docId, limit = 50, options = {}) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = options;

  if (!docId || typeof docId !== "string") {
    return { error: "docId is required", code: "INVALID_INPUT" };
  }

  const versionsPath = getVersionsPath(dataDir, workspace, docId);
  const data = await readJsonPath(versionsPath, { versions: [] });
  const versions = Array.isArray(data.versions) ? data.versions : [];

  // Return most recent first, limited
  const result = versions
    .slice(-limit)
    .reverse()
    .map((v) => ({
      versionId: v.versionId,
      createdAt: v.createdAt,
      diffSummary: v.diff || { additions: 0, deletions: 0 },
      metadata: v.metadata || {},
    }));

  return result;
}

/**
 * Get a specific version of a document.
 * @param {string} docId - Document ID
 * @param {string} versionId - Version ID
 * @param {object} [options]
 * @param {string} [options.workspace='default']
 * @param {string} [options.dataDir]
 * @returns {Promise<{ versionId: string, content: string, metadata: object, createdAt: string } | { error: string, code: string }>}
 */
export async function getDocumentVersion(docId, versionId, options = {}) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = options;

  if (!docId || typeof docId !== "string") {
    return { error: "docId is required", code: "INVALID_INPUT" };
  }
  if (!versionId || typeof versionId !== "string") {
    return { error: "versionId is required", code: "INVALID_INPUT" };
  }

  const versionsPath = getVersionsPath(dataDir, workspace, docId);
  const data = await readJsonPath(versionsPath, { versions: [] });
  const versions = Array.isArray(data.versions) ? data.versions : [];

  const version = versions.find((v) => v.versionId === versionId);
  if (!version) {
    return { error: "Version not found", code: "NOT_FOUND" };
  }

  return {
    versionId: version.versionId,
    docId: version.docId,
    content: version.content || "",
    metadata: version.metadata || {},
    createdAt: version.createdAt,
  };
}

/**
 * Rollback a document to a specific version.
 * Creates a new version with the old content.
 * @param {string} docId - Document ID
 * @param {string} versionId - Version ID to rollback to
 * @param {object} [options]
 * @param {string} [options.workspace='default']
 * @param {string} [options.dataDir]
 * @returns {Promise<{ versionId: string, rolledBackTo: string, createdAt: string } | { error: string, code: string }>}
 */
export async function rollbackDocument(docId, versionId, options = {}) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = options;

  if (!docId || typeof docId !== "string") {
    return { error: "docId is required", code: "INVALID_INPUT" };
  }
  if (!versionId || typeof versionId !== "string") {
    return { error: "versionId is required", code: "INVALID_INPUT" };
  }

  const versionsPath = getVersionsPath(dataDir, workspace, docId);
  const data = await readJsonPath(versionsPath, { versions: [] });
  const versions = Array.isArray(data.versions) ? data.versions : [];

  const targetVersion = versions.find((v) => v.versionId === versionId);
  if (!targetVersion) {
    return { error: "Version not found", code: "NOT_FOUND" };
  }

  // Save the rollback as a new version
  const result = await saveDocumentVersion(
    docId,
    targetVersion.content,
    { rolledBackFrom: versionId, ...targetVersion.metadata },
    { workspace, dataDir },
  );

  return {
    versionId: result.versionId,
    rolledBackTo: versionId,
    content: targetVersion.content,
    createdAt: result.createdAt,
  };
}

/**
 * Compute diff between two specific versions.
 * @param {string} docId - Document ID
 * @param {string} v1 - First version ID
 * @param {string} v2 - Second version ID
 * @param {object} [options]
 * @param {string} [options.workspace='default']
 * @param {string} [options.dataDir]
 * @returns {Promise<{ additions: number, deletions: number, changes: Array<{ type: string, line: number, content: string }> } | { error: string, code: string }>}
 */
export async function diffVersions(docId, v1, v2, options = {}) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = options;

  if (!docId || typeof docId !== "string") {
    return { error: "docId is required", code: "INVALID_INPUT" };
  }
  if (!v1 || typeof v1 !== "string") {
    return { error: "v1 is required", code: "INVALID_INPUT" };
  }
  if (!v2 || typeof v2 !== "string") {
    return { error: "v2 is required", code: "INVALID_INPUT" };
  }

  const versionsPath = getVersionsPath(dataDir, workspace, docId);
  const data = await readJsonPath(versionsPath, { versions: [] });
  const versions = Array.isArray(data.versions) ? data.versions : [];

  const version1 = versions.find((v) => v.versionId === v1);
  if (!version1) {
    return { error: `Version ${v1} not found`, code: "NOT_FOUND" };
  }

  const version2 = versions.find((v) => v.versionId === v2);
  if (!version2) {
    return { error: `Version ${v2} not found`, code: "NOT_FOUND" };
  }

  return computeDiff(version1.content || "", version2.content || "");
}
