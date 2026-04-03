import { test, expect } from "@playwright/test";

test.describe("Health check endpoints", () => {
  test("GET /health/live returns 200 with ok: true", async ({ request }) => {
    const res = await request.get("/health/live");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("alive");
  });

  test("GET /health/ready returns a valid response", async ({ request }) => {
    const res = await request.get("/health/ready");
    // May be 200 (ready) or 503 (backend unreachable) — both are valid when
    // no real Ollama is running. We just verify the shape.
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.status).toBe("string");
  });

  test("GET /health returns a valid response", async ({ request }) => {
    const res = await request.get("/health");
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty("reachable");
    expect(body).toHaveProperty("backend");
  });
});
