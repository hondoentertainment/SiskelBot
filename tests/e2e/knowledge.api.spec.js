import { test, expect } from "@playwright/test";

test.describe("Knowledge / Context API", () => {
  const workspace = "test-e2e-knowledge";

  test("POST /api/v1/context adds a document", async ({ request }) => {
    const res = await request.post("/api/v1/context", {
      data: {
        workspace,
        title: "Test Document",
        content: "This is test content for the knowledge base.",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.title).toBe("Test Document");
    expect(body).toHaveProperty("createdAt");
  });

  test("GET /api/v1/context lists documents", async ({ request }) => {
    // Seed a document
    await request.post("/api/v1/context", {
      data: { workspace, title: "List Check Doc", content: "Content for listing" },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/context", {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("GET /api/v1/context/:id returns a specific document", async ({ request }) => {
    // Create a document first
    const addRes = await request.post("/api/v1/context", {
      data: { workspace, title: "Get By ID", content: "Specific doc" },
      headers: { "Content-Type": "application/json" },
    });
    const doc = await addRes.json();

    const res = await request.get(`/api/v1/context/${doc.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(doc.id);
    expect(body.title).toBe("Get By ID");
  });

  test("GET /api/v1/context/:id returns 404 for missing document", async ({ request }) => {
    const res = await request.get("/api/v1/context/nonexistent-doc-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /api/v1/context/:id removes a document", async ({ request }) => {
    // Create a document to delete
    const addRes = await request.post("/api/v1/context", {
      data: { workspace, title: "Delete Me Doc", content: "Will be deleted" },
      headers: { "Content-Type": "application/json" },
    });
    const doc = await addRes.json();

    const res = await request.delete(`/api/v1/context/${doc.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(204);

    // Verify it is gone
    const getRes = await request.get(`/api/v1/context/${doc.id}`, {
      params: { workspace },
    });
    expect(getRes.status()).toBe(404);
  });

  test("DELETE /api/v1/context/:id returns 404 for missing document", async ({ request }) => {
    const res = await request.delete("/api/v1/context/nonexistent-doc-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
  });

  test("POST /api/v1/context/sync merges documents and returns merged list", async ({ request }) => {
    const res = await request.post("/api/v1/context/sync", {
      data: {
        workspace,
        items: [
          { id: "sync-doc-1", title: "Sync One", content: "First sync doc" },
          { id: "sync-doc-2", title: "Sync Two", content: "Second sync doc" },
        ],
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    const ids = body.items.map((d) => d.id);
    expect(ids).toContain("sync-doc-1");
    expect(ids).toContain("sync-doc-2");
  });
});
