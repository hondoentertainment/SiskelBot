/**
 * Phase 38.3: Model registry — track trained models, versions, hyperparameters,
 * metrics, lineage, and deployments.
 *
 * Storage layout (under data/):
 *   models/{workspaceId}/{modelId}.json     — model document with all versions
 *   models/deployments.json                 — deployment records per environment
 *   models/index.json                       — global index of all models
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const REGISTRY_VERSION = 1;
const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

const VALID_STATUSES = new Set([
  "training",
  "ready",
  "deployed",
  "deprecated",
  "failed",
]);

const VALID_ENVIRONMENTS = new Set(["production", "staging", "experiment"]);

const VALID_MODEL_TYPES = new Set([
  "llm",
  "embedding",
  "reranker",
  "classifier",
  "vision",
  "audio",
  "multimodal",
  "other",
]);

// ─── path helpers ───────────────────────────────────────────────────────────

function modelsDir() {
  return join(getDataDir(), "models");
}

function workspaceDir(workspaceId) {
  return join(modelsDir(), sanitizeId(workspaceId) || "default");
}

function modelPath(workspaceId, modelId) {
  return join(workspaceDir(workspaceId), `${sanitizeId(modelId)}.json`);
}

function deploymentsPath() {
  return join(modelsDir(), "deployments.json");
}

function indexPath() {
  return join(modelsDir(), "index.json");
}

function sanitizeId(id) {
  if (typeof id !== "string") return "";
  return id.trim().replace(/[^a-zA-Z0-9._-]/g, "");
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase().slice(0, MAX_TAG_LEN) : ""))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

function normalizeType(type) {
  if (typeof type !== "string") return "llm";
  const v = type.trim().toLowerCase();
  return VALID_MODEL_TYPES.has(v) ? v : "other";
}

async function loadIndex() {
  const data = await readJsonPath(indexPath(), { _version: REGISTRY_VERSION, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveIndex(items) {
  await writeJsonPath(indexPath(), { _version: REGISTRY_VERSION, items });
}

async function loadDeployments() {
  const data = await readJsonPath(deploymentsPath(), {
    _version: REGISTRY_VERSION,
    environments: {},
    history: [],
  });
  return {
    environments: data.environments && typeof data.environments === "object" ? data.environments : {},
    history: Array.isArray(data.history) ? data.history : [],
  };
}

async function saveDeployments(data) {
  await writeJsonPath(deploymentsPath(), {
    _version: REGISTRY_VERSION,
    environments: data.environments || {},
    history: Array.isArray(data.history) ? data.history : [],
  });
}

async function loadModel(workspaceId, modelId) {
  const data = await readJsonPath(modelPath(workspaceId, modelId), null);
  if (!data || data.deleted || !data.id) return null;
  return data;
}

async function saveModel(workspaceId, modelDoc) {
  await writeJsonPath(modelPath(workspaceId, modelDoc.id), {
    _version: REGISTRY_VERSION,
    ...modelDoc,
  });
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Register a new model in the workspace.
 * @param {string} workspaceId
 * @param {object} model - { name, baseModel, type, path?, remoteUrl?, tags?, description?, createdBy? }
 * @returns {Promise<object>} - Full model document (with empty versions array)
 */
export async function registerModel(workspaceId, model) {
  if (!model || typeof model !== "object") {
    throw new Error("model is required");
  }
  const name = typeof model.name === "string" ? model.name.trim().slice(0, MAX_NAME_LEN) : "";
  if (!name) {
    throw new Error("model name is required");
  }
  const baseModel = typeof model.baseModel === "string" ? model.baseModel.trim() : "";
  const type = normalizeType(model.type);
  const description = typeof model.description === "string"
    ? model.description.trim().slice(0, MAX_DESCRIPTION_LEN)
    : "";
  const tags = normalizeTags(model.tags);
  const now = new Date().toISOString();
  const id = sanitizeId(model.id) || randomUUID();

  const doc = {
    id,
    workspaceId: workspaceId ? String(workspaceId) : "default",
    name,
    baseModel,
    type,
    description,
    tags,
    path: typeof model.path === "string" ? model.path : null,
    remoteUrl: typeof model.remoteUrl === "string" ? model.remoteUrl : null,
    createdBy: model.createdBy ? String(model.createdBy) : "anonymous",
    createdAt: now,
    updatedAt: now,
    versions: [],
    latestVersion: null,
  };

  await saveModel(workspaceId, doc);

  await withPathLock(indexPath(), async () => {
    const items = await loadIndex();
    items.push({
      id,
      workspaceId: doc.workspaceId,
      name,
      baseModel,
      type,
      description,
      tags,
      createdAt: now,
      updatedAt: now,
      versionCount: 0,
      latestVersion: null,
      latestStatus: null,
    });
    await saveIndex(items);
  });

  return doc;
}

