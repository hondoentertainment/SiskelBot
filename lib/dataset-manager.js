/**
 * Phase 38.2: Dataset management for ML training.
 * Version, tag, and split training datasets.
 *
 * Storage: data/datasets/{workspaceId}/{datasetId}.json
 * Each dataset file stores: { id, name, description, workspaceId, versions: [], tags: {}, currentVersion, createdAt }
 * Each version stores: { version, examples, createdAt, metadata }
 */
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function getDatasetPath(workspaceId, datasetId) {
  const ws = sanitize(workspaceId || "default");
  const id = sanitize(datasetId);
  return join(getDataDir(), "datasets", ws, `${id}.json`);
}

function getIndexPath(workspaceId) {
  const ws = sanitize(workspaceId || "default");
  return join(getDataDir(), "datasets", ws, "_index.json");
}

function getGlobalIndexPath() {
  return join(getDataDir(), "datasets", "_global-index.json");
}

async function registerGlobal(datasetId, workspaceId) {
  const path = getGlobalIndexPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { map: {} });
    const map = data.map && typeof data.map === "object" ? data.map : {};
    map[datasetId] = workspaceId || "default";
    await writeJsonPath(path, { map });
  });
}

async function unregisterGlobal(datasetId) {
  const path = getGlobalIndexPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { map: {} });
    const map = data.map && typeof data.map === "object" ? data.map : {};
    delete map[datasetId];
    await writeJsonPath(path, { map });
  });
}

async function resolveWorkspace(datasetId) {
  const path = getGlobalIndexPath();
  const data = await readJsonPath(path, { map: {} });
  const map = data.map && typeof data.map === "object" ? data.map : {};
  return map[datasetId] || null;
}

/**
 * Bump a semver-style version string.
 * Default: bump minor, keep patch at 0.
 */
