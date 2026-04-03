import { test, expect } from "@playwright/test";

test.describe("Plugin marketplace API", () => {
  let availablePackId;

  test("GET /api/marketplace lists available packs", async ({ request }) => {
    const res = await request.get("/api/marketplace");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("_version", 1);
    expect(body).toHaveProperty("packs");
    expect(Array.isArray(body.packs)).toBe(true);
    // Save first pack id for later tests
    if (body.packs.length > 0) {
      availablePackId = body.packs[0].id;
    }
  });

  test("GET /api/marketplace supports category filter", async ({ request }) => {
    const res = await request.get("/api/marketplace?category=nonexistent-category-xyz");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("packs");
    expect(Array.isArray(body.packs)).toBe(true);
    // Filtering by a nonexistent category should yield zero results
    expect(body.packs.length).toBe(0);
  });

  test("GET /api/marketplace/:packId returns pack details", async ({ request }) => {
    // First get a valid pack id
    const listRes = await request.get("/api/marketplace");
    const { packs } = await listRes.json();
    if (packs.length === 0) {
      test.skip();
      return;
    }
    const packId = packs[0].id;

    const res = await request.get(`/api/marketplace/${packId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id", packId);
    expect(body).toHaveProperty("name");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("description");
  });

  test("GET /api/marketplace/:packId returns 404 for unknown pack", async ({
    request,
  }) => {
    const res = await request.get("/api/marketplace/nonexistent-pack-xyz");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /api/marketplace/:packId/install installs a pack into a workspace", async ({
    request,
  }) => {
    const listRes = await request.get("/api/marketplace");
    const { packs } = await listRes.json();
    if (packs.length === 0) {
      test.skip();
      return;
    }
    const packId = packs[0].id;
    const workspaceId = "e2e-marketplace-ws";

    const res = await request.post(`/api/marketplace/${packId}/install`, {
      data: { workspaceId },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("packId", packId);
    expect(body).toHaveProperty("workspaceId", workspaceId);
  });

  test("GET /api/workspaces/:id/plugins lists installed packs", async ({
    request,
  }) => {
    const workspaceId = "e2e-marketplace-ws";
    const res = await request.get(`/api/workspaces/${workspaceId}/plugins`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("_version", 1);
    expect(body).toHaveProperty("workspaceId", workspaceId);
    expect(body).toHaveProperty("packs");
    expect(Array.isArray(body.packs)).toBe(true);
  });

  test("POST /api/marketplace/:packId/install returns 400 without workspaceId", async ({
    request,
  }) => {
    const listRes = await request.get("/api/marketplace");
    const { packs } = await listRes.json();
    if (packs.length === 0) {
      test.skip();
      return;
    }
    const packId = packs[0].id;

    const res = await request.post(`/api/marketplace/${packId}/install`, {
      data: {},
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("DELETE /api/marketplace/:packId/install uninstalls a pack", async ({
    request,
  }) => {
    const listRes = await request.get("/api/marketplace");
    const { packs } = await listRes.json();
    if (packs.length === 0) {
      test.skip();
      return;
    }
    const packId = packs[0].id;
    const workspaceId = "e2e-marketplace-ws";

    // Ensure installed first
    await request.post(`/api/marketplace/${packId}/install`, {
      data: { workspaceId },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.delete(
      `/api/marketplace/${packId}/install?workspaceId=${workspaceId}`
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("packId", packId);
  });

  test("DELETE /api/marketplace/:packId/install returns 400 without workspaceId", async ({
    request,
  }) => {
    const res = await request.delete("/api/marketplace/some-pack/install");
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });
});