/**
 * Create a new version of an existing model.
 * @param {string} modelId
 * @param {object} version - Version metadata
 * @returns {Promise<object>} - The created version record
 */
export async function createModelVersion(modelId, version) {
  if (!version || typeof version !== "object") {
    throw new Error("version is required");
  }
  const id = sanitizeId(modelId);
  if (!id) throw new Error("modelId is required");

  // Look up the workspace by scanning the index.
  const workspaceId = await findWorkspaceForModel(id);
  if (!workspaceId) throw new Error("model not found");

  return withPathLock(modelPath(workspaceId, id), async () => {
    const doc = await loadModel(workspaceId, id);
    if (!doc) throw new Error("model not found");

    const versionLabel = typeof version.version === "string" && version.version.trim()
      ? version.version.trim().slice(0, 60)
      : `v${doc.versions.length + 1}`;

    if (doc.versions.some((v) => v.version === versionLabel)) {
      throw new Error(`version ${versionLabel} already exists`);
    }

    const createdAt = version.createdAt || new Date().toISOString();
    const record = {
      version: versionLabel,
      baseModel: typeof version.baseModel === "string" ? version.baseModel : doc.baseModel,
      datasetId: typeof version.datasetId === "string" ? version.datasetId : null,
      datasetVersion: typeof version.datasetVersion === "string" ? version.datasetVersion : null,
      parentVersion: typeof version.parentVersion === "string" ? version.parentVersion : null,
      hyperparameters: version.hyperparameters && typeof version.hyperparameters === "object"
        ? version.hyperparameters
        : {},
      metrics: version.metrics && typeof version.metrics === "object" ? version.metrics : {},
      artifacts: {
        modelPath: version.artifacts?.modelPath || null,
        configPath: version.artifacts?.configPath || null,
        tokenizerPath: version.artifacts?.tokenizerPath || null,
        ...(version.artifacts && typeof version.artifacts === "object" ? version.artifacts : {}),
      },
      trainingTime: Number.isFinite(version.trainingTime) ? version.trainingTime : null,
      trainingCost: Number.isFinite(version.trainingCost) ? version.trainingCost : null,
      status: VALID_STATUSES.has(version.status) ? version.status : "ready",
      notes: typeof version.notes === "string" ? version.notes.slice(0, MAX_DESCRIPTION_LEN) : "",
      createdBy: version.createdBy ? String(version.createdBy) : doc.createdBy,
      createdAt,
      updatedAt: createdAt,
    };

    doc.versions.push(record);
    doc.latestVersion = versionLabel;
    doc.updatedAt = createdAt;
    await saveModel(workspaceId, doc);

    // Update index
    await withPathLock(indexPath(), async () => {
      const items = await loadIndex();
      const idx = items.findIndex((e) => e.id === id);
      if (idx >= 0) {
        items[idx].versionCount = doc.versions.length;
        items[idx].latestVersion = versionLabel;
        items[idx].latestStatus = record.status;
        items[idx].updatedAt = createdAt;
        await saveIndex(items);
      }
    });

    return record;
  });
}

async function findWorkspaceForModel(modelId) {
  const id = sanitizeId(modelId);
  if (!id) return null;
  const items = await loadIndex();
  const entry = items.find((e) => e.id === id);
  return entry ? entry.workspaceId : null;
}

/**
 * Get a model document by id (any workspace).
 * @param {string} modelId
 * @returns {Promise<object|null>}
 */
export async function getModel(modelId) {
  const id = sanitizeId(modelId);
  if (!id) return null;
  const workspaceId = await findWorkspaceForModel(id);
  if (!workspaceId) return null;
  return loadModel(workspaceId, id);
}

/**
 * Get a specific version of a model.
 * @param {string} modelId
 * @param {string} version
 * @returns {Promise<object|null>}
 */
export async function getModelVersion(modelId, version) {
  const doc = await getModel(modelId);
  if (!doc) return null;
  const v = doc.versions.find((x) => x.version === version);
  return v || null;
}

