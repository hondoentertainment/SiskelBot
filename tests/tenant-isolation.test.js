/**
 * Tenant isolation regression test.
 *
 * Provisions two distinct users (user_a, user_b) with separate API keys via
 * USER_API_KEYS, gives each a private workspace with a UUID id, then verifies
 * that user_b cannot read, list, modify, or delete resources owned by user_a
 * across multiple resource types.
 *
 * Resources covered:
 *   - workspaces        (routes/workspaces.js — full isolation enforced)
 *   - workspace export  (routes/workspaces.js — getWorkspaceAgentAccess gate)
 *   - workspace delete  (routes/workspaces.js — getWorkspaceAgentAccess gate)
 *   - agent sessions    (routes/agent-sessions.js — getWorkspaceAgentAccess gate)
 *   - smuggled headers  (X-Workspace-Id cannot bypass user scoping on /workspaces)
 *
 * Bootstraps the full server.js so all middleware, route mounting, and storage
 * wiring runs the same way as production.
 *
 * Known isolation gaps that are documented as `todo` and intentionally NOT
 * asserted here. Fix the routes first, then convert the todos into asserting
 * tests:
 *   - routes/conversations.js: never invokes userAuth and never passes
 *     req.userId to storage, so all conversations live under a single shared
 *     "anonymous" tenant keyed only by workspace id.
 *   - routes/memory.js: same shape — no userAuth on any handler, falls back to
 *     `req.userId || "anonymous"` so two distinct USER_API_KEYS users share
 *     the same memory store.
 *   - routes/knowledge.js /context POST/PUT/DELETE/:id GET: do not pass
 *     req.userId to storage. POST writes under "anonymous", GET (list) reads
 *     from req.userId — so a user cannot even see the doc they just created.
 *     This both is broken and leaks across tenants.
 *
 * See the trailing `it.todo` block for the canonical list and references.
 */
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

import { _resetForTesting as resetAuthCache } from "../lib/auth.js";
import { _resetApiKeysCacheForTesting as resetApiKeysCache } from "../lib/api-keys.js";

const USER_A_KEY = "tenant-a-key";
const USER_B_KEY = "tenant-b-key";
const USER_A_ID = "tenant_user_a";
const USER_B_ID = "tenant_user_b";

let app;
let storageDir;
let envBackup;
let workspaceA;
let workspaceB;

const created = {
  sessionId: null,
};

function withKey(req, key) {
  return req.set("Authorization", `Bearer ${key}`);
}

before(async () => {
  envBackup = { ...process.env };
  storageDir = mkdtempSync(join(tmpdir(), "tenant-isolation-"));
  Object.assign(process.env, {
    STORAGE_PATH: storageDir,
    BACKEND: "ollama",
    // The env parser splits the whole string on commas first, so we cannot
    // include multi-scope entries (a:b:read,write would split). The simple
    // "key:userId" form yields the default scopes (read, write).
    USER_API_KEYS: `${USER_A_KEY}:${USER_A_ID},${USER_B_KEY}:${USER_B_ID}`,
    NODE_ENV: "test",
    AGENT_SESSION_API: "1",
    DISABLE_SECURITY_HEADERS: "1",
    SESSION_SECRET: "tenant-isolation-test-secret",
    VERCEL: "1",
    RATE_LIMIT_MAX: "10000",
    STORAGE_RATE_LIMIT_MAX: "10000",
  });

  resetAuthCache();
  resetApiKeysCache();

  const moduleUrl = new URL(`../server.js?tenant-iso=${Date.now()}${Math.random()}`, import.meta.url);
  const mod = await import(moduleUrl.href);
  app = mod.default;

  // Each user creates their own personal workspace. UUIDs prevent collision.
  const createA = await withKey(request(app).post("/api/v1/workspaces"), USER_A_KEY).send({ name: "workspace_a" });
  assert.equal(createA.status, 201, `user_a workspace create: ${createA.status} ${JSON.stringify(createA.body)}`);
  workspaceA = createA.body.id;
  assert.ok(workspaceA, "workspace_a id must be set");

  const createB = await withKey(request(app).post("/api/v1/workspaces"), USER_B_KEY).send({ name: "workspace_b" });
  assert.equal(createB.status, 201, `user_b workspace create: ${createB.status} ${JSON.stringify(createB.body)}`);
  workspaceB = createB.body.id;
  assert.ok(workspaceB, "workspace_b id must be set");
  assert.notEqual(workspaceA, workspaceB, "workspaces must have distinct ids");
});

