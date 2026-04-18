/**
 * Route tests for /api/admin/prompt-patches/* endpoints.
 * Covers: list, single-fetch, apply, reject, synthesize, and diff with
 * isolated STORAGE_PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-patches-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminPromptPatchesRoutes } = await import("../routes/admin-prompt-patches.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminPromptPatchesRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

async function seedSignal(ws) {
  // Seed enough failure + reliability data that synthesizePatch emits a real
  // non-null patch (chronic "permission" failures exceed score threshold and
  // genealogy shows both a "loser" and "winner" tool).
  const { recordRunFailures } = await import("../lib/agent-failure-store.js");
  const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
  const failures = [];
  for (let i = 0; i < 3; i++) failures.push({ tool: "bad_tool", category: "permission" });
  for (let i = 0; i < 2; i++) failures.push({ tool: "bad_tool", category: "validation" });
  await recordRunFailures(ws, failures);

  const outcomes = [];
  for (let i = 0; i < 10; i++) outcomes.push({ tool: "winner", ok: true });
  for (let i = 0; i < 8; i++) outcomes.push({ tool: "loser", ok: false });
  for (let i = 0; i < 6; i++) outcomes.push({ tool: "bad_tool", ok: false });
  await recordToolOutcomes(ws, outcomes);
}

test("GET /prompt-patches: empty workspace returns empty list + active:null", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/prompt-patches?workspace=wsPatchEmpty");
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, "wsPatchEmpty");
  assert.equal(r.body.active, null);
  assert.deepEqual(r.body.patches, []);
});

test("POST /prompt-patches/synthesize: empty workspace → {patch:null, reason:'no signal'}", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/prompt-patches/synthesize?workspace=wsSynthEmpty")
    .send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.patch, null);
  assert.equal(r.body.reason, "no signal");
});

test("POST /prompt-patches/synthesize: with seeded signal returns a pending patch", async () => {
  const ws = `wsSynth-${Date.now()}`;
  await seedSignal(ws);

  const { request, app } = await buildHarness();
  const r = await request(app)
    .post(`/api/admin/prompt-patches/synthesize?workspace=${ws}`)
    .send({});
  assert.equal(r.status, 200);
  assert.ok(r.body.patch, "expected a patch to be returned");
  assert.equal(r.body.patch.status, "pending");
  assert.equal(r.body.patch.workspace, ws);
  assert.ok(typeof r.body.patch.content === "string" && r.body.patch.content.length > 0);
  assert.ok(typeof r.body.patch.version === "string" && r.body.patch.version.length > 0);
});

test("GET /prompt-patches/:unknown → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .get("/api/admin/prompt-patches/does-not-exist?workspace=wsPatchEmpty");
  assert.equal(r.status, 404);
});

test("POST /prompt-patches/:version/apply: marks applied and appears as active", async () => {
  const ws = `wsApply-${Date.now()}`;
  await seedSignal(ws);

  const { request, app } = await buildHarness();
  const synth = await request(app)
    .post(`/api/admin/prompt-patches/synthesize?workspace=${ws}`)
    .send({});
  const version = synth.body.patch.version;

  const applyRes = await request(app)
    .post(`/api/admin/prompt-patches/${version}/apply?workspace=${ws}`)
    .send({ adminId: "tester" });
  assert.equal(applyRes.status, 200);
  assert.equal(applyRes.body.patch.status, "applied");
  assert.equal(applyRes.body.patch.appliedBy, "tester");

  const list = await request(app).get(`/api/admin/prompt-patches?workspace=${ws}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.active, "expected active patch after apply");
  assert.equal(list.body.active.version, version);
  assert.equal(list.body.active.status, "applied");
});

test("POST /prompt-patches/:version/reject: marks rejected", async () => {
  const ws = `wsReject-${Date.now()}`;
  await seedSignal(ws);

  const { request, app } = await buildHarness();
  const synth = await request(app)
    .post(`/api/admin/prompt-patches/synthesize?workspace=${ws}`)
    .send({});
  const version = synth.body.patch.version;

  const rejectRes = await request(app)
    .post(`/api/admin/prompt-patches/${version}/reject?workspace=${ws}`)
    .send({ adminId: "tester" });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.patch.status, "rejected");

  const single = await request(app)
    .get(`/api/admin/prompt-patches/${version}?workspace=${ws}`);
  assert.equal(single.status, 200);
  assert.equal(single.body.patch.status, "rejected");
});

test("POST /prompt-patches/:unknown/apply → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/prompt-patches/no-such-version/apply?workspace=wsPatchEmpty")
    .send({});
  assert.equal(r.status, 404);
});

test("GET /prompt-patches/diff: returns line-level diff array", async () => {
  const ws = `wsDiff-${Date.now()}`;
  // Build two distinct patches by mutating the store directly via savePatch.
  const { savePatch } = await import("../lib/agent-prompt-tuner.js");
  const base = { workspace: ws, generatedAt: Date.now() - 1000, status: "pending" };
  await savePatch({
    ...base,
    version: "v-a",
    content: "line one\nshared line\nline three",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
  });
  await savePatch({
    ...base,
    generatedAt: Date.now(),
    version: "v-b",
    content: "line one changed\nshared line\nbrand new line",
    basis: { failureCount: 0, genealogyCount: 0, conflictCount: 0, toolsFlagged: [], toolsPreferred: [] },
  });

  const { request, app } = await buildHarness();
  const r = await request(app)
    .get(`/api/admin/prompt-patches/diff?workspace=${ws}&from=v-a&to=v-b`);
  assert.equal(r.status, 200);
  assert.equal(r.body.from, "v-a");
  assert.equal(r.body.to, "v-b");
  assert.ok(Array.isArray(r.body.diff));
  const types = new Set(r.body.diff.map((d) => d.type));
  assert.ok(types.has("added"), "diff should contain added entries");
  assert.ok(types.has("removed"), "diff should contain removed entries");
  assert.ok(types.has("unchanged"), "diff should contain unchanged entries");
  const unchanged = r.body.diff.find((d) => d.type === "unchanged");
  assert.equal(unchanged.text, "shared line");
});

test("GET /prompt-patches/diff: unknown version → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .get("/api/admin/prompt-patches/diff?workspace=wsPatchEmpty&from=x&to=y");
  assert.equal(r.status, 404);
});