/**
 * List models in a workspace (or all).
 * @param {string} [workspaceId]
 * @param {object} [options] - { tag, type, status, limit, offset }
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function listModels(workspaceId, options = {}) {
  const items = await loadIndex();
  let filtered = items;
  if (workspaceId) {
    filtered = filtered.filter((e) => e.workspaceId === String(workspaceId));
  }
  if (options.tag) {
    const tag = String(options.tag).trim().toLowerCase();
    filtered = filtered.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  }
  if (options.type) {
    const t = normalizeType(options.type);
    filtered = filtered.filter((e) => e.type === t);
  }
  if (options.status) {
    filtered = filtered.filter((e) => e.latestStatus === options.status);
  }

  filtered = filtered.slice().sort((a, b) => {
    const ta = new Date(b.updatedAt || 0).getTime();
    const tb = new Date(a.updatedAt || 0).getTime();
    return ta - tb;
  });

  const total = filtered.length;
  const offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, options.limit)) : 100;
  return { items: filtered.slice(offset, offset + limit), total };
}

/**
 * List all versions of a model.
 * @param {string} modelId
 * @returns {Promise<object[]>}
 */
export async function listModelVersions(modelId) {
  const doc = await getModel(modelId);
  if (!doc) return [];
  return doc.versions.slice().sort((a, b) => {
    const ta = new Date(b.createdAt || 0).getTime();
    const tb = new Date(a.createdAt || 0).getTime();
    return ta - tb;
  });
}

/**
 * Update the status of a specific model version.
 * @param {string} modelId
 * @param {string} version
 * @param {string} status
 * @returns {Promise<object>} - Updated version
 */
export async function setModelStatus(modelId, version, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const id = sanitizeId(modelId);
  const workspaceId = await findWorkspaceForModel(id);
  if (!workspaceId) throw new Error("model not found");

  return withPathLock(modelPath(workspaceId, id), async () => {
    const doc = await loadModel(workspaceId, id);
    if (!doc) throw new Error("model not found");
    const v = doc.versions.find((x) => x.version === version);
    if (!v) throw new Error("version not found");
    v.status = status;
    v.updatedAt = new Date().toISOString();
    doc.updatedAt = v.updatedAt;
    await saveModel(workspaceId, doc);

    if (doc.latestVersion === version) {
      await withPathLock(indexPath(), async () => {
        const items = await loadIndex();
        const idx = items.findIndex((e) => e.id === id);
        if (idx >= 0) {
          items[idx].latestStatus = status;
          items[idx].updatedAt = v.updatedAt;
          await saveIndex(items);
        }
      });
    }
    return v;
  });
}

/**
 * Deploy a model version to an environment.
 * @param {string} modelId
 * @param {string} version
 * @param {string} environment
 * @returns {Promise<object>} - Deployment record
 */
export async function deployModel(modelId, version, environment) {
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error(`invalid environment: ${environment}`);
  }
  const v = await getModelVersion(modelId, version);
  if (!v) throw new Error("model version not found");

  const id = sanitizeId(modelId);
  const now = new Date().toISOString();
  const record = {
    modelId: id,
    version,
    environment,
    deployedAt: now,
  };

  await withPathLock(deploymentsPath(), async () => {
    const data = await loadDeployments();
    const previous = data.environments[environment] || null;
    data.environments[environment] = record;
    data.history.push({
      ...record,
      previousModelId: previous?.modelId || null,
      previousVersion: previous?.version || null,
    });
    if (data.history.length > 1000) {
      data.history = data.history.slice(-1000);
    }
    await saveDeployments(data);
  });

  // Mark version as deployed.
  await setModelStatus(id, version, "deployed").catch(() => {});

  return record;
}

/**
 * Get the currently deployed model in an environment.
 * @param {string} environment
 * @returns {Promise<object|null>}
 */
export async function getDeployedModel(environment) {
  if (!VALID_ENVIRONMENTS.has(environment)) return null;
  const data = await loadDeployments();
  return data.environments[environment] || null;
}

/**
 * Roll back a deployment to a prior version.
 * @param {string} environment
 * @param {string} targetVersion
 * @returns {Promise<object>} - The new (rolled back) deployment record
 */
export async function rollbackDeployment(environment, targetVersion) {
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error(`invalid environment: ${environment}`);
  }
  const current = await getDeployedModel(environment);
  if (!current) throw new Error("no current deployment to roll back");
  const modelId = current.modelId;
  const target = await getModelVersion(modelId, targetVersion);
  if (!target) throw new Error("target version not found");
  return deployModel(modelId, targetVersion, environment);
}

