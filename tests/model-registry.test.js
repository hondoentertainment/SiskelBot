/**
 * Tests for lib/model-registry.js — model and version CRUD, status transitions,
 * deployment/rollback, lineage tracking, comparison, model card generation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-model-registry-"));
process.env.STORAGE_PATH = tempDir;

const {
  registerModel,
  createModelVersion,
  getModel,
  getModelVersion,
  listModels,
  listModelVersions,
  setModelStatus,
  deployModel,
  getDeployedModel,
  rollbackDeployment,
  getModelLineage,
  compareModels,
  searchModels,
  deleteModelVersion,
  getModelMetrics,
  generateModelCard,
} = await import("../lib/model-registry.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// ─── registerModel ──────────────────────────────────────────────────────────

test("registerModel creates a model with an id and empty versions", async () => {
  const model = await registerModel("ws-a", {
    name: "Sentiment Classifier",
    baseModel: "distilbert",
    type: "classifier",
    description: "Classifies text sentiment",
    tags: ["nlp", "sentiment"],
    createdBy: "alice",
  });
  assert.ok(model.id);
  assert.equal(model.name, "Sentiment Classifier");
  assert.equal(model.baseModel, "distilbert");
  assert.equal(model.type, "classifier");
  assert.deepEqual(model.tags, ["nlp", "sentiment"]);
  assert.equal(model.createdBy, "alice");
  assert.deepEqual(model.versions, []);
  assert.equal(model.latestVersion, null);
});

test("registerModel throws when name is missing", async () => {
  await assert.rejects(
    () => registerModel("ws-a", { baseModel: "x" }),
    /name is required/
  );
});

test("registerModel normalizes tags and defaults unknown type", async () => {
  const model = await registerModel("ws-a", {
    name: "Tag test",
    type: "unknown-type",
    tags: ["  NLP  ", "Sentiment", "", "rag"],
  });
  assert.equal(model.type, "other");
  assert.deepEqual(model.tags, ["nlp", "sentiment", "rag"]);
});

// ─── createModelVersion ─────────────────────────────────────────────────────

test("createModelVersion appends a version and updates latestVersion", async () => {
  const model = await registerModel("ws-b", {
    name: "Classifier v1",
    baseModel: "bert-base",
    type: "classifier",
  });
  const v1 = await createModelVersion(model.id, {
    version: "1.0.0",
    datasetId: "ds-1",
    datasetVersion: "v1",
    hyperparameters: { lr: 0.001, batchSize: 32, epochs: 3 },
    metrics: { accuracy: 0.87, loss: 0.23, f1: 0.85 },
    artifacts: { modelPath: "/models/classifier/v1.safetensors" },
    trainingTime: 3600,
    trainingCost: 12.5,
    createdBy: "bob",
  });
  assert.equal(v1.version, "1.0.0");
  assert.equal(v1.status, "ready");
  assert.equal(v1.metrics.accuracy, 0.87);
  assert.equal(v1.hyperparameters.lr, 0.001);

  const fresh = await getModel(model.id);
  assert.equal(fresh.latestVersion, "1.0.0");
  assert.equal(fresh.versions.length, 1);
});

test("createModelVersion auto-generates version label when missing", async () => {
  const model = await registerModel("ws-b", { name: "Auto version model", baseModel: "b" });
  const v = await createModelVersion(model.id, { metrics: { accuracy: 0.5 } });
  assert.equal(v.version, "v1");
  const v2 = await createModelVersion(model.id, { metrics: { accuracy: 0.6 } });
  assert.equal(v2.version, "v2");
});

test("createModelVersion rejects duplicate version strings", async () => {
  const model = await registerModel("ws-b", { name: "Dup test", baseModel: "b" });
  await createModelVersion(model.id, { version: "1.0.0" });
  await assert.rejects(
    () => createModelVersion(model.id, { version: "1.0.0" }),
    /already exists/
  );
});

test("createModelVersion throws for unknown model", async () => {
  await assert.rejects(
    () => createModelVersion("nonexistent-id", { version: "1.0.0" }),
    /model not found/
  );
});

// ─── getModel / getModelVersion ─────────────────────────────────────────────

test("getModelVersion returns null for missing version", async () => {
  const model = await registerModel("ws-c", { name: "Get test", baseModel: "b" });
  const result = await getModelVersion(model.id, "nope");
  assert.equal(result, null);
});

// ─── listModels / listModelVersions ─────────────────────────────────────────

test("listModels filters by workspaceId", async () => {
  await registerModel("ws-list-1", { name: "M1" });
  await registerModel("ws-list-1", { name: "M2" });
  await registerModel("ws-list-2", { name: "M3" });
  const ws1 = await listModels("ws-list-1");
  const ws2 = await listModels("ws-list-2");
  assert.ok(ws1.items.length >= 2);
  assert.ok(ws2.items.length >= 1);
  assert.ok(ws1.items.every((m) => m.workspaceId === "ws-list-1"));
});

test("listModelVersions returns versions sorted newest first", async () => {
  const model = await registerModel("ws-v-sort", { name: "Versions sorted" });
  await createModelVersion(model.id, { version: "1.0" });
  await new Promise((r) => setTimeout(r, 5));
  await createModelVersion(model.id, { version: "2.0" });
  const versions = await listModelVersions(model.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, "2.0");
});

// ─── setModelStatus ─────────────────────────────────────────────────────────

test("setModelStatus transitions through valid states", async () => {
  const model = await registerModel("ws-status", { name: "Status transitions" });
  await createModelVersion(model.id, { version: "1.0" });

  let v = await setModelStatus(model.id, "1.0", "training");
  assert.equal(v.status, "training");
  v = await setModelStatus(model.id, "1.0", "ready");
  assert.equal(v.status, "ready");
  v = await setModelStatus(model.id, "1.0", "deprecated");
  assert.equal(v.status, "deprecated");
});

test("setModelStatus rejects invalid status", async () => {
  const model = await registerModel("ws-status2", { name: "Invalid status" });
  await createModelVersion(model.id, { version: "1.0" });
  await assert.rejects(
    () => setModelStatus(model.id, "1.0", "bogus"),
    /invalid status/
  );
});

test("setModelStatus rejects unknown version", async () => {
  const model = await registerModel("ws-status3", { name: "x" });
  await assert.rejects(
    () => setModelStatus(model.id, "nope", "ready"),
    /version not found/
  );
});

// ─── deployModel / rollbackDeployment ───────────────────────────────────────

test("deployModel creates a deployment record and updates status", async () => {
  const model = await registerModel("ws-deploy", { name: "Deploy test" });
  await createModelVersion(model.id, { version: "1.0", metrics: { accuracy: 0.9 } });
  const d = await deployModel(model.id, "1.0", "staging");
  assert.equal(d.environment, "staging");
  assert.equal(d.modelId, model.id);
  assert.equal(d.version, "1.0");
  const v = await getModelVersion(model.id, "1.0");
  assert.equal(v.status, "deployed");
});

test("deployModel rejects invalid environment", async () => {
  const model = await registerModel("ws-deploy-env", { name: "Env test" });
  await createModelVersion(model.id, { version: "1.0" });
  await assert.rejects(
    () => deployModel(model.id, "1.0", "bogus-env"),
    /invalid environment/
  );
});

test("getDeployedModel returns current deployment", async () => {
  const model = await registerModel("ws-dep-get", { name: "Get deployed" });
  await createModelVersion(model.id, { version: "1.0" });
  await deployModel(model.id, "1.0", "production");
  const d = await getDeployedModel("production");
  assert.ok(d);
  assert.equal(d.modelId, model.id);
  assert.equal(d.version, "1.0");
});

test("rollbackDeployment restores an earlier version", async () => {
  const model = await registerModel("ws-rollback", { name: "Rollback test" });
  await createModelVersion(model.id, { version: "1.0" });
  await createModelVersion(model.id, { version: "2.0" });
  await deployModel(model.id, "1.0", "experiment");
  await deployModel(model.id, "2.0", "experiment");
  const rolled = await rollbackDeployment("experiment", "1.0");
  assert.equal(rolled.version, "1.0");
  const current = await getDeployedModel("experiment");
  assert.equal(current.version, "1.0");
});

test("rollbackDeployment rejects invalid environment", async () => {
  await assert.rejects(
    () => rollbackDeployment("bogus-env", "1.0"),
    /invalid environment/
  );
});

// ─── getModelLineage ────────────────────────────────────────────────────────

test("getModelLineage tracks parent/child versions", async () => {
  const model = await registerModel("ws-lineage", {
    name: "Lineage test",
    baseModel: "base-llm",
  });
  await createModelVersion(model.id, { version: "v1", datasetId: "ds-1" });
  await createModelVersion(model.id, { version: "v2", parentVersion: "v1", datasetId: "ds-2" });
  await createModelVersion(model.id, { version: "v3", parentVersion: "v1", datasetId: "ds-3" });

  const lin1 = await getModelLineage(model.id, "v1");
  assert.equal(lin1.baseModel, "base-llm");
  assert.equal(lin1.parentVersion, null);
  assert.equal(lin1.children.length, 2);
  assert.deepEqual(lin1.children.map((c) => c.version).sort(), ["v2", "v3"]);

  const lin2 = await getModelLineage(model.id, "v2");
  assert.equal(lin2.parentVersion, "v1");
  assert.equal(lin2.dataset.datasetId, "ds-2");
});

// ─── compareModels ──────────────────────────────────────────────────────────

test("compareModels returns per-metric diff", async () => {
  const mA = await registerModel("ws-cmp", { name: "Compare A" });
  await createModelVersion(mA.id, {
    version: "1.0",
    metrics: { accuracy: 0.8, loss: 0.4, f1: 0.75 },
  });
  const mB = await registerModel("ws-cmp", { name: "Compare B" });
  await createModelVersion(mB.id, {
    version: "1.0",
    metrics: { accuracy: 0.85, loss: 0.35, perplexity: 12 },
  });
  const cmp = await compareModels(
    { modelId: mA.id, version: "1.0" },
    { modelId: mB.id, version: "1.0" }
  );
  assert.ok(cmp.metrics.accuracy);
  assert.equal(cmp.metrics.accuracy.a, 0.8);
  assert.equal(cmp.metrics.accuracy.b, 0.85);
  assert.ok(Math.abs(cmp.metrics.accuracy.diff - 0.05) < 1e-9);
  // f1 only in A
  assert.equal(cmp.metrics.f1.a, 0.75);
  assert.equal(cmp.metrics.f1.b, null);
  assert.equal(cmp.metrics.f1.diff, null);
  // perplexity only in B
  assert.equal(cmp.metrics.perplexity.a, null);
  assert.equal(cmp.metrics.perplexity.b, 12);
});

// ─── searchModels ───────────────────────────────────────────────────────────

test("searchModels filters by query and tag", async () => {
  await registerModel("ws-search", {
    name: "Sentiment Finder",
    description: "finds sentiment in text",
    tags: ["sentiment"],
  });
  await registerModel("ws-search", {
    name: "Toxicity Detector",
    tags: ["moderation"],
  });
  const sentimentResults = await searchModels("sentiment", { workspaceId: "ws-search" });
  assert.ok(sentimentResults.some((r) => r.name === "Sentiment Finder"));
  const tagResults = await searchModels("", { tag: "moderation", workspaceId: "ws-search" });
  assert.ok(tagResults.some((r) => r.name === "Toxicity Detector"));
});

test("searchModels filters by minAccuracy", async () => {
  const hi = await registerModel("ws-search-acc", { name: "High acc" });
  await createModelVersion(hi.id, { version: "1.0", metrics: { accuracy: 0.95 } });
  const lo = await registerModel("ws-search-acc", { name: "Low acc" });
  await createModelVersion(lo.id, { version: "1.0", metrics: { accuracy: 0.5 } });
  const results = await searchModels("", { minAccuracy: 0.9, workspaceId: "ws-search-acc" });
  assert.ok(results.some((r) => r.name === "High acc"));
  assert.ok(!results.some((r) => r.name === "Low acc"));
});

// ─── deleteModelVersion ─────────────────────────────────────────────────────

test("deleteModelVersion removes a version and updates latestVersion", async () => {
  const model = await registerModel("ws-del", { name: "Delete test" });
  await createModelVersion(model.id, { version: "1.0" });
  await createModelVersion(model.id, { version: "2.0" });
  const result = await deleteModelVersion(model.id, "2.0");
  assert.equal(result.ok, true);
  const fresh = await getModel(model.id);
  assert.equal(fresh.versions.length, 1);
  assert.equal(fresh.latestVersion, "1.0");
});

test("deleteModelVersion rejects missing version", async () => {
  const model = await registerModel("ws-del2", { name: "Delete missing" });
  await assert.rejects(
    () => deleteModelVersion(model.id, "ghost"),
    /version not found/
  );
});

// ─── getModelMetrics ────────────────────────────────────────────────────────

test("getModelMetrics returns just the metrics object", async () => {
  const model = await registerModel("ws-metrics", { name: "Metrics test" });
  await createModelVersion(model.id, {
    version: "1.0",
    metrics: { accuracy: 0.77, loss: 0.3 },
  });
  const m = await getModelMetrics(model.id, "1.0");
  assert.equal(m.accuracy, 0.77);
  assert.equal(m.loss, 0.3);
});

// ─── generateModelCard ──────────────────────────────────────────────────────

test("generateModelCard produces markdown with required sections", async () => {
  const model = await registerModel("ws-card", {
    name: "Card test model",
    baseModel: "llama-3",
    type: "llm",
    description: "A helpful assistant.",
    tags: ["chat", "assistant"],
    createdBy: "alice",
  });
  const v = await createModelVersion(model.id, {
    version: "1.0.0",
    datasetId: "chat-ds",
    datasetVersion: "v3",
    hyperparameters: { lr: 0.0001, batchSize: 64, epochs: 5 },
    metrics: { accuracy: 0.92, perplexity: 8.3 },
    trainingTime: 7200,
    trainingCost: 42.42,
    createdBy: "alice",
  });
  const fresh = await getModel(model.id);
  const card = generateModelCard(fresh, v);
  assert.match(card, /# Model Card:/);
  assert.match(card, /## Model description/);
  assert.match(card, /## Training data/);
  assert.match(card, /## Hyperparameters/);
  assert.match(card, /## Metrics/);
  assert.match(card, /## Intended use/);
  assert.match(card, /## Limitations/);
  assert.match(card, /## Citation/);
  assert.match(card, /llama-3/);
  assert.match(card, /0\.92/);
  assert.match(card, /chat-ds/);
  assert.match(card, /@misc\{/);
});

test("generateModelCard handles missing metrics and hyperparameters", async () => {
  const model = await registerModel("ws-card2", { name: "Minimal model" });
  const v = await createModelVersion(model.id, { version: "1.0" });
  const fresh = await getModel(model.id);
  const card = generateModelCard(fresh, v);
  assert.match(card, /\(none\)/);
  assert.match(card, /Minimal model/);
});

test("generateModelCard throws without model and version", () => {
  assert.throws(() => generateModelCard(null, null), /required/);
});
