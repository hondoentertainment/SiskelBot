/**
 * Tests for lib/lora-adapters.js — LoRA adapter registration, workspace active
 * adapter resolution, metrics, and model-name resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerAdapter,
  unregisterAdapter,
  loadAdapter,
  unloadAdapter,
  listAdapters,
  getAdapter,
  switchActiveAdapter,
  getActiveAdapter,
  recordAdapterUsage,
  getAdapterMetrics,
  buildModelNameWithAdapter,
  importOpenAIFineTune,
  listOpenAIFineTunes,
  fetchHuggingFaceAdapterInfo,
  _resetAdapterStoreForTest,
} from "../lib/lora-adapters.js";

const WS = "adapter-test-ws-" + Date.now();
const WS_OTHER = WS + "-other";

test.beforeEach(async () => {
  await _resetAdapterStoreForTest();
});

// ────────────── registration / unregistration ──────────────

test("registerAdapter validates required fields", async () => {
  await assert.rejects(() => registerAdapter(null), /required/i);
  await assert.rejects(() => registerAdapter({}), /name is required/i);
  await assert.rejects(
    () => registerAdapter({ name: "x" }),
    /baseModel is required/i
  );
  await assert.rejects(
    () => registerAdapter({ name: "x", baseModel: "llama3", source: "nope" }),
    /source must be one of/i
  );
  await assert.rejects(
    () =>
      registerAdapter({
        name: "x",
        baseModel: "llama3",
        source: "local",
        adapterType: "wat",
      }),
    /adapterType must be one of/i
  );
  await assert.rejects(
    () =>
      registerAdapter({
        name: "x",
        baseModel: "llama3",
        source: "local",
        scope: "workspace",
      }),
    /workspaceId is required/i
  );
});

test("registerAdapter persists a record with defaults", async () => {
  const result = await registerAdapter({
    name: "my-adapter",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS,
  });
  assert.ok(result.id);
  assert.ok(result.registeredAt);
  assert.equal(result.loaded, false);

  const adapter = await getAdapter(result.id);
  assert.ok(adapter);
  assert.equal(adapter.name, "my-adapter");
  assert.equal(adapter.baseModel, "llama3");
  assert.equal(adapter.adapterType, "lora");
  assert.equal(adapter.scope, "workspace");
  assert.equal(adapter.workspaceId, WS);
  assert.equal(adapter.loaded, false);
});

test("unregisterAdapter removes record and clears active selection", async () => {
  const { id } = await registerAdapter({
    name: "drop-me",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS,
  });
  await switchActiveAdapter(WS, id);
  assert.equal((await getActiveAdapter(WS))?.id, id);

  const res = await unregisterAdapter(id);
  assert.equal(res.ok, true);
  assert.equal(await getAdapter(id), null);
  assert.equal(await getActiveAdapter(WS), null);

  const missing = await unregisterAdapter("not-real");
  assert.equal(missing.ok, false);
});

test("listAdapters filters workspace-scoped adapters by workspace", async () => {
  const a = await registerAdapter({
    name: "ws-one",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS,
  });
  const b = await registerAdapter({
    name: "ws-two",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS_OTHER,
  });
  const g = await registerAdapter({
    name: "global-one",
    baseModel: "llama3",
    source: "local",
    scope: "global",
  });

  const forWs = await listAdapters(WS);
  const ids = forWs.map((x) => x.id).sort();
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(g.id));
  assert.ok(!ids.includes(b.id));

  const all = await listAdapters();
  assert.equal(all.length, 3);
});

// ────────────── load / unload ──────────────

test("loadAdapter and unloadAdapter flip flags", async () => {
  const { id } = await registerAdapter({
    name: "load-me",
    baseModel: "llama3",
    source: "local",
    scope: "global",
  });
  const loaded = await loadAdapter(id);
  assert.equal(loaded.loaded, true);
  assert.ok(loaded.loadedAt);

  const fetched = await getAdapter(id);
  assert.equal(fetched.loaded, true);

  const unloaded = await unloadAdapter(id);
  assert.equal(unloaded.loaded, false);
  const again = await getAdapter(id);
  assert.equal(again.loaded, false);
  assert.equal(again.loadedAt, null);

  await assert.rejects(() => loadAdapter("nope"), /not found/i);
});

// ────────────── workspace active adapter ──────────────

test("switchActiveAdapter sets and clears active adapter per workspace", async () => {
  const { id } = await registerAdapter({
    name: "active-one",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS,
  });

  const set = await switchActiveAdapter(WS, id);
  assert.equal(set.adapterId, id);
  assert.equal((await getActiveAdapter(WS))?.id, id);

  const cleared = await switchActiveAdapter(WS, null);
  assert.equal(cleared.adapterId, null);
  assert.equal(await getActiveAdapter(WS), null);
});

test("switchActiveAdapter forbids cross-workspace selection", async () => {
  const { id } = await registerAdapter({
    name: "scoped",
    baseModel: "llama3",
    source: "local",
    scope: "workspace",
    workspaceId: WS,
  });
  await assert.rejects(
    () => switchActiveAdapter(WS_OTHER, id),
    /not accessible/i
  );
});

test("switchActiveAdapter requires workspaceId and existing adapter", async () => {
  await assert.rejects(() => switchActiveAdapter("", "anything"), /workspaceId is required/i);
  await assert.rejects(() => switchActiveAdapter(WS, "missing"), /not found/i);
});

test("getActiveAdapter returns null when nothing set", async () => {
  assert.equal(await getActiveAdapter(WS), null);
  assert.equal(await getActiveAdapter(""), null);
});

// ────────────── model name resolution ──────────────

test("buildModelNameWithAdapter passes through with no adapter", () => {
  assert.deepEqual(buildModelNameWithAdapter("gpt-4o-mini", null), {
    model: "gpt-4o-mini",
  });
});

test("buildModelNameWithAdapter returns fine-tuned model ID for OpenAI source", () => {
  const resolved = buildModelNameWithAdapter("gpt-3.5-turbo", {
    id: "adp_123",
    name: "mine",
    source: "openai",
    sourceConfig: { fineTunedModelId: "ft:gpt-3.5-turbo:org::abc" },
  });
  assert.equal(resolved.model, "ft:gpt-3.5-turbo:org::abc");
  assert.equal(resolved.extras, undefined);
});

test("buildModelNameWithAdapter falls back to base model when OpenAI config lacks id", () => {
  const resolved = buildModelNameWithAdapter("gpt-3.5-turbo", {
    id: "adp_123",
    source: "openai",
    sourceConfig: {},
  });
  assert.equal(resolved.model, "gpt-3.5-turbo");
});

test("buildModelNameWithAdapter adds adapter_name extras for HuggingFace source", () => {
  const resolved = buildModelNameWithAdapter("llama3", {
    id: "adp_hf",
    name: "lora-name",
    source: "huggingface",
    sourceConfig: { modelId: "org/name" },
  });
  assert.equal(resolved.model, "llama3");
  assert.deepEqual(resolved.extras, { adapter_name: "lora-name" });
});

test("buildModelNameWithAdapter handles local source with pseudo-model name", () => {
  const resolved = buildModelNameWithAdapter("llama3", {
    id: "adp_local",
    source: "local",
    sourceConfig: {},
  });
  assert.equal(resolved.model, "adapter:adp_local");
});

test("buildModelNameWithAdapter returns base when caller passes a raw id", () => {
  // Callers are expected to look up records; strings cannot be resolved here.
  const resolved = buildModelNameWithAdapter("llama3", "adp_123");
  assert.deepEqual(resolved, { model: "llama3" });
});

// ────────────── metrics tracking ──────────────

test("recordAdapterUsage aggregates usage, latency and errors", async () => {
  const { id } = await registerAdapter({
    name: "metrics",
    baseModel: "llama3",
    source: "local",
    scope: "global",
  });

  await recordAdapterUsage(id, { latencyMs: 100 });
  await recordAdapterUsage(id, { latencyMs: 200 });
  await recordAdapterUsage(id, { latencyMs: 300, error: true });

  const m = await getAdapterMetrics(id);
  assert.equal(m.usage, 3);
  assert.equal(m.avgLatency, 200);
  assert.equal(m.errorRate, 0.3333);
  assert.ok(m.lastUsed);
});

test("getAdapterMetrics returns zeros for unknown adapter", async () => {
  const m = await getAdapterMetrics("never-registered");
  assert.deepEqual(m, { usage: 0, avgLatency: 0, errorRate: 0, lastUsed: null });
});

test("recordAdapterUsage is a no-op when adapterId is falsy", async () => {
  await recordAdapterUsage(null, { latencyMs: 5 });
  await recordAdapterUsage(undefined, { latencyMs: 5 });
  // No throw, no state change.
});

// ────────────── metadata fetching (mocked) ──────────────

test("listOpenAIFineTunes normalizes fine-tune job data (mocked fetch)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /fine_tuning\/jobs/);
    assert.equal(opts?.headers?.Authorization, "Bearer test-key");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            {
              id: "ftjob-1",
              fine_tuned_model: "ft:gpt-3.5-turbo:org::foo",
              model: "gpt-3.5-turbo",
              status: "succeeded",
              created_at: 1700000000,
            },
            {
              id: "ftjob-2",
              fine_tuned_model: null,
              model: "gpt-4o-mini",
              status: "running",
              created_at: 1700000100,
            },
          ],
        };
      },
      async text() { return ""; },
    };
  };
  try {
    const jobs = await listOpenAIFineTunes("test-key");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, "ftjob-1");
    assert.equal(jobs[0].fineTunedModel, "ft:gpt-3.5-turbo:org::foo");
    assert.equal(jobs[1].fineTunedModel, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listOpenAIFineTunes requires apiKey", async () => {
  await assert.rejects(() => listOpenAIFineTunes(""), /apiKey is required/i);
});

test("listOpenAIFineTunes surfaces API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return "invalid key"; },
    async json() { return {}; },
  });
  try {
    await assert.rejects(() => listOpenAIFineTunes("bad"), /OpenAI API error 401/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importOpenAIFineTune registers an adapter from a completed job (mocked fetch)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /fine_tuning\/jobs\/ftjob-abc/);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "ftjob-abc",
          fine_tuned_model: "ft:gpt-3.5-turbo:org::xyz",
          model: "gpt-3.5-turbo",
          status: "succeeded",
        };
      },
      async text() { return ""; },
    };
  };
  try {
    const res = await importOpenAIFineTune("ftjob-abc", "test-key", {
      workspaceId: WS,
    });
    assert.ok(res.id);
    const adapter = await getAdapter(res.id);
    assert.equal(adapter.source, "openai");
    assert.equal(adapter.baseModel, "gpt-3.5-turbo");
    assert.equal(adapter.sourceConfig.fineTunedModelId, "ft:gpt-3.5-turbo:org::xyz");
    assert.equal(adapter.scope, "workspace");
    assert.equal(adapter.workspaceId, WS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importOpenAIFineTune rejects when job has no fine_tuned_model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { id: "ftjob-x", fine_tuned_model: null, model: "gpt-3.5-turbo", status: "running" };
    },
    async text() { return ""; },
  });
  try {
    await assert.rejects(
      () => importOpenAIFineTune("ftjob-x", "test-key"),
      /no fine_tuned_model/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchHuggingFaceAdapterInfo normalizes card data (mocked fetch)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /huggingface\.co\/api\/models\/org%2Fmy-adapter/);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          author: "org",
          sha: "abc123",
          tags: ["peft", "lora"],
          pipeline_tag: "text-generation",
          downloads: 42,
          likes: 7,
          lastModified: "2025-01-01T00:00:00Z",
          cardData: { base_model: "meta-llama/Llama-3-8B" },
          library_name: "peft",
        };
      },
      async text() { return ""; },
    };
  };
  try {
    const info = await fetchHuggingFaceAdapterInfo("org/my-adapter");
    assert.equal(info.modelId, "org/my-adapter");
    assert.equal(info.author, "org");
    assert.equal(info.sha, "abc123");
    assert.deepEqual(info.tags, ["peft", "lora"]);
    assert.equal(info.baseModel, "meta-llama/Llama-3-8B");
    assert.equal(info.library, "peft");
    assert.equal(info.downloads, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchHuggingFaceAdapterInfo requires modelId", async () => {
  await assert.rejects(() => fetchHuggingFaceAdapterInfo(""), /modelId is required/i);
});

test("fetchHuggingFaceAdapterInfo surfaces API errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    async text() { return "not found"; },
    async json() { return {}; },
  });
  try {
    await assert.rejects(
      () => fetchHuggingFaceAdapterInfo("nope/nope"),
      /HuggingFace API error 404/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