/**
 * Get lineage info for a model version (base model, dataset, parent, children).
 * @param {string} modelId
 * @param {string} version
 * @returns {Promise<object|null>}
 */
export async function getModelLineage(modelId, version) {
  const doc = await getModel(modelId);
  if (!doc) return null;
  const v = doc.versions.find((x) => x.version === version);
  if (!v) return null;

  const children = doc.versions
    .filter((x) => x.parentVersion === version)
    .map((x) => ({ version: x.version, createdAt: x.createdAt, status: x.status }));

  return {
    modelId: doc.id,
    version: v.version,
    baseModel: v.baseModel || doc.baseModel,
    dataset: v.datasetId
      ? { datasetId: v.datasetId, datasetVersion: v.datasetVersion || null }
      : null,
    parentVersion: v.parentVersion || null,
    children,
  };
}

/**
 * Compare metrics between two model versions.
 * @param {{ modelId: string, version: string }} modelA
 * @param {{ modelId: string, version: string }} modelB
 * @returns {Promise<object>} - { [metricName]: { a, b, diff } }
 */
export async function compareModels(modelA, modelB) {
  if (!modelA || !modelB) throw new Error("both modelA and modelB are required");
  const va = await getModelVersion(modelA.modelId, modelA.version);
  const vb = await getModelVersion(modelB.modelId, modelB.version);
  if (!va) throw new Error("modelA version not found");
  if (!vb) throw new Error("modelB version not found");

  const metricsA = va.metrics || {};
  const metricsB = vb.metrics || {};
  const keys = new Set([...Object.keys(metricsA), ...Object.keys(metricsB)]);
  const comparison = {};
  for (const key of keys) {
    const a = Number.isFinite(metricsA[key]) ? metricsA[key] : null;
    const b = Number.isFinite(metricsB[key]) ? metricsB[key] : null;
    const diff = a !== null && b !== null ? b - a : null;
    comparison[key] = { a, b, diff };
  }
  return {
    a: { modelId: modelA.modelId, version: modelA.version },
    b: { modelId: modelB.modelId, version: modelB.version },
    metrics: comparison,
  };
}

/**
 * Search models by free-text query with optional filters.
 * @param {string} query
 * @param {object} [filters] - { baseModel, tag, status, minAccuracy, workspaceId }
 * @returns {Promise<object[]>}
 */
