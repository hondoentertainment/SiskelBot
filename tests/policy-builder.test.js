import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { saveWorkspaceAgentSettings, loadWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { canEditWorkspacePolicy, saveWorkspacePolicy, listPolicyEdits } from "../lib/policy-builder.js";
import { mountPolicyBuilderRoutes } from "../routes/policy-builder.js";

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    const prev = process.env.STORAGE_PATH;
    process.env.STORAGE_PATH = dir;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("only workspace admins may edit policy", () => {
  assert.equal(canEditWorkspacePolicy("admin"), true);
  assert.equal(canEditWorkspacePolicy("member"), false);
  assert.equal(canEditWorkspacePolicy("viewer"), false);
});

test("saving policy keeps the prompt and writes an audit row", isolate(async () => {
  await saveWorkspaceAgentSettings("ada", "default", {
    defaultSystemPrompt: "Keep this prompt",
    memorySnippets: ["fact"],
  });
  const policy = await saveWorkspacePolicy({
    storageUserId: "ada",
    workspaceId: "default",
    userId: "ada",
    draft: {
      deniedTools: "query_database\nworkspace_run_command",
      browserAllowedHosts: "docs.example.com",
      toolCategoryCaps: { read: 10, write: 2, network: 3 },
      maxExternalFetches: 4,
      sqlQueryEnabled: true,
    },
  });
  assert.deepEqual(policy.deniedTools, ["query_database", "workspace_run_command"]);
  assert.deepEqual(policy.browserAllowedHosts, ["docs.example.com"]);
  assert.equal(policy.toolCategoryCaps.network, 3);
  assert.equal(policy.sqlQueryEnabled, true);
  const settings = await loadWorkspaceAgentSettings("ada", "default");
  assert.equal(settings.defaultSystemPrompt, "Keep this prompt");
  assert.deepEqual(settings.memorySnippets, ["fact"]);
  const edits = await listPolicyEdits("default");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].userId, "ada");
  assert.equal(edits[0].after.sqlQueryEnabled, true);
  assert.equal(JSON.stringify(edits).includes("Keep this prompt"), false);
}));

test("policy routes reject an unknown workspace and audit a save", isolate(async () => {
  const app = express();
  app.use(express.json());
  mountPolicyBuilderRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
    logRequest: (_q, _s, n) => n(),
    userAuth: (req, _res, next) => {
      req.userId = "ada";
      next();
    },
  });
  const missing = await request(app).put("/api/v1/workspaces/nope/agent-policy").send({ sqlQueryEnabled: true });
  assert.equal(missing.status, 403);
  const saved = await request(app).put("/api/v1/workspaces/default/agent-policy").send({
    deniedTools: ["gmail_send_message"],
    toolCategoryCaps: { network: 1 },
    sqlQueryEnabled: false,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.agentPolicy.deniedTools, ["gmail_send_message"]);
  const audit = await request(app).get("/api/v1/workspaces/default/agent-policy/audit");
  assert.equal(audit.status, 200);
  assert.equal(audit.body.edits.length, 1);
}));
