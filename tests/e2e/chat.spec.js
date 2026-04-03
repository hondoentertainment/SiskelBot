import { test, expect } from "@playwright/test";

test.describe("Chat completions API", () => {
  test("POST /v1/chat/completions returns SSE stream or error without backend", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: {
        model: "llama3.2",
        messages: [{ role: "user", content: "Say hello" }],
        stream: true,
      },
      headers: { "Content-Type": "application/json" },
    });

    // Without a running Ollama backend, we expect either:
    //   - 502/503/500 (backend unreachable)
    //   - 200 with SSE stream (if backend happens to be up)
    // Both are valid — the important thing is the server doesn't crash.
    const status = res.status();
    expect([200, 500, 502, 503]).toContain(status);

    if (status === 200) {
      const contentType = res.headers()["content-type"] || "";
      expect(contentType).toContain("text/event-stream");
    } else {
      // Error response should be JSON with an error message
      const body = await res.json();
      expect(body).toHaveProperty("error");
    }
  });

  test("POST /v1/chat/completions with missing messages does not crash server", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: { model: "llama3.2" },
      headers: { "Content-Type": "application/json" },
    });

    // Without a running backend the server may return 400 (validation)
    // or 502/500 (backend unreachable before validation). Either way
    // the server must respond — not crash.
    const status = res.status();
    expect([400, 500, 502, 503]).toContain(status);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  test("POST /v1/chat/completions non-streaming returns JSON or error", async ({
    request,
  }) => {
    const res = await request.post("/v1/chat/completions", {
      data: {
        model: "llama3.2",
        messages: [{ role: "user", content: "Say hello" }],
        stream: false,
      },
      headers: { "Content-Type": "application/json" },
    });

    const status = res.status();
    expect([200, 500, 502, 503]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("choices");
    } else {
      const body = await res.json();
      expect(body).toHaveProperty("error");
    }
  });
});
