import { test, expect } from "@playwright/test";

test.describe("Recipes API", () => {
  const workspace = "test-e2e-recipes";

  test("POST /api/v1/recipes creates a recipe", async ({ request }) => {
    const res = await request.post("/api/v1/recipes", {
      data: {
        workspace,
        name: "E2E Test Recipe",
        steps: [
          { action: "build", target: "frontend" },
          { action: "deploy", target: "staging" },
        ],
      },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("E2E Test Recipe");
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps).toHaveLength(2);
  });

  test("POST /api/v1/recipes rejects missing name", async ({ request }) => {
    const res = await request.post("/api/v1/recipes", {
      data: { workspace, steps: [] },
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("GET /api/v1/recipes lists recipes", async ({ request }) => {
    // Seed a recipe
    await request.post("/api/v1/recipes", {
      data: { workspace, name: "List Test Recipe", steps: [{ action: "build" }] },
      headers: { "Content-Type": "application/json" },
    });

    const res = await request.get("/api/v1/recipes", {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("GET /api/v1/recipes/:id returns a specific recipe", async ({ request }) => {
    // Create a recipe to fetch
    const createRes = await request.post("/api/v1/recipes", {
      data: { workspace, name: "Fetch This Recipe", steps: [{ action: "test" }] },
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();

    const res = await request.get(`/api/v1/recipes/${created.id}`, {
      params: { workspace },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Fetch This Recipe");
  });

  test("GET /api/v1/recipes/:id returns 404 for missing recipe", async ({ request }) => {
    const res = await request.get("/api/v1/recipes/nonexistent-recipe-999", {
      params: { workspace },
    });

    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
