import { test, expect } from "@playwright/test";

test.describe("Conversations API", () => {
  const workspace = "test-e2e-conversations";
  test("POST /api/v1/conversations creates a conversation", async ({ request }) => {
    const res = await request.post("/api/v1/conversations", {
      data: {
        workspace,
        title: "E2E Test Conversation",
        messages: [{ role: "user", content: "Hello" }],
        meta: { source: "e2e" },
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.title).toBe("E2E Test Conversation");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body).toHaveProperty("createdAt");
    expect(body.id).toBeTruthy();
  });

  test("GET /api/v1/conversations lists conversations", async ({ request }) => {
    // Ensure at least one conversation exists
    await request.post("/api/v1/conversations", {
      data: { workspace, title: "List Test" },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/conversations", {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("GET /api/v1/conversations/:id returns a conversation", async ({ request }) => {
    // Create a conversation to fetch
    const createRes = await request.post("/api/v1/conversations", {
      data: { workspace, title: "Fetch Me" },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.get(`/api/v1/conversations/${created.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.title).toBe("Fetch Me");
  });

  test("GET /api/v1/conversations/:id returns 404 for missing id", async ({ request }) => {
    const res = await request.get("/api/v1/conversations/nonexistent-id-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("PUT /api/v1/conversations/:id updates a conversation", async ({ request }) => {
    // Create a conversation to update
    const createRes = await request.post("/api/v1/conversations", {
      data: { workspace, title: "Before Update", messages: [] },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.put(`/api/v1/conversations/${created.id}`, {
      data: {
        workspace,
        title: "After Update",
        messages: [{ role: "user", content: "Updated" }],
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("After Update");
    expect(body.messages).toHaveLength(1);
  });

  test("PUT /api/v1/conversations/:id returns 404 for missing id", async ({ request }) => {
    const res = await request.put("/api/v1/conversations/nonexistent-id-999", {
      data: { workspace, title: "Ghost" },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /api/v1/conversations/:id removes a conversation", async ({ request }) => {
    // Create a conversation to delete
    const createRes = await request.post("/api/v1/conversations", {
      data: { workspace, title: "Delete Me" },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.delete(`/api/v1/conversations/${created.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(204);

    // Verify it is gone
    const getRes = await request.get(`/api/v1/conversations/${created.id}`, {
      params: { workspace },
    });
    expect(getRes.status()).toBe(404);
  });

  test("DELETE /api/v1/conversations/:id returns 404 for missing id", async ({ request }) => {
    const res = await request.delete("/api/v1/conversations/nonexistent-id-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
  });

  test("POST /api/v1/conversations/:id/branch creates a branch", async ({ request }) => {
    // Create a conversation with messages to branch from
    const createRes = await request.post("/api/v1/conversations", {
      data: {
        workspace,
        title: "Branch Source",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
          { role: "user", content: "How are you?" },
        ],
      },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.post(`/api/v1/conversations/${created.id}/branch`, {
      data: {
        workspace,
        atMessageIndex: 1,
        label: "alternate path",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
  });

  test("POST /api/v1/conversations/:id/branch rejects invalid atMessageIndex", async ({ request }) => {
    const createRes = await request.post("/api/v1/conversations", {
      data: { workspace, title: "Branch Bad Index", messages: [{ role: "user", content: "Hi" }] },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.post(`/api/v1/conversations/${created.id}/branch`, {
      data: { workspace, atMessageIndex: -1 },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });
});