after(() => {
  process.env = envBackup;
  resetAuthCache();
  resetApiKeysCache();
  try {
    rmSync(storageDir, { recursive: true, force: true });
  } catch {
    /* best effort cleanup */
  }
});

describe("tenant isolation", () => {
  describe("workspaces", () => {
    test("user_a sees only its own workspaces", async () => {
      const res = await withKey(request(app).get("/api/v1/workspaces"), USER_A_KEY);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      const ids = res.body.items.map((w) => w.id);
      assert.ok(ids.includes(workspaceA), "user_a should see workspace_a");
      assert.ok(!ids.includes(workspaceB), `user_a must NOT see workspace_b; got: ${JSON.stringify(ids)}`);
    });

    test("user_b sees only its own workspaces", async () => {
      const res = await withKey(request(app).get("/api/v1/workspaces"), USER_B_KEY);
      assert.equal(res.status, 200);
      const ids = res.body.items.map((w) => w.id);
      assert.ok(ids.includes(workspaceB), "user_b should see workspace_b");
      assert.ok(!ids.includes(workspaceA), `user_b must NOT see workspace_a; got: ${JSON.stringify(ids)}`);
    });

    test("an unauthenticated caller cannot list workspaces", async () => {
      const res = await request(app).get("/api/v1/workspaces");
      assert.equal(res.status, 401, `expected 401, got ${res.status}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("user_b cannot export user_a's workspace bundle", async () => {
      const res = await withKey(
        request(app).get(`/api/v1/workspaces/${workspaceA}/export`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot delete user_a's workspace", async () => {
      const res = await withKey(
        request(app).delete(`/api/v1/workspaces/${workspaceA}?confirm=DELETE`),
        USER_B_KEY,
      );
      // Either 403 (forbidden) or 400 (not in user_b's list) is acceptable.
      assert.ok(res.status === 403 || res.status === 400, `expected 4xx, got ${res.status}`);
      assert.notEqual(res.status, 204, "delete must not have succeeded");

      // Verify user_a's workspace still exists.
      const stillThere = await withKey(request(app).get("/api/v1/workspaces"), USER_A_KEY);
      const ids = stillThere.body.items.map((w) => w.id);
      assert.ok(ids.includes(workspaceA), "workspace_a must still exist after attempted cross-tenant delete");
    });
  });

  describe("agent sessions", () => {
    test("user_a creates an agent session in workspace_a", async () => {
      const res = await withKey(request(app).post("/api/v1/agent/sessions"), USER_A_KEY).send({
        workspace: workspaceA,
        title: "user_a-session",
      });
      assert.equal(res.status, 201, `create agent session: ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(res.body.id);
      created.sessionId = res.body.id;
    });

    test("user_a can read its own agent session", async () => {
      const res = await withKey(
        request(app).get(`/api/v1/agent/sessions/${created.sessionId}`),
        USER_A_KEY,
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.id, created.sessionId);
    });

    test("user_b cannot create an agent session in workspace_a", async () => {
      const res = await withKey(request(app).post("/api/v1/agent/sessions"), USER_B_KEY).send({
        workspace: workspaceA,
        title: "user_b-session",
      });
      assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot list workspace_a's agent sessions", async () => {
      const res = await withKey(
        request(app).get(`/api/v1/agent/sessions?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot get user_a's agent session by id", async () => {
      const res = await withKey(
        request(app).get(`/api/v1/agent/sessions/${created.sessionId}`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot pause user_a's agent session", async () => {
      const res = await withKey(
        request(app).post(`/api/v1/agent/sessions/${created.sessionId}/pause`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot resume user_a's agent session", async () => {
      const res = await withKey(
        request(app).post(`/api/v1/agent/sessions/${created.sessionId}/resume`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("user_b cannot cancel user_a's agent session", async () => {
      const res = await withKey(
        request(app).post(`/api/v1/agent/sessions/${created.sessionId}/cancel`),
        USER_B_KEY,
      );
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN");
    });

    test("agent sessions: 404 for unknown session id (no existence leak)", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await withKey(
        request(app).get(`/api/v1/agent/sessions/${fakeId}`),
        USER_B_KEY,
      );
      assert.equal(res.status, 404);
      assert.equal(res.body.code, "NOT_FOUND");
    });

    test("user_a's session is still present and untouched after user_b's attempts", async () => {
      const res = await withKey(
        request(app).get(`/api/v1/agent/sessions/${created.sessionId}`),
        USER_A_KEY,
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.id, created.sessionId);
      // status should still be "running" — user_b's pause/cancel must not have applied.
      assert.equal(res.body.status, "running");
    });
  });

  describe("smuggled workspace ids", () => {
    test("user_b cannot smuggle workspace_a id via X-Workspace-Id header on /workspaces list", async () => {
      const res = await withKey(
        request(app).get("/api/v1/workspaces").set("X-Workspace-Id", workspaceA),
        USER_B_KEY,
      );
      assert.equal(res.status, 200);
      const ids = res.body.items.map((w) => w.id);
      assert.ok(!ids.includes(workspaceA), "header-supplied workspace id must not bypass user scoping");
    });

    test("user_b cannot smuggle workspace_a id via X-User-Id header", async () => {
      const res = await withKey(
        request(app).get("/api/v1/workspaces").set("X-User-Id", USER_A_ID),
        USER_B_KEY,
      );
      assert.equal(res.status, 200);
      const ids = res.body.items.map((w) => w.id);
      assert.ok(!ids.includes(workspaceA), "header-supplied user id must not override authenticated user");
    });
  });

  /**
   * Documented isolation gaps that block adding passing tests today.
   *
   * These are TODO entries in the test runner so they show up in CI output and
   * block the merger from accidentally claiming tenant isolation is fully
   * covered. Fix the underlying routes first; then drop the `todo` flag and
   * implement an assertion that user_b cannot read user_a's data.
   */
  describe("conversations", () => {
    test("an unauthenticated caller cannot list conversations", async () => {
      const res = await request(app).get(`/api/v1/conversations?workspace=${workspaceA}`);
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("an unauthenticated caller cannot create a conversation", async () => {
      const res = await request(app)
        .post("/api/v1/conversations")
        .send({ workspace: workspaceA, title: "anon", messages: [] });
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("user_a creates a conversation in workspace_a; user_b cannot see it", async () => {
      const create = await withKey(request(app).post("/api/v1/conversations"), USER_A_KEY).send({
        workspace: workspaceA,
        title: "user_a-conv",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(create.status, 201, `create conv: ${create.status} ${JSON.stringify(create.body)}`);
      const convId = create.body.id;
      assert.ok(convId, "conversation id must be set");

      // user_a sees their own conversation in their list
      const listA = await withKey(
        request(app).get(`/api/v1/conversations?workspace=${workspaceA}`),
        USER_A_KEY,
      );
      assert.equal(listA.status, 200);
      const idsA = (listA.body.items || []).map((c) => c.id);
      assert.ok(idsA.includes(convId), "user_a must see their own conversation");

      // user_b sees nothing in workspace_a (different storage namespace)
      const listB = await withKey(
        request(app).get(`/api/v1/conversations?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(listB.status, 200);
      const idsB = (listB.body.items || []).map((c) => c.id);
      assert.ok(
        !idsB.includes(convId),
        `user_b must NOT see user_a's conversation; got: ${JSON.stringify(idsB)}`,
      );

      // user_b cannot GET user_a's conversation by id
      const getB = await withKey(
        request(app).get(`/api/v1/conversations/${convId}?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(getB.status, 404, `expected 404, got ${getB.status}: ${JSON.stringify(getB.body)}`);

      // user_b cannot PUT user_a's conversation by id
      const putB = await withKey(request(app).put(`/api/v1/conversations/${convId}`), USER_B_KEY).send({
        workspace: workspaceA,
        title: "hijacked",
      });
      assert.equal(putB.status, 404, `expected 404, got ${putB.status}: ${JSON.stringify(putB.body)}`);

      // user_b cannot DELETE user_a's conversation by id
      const delB = await withKey(
        request(app).delete(`/api/v1/conversations/${convId}?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(delB.status, 404, `expected 404, got ${delB.status}: ${JSON.stringify(delB.body)}`);

      // user_a's conversation is still intact and unmodified
      const getA = await withKey(
        request(app).get(`/api/v1/conversations/${convId}?workspace=${workspaceA}`),
        USER_A_KEY,
      );
      assert.equal(getA.status, 200);
      assert.equal(getA.body.id, convId);
      assert.equal(getA.body.title, "user_a-conv", "title must not have been hijacked by user_b");
    });
  });

  describe("memory", () => {
    test("an unauthenticated caller cannot list memories", async () => {
      const res = await request(app).get(`/api/v1/memory?workspace=${workspaceA}`);
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("an unauthenticated caller cannot create a memory", async () => {
      const res = await request(app)
        .post("/api/v1/memory")
        .send({ workspace: workspaceA, content: "anonymous memory" });
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("an unauthenticated caller cannot search memories", async () => {
      const res = await request(app).get(`/api/v1/memory/search?workspace=${workspaceA}&q=hello`);
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "AUTH_REQUIRED");
    });

    test("user_a stores a memory in workspace_a; user_b cannot list/recall/forget it", async () => {
      const create = await withKey(request(app).post("/api/v1/memory"), USER_A_KEY).send({
        workspace: workspaceA,
        content: "user_a private memory contents",
        category: "fact",
        importance: 4,
      });
      assert.equal(create.status, 201, `create memory: ${create.status} ${JSON.stringify(create.body)}`);
      const memoryId = create.body.id;
      assert.ok(memoryId, "memory id must be set");

      // user_a sees their own memory in their list
      const listA = await withKey(
        request(app).get(`/api/v1/memory?workspace=${workspaceA}`),
        USER_A_KEY,
      );
      assert.equal(listA.status, 200);
      const idsA = (listA.body.memories || []).map((m) => m.id);
      assert.ok(idsA.includes(memoryId), "user_a must see their own memory");

      // user_b sees nothing in workspace_a (different storage namespace)
      const listB = await withKey(
        request(app).get(`/api/v1/memory?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(listB.status, 200);
      const idsB = (listB.body.memories || []).map((m) => m.id);
      assert.ok(
        !idsB.includes(memoryId),
        `user_b must NOT see user_a's memory; got: ${JSON.stringify(idsB)}`,
      );

      // user_b cannot recall user_a's memory via search
      const searchB = await withKey(
        request(app).get(`/api/v1/memory/search?workspace=${workspaceA}&q=private`),
        USER_B_KEY,
      );
      assert.equal(searchB.status, 200);
      const searchIdsB = (searchB.body.memories || []).map((m) => m.id);
      assert.ok(
        !searchIdsB.includes(memoryId),
        `user_b must NOT recall user_a's memory; got: ${JSON.stringify(searchIdsB)}`,
      );

      // user_b cannot forget user_a's memory
      const delB = await withKey(
        request(app).delete(`/api/v1/memory/${memoryId}?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.notEqual(delB.status, 204, "delete must not have succeeded for user_b");
      assert.ok(
        delB.status === 404 || delB.status === 403,
        `expected 404 or 403, got ${delB.status}: ${JSON.stringify(delB.body)}`,
      );

      // user_a's memory is still intact
      const listAAfter = await withKey(
        request(app).get(`/api/v1/memory?workspace=${workspaceA}`),
        USER_A_KEY,
      );
      assert.equal(listAAfter.status, 200);
      const idsAAfter = (listAAfter.body.memories || []).map((m) => m.id);
      assert.ok(idsAAfter.includes(memoryId), "user_a's memory must survive user_b's attempts");
    });

    test("two USER_API_KEYS users get distinct memory namespaces", async () => {
      // user_a writes to workspace_a, user_b writes to workspace_b. user_b
      // peeking at workspace_a (by guessing its id) must not see user_a's
      // memory because the storage namespace is keyed by req.userId too.
      const createA = await withKey(request(app).post("/api/v1/memory"), USER_A_KEY).send({
        workspace: workspaceA,
        content: "user_a-only namespace memory",
      });
      assert.equal(createA.status, 201);

      const createB = await withKey(request(app).post("/api/v1/memory"), USER_B_KEY).send({
        workspace: workspaceB,
        content: "user_b-only namespace memory",
      });
      assert.equal(createB.status, 201);

      const peek = await withKey(
        request(app).get(`/api/v1/memory?workspace=${workspaceA}`),
        USER_B_KEY,
      );
      assert.equal(peek.status, 200);
      const peekIds = (peek.body.memories || []).map((m) => m.id);
      assert.ok(
        !peekIds.includes(createA.body.id),
        `user_b peeking at workspace_a must not see user_a's memory; got: ${JSON.stringify(peekIds)}`,
      );
    });
  });

  test(
    "TODO: routes/knowledge.js /context CRUD — POST/PUT/DELETE/:id GET drop req.userId",
    { todo: true },
    () => {
      // GET /api/v1/context lists with `storage.listItems("context", workspace, req.userId)`
      // (correct), but POST, PUT /:id, GET /:id, and DELETE /:id all call the
      // storage layer without passing req.userId. The result is that a doc
      // created via POST is stored under "anonymous" and never appears in the
      // owner's list (which is scoped by req.userId), and any other caller
      // that knows the workspace can read/modify/delete it.
      //
      // Fix: pass req.userId (or resolveStorageUserId(...)) to every storage
      // call; the simplest fix is to make all five handlers consistent with
      // the GET-list handler.
    },
  );
});
