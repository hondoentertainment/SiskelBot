import { test, expect } from "@playwright/test";

test.describe("Webhooks API", () => {
  const workspace = "test-e2e-webhooks";

  test("POST /api/v1/webhooks registers a webhook", async ({ request }) => {
    const res = await request.post("/api/v1/webhooks", {
      data: {
        workspace,
        url: "https://example.com/webhook",
        events: ["message_sent"],
        secret: "test-secret",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.url).toBe("https://example.com/webhook");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toContain("message_sent");
  });

  test("POST /api/v1/webhooks rejects missing url", async ({ request }) => {
    const res = await request.post("/api/v1/webhooks", {
      data: { workspace, events: ["message_sent"] },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("POST /api/v1/webhooks rejects empty events", async ({ request }) => {
    const res = await request.post("/api/v1/webhooks", {
      data: { workspace, url: "https://example.com/hook", events: [] },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("GET /api/v1/webhooks lists registered webhooks", async ({ request }) => {
    // Ensure at least one webhook exists
    await request.post("/api/v1/webhooks", {
      data: {
        workspace,
        url: "https://example.com/list-hook",
        events: ["plan_created"],
      },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/webhooks", {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("DELETE /api/v1/webhooks/:id removes a webhook", async ({ request }) => {
    // Create a webhook to delete
    const createRes = await request.post("/api/v1/webhooks", {
      data: {
        workspace,
        url: "https://example.com/delete-hook",
        events: ["recipe_executed"],
      },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.delete(`/api/v1/webhooks/${created.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(204);
  });

  test("DELETE /api/v1/webhooks/:id returns 404 for missing webhook", async ({ request }) => {
    const res = await request.delete("/api/v1/webhooks/nonexistent-webhook-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
  });
});
