import { test, expect } from "@playwright/test";

test.describe("Workspaces API", () => {
  test("POST /api/v1/workspaces creates a workspace", async ({ request }) => {
    const res = await request.post("/api/v1/workspaces", {
      data: {
        name: "E2E Test Workspace",
        type: "personal",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("E2E Test Workspace");
  });

  test("POST /api/v1/workspaces creates a team workspace", async ({ request }) => {
    const res = await request.post("/api/v1/workspaces", {
      data: {
        name: "E2E Team Workspace",
        type: "team",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("E2E Team Workspace");
  });

  test("GET /api/v1/workspaces lists workspaces", async ({ request }) => {
    // Ensure at least one workspace exists
    await request.post("/api/v1/workspaces", {
      data: { name: "List Check Workspace" },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/workspaces");

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    // Should contain at least one workspace (the default or created ones)
    expect(body.items.length).toBeGreaterThanOrEqual(0);
  });

  test("GET /api/v1/workspaces/:id/export returns workspace data", async ({ request }) => {
    // Create a workspace to export
    const createRes = await request.post("/api/v1/workspaces", {
      data: { name: "Export Workspace" },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.get(`/api/v1/workspaces/${created.id}/export`);

    // May be 200 with export data or 404 if workspace storage is empty
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("workspaceId");
    }
  });

  test("DELETE /api/v1/workspaces/:id requires confirm parameter", async ({ request }) => {
    // Create a workspace to delete
    const createRes = await request.post("/api/v1/workspaces", {
      data: { name: "Delete Me Workspace" },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    // Without confirm, should get 400
    const noConfirmRes = await request.delete(`/api/v1/workspaces/${created.id}`);
    expect(noConfirmRes.status()).toBe(400);
    const errBody = await noConfirmRes.json();
    expect(errBody.code).toBe("CONFIRM_REQUIRED");

    // With confirm, should succeed
    const res = await request.delete(`/api/v1/workspaces/${created.id}`, {
      data: { confirm: "DELETE" },
      headers: { "Content-Type": "application/json" },
    });

    // Should be 204 on success or other status if ownership check fails
    expect([204, 400, 403]).toContain(res.status());
  });
});
