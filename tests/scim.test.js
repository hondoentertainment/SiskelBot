/**
 * Phase 46.2: SCIM 2.0 provisioning tests.
 *
 * Covers the SCIM library (lib/scim.js), the bearer token middleware
 * (lib/scim-auth.js), and the route module (routes/scim.js) end-to-end
 * via supertest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";

// Isolate storage per test run before importing modules that read STORAGE_PATH.
const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-scim-"));
const origStoragePath = process.env.STORAGE_PATH;
const origStorageBackend = process.env.STORAGE_BACKEND;
const origToken = process.env.SCIM_BEARER_TOKEN;
const origPrev = process.env.SCIM_BEARER_TOKEN_PREVIOUS;
process.env.STORAGE_PATH = tempDir;
delete process.env.STORAGE_BACKEND;
process.env.SCIM_BEARER_TOKEN = "test-scim-bearer-token-1234567890";
delete process.env.SCIM_BEARER_TOKEN_PREVIOUS;

const TOKEN = process.env.SCIM_BEARER_TOKEN;

const {
  SCIM_SCHEMAS,
  createSCIMUser,
  getSCIMUser,
  updateSCIMUser,
  patchSCIMUser,
  deleteSCIMUser,
  listSCIMUsers,
  createSCIMGroup,
  getSCIMGroup,
  patchSCIMGroup,
  deleteSCIMGroup,
  listSCIMGroups,
  toSCIMUser,
  fromSCIMUser,
  parseSCIMFilter,
  _resetSCIMForTesting,
} = await import("../lib/scim.js");

const { validateSCIMToken, scimErrorBody } = await import("../lib/scim-auth.js");
const { mountScimRoutes } = await import("../routes/scim.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (origStoragePath !== undefined) process.env.STORAGE_PATH = origStoragePath;
  else delete process.env.STORAGE_PATH;
  if (origStorageBackend !== undefined) process.env.STORAGE_BACKEND = origStorageBackend;
  if (origToken !== undefined) process.env.SCIM_BEARER_TOKEN = origToken;
  else delete process.env.SCIM_BEARER_TOKEN;
  if (origPrev !== undefined) process.env.SCIM_BEARER_TOKEN_PREVIOUS = origPrev;
  else delete process.env.SCIM_BEARER_TOKEN_PREVIOUS;
});

test.beforeEach(async () => {
  await _resetSCIMForTesting();
});

function buildTestApp() {
  const app = express();
  mountScimRoutes(app, {});
  return app;
}

// ─── parseSCIMFilter ────────────────────────────────────────────────────────

test("parseSCIMFilter: eq with quoted string", () => {
  const f = parseSCIMFilter('userName eq "alice"');
  assert.deepEqual(f, { field: "userName", op: "eq", value: "alice" });
});

test("parseSCIMFilter: eq with boolean", () => {
  const f = parseSCIMFilter("active eq true");
  assert.deepEqual(f, { field: "active", op: "eq", value: true });
});

test("parseSCIMFilter: eq with number", () => {
  const f = parseSCIMFilter("count eq 42");
  assert.deepEqual(f, { field: "count", op: "eq", value: 42 });
});

test("parseSCIMFilter: co (contains)", () => {
  const f = parseSCIMFilter('userName co "ali"');
  assert.deepEqual(f, { field: "userName", op: "co", value: "ali" });
});

test("parseSCIMFilter: sw (starts with)", () => {
  const f = parseSCIMFilter('userName sw "al"');
  assert.deepEqual(f, { field: "userName", op: "sw", value: "al" });
});

test("parseSCIMFilter: ew (ends with)", () => {
  const f = parseSCIMFilter('userName ew "ce"');
  assert.deepEqual(f, { field: "userName", op: "ew", value: "ce" });
});

test("parseSCIMFilter: pr (present)", () => {
  const f = parseSCIMFilter("userName pr");
  assert.deepEqual(f, { field: "userName", op: "pr", value: null });
});

test("parseSCIMFilter: gt/ge/lt/le", () => {
  assert.deepEqual(parseSCIMFilter("count gt 5"), { field: "count", op: "gt", value: 5 });
  assert.deepEqual(parseSCIMFilter("count ge 5"), { field: "count", op: "ge", value: 5 });
  assert.deepEqual(parseSCIMFilter("count lt 5"), { field: "count", op: "lt", value: 5 });
  assert.deepEqual(parseSCIMFilter("count le 5"), { field: "count", op: "le", value: 5 });
});

test("parseSCIMFilter: returns null for empty/invalid", () => {
  assert.equal(parseSCIMFilter(""), null);
  assert.equal(parseSCIMFilter(null), null);
  assert.equal(parseSCIMFilter("garbage"), null);
});

// ─── User CRUD via lib ──────────────────────────────────────────────────────

test("createSCIMUser: creates user with id and meta", async () => {
  const user = await createSCIMUser({
    schemas: [SCIM_SCHEMAS.user],
    userName: "alice@example.com",
    name: { givenName: "Alice", familyName: "Anderson" },
    emails: [{ value: "alice@example.com", type: "work", primary: true }],
    active: true,
  });
  assert.ok(user.id);
  assert.ok(user.meta);
  assert.equal(user.meta.resourceType, "User");
  assert.ok(user.meta.created);
  assert.ok(user.meta.lastModified);
  assert.equal(user.userName, "alice@example.com");
  assert.ok(user.schemas.includes(SCIM_SCHEMAS.user));
});

test("createSCIMUser: rejects missing userName", async () => {
  await assert.rejects(() => createSCIMUser({}), /userName is required/);
});

test("createSCIMUser: enforces uniqueness on userName", async () => {
  await createSCIMUser({ userName: "bob@example.com" });
  await assert.rejects(
    () => createSCIMUser({ userName: "bob@example.com" }),
    (err) => err.status === 409 && err.scimType === "uniqueness",
  );
});

test("getSCIMUser: returns user by id", async () => {
  const created = await createSCIMUser({ userName: "carol@example.com" });
  const fetched = await getSCIMUser(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.userName, "carol@example.com");
});

test("getSCIMUser: returns null for unknown id", async () => {
  assert.equal(await getSCIMUser("nonexistent"), null);
});

test("updateSCIMUser: replaces user (PUT semantics)", async () => {
  const created = await createSCIMUser({
    userName: "dave@example.com",
    displayName: "Dave",
  });
  const updated = await updateSCIMUser(created.id, {
    userName: "dave@example.com",
    displayName: "David Smith",
    name: { givenName: "David", familyName: "Smith" },
    active: true,
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.displayName, "David Smith");
  assert.equal(updated.name.givenName, "David");
  // Created timestamp preserved
  assert.equal(updated.meta.created, created.meta.created);
});

test("updateSCIMUser: 404 for unknown id", async () => {
  await assert.rejects(
    () => updateSCIMUser("nonexistent", { userName: "x" }),
    (err) => err.status === 404,
  );
});

test("deleteSCIMUser: removes user", async () => {
  const created = await createSCIMUser({ userName: "eve@example.com" });
  const ok = await deleteSCIMUser(created.id);
  assert.equal(ok, true);
  assert.equal(await getSCIMUser(created.id), null);
});

test("deleteSCIMUser: returns false for unknown id", async () => {
  assert.equal(await deleteSCIMUser("nonexistent"), false);
});

// ─── PATCH operations ───────────────────────────────────────────────────────

test("patchSCIMUser: replace simple attribute", async () => {
  const user = await createSCIMUser({ userName: "frank@example.com", active: true });
  const patched = await patchSCIMUser(user.id, [
    { op: "replace", path: "active", value: false },
  ]);
  assert.equal(patched.active, false);
});

test("patchSCIMUser: replace nested attribute (name.givenName)", async () => {
  const user = await createSCIMUser({
    userName: "grace@example.com",
    name: { givenName: "Grace", familyName: "Hopper" },
  });
  const patched = await patchSCIMUser(user.id, [
    { op: "replace", path: "name.givenName", value: "Gracie" },
  ]);
  assert.equal(patched.name.givenName, "Gracie");
  assert.equal(patched.name.familyName, "Hopper");
});

test("patchSCIMUser: replace without path uses value object", async () => {
  const user = await createSCIMUser({ userName: "henry@example.com", active: true });
  const patched = await patchSCIMUser(user.id, [
    { op: "replace", value: { active: false, displayName: "Henry P" } },
  ]);
  assert.equal(patched.active, false);
  assert.equal(patched.displayName, "Henry P");
});

test("patchSCIMUser: add to multi-valued attribute (emails)", async () => {
  const user = await createSCIMUser({
    userName: "iris@example.com",
    emails: [{ value: "iris@example.com", type: "work", primary: true }],
  });
  const patched = await patchSCIMUser(user.id, [
    { op: "add", path: "emails", value: { value: "iris.home@example.com", type: "home" } },
  ]);
  assert.equal(patched.emails.length, 2);
  assert.ok(patched.emails.find((e) => e.value === "iris.home@example.com"));
});

test("patchSCIMUser: replace filtered multi-valued (emails[type eq \"work\"].value)", async () => {
  const user = await createSCIMUser({
    userName: "jack@example.com",
    emails: [
      { value: "jack@old.com", type: "work", primary: true },
      { value: "jack@home.com", type: "home" },
    ],
  });
  const patched = await patchSCIMUser(user.id, [
    { op: "replace", path: 'emails[type eq "work"].value', value: "jack@new.com" },
  ]);
  const work = patched.emails.find((e) => e.type === "work");
  const home = patched.emails.find((e) => e.type === "home");
  assert.equal(work.value, "jack@new.com");
  assert.equal(home.value, "jack@home.com");
});

test("patchSCIMUser: remove with filter", async () => {
  const user = await createSCIMUser({
    userName: "kate@example.com",
    emails: [
      { value: "kate@work.com", type: "work" },
      { value: "kate@home.com", type: "home" },
    ],
  });
  const patched = await patchSCIMUser(user.id, [
    { op: "remove", path: 'emails[type eq "home"]' },
  ]);
  assert.equal(patched.emails.length, 1);
  assert.equal(patched.emails[0].type, "work");
});

test("patchSCIMUser: 404 for unknown id", async () => {
  await assert.rejects(
    () => patchSCIMUser("nonexistent", [{ op: "replace", path: "active", value: false }]),
    (err) => err.status === 404,
  );
});

// ─── Pagination ─────────────────────────────────────────────────────────────

test("listSCIMUsers: pagination with startIndex and count", async () => {
  for (let i = 0; i < 5; i++) {
    await createSCIMUser({ userName: `user${i}@example.com` });
  }
  const page1 = await listSCIMUsers(null, 1, 2);
  assert.equal(page1.totalResults, 5);
  assert.equal(page1.startIndex, 1);
  assert.equal(page1.itemsPerPage, 2);
  assert.equal(page1.Resources.length, 2);
  assert.ok(page1.schemas.includes(SCIM_SCHEMAS.listResponse));

  const page2 = await listSCIMUsers(null, 3, 2);
  assert.equal(page2.Resources.length, 2);
  assert.equal(page2.startIndex, 3);

  const page3 = await listSCIMUsers(null, 5, 2);
  assert.equal(page3.Resources.length, 1);
});

test("listSCIMUsers: filter by userName eq", async () => {
  await createSCIMUser({ userName: "alpha@example.com" });
  await createSCIMUser({ userName: "beta@example.com" });
  const result = await listSCIMUsers('userName eq "alpha@example.com"', 1, 100);
  assert.equal(result.totalResults, 1);
  assert.equal(result.Resources[0].userName, "alpha@example.com");
});

test("listSCIMUsers: filter by active eq false", async () => {
  await createSCIMUser({ userName: "active1@example.com", active: true });
  await createSCIMUser({ userName: "inactive1@example.com", active: false });
  const result = await listSCIMUsers("active eq false", 1, 100);
  assert.equal(result.totalResults, 1);
  assert.equal(result.Resources[0].userName, "inactive1@example.com");
});

// ─── Group CRUD ─────────────────────────────────────────────────────────────

test("createSCIMGroup: creates group with id and meta", async () => {
  const group = await createSCIMGroup({
    schemas: [SCIM_SCHEMAS.group],
    displayName: "Engineering",
    members: [{ value: "user-1", display: "alice" }],
  });
  assert.ok(group.id);
  assert.equal(group.meta.resourceType, "Group");
  assert.equal(group.displayName, "Engineering");
  assert.equal(group.members.length, 1);
});

test("createSCIMGroup: rejects missing displayName", async () => {
  await assert.rejects(() => createSCIMGroup({}), /displayName is required/);
});

test("createSCIMGroup: enforces uniqueness on displayName", async () => {
  await createSCIMGroup({ displayName: "DupeGroup" });
  await assert.rejects(
    () => createSCIMGroup({ displayName: "DupeGroup" }),
    (err) => err.status === 409,
  );
});

test("patchSCIMGroup: add member", async () => {
  const group = await createSCIMGroup({ displayName: "Members1", members: [] });
  const patched = await patchSCIMGroup(group.id, [
    { op: "add", path: "members", value: { value: "user-2", display: "bob" } },
  ]);
  assert.equal(patched.members.length, 1);
  assert.equal(patched.members[0].value, "user-2");
});

test("patchSCIMGroup: remove member by filter", async () => {
  const group = await createSCIMGroup({
    displayName: "Members2",
    members: [
      { value: "user-1", display: "alice" },
      { value: "user-2", display: "bob" },
    ],
  });
  const patched = await patchSCIMGroup(group.id, [
    { op: "remove", path: 'members[value eq "user-1"]' },
  ]);
  assert.equal(patched.members.length, 1);
  assert.equal(patched.members[0].value, "user-2");
});

test("deleteSCIMGroup: removes group", async () => {
  const group = await createSCIMGroup({ displayName: "ToDelete" });
  assert.equal(await deleteSCIMGroup(group.id), true);
  assert.equal(await getSCIMGroup(group.id), null);
});

test("listSCIMGroups: filter and pagination", async () => {
  await createSCIMGroup({ displayName: "Alpha" });
  await createSCIMGroup({ displayName: "Beta" });
  await createSCIMGroup({ displayName: "Gamma" });
  const all = await listSCIMGroups(null, 1, 100);
  assert.equal(all.totalResults, 3);
  const filtered = await listSCIMGroups('displayName eq "Beta"', 1, 100);
  assert.equal(filtered.totalResults, 1);
  assert.equal(filtered.Resources[0].displayName, "Beta");
});

// ─── Conversion helpers ─────────────────────────────────────────────────────

test("toSCIMUser: converts local user", () => {
  const local = {
    userId: "u-123",
    email: "lara@example.com",
    fullName: "Lara Croft",
    givenName: "Lara",
    familyName: "Croft",
    active: true,
  };
  const scim = toSCIMUser(local);
  assert.ok(scim.id);
  assert.ok(scim.schemas.includes(SCIM_SCHEMAS.user));
  assert.equal(scim.userName, "lara@example.com");
  assert.equal(scim.name.givenName, "Lara");
  assert.equal(scim.name.familyName, "Croft");
  assert.equal(scim.emails[0].value, "lara@example.com");
  assert.equal(scim.emails[0].primary, true);
  assert.equal(scim.active, true);
  assert.equal(scim.meta.resourceType, "User");
});

test("fromSCIMUser: converts SCIM to local shape", () => {
  const scim = {
    id: "scim-1",
    externalId: "ext-1",
    userName: "mike@example.com",
    name: { givenName: "Mike", familyName: "Wazowski", formatted: "Mike Wazowski" },
    displayName: "Mike Wazowski",
    emails: [{ value: "mike@example.com", type: "work", primary: true }],
    active: true,
    meta: { created: "2024-01-01T00:00:00Z", lastModified: "2024-01-02T00:00:00Z" },
  };
  const local = fromSCIMUser(scim);
  assert.equal(local.id, "scim-1");
  assert.equal(local.userId, "ext-1");
  assert.equal(local.userName, "mike@example.com");
  assert.equal(local.email, "mike@example.com");
  assert.equal(local.givenName, "Mike");
  assert.equal(local.familyName, "Wazowski");
  assert.equal(local.fullName, "Mike Wazowski");
  assert.equal(local.active, true);
  assert.equal(local.createdAt, "2024-01-01T00:00:00Z");
});

test("round-trip: toSCIMUser then fromSCIMUser preserves identity", () => {
  const local = {
    userId: "u-rt",
    email: "rt@example.com",
    givenName: "Round",
    familyName: "Trip",
    fullName: "Round Trip",
    active: true,
  };
  const scim = toSCIMUser(local);
  const back = fromSCIMUser(scim);
  assert.equal(back.email, local.email);
  assert.equal(back.givenName, local.givenName);
  assert.equal(back.familyName, local.familyName);
  assert.equal(back.active, local.active);
});

// ─── Bearer token auth ──────────────────────────────────────────────────────

test("validateSCIMToken: accepts correct bearer token", () => {
  const req = { headers: { authorization: `Bearer ${TOKEN}` } };
  const result = validateSCIMToken(req);
  assert.equal(result.ok, true);
});

test("validateSCIMToken: rejects wrong token", () => {
  const req = { headers: { authorization: "Bearer wrong-token" } };
  const result = validateSCIMToken(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "INVALID_TOKEN");
});

test("validateSCIMToken: rejects missing header", () => {
  const result = validateSCIMToken({ headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("validateSCIMToken: 503 when not configured", () => {
  delete process.env.SCIM_BEARER_TOKEN;
  delete process.env.SCIM_BEARER_TOKEN_PREVIOUS;
  try {
    const result = validateSCIMToken({ headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "SCIM_NOT_CONFIGURED");
  } finally {
    process.env.SCIM_BEARER_TOKEN = TOKEN;
  }
});

test("validateSCIMToken: accepts previous token with deprecated flag", () => {
  process.env.SCIM_BEARER_TOKEN_PREVIOUS = "old-token-xxxxxxxxxxxxxxxxxxx";
  try {
    const result = validateSCIMToken({ headers: { authorization: "Bearer old-token-xxxxxxxxxxxxxxxxxxx" } });
    assert.equal(result.ok, true);
    assert.equal(result.deprecated, true);
  } finally {
    delete process.env.SCIM_BEARER_TOKEN_PREVIOUS;
  }
});

test("scimErrorBody: includes SCIM error schema", () => {
  const body = scimErrorBody(404, "Not found");
  assert.ok(body.schemas.includes(SCIM_SCHEMAS.error));
  assert.equal(body.status, "404");
  assert.equal(body.detail, "Not found");
});

// ─── Route module integration tests ─────────────────────────────────────────

test("GET /scim/v2/ServiceProviderConfig: returns config", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/ServiceProviderConfig")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/scim\+json/);
  assert.ok(res.body.schemas.includes(SCIM_SCHEMAS.serviceProviderConfig));
  assert.equal(res.body.patch.supported, true);
  assert.equal(res.body.filter.supported, true);
});

test("GET /scim/v2/ResourceTypes: lists User and Group", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/ResourceTypes")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalResults, 2);
  assert.ok(res.body.Resources.find((r) => r.id === "User"));
  assert.ok(res.body.Resources.find((r) => r.id === "Group"));
});

test("GET /scim/v2/Schemas: lists schemas", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/Schemas")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.totalResults >= 2);
});

test("GET without bearer token: returns 401", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/scim/v2/ServiceProviderConfig");
  assert.equal(res.status, 401);
  assert.match(res.headers["content-type"], /application\/scim\+json/);
  assert.ok(res.body.schemas.includes(SCIM_SCHEMAS.error));
});

test("GET with wrong bearer token: returns 401", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/Users")
    .set("Authorization", "Bearer not-the-real-token");
  assert.equal(res.status, 401);
  assert.equal(res.body.detail, "Invalid SCIM bearer token");
});

test("POST /scim/v2/Users: creates user with application/scim+json", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .post("/scim/v2/Users")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        schemas: [SCIM_SCHEMAS.user],
        userName: "route-alice@example.com",
        name: { givenName: "Alice", familyName: "Route" },
        emails: [{ value: "route-alice@example.com", type: "work", primary: true }],
        active: true,
      }),
    );
  assert.equal(res.status, 201);
  assert.match(res.headers["content-type"], /application\/scim\+json/);
  assert.ok(res.headers["location"]?.startsWith("/scim/v2/Users/"));
  assert.ok(res.body.id);
  assert.equal(res.body.userName, "route-alice@example.com");
});

test("POST /scim/v2/Users: 409 on duplicate userName", async () => {
  const app = buildTestApp();
  await request(app)
    .post("/scim/v2/Users")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(JSON.stringify({ userName: "dup@example.com" }));
  const res = await request(app)
    .post("/scim/v2/Users")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(JSON.stringify({ userName: "dup@example.com" }));
  assert.equal(res.status, 409);
  assert.equal(res.body.scimType, "uniqueness");
});

test("GET /scim/v2/Users/:id: returns user", async () => {
  const app = buildTestApp();
  const created = await createSCIMUser({ userName: "fetchme@example.com" });
  const res = await request(app)
    .get(`/scim/v2/Users/${created.id}`)
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.id);
});

test("GET /scim/v2/Users/:id: 404 for unknown", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/Users/nonexistent")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 404);
  assert.ok(res.body.schemas.includes(SCIM_SCHEMAS.error));
});

test("GET /scim/v2/Users: filter and pagination", async () => {
  const app = buildTestApp();
  await createSCIMUser({ userName: "page1@example.com" });
  await createSCIMUser({ userName: "page2@example.com" });
  await createSCIMUser({ userName: "page3@example.com" });
  const res = await request(app)
    .get('/scim/v2/Users?filter=userName eq "page2@example.com"')
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalResults, 1);
  assert.equal(res.body.Resources[0].userName, "page2@example.com");
});

test("PUT /scim/v2/Users/:id: replaces user", async () => {
  const app = buildTestApp();
  const created = await createSCIMUser({ userName: "puttable@example.com" });
  const res = await request(app)
    .put(`/scim/v2/Users/${created.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        userName: "puttable@example.com",
        displayName: "Updated Name",
        active: false,
      }),
    );
  assert.equal(res.status, 200);
  assert.equal(res.body.displayName, "Updated Name");
  assert.equal(res.body.active, false);
});

test("PATCH /scim/v2/Users/:id: deactivate user", async () => {
  const app = buildTestApp();
  const created = await createSCIMUser({ userName: "deactivate@example.com", active: true });
  const res = await request(app)
    .patch(`/scim/v2/Users/${created.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        schemas: [SCIM_SCHEMAS.patchOp],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    );
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
});

test("PATCH /scim/v2/Users/:id: missing Operations returns 400", async () => {
  const app = buildTestApp();
  const created = await createSCIMUser({ userName: "patch-bad@example.com" });
  const res = await request(app)
    .patch(`/scim/v2/Users/${created.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(JSON.stringify({}));
  assert.equal(res.status, 400);
  assert.equal(res.body.scimType, "invalidSyntax");
});

test("DELETE /scim/v2/Users/:id: returns 204", async () => {
  const app = buildTestApp();
  const created = await createSCIMUser({ userName: "deleteme@example.com" });
  const res = await request(app)
    .delete(`/scim/v2/Users/${created.id}`)
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 204);
  assert.equal(await getSCIMUser(created.id), null);
});

test("DELETE /scim/v2/Users/:id: 404 for unknown id", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .delete("/scim/v2/Users/nonexistent")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 404);
});

test("POST /scim/v2/Groups: creates a group", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .post("/scim/v2/Groups")
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        schemas: [SCIM_SCHEMAS.group],
        displayName: "EngineeringRoute",
        members: [{ value: "user-1", display: "alice" }],
      }),
    );
  assert.equal(res.status, 201);
  assert.equal(res.body.displayName, "EngineeringRoute");
  assert.equal(res.body.members.length, 1);
});

test("PATCH /scim/v2/Groups/:id: add and remove members", async () => {
  const app = buildTestApp();
  const group = await createSCIMGroup({ displayName: "RouteMembers", members: [] });

  // Add member
  const addRes = await request(app)
    .patch(`/scim/v2/Groups/${group.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        schemas: [SCIM_SCHEMAS.patchOp],
        Operations: [
          { op: "add", path: "members", value: { value: "user-99", display: "bob" } },
        ],
      }),
    );
  assert.equal(addRes.status, 200);
  assert.equal(addRes.body.members.length, 1);

  // Remove member
  const remRes = await request(app)
    .patch(`/scim/v2/Groups/${group.id}`)
    .set("Authorization", `Bearer ${TOKEN}`)
    .set("Content-Type", "application/scim+json")
    .send(
      JSON.stringify({
        schemas: [SCIM_SCHEMAS.patchOp],
        Operations: [{ op: "remove", path: 'members[value eq "user-99"]' }],
      }),
    );
  assert.equal(remRes.status, 200);
  assert.equal(remRes.body.members.length, 0);
});

test("DELETE /scim/v2/Groups/:id: returns 204", async () => {
  const app = buildTestApp();
  const group = await createSCIMGroup({ displayName: "ToDeleteRoute" });
  const res = await request(app)
    .delete(`/scim/v2/Groups/${group.id}`)
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 204);
  assert.equal(await getSCIMGroup(group.id), null);
});

// ─── SCIM schema compliance smoke tests ─────────────────────────────────────

test("schema compliance: ListResponse has required fields", async () => {
  const app = buildTestApp();
  await createSCIMUser({ userName: "schema1@example.com" });
  const res = await request(app)
    .get("/scim/v2/Users")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.schemas));
  assert.ok(res.body.schemas.includes(SCIM_SCHEMAS.listResponse));
  assert.equal(typeof res.body.totalResults, "number");
  assert.equal(typeof res.body.startIndex, "number");
  assert.equal(typeof res.body.itemsPerPage, "number");
  assert.ok(Array.isArray(res.body.Resources));
});

test("schema compliance: User resource has schemas, id, meta, userName", async () => {
  const user = await createSCIMUser({ userName: "schema2@example.com" });
  assert.ok(Array.isArray(user.schemas));
  assert.ok(user.schemas.includes(SCIM_SCHEMAS.user));
  assert.equal(typeof user.id, "string");
  assert.ok(user.meta);
  assert.equal(user.meta.resourceType, "User");
  assert.ok(user.meta.location.includes(user.id));
  assert.equal(typeof user.userName, "string");
});

test("schema compliance: Error response has schemas, status, detail", async () => {
  const app = buildTestApp();
  const res = await request(app)
    .get("/scim/v2/Users/nonexistent")
    .set("Authorization", `Bearer ${TOKEN}`);
  assert.equal(res.status, 404);
  assert.ok(res.body.schemas.includes(SCIM_SCHEMAS.error));
  assert.equal(res.body.status, "404");
  assert.equal(typeof res.body.detail, "string");
});
