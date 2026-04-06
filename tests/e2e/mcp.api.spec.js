import { test, expect } from "@playwright/test";

// MCP (Model Context Protocol) endpoints may not be mounted if the MCP
// module is not present. These tests verify the server responds gracefully
// regardless of whether MCP is configured.

test.describe("MCP endpoint", () => {
  test("POST /mcp with initialize method returns a response", async ({ request }) => {
    const res = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1.0.0" },
        },
      },
      headers: { "Content-Type": "application/json" },
    });

    // If MCP is mounted, expect 200 with JSON-RPC response.
    // If not mounted, expect 404.
    const status = res.status();
    expect([200, 404]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("id", 1);
      expect(body).toHaveProperty("result");
      expect(body.result).toHaveProperty("protocolVersion");
      expect(body.result).toHaveProperty("serverInfo");
    }
  });

  test("POST /mcp with tools/list returns available tools", async ({ request }) => {
    const res = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      headers: { "Content-Type": "application/json" },
    });

    const status = res.status();
    expect([200, 404]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("id", 2);
      // Result should have a tools array
      if (body.result) {
        expect(body.result).toHaveProperty("tools");
        expect(Array.isArray(body.result.tools)).toBe(true);
      }
    }
  });

  test("POST /mcp with resources/list returns available resources", async ({ request }) => {
    const res = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {},
      },
      headers: { "Content-Type": "application/json" },
    });

    const status = res.status();
    expect([200, 404]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      expect(body).toHaveProperty("id", 3);
      if (body.result) {
        expect(body.result).toHaveProperty("resources");
        expect(Array.isArray(body.result.resources)).toBe(true);
      }
    }
  });

  test("POST /mcp with invalid method returns error or 404", async ({ request }) => {
    const res = await request.post("/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 4,
        method: "nonexistent/method",
        params: {},
      },
      headers: { "Content-Type": "application/json" },
    });

    const status = res.status();
    // Either 404 (not mounted) or 200 with JSON-RPC error
    expect([200, 400, 404]).toContain(status);

    if (status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("jsonrpc", "2.0");
      // Should have an error field for unknown methods
      if (body.error) {
        expect(body.error).toHaveProperty("code");
        expect(body.error).toHaveProperty("message");
      }
    }
  });
});
