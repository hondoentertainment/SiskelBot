import { test, expect } from "@playwright/test";

test.describe("Workspace templates API", () => {
  let templateId;

  test("GET /api/workspace-templates lists templates", async ({ request }) => {
    const res = await request.get("/api/workspace-templates");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("_version", 1);
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("POST /api/workspace-templates creates a new template (admin)", async ({
    request,
  }) => {
    const res = await request.post("/api/workspace-templates", {
      data: {
        name: "E2E Test Template",
        description: "Template created by E2E tests",
        config: {
          model: "llama3.2",
          systemPrompt: "You are a helpful assistant.",
          temperature: 0.7,
        },
      },
      headers: {
        "Content-Type": "application/json",
        "x-admin-api-key": process.env.ADMIN_API_KEY || "test-admin-key",
      },
    });
    // Without ADMIN_API_KEY configured, expect 401; otherwise 201.
    if (res.status() === 201) {
      const body = await res.json();
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name", "E2E Test Template");
      templateId = body.id;
    } else {
      expect(res.status()).toBe(401);
      const body = await res.json();
      expect(body.code).toMatch(/ADMIN/);
    }
  });

  test("GET /api/workspace-templates/:id returns template details", async ({
    request,
  }) => {
    if (!templateId) {
      test.skip();
      return;
    }
    const res = await request.get(`/api/workspace-templates/${templateId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id", templateId);
    expect(body).toHaveProperty("name", "E2E Test Template");
    expect(body).toHaveProperty("config");
    expect(body.config).toHaveProperty("model", "llama3.2");
  });

  test("GET /api/workspace-templates/:id returns 404 for unknown template", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/workspace-templates/nonexistent-template-xyz"
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("PUT /api/workspace-templates/:id updates a template (admin)", async ({
    request,
  }) => {
    if (!templateId) {
      test.skip();
      return;
    }
    const res = await request.put(`/api/workspace-templates/${templateId}`, {
      data: {
        name: "E2E Updated Template",
        description: "Updated by E2E test",
        config: {
          model: "llama3.2",
          systemPrompt: "Updated prompt.",
          temperature: 0.5,
        },
      },
      headers: {
        "Content-Type": "application/json",
        "x-admin-api-key": process.env.ADMIN_API_KEY || "test-admin-key",
      },
    });
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("name", "E2E Updated Template");
    } else {
      // Admin not configured
      expect(res.status()).toBe(401);
    }
  });

  test("POST /api/workspace-templates/:id/apply applies template to workspace", async ({
    request,
  }) => {
    if (!templateId) {
      test.skip();
      return;
    }
    const res = await request.post(
      `/api/workspace-templates/${templateId}/apply`,
      {
        data: { workspaceId: "e2e-ws-from-template" },
        headers: { "Content-Type": "application/json" },
      }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok", true);
  });

  test("POST /api/workspace-templates/:id/apply returns 400 without workspaceId", async ({
    request,
  }) => {
    if (!templateId) {
      test.skip();
      return;
    }
    const res = await request.post(
      `/api/workspace-templates/${templateId}/apply`,
      {
        data: {},
        headers: { "Content-Type": "application/json" },
      }
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("POST /api/workspace-templates/:id/apply returns 404 for unknown template", async ({
    request,
  }) => {
    const res = await request.post(
      "/api/workspace-templates/nonexistent-id/apply",
      {
        data: { workspaceId: "e2e-test-ws" },
        headers: { "Content-Type": "application/json" },
      }
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /api/workspace-templates/:id deletes a template (admin)", async ({
    request,
  }) => {
    if (!templateId) {
      test.skip();
      return;
    }
    const res = await request.delete(
      `/api/workspace-templates/${templateId}`,
      {
        headers: {
          "x-admin-api-key": process.env.ADMIN_API_KEY || "test-admin-key",
        },
      }
    );
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("ok", true);

      // Verify it's gone
      const getRes = await request.get(
        `/api/workspace-templates/${templateId}`
      );
      expect(getRes.status()).toBe(404);
    } else {
      // Admin not configured
      expect(res.status()).toBe(401);
    }
  });

  test("DELETE /api/workspace-templates/:id returns 404 for unknown template", async ({
    request,
  }) => {
    const res = await request.delete(
      "/api/workspace-templates/nonexistent-template-xyz",
      {
        headers: {
          "x-admin-api-key": process.env.ADMIN_API_KEY || "test-admin-key",
        },
      }
    );
    // 404 or 401 (admin not configured)
    expect([404, 401]).toContain(res.status());
  });
});