function bumpVersion(version, segment = "minor") {
  const parts = String(version || "1.0.0").split(".").map((p) => Number(p) || 0);
  while (parts.length < 3) parts.push(0);
  if (segment === "major") {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (segment === "minor") {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }
  return parts.join(".");
}

function normalizeExample(example) {
  const input = example?.input != null ? String(example.input) : "";
  const output = example?.output != null ? String(example.output) : "";
  const tags = Array.isArray(example?.tags) ? example.tags.map(String) : [];
  const metadata = example?.metadata && typeof example.metadata === "object" ? example.metadata : {};
  const id = example?.id || hashExample({ input, output });
  return { id, input, output, tags, metadata };
}

function hashExample(example) {
  const payload = `${example.input || ""}\u0000${example.output || ""}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function readDatasetFile(workspaceId, datasetId) {
  const path = getDatasetPath(workspaceId, datasetId);
  const data = await readJsonPath(path, null);
  if (!data || !data.id || data._deleted) return null;
  if (!Array.isArray(data.versions)) return null;
  return data;
}

async function writeDatasetFile(workspaceId, datasetId, data) {
  const path = getDatasetPath(workspaceId, datasetId);
  await writeJsonPath(path, data);
}

async function updateIndex(workspaceId, entry, remove = false) {
  const path = getIndexPath(workspaceId);
  await withPathLock(path, async () => {
    const idx = await readJsonPath(path, { datasets: [] });
    const list = Array.isArray(idx.datasets) ? idx.datasets : [];
    const filtered = list.filter((d) => d.id !== entry.id);
    if (!remove) filtered.push(entry);
    await writeJsonPath(path, { datasets: filtered });
  });
}

/**
 * Create a new dataset.
 */
export async function createDataset(name, description, workspaceId) {
  if (!name || typeof name !== "string") {
    return { error: "name is required", code: "INVALID_INPUT" };
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const dataset = {
    id,
    name,
    description: description || "",
    workspaceId: workspaceId || "default",
    versions: [
      {
        version: "1.0.0",
        examples: [],
        metadata: {},
        createdAt,
      },
    ],
    tags: {},
    currentVersion: "1.0.0",
    createdAt,
    updatedAt: createdAt,
  };
  await writeDatasetFile(workspaceId, id, dataset);
  await updateIndex(workspaceId, {
    id,
    name,
    description: description || "",
    currentVersion: "1.0.0",
    createdAt,
  });
  await registerGlobal(id, workspaceId || "default");
  return dataset;
}

/**
 * Add examples to a dataset. Creates a new version.
 */
export async function addExamples(datasetId, examples, metadata = {}) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  if (!Array.isArray(examples)) {
    return { error: "examples must be an array", code: "INVALID_INPUT" };
  }
  const workspaceId = metadata?.workspaceId;

  // Locate workspace containing dataset if not supplied
  let ws = workspaceId;
  if (!ws) {
    ws = await findWorkspaceForDataset(datasetId);
  }
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = getDatasetPath(ws, datasetId);
  return withPathLock(path, async () => {
    const dataset = await readDatasetFile(ws, datasetId);
    if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

    const latest = dataset.versions[dataset.versions.length - 1];
    const existing = Array.isArray(latest?.examples) ? latest.examples : [];
    const normalizedNew = examples.map(normalizeExample);

    // Merge: new + existing, dedup by id (new wins)
    const byId = new Map();
    for (const ex of existing) byId.set(ex.id, ex);
    for (const ex of normalizedNew) byId.set(ex.id, ex);
    const merged = Array.from(byId.values());

    const newVersion = bumpVersion(dataset.currentVersion, "minor");
    const createdAt = new Date().toISOString();
    dataset.versions.push({
      version: newVersion,
      examples: merged,
      metadata: metadata || {},
      createdAt,
    });
    dataset.currentVersion = newVersion;
    dataset.updatedAt = createdAt;

    await writeDatasetFile(ws, datasetId, dataset);
    await updateIndex(ws, {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      currentVersion: newVersion,
      createdAt: dataset.createdAt,
    });
    return {
      datasetId,
      version: newVersion,
      exampleCount: merged.length,
      added: normalizedNew.length,
      createdAt,
    };
  });
}

/**
 * Remove examples from a dataset. Creates a new version.
 */
export async function removeExamples(datasetId, exampleIds) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  if (!Array.isArray(exampleIds)) {
    return { error: "exampleIds must be an array", code: "INVALID_INPUT" };
  }
  const ws = await findWorkspaceForDataset(datasetId);
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = getDatasetPath(ws, datasetId);
  return withPathLock(path, async () => {
    const dataset = await readDatasetFile(ws, datasetId);
    if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

    const latest = dataset.versions[dataset.versions.length - 1];
    const existing = Array.isArray(latest?.examples) ? latest.examples : [];
    const idSet = new Set(exampleIds.map(String));
    const remaining = existing.filter((ex) => !idSet.has(ex.id));
    const removedCount = existing.length - remaining.length;

    const newVersion = bumpVersion(dataset.currentVersion, "minor");
    const createdAt = new Date().toISOString();
    dataset.versions.push({
      version: newVersion,
      examples: remaining,
      metadata: { action: "remove", removed: removedCount },
      createdAt,
    });
    dataset.currentVersion = newVersion;
    dataset.updatedAt = createdAt;

    await writeDatasetFile(ws, datasetId, dataset);
    await updateIndex(ws, {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      currentVersion: newVersion,
      createdAt: dataset.createdAt,
    });
    return {
      datasetId,
      version: newVersion,
      removed: removedCount,
      exampleCount: remaining.length,
      createdAt,
    };
  });
}

/**
 * List datasets in a workspace.
 */
export async function listDatasets(workspaceId) {
  const path = getIndexPath(workspaceId);
  const idx = await readJsonPath(path, { datasets: [] });
  return Array.isArray(idx.datasets) ? idx.datasets : [];
}

/**
 * Search for the workspace containing a dataset (when workspaceId is not supplied).
 */
async function findWorkspaceForDataset(datasetId) {
  return resolveWorkspace(datasetId);
}

/**
 * Get a dataset. Optionally load a specific version.
 */
export async function getDataset(datasetId, version, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  if (!version) {
    return dataset;
  }

  // Resolve a tag to a version if needed
  const resolved = dataset.tags?.[version] || version;
  const match = dataset.versions.find((v) => v.version === resolved);
  if (!match) {
    return { error: `version ${version} not found`, code: "NOT_FOUND" };
  }
  return {
    ...dataset,
    currentVersion: resolved,
    version: match,
  };
}

/**
 * Delete a dataset.
 */
export async function deleteDataset(datasetId, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = getDatasetPath(ws, datasetId);
  const existing = await readDatasetFile(ws, datasetId);
  if (!existing) return { error: "dataset not found", code: "NOT_FOUND" };

  // Write a tombstone (empty object) to mark deletion
  await writeJsonPath(path, { _deleted: true, id: datasetId });
  await updateIndex(ws, { id: datasetId }, true);
  await unregisterGlobal(datasetId);
  return { deleted: true, datasetId };
}

/**
 * Tag a specific version with a label (e.g., "production").
 */
export async function tagDataset(datasetId, version, tag, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  if (!version) return { error: "version is required", code: "INVALID_INPUT" };
  if (!tag || typeof tag !== "string") {
    return { error: "tag is required", code: "INVALID_INPUT" };
  }
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const path = getDatasetPath(ws, datasetId);
  return withPathLock(path, async () => {
    const dataset = await readDatasetFile(ws, datasetId);
    if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

    const match = dataset.versions.find((v) => v.version === version);
    if (!match) {
      return { error: `version ${version} not found`, code: "NOT_FOUND" };
    }
    dataset.tags = dataset.tags || {};
    dataset.tags[tag] = version;
    dataset.updatedAt = new Date().toISOString();
    await writeDatasetFile(ws, datasetId, dataset);
    return { datasetId, version, tag };
  });
}

/**
 * Deterministically split a dataset into train/val/test based on example ID hash.
 */
export async function splitDataset(datasetId, ratios, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  const r = ratios && typeof ratios === "object"
    ? ratios
    : { train: 0.8, val: 0.1, test: 0.1 };
  const train = Number(r.train) || 0;
  const val = Number(r.val) || 0;
  const test = Number(r.test) || 0;
  const sum = train + val + test;
  if (sum <= 0) {
    return { error: "ratios must sum to a positive number", code: "INVALID_INPUT" };
  }
  // Normalize
  const tr = train / sum;
  const va = val / sum;

  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  const latest = dataset.versions[dataset.versions.length - 1];
  const examples = Array.isArray(latest?.examples) ? latest.examples : [];

  const trainSet = [];
  const valSet = [];
  const testSet = [];
  for (const ex of examples) {
    // Deterministic bucket in [0, 1) from example id hash
    const h = createHash("sha256").update(String(ex.id)).digest();
    const bucket = (h.readUInt32BE(0) % 1_000_000) / 1_000_000;
    if (bucket < tr) trainSet.push(ex);
    else if (bucket < tr + va) valSet.push(ex);
    else testSet.push(ex);
  }
  return { train: trainSet, val: valSet, test: testSet };
}

/**
 * Get all versions of a dataset with summary metadata.
 */
export async function getDatasetVersions(datasetId, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  return dataset.versions.map((v) => ({
    version: v.version,
    exampleCount: Array.isArray(v.examples) ? v.examples.length : 0,
    createdAt: v.createdAt,
    metadata: v.metadata || {},
  }));
}

/**
 * Compare two versions of a dataset.
 */
export async function compareVersions(datasetId, v1, v2, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  if (!v1 || !v2) return { error: "v1 and v2 are required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  const version1 = dataset.versions.find((v) => v.version === v1);
  const version2 = dataset.versions.find((v) => v.version === v2);
  if (!version1) return { error: `version ${v1} not found`, code: "NOT_FOUND" };
  if (!version2) return { error: `version ${v2} not found`, code: "NOT_FOUND" };

  const set1 = new Map((version1.examples || []).map((e) => [e.id, e]));
  const set2 = new Map((version2.examples || []).map((e) => [e.id, e]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const [id, ex] of set2) {
    if (!set1.has(id)) {
      added.push(ex);
    } else {
      const prior = set1.get(id);
      if (prior.input !== ex.input || prior.output !== ex.output) {
        modified.push({ id, before: prior, after: ex });
      }
    }
  }
  for (const [id, ex] of set1) {
    if (!set2.has(id)) removed.push(ex);
  }
  return { added, removed, modified };
}

/**
 * Export a dataset to a specific format.
 * Supported: jsonl, csv, parquet (json fallback), openai-ft
 */
export async function exportDataset(datasetId, format = "jsonl", workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  const latest = dataset.versions[dataset.versions.length - 1];
  const examples = Array.isArray(latest?.examples) ? latest.examples : [];

  const fmt = String(format || "jsonl").toLowerCase();
  if (fmt === "jsonl") {
    const lines = examples.map((ex) =>
      JSON.stringify({ id: ex.id, input: ex.input, output: ex.output, tags: ex.tags || [], metadata: ex.metadata || {} }),
    );
    return { format: "jsonl", contentType: "application/x-ndjson", data: lines.join("\n") };
  }
  if (fmt === "csv") {
    const escape = (v) => {
      const s = String(v == null ? "" : v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const header = "id,input,output,tags";
    const rows = examples.map((ex) =>
      [escape(ex.id), escape(ex.input), escape(ex.output), escape((ex.tags || []).join("|"))].join(","),
    );
    return { format: "csv", contentType: "text/csv", data: [header, ...rows].join("\n") };
  }
  if (fmt === "parquet") {
    // JSON-based substitute (Parquet requires a binary writer dependency).
    return {
      format: "parquet",
      contentType: "application/json",
      data: JSON.stringify({ schema: ["id", "input", "output", "tags", "metadata"], rows: examples }),
    };
  }
  if (fmt === "openai-ft") {
    const lines = examples.map((ex) =>
      JSON.stringify({
        messages: [
          { role: "user", content: ex.input || "" },
          { role: "assistant", content: ex.output || "" },
        ],
      }),
    );
    return { format: "openai-ft", contentType: "application/x-ndjson", data: lines.join("\n") };
  }
  return { error: `unsupported format: ${format}`, code: "INVALID_FORMAT" };
}

/**
 * Import a dataset from an exported format.
 */
export async function importDataset(name, content, format = "jsonl", workspaceId, description) {
  if (!name) return { error: "name is required", code: "INVALID_INPUT" };
  if (content == null) return { error: "content is required", code: "INVALID_INPUT" };

  const fmt = String(format || "jsonl").toLowerCase();
  let examples = [];

  try {
    if (fmt === "jsonl") {
      const lines = String(content).split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        const obj = JSON.parse(line);
        examples.push({
          input: obj.input != null ? obj.input : (obj.messages?.[0]?.content || ""),
          output: obj.output != null ? obj.output : (obj.messages?.[1]?.content || ""),
          tags: obj.tags || [],
          metadata: obj.metadata || {},
        });
      }
    } else if (fmt === "csv") {
      const lines = String(content).split(/\r?\n/).filter((l) => l.trim());
      if (lines.length === 0) examples = [];
      else {
        const header = parseCsvLine(lines[0]);
        const idxInput = header.indexOf("input");
        const idxOutput = header.indexOf("output");
        const idxTags = header.indexOf("tags");
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCsvLine(lines[i]);
          examples.push({
            input: idxInput >= 0 ? cols[idxInput] || "" : "",
            output: idxOutput >= 0 ? cols[idxOutput] || "" : "",
            tags: idxTags >= 0 && cols[idxTags] ? cols[idxTags].split("|").filter(Boolean) : [],
          });
        }
      }
    } else if (fmt === "openai-ft") {
      const lines = String(content).split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        const obj = JSON.parse(line);
        const userMsg = obj.messages?.find((m) => m.role === "user");
        const asstMsg = obj.messages?.find((m) => m.role === "assistant");
        examples.push({
          input: userMsg?.content || "",
          output: asstMsg?.content || "",
        });
      }
    } else if (fmt === "parquet") {
      const parsed = typeof content === "string" ? JSON.parse(content) : content;
      examples = Array.isArray(parsed?.rows) ? parsed.rows : [];
    } else {
      return { error: `unsupported format: ${format}`, code: "INVALID_FORMAT" };
    }
  } catch (err) {
    return { error: `failed to parse ${fmt}: ${err.message}`, code: "PARSE_ERROR" };
  }

  const dataset = await createDataset(name, description || "", workspaceId);
  if (dataset.error) return dataset;

  if (examples.length > 0) {
    await addExamples(dataset.id, examples, { workspaceId, source: "import", format: fmt });
  }
  return {
    datasetId: dataset.id,
    name: dataset.name,
    imported: examples.length,
  };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Compute summary statistics for a dataset.
 */
export async function getDatasetStats(datasetId, workspaceId) {
  if (!datasetId) return { error: "datasetId is required", code: "INVALID_INPUT" };
  let ws = workspaceId || (await findWorkspaceForDataset(datasetId));
  if (!ws) return { error: "dataset not found", code: "NOT_FOUND" };

  const dataset = await readDatasetFile(ws, datasetId);
  if (!dataset) return { error: "dataset not found", code: "NOT_FOUND" };

  const latest = dataset.versions[dataset.versions.length - 1];
  const examples = Array.isArray(latest?.examples) ? latest.examples : [];
  const total = examples.length;
  let inputSum = 0;
  let outputSum = 0;
  const tagCount = {};
  for (const ex of examples) {
    inputSum += (ex.input || "").length;
    outputSum += (ex.output || "").length;
    for (const t of ex.tags || []) {
      tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }
  return {
    totalExamples: total,
    avgInputLength: total ? inputSum / total : 0,
    avgOutputLength: total ? outputSum / total : 0,
    tagDistribution: tagCount,
    versionCount: dataset.versions.length,
    currentVersion: dataset.currentVersion,
  };
}

/**
 * Deduplicate examples by hash of input+output.
 */
export function deduplicateExamples(examples) {
  if (!Array.isArray(examples)) return [];
  const seen = new Set();
  const out = [];
  for (const ex of examples) {
    const norm = normalizeExample(ex);
    const key = hashExample(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

/**
 * Validate example quality.
 * Checks: minimum length, consistent types, non-empty required fields.
 */
export function validateQuality(examples, options = {}) {
  const minInputLength = Number(options.minInputLength) || 1;
  const minOutputLength = Number(options.minOutputLength) || 1;
  const issues = [];
  if (!Array.isArray(examples)) {
    return { valid: false, issues: [{ type: "INVALID_TYPE", message: "examples must be an array" }] };
  }

  let detectedInputType = null;
  let detectedOutputType = null;
  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i] || {};
    if (ex.input == null || ex.input === "") {
      issues.push({ index: i, type: "MISSING_INPUT", message: "input is required" });
      continue;
    }
    if (ex.output == null || ex.output === "") {
      issues.push({ index: i, type: "MISSING_OUTPUT", message: "output is required" });
      continue;
    }
    const inputType = typeof ex.input;
    const outputType = typeof ex.output;
    if (detectedInputType == null) detectedInputType = inputType;
    else if (detectedInputType !== inputType) {
      issues.push({
        index: i,
        type: "INCONSISTENT_TYPE",
        message: `input type ${inputType} differs from detected ${detectedInputType}`,
      });
    }
    if (detectedOutputType == null) detectedOutputType = outputType;
    else if (detectedOutputType !== outputType) {
      issues.push({
        index: i,
        type: "INCONSISTENT_TYPE",
        message: `output type ${outputType} differs from detected ${detectedOutputType}`,
      });
    }
    const inputStr = String(ex.input);
    const outputStr = String(ex.output);
    if (inputStr.length < minInputLength) {
      issues.push({ index: i, type: "INPUT_TOO_SHORT", message: `input length ${inputStr.length} < ${minInputLength}` });
    }
    if (outputStr.length < minOutputLength) {
      issues.push({ index: i, type: "OUTPUT_TOO_SHORT", message: `output length ${outputStr.length} < ${minOutputLength}` });
    }
    // Basic language check: non-empty printable-ish
    if (!/\S/.test(inputStr)) {
      issues.push({ index: i, type: "EMPTY_INPUT", message: "input is whitespace only" });
    }
  }
  return { valid: issues.length === 0, issues };
}
