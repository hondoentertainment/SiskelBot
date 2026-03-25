import { test, expect } from "@playwright/test";

test.describe("Knowledge API", () => {
  test("POST /api/v1/knowledge/index indexes a document", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/knowledge/index", {
      data: {
        text: "Playwright is an end-to-end testing framework for web apps.",
        workspace: "test-e2e",
        title: "Playwright intro",
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
  });

  test("POST /api/v1/knowledge/index rejects missing text", async ({
    request,
  }) => {
    const res = await request.post("/api/v1/knowledge/index", {
      data: { workspace: "test-e2e" },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("GET /api/v1/knowledge/search returns results", async ({
    request,
  }) => {
    // First, index a document to ensure there is something to search
    await request.post("/api/v1/knowledge/index", {
      data: {
        text: "SiskelBot uses Express and streams SSE responses to clients.",
        workspace: "test-e2e-search",
        title: "SiskelBot architecture",
      },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/knowledge/search", {
      params: {
        q: "SSE",
        workspace: "test-e2e-search",
      },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("snippets");
    expect(Array.isArray(body.snippets)).toBe(true);
    expect(body.snippets.length).toBeGreaterThan(0);
    // Each snippet should have id, snippet text, and score
    const first = body.snippets[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("snippet");
    expect(first).toHaveProperty("score");
  });

  test("GET /api/v1/knowledge/search with no query returns empty snippets", async ({
    request,
  }) => {
    const res = await request.get("/api/v1/knowledge/search", {
      params: { q: "", workspace: "test-e2e-empty" },
    });

    // Should still return 200 with an empty snippets array
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("snippets");
    expect(Array.isArray(body.snippets)).toBe(true);
  });
});