export async function searchModels(query, filters = {}) {
  const items = await loadIndex();
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  let matches = items;
  if (q) {
    matches = matches.filter((e) => {
      const hay = `${e.name || ""} ${e.description || ""} ${(e.tags || []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (filters.workspaceId) {
    matches = matches.filter((e) => e.workspaceId === String(filters.workspaceId));
  }
  if (filters.baseModel) {
    matches = matches.filter((e) => e.baseModel === filters.baseModel);
  }
  if (filters.tag) {
    const tag = String(filters.tag).trim().toLowerCase();
    matches = matches.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  }
  if (filters.status) {
    matches = matches.filter((e) => e.latestStatus === filters.status);
  }

  if (Number.isFinite(filters.minAccuracy)) {
    // Need to look up latest version metrics for each match
    const filtered = [];
    for (const entry of matches) {
      const doc = await loadModel(entry.workspaceId, entry.id);
      if (!doc) continue;
      const latest = doc.versions.find((v) => v.version === doc.latestVersion);
      const acc = latest?.metrics?.accuracy;
      if (Number.isFinite(acc) && acc >= filters.minAccuracy) {
        filtered.push(entry);
      }
    }
    return filtered;
  }
  return matches;
}

/**
 * Delete a specific model version.
 * @param {string} modelId
 * @param {string} version
 * @returns {Promise<{ ok: boolean }>}
 */
export async function deleteModelVersion(modelId, version) {
  const id = sanitizeId(modelId);
  const workspaceId = await findWorkspaceForModel(id);
  if (!workspaceId) throw new Error("model not found");

  return withPathLock(modelPath(workspaceId, id), async () => {
    const doc = await loadModel(workspaceId, id);
    if (!doc) throw new Error("model not found");
    const idx = doc.versions.findIndex((x) => x.version === version);
    if (idx < 0) throw new Error("version not found");
    doc.versions.splice(idx, 1);
    const now = new Date().toISOString();
    if (doc.latestVersion === version) {
      const last = doc.versions[doc.versions.length - 1];
      doc.latestVersion = last ? last.version : null;
    }
    doc.updatedAt = now;
    await saveModel(workspaceId, doc);

    await withPathLock(indexPath(), async () => {
      const items = await loadIndex();
      const idxI = items.findIndex((e) => e.id === id);
      if (idxI >= 0) {
        items[idxI].versionCount = doc.versions.length;
        items[idxI].latestVersion = doc.latestVersion;
        const latestV = doc.versions.find((v) => v.version === doc.latestVersion);
        items[idxI].latestStatus = latestV ? latestV.status : null;
        items[idxI].updatedAt = now;
        await saveIndex(items);
      }
    });

    return { ok: true };
  });
}

/**
 * Return just the metrics for a specific version.
 * @param {string} modelId
 * @param {string} version
 * @returns {Promise<object|null>}
 */
export async function getModelMetrics(modelId, version) {
  const v = await getModelVersion(modelId, version);
  if (!v) return null;
  return v.metrics || {};
}

// ─── model card generation ──────────────────────────────────────────────────

/**
 * Generate a markdown model card for a specific model version.
 * @param {object} model - Model document (from getModel)
 * @param {object} version - Version record (from getModelVersion)
 * @returns {string} - Markdown model card
 */
export function generateModelCard(model, version) {
  if (!model || !version) {
    throw new Error("model and version are required");
  }
  const name = model.name || "Unnamed Model";
  const base = version.baseModel || model.baseModel || "(not specified)";
  const description = model.description || "(no description provided)";
  const tags = Array.isArray(model.tags) && model.tags.length ? model.tags.join(", ") : "(none)";
  const intendedUse = model.intendedUse || version.intendedUse
    || "General-purpose inference. Validate suitability for any production workload before deployment.";
  const limitations = version.limitations || model.limitations
    || "May reflect biases present in the training data. Performance outside the training distribution is not guaranteed.";

  const hp = version.hyperparameters || {};
  const hpRows = Object.keys(hp).length
    ? Object.entries(hp).map(([k, v]) => `| ${k} | ${JSON.stringify(v)} |`).join("\n")
    : "| (none) | |";

  const metrics = version.metrics || {};
  const metricsRows = Object.keys(metrics).length
    ? Object.entries(metrics).map(([k, v]) => `| ${k} | ${typeof v === "number" ? v : JSON.stringify(v)} |`).join("\n")
    : "| (none) | |";

  const dataset = version.datasetId
    ? `${version.datasetId}${version.datasetVersion ? ` (version ${version.datasetVersion})` : ""}`
    : "(not specified)";

  const trainingTime = Number.isFinite(version.trainingTime)
    ? `${version.trainingTime} seconds`
    : "(not recorded)";
  const trainingCost = Number.isFinite(version.trainingCost)
    ? `$${version.trainingCost.toFixed(2)}`
    : "(not recorded)";

  const createdAt = version.createdAt || model.createdAt || "";
  const createdBy = version.createdBy || model.createdBy || "anonymous";

  return `# Model Card: ${name} (${version.version})

## Model description

${description}

- **Model ID:** \`${model.id}\`
- **Version:** \`${version.version}\`
- **Base model:** \`${base}\`
- **Type:** ${model.type || "llm"}
- **Status:** ${version.status}
- **Tags:** ${tags}
- **Created by:** ${createdBy}
- **Created at:** ${createdAt}

## Training data

- **Dataset:** ${dataset}
- **Training time:** ${trainingTime}
- **Training cost:** ${trainingCost}

## Hyperparameters

| Parameter | Value |
|-----------|-------|
${hpRows}

## Metrics

| Metric | Value |
|--------|-------|
${metricsRows}

## Intended use

${intendedUse}

## Limitations

${limitations}

## Citation

\`\`\`bibtex
@misc{${(model.id || "model").replace(/[^a-zA-Z0-9]/g, "")}_${(version.version || "v1").replace(/[^a-zA-Z0-9]/g, "")},
  title  = {${name}},
  author = {${createdBy}},
  year   = {${createdAt ? createdAt.slice(0, 4) : new Date().getFullYear()}},
  note   = {Version ${version.version}, base model ${base}},
}
\`\`\`
`;
}

// ─── test helpers ───────────────────────────────────────────────────────────

/**
 * Reset in-memory caches (no-op for now, used by tests).
 */
export function __resetForTests() {
  // placeholder — kept for API symmetry with other lib modules
}
