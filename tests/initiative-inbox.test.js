import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { persistProposals, resolveProposal } from "../lib/initiative-engine.js";
import { loadAdviceInbox, toAdviceInbox } from "../lib/initiative-inbox.js";
import { mountAdviceRoutes } from "../routes/advice.js";

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-"));
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

test("advice inbox keeps pending and approved proposals only", () => {
  const view = toAdviceInbox([
    { id: "1", title: "Fix the brief", rationale: "Three failures", category: "fix", status: "pending", confidence: 0.8 },
    { id: "2", title: "Done", status: "dismissed" },
    { id: "3", title: "Approved restart", status: "approved", category: "fix" },
    { id: "4", title: "Ran", status: "executed" },
  ]);
  assert.deepEqual(view.map((p) => p.id), ["1", "3"]);
  assert.equal(view[0].rationale, "Three failures");
});

test("loadAdviceInbox reads stored proposals for the workspace", isolate(async () => {
  const { created } = await persistProposals("advice-ws", [
    {
      title: "Repair failing scheduled agent",
      rationale: "Morning brief failed twice",
      category: "fix",
      suggestedAction: "Open the run log",
      confidence: 0.9,
      signalFingerprint: "fp-fail",
    },
    {
      title: "Ignore me",
      rationale: "closed",
      category: "notify",
      confidence: 0.2,
      signalFingerprint: "fp-old",
    },
  ]);
  await resolveProposal("advice-ws", created[1].id, { status: "dismissed", by: "ada" });
  const inbox = await loadAdviceInbox("advice-ws");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].title, "Repair failing scheduled agent");
  assert.equal(inbox[0].status, "pending");
}));

test("GET /advice/initiatives returns the open inbox", isolate(async () => {
  await persistProposals("default", [{
    title: "Restart overdue scheduled agent",
    rationale: "Next run was yesterday",
    category: "fix",
    confidence: 0.7,
    signalFingerprint: "fp-overdue",
  }]);
  const app = express();
  app.use(express.json());
  mountAdviceRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
    logRequest: (_q, _s, n) => n(),
    userAuth: (_q, _s, n) => n(),
    sanitizeWorkspace: (w) => (typeof w === "string" && w.trim() ? w.trim() : "default"),
  });
  const res = await request(app).get("/api/v1/advice/initiatives").query({ workspace: "default" });
  assert.equal(res.status, 200);
  assert.equal(res.body.proposals.length, 1);
  assert.match(res.body.proposals[0].title, /overdue/);
}));
