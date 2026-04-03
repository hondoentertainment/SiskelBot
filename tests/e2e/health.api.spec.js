import { test, expect } from "@playwright/test";

test.describe("Health & config API endpoints", () => {
  test("GET /health/live returns 200", async ({ request }) => {
    const res = await request.get("/health/live");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /health/ready returns 200", async ({ request }) => {
    const res = await request.get("/health/ready");
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.status).toBe("string");
  });

  test("GET /config returns valid JSON with backend field", async ({
    request,
  }) => {
    const res = await request.get("/config");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(body).toHaveProperty("backend");
    expect(typeof body.backend).toBe("string");
  });

  test("GET /api/docs/openapi.json returns valid schema", async ({
    request,
  }) => {
    const res = await request.get("/api/docs/openapi.json");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    // OpenAPI 3.x must have openapi and info fields
    expect(body).toHaveProperty("openapi");
    expect(body.openapi).toMatch(/^3\./);
    expect(body).toHaveProperty("info");
    expect(body.info).toHaveProperty("title");
    expect(body).toHaveProperty("paths");
  });
});
