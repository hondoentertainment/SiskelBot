import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSecret } from "../lib/secrets-store.js";
import { getToolCategory } from "../lib/agent-policy.js";
import {
  importOpenApiSpec,
  invokeOpenApiTool,
  openApiToolDefs,
  resetOpenApiHostBudgets,
  parseOpenApiSpec,
} from "../lib/openapi-tool-factory.js";

const spec = {
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        summary: "List items",
        parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }],
      },
      post: { operationId: "createItem", summary: "Create" },
    },
  },
};

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oapi-"));
    const prevStore = process.env.STORAGE_PATH;
    const prevOn = process.env.OPENAPI_TOOLS_ENABLED;
    const prevWrite = process.env.OPENAPI_TOOLS_WRITE;
    process.env.STORAGE_PATH = dir;
    delete process.env.OPENAPI_TOOLS_ENABLED;
    delete process.env.OPENAPI_TOOLS_WRITE;
    resetOpenApiHostBudgets();
    try {
      await fn();
    } finally {
      if (prevStore === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = prevStore;
      if (prevOn === undefined) delete process.env.OPENAPI_TOOLS_ENABLED;
      else process.env.OPENAPI_TOOLS_ENABLED = prevOn;
      if (prevWrite === undefined) delete process.env.OPENAPI_TOOLS_WRITE;
      else process.env.OPENAPI_TOOLS_WRITE = prevWrite;
      resetOpenApiHostBudgets();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("localhost and non-https specs are rejected", () => {
  assert.throws(() => parseOpenApiSpec({
    openapi: "3.0.3",
    servers: [{ url: "http://api.example.com" }],
    paths: { "/x": { get: { operationId: "x" } } },
  }), /https/);
  assert.throws(() => parseOpenApiSpec({
    openapi: "3.0.3",
    servers: [{ url: "https://127.0.0.1" }],
    paths: { "/x": { get: { operationId: "x" } } },
  }), /blocked/);
});

test("imported tools use the workspace bearer token, cap the host, and block writes by default", isolate(async () => {
  const imported = await importOpenApiSpec("default", {
    name: "Example",
    spec,
    authSecretName: "partner_token",
    enabled: true,
    maxPerMinute: 2,
  });
  assert.equal(imported.operations.length, 2);
  await setSecret("workspace", "default", "partner_token", "partner-secret-token", "openapi");
  process.env.OPENAPI_TOOLS_ENABLED = "1";
  const defs = await openApiToolDefs("default");
  assert.equal(defs.length, 1);
  assert.equal(getToolCategory(defs[0].function.name), "network");
  const getName = imported.operations.find((op) => op.method === "get").name;
  const postName = imported.operations.find((op) => op.method === "post").name;
  const blocked = await invokeOpenApiTool(postName, {}, { workspace: "default", workspaceUserId: "ada" });
  assert.equal(JSON.parse(blocked.content).code, "OPENAPI_WRITE_DISABLED");

  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    return { ok: true, status: 200, text: async () => "{\"items\":[1]}" };
  };
  const first = await invokeOpenApiTool(getName, { q: "kit" }, { workspace: "default", workspaceUserId: "ada" }, { fetchImpl: fetcher });
  assert.equal(first.ok, true);
  assert.equal(calls[0].auth, "Bearer partner-secret-token");
  assert.match(calls[0].url, /https:\/\/api\.example\.com\/v1\/items\?q=kit/);
  await invokeOpenApiTool(getName, {}, { workspace: "default", workspaceUserId: "ada" }, { fetchImpl: fetcher });
  const limited = await invokeOpenApiTool(getName, {}, { workspace: "default", workspaceUserId: "ada" }, { fetchImpl: fetcher });
  assert.equal(JSON.parse(limited.content).code, "HOST_RATE_LIMIT");
  assert.equal(calls.length, 2);

  delete process.env.OPENAPI_TOOLS_ENABLED;
  const disabled = await invokeOpenApiTool(getName, {}, { workspace: "default", workspaceUserId: "ada" }, { fetchImpl: fetcher });
  assert.equal(JSON.parse(disabled.content).code, "OPENAPI_DISABLED");
}));
