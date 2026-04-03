import { test, expect } from "@playwright/test";

test.describe("Conversation branching API", () => {
  let conversationId;

  test.beforeAll(async ({ request }) => {
    // Create a conversation with messages to branch from
    const res = await request.post("/api/conversations", {
      data: {
        title: "Branch test conversation",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
          { role: "assistant", content: "I am fine, thanks." },
        ],
        workspace: "e2e-branching",
      },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    conversationId = body.id;
    expect(conversationId).toBeTruthy();
  });

  test("POST /api/conversations/:id/branch creates a branch at a message index", async ({
    request,
  }) => {
    const res = await request.post(`/api/conversations/${conversationId}/branch`, {
      data: {
        atMessageIndex: 1,
        label: "alternate response",
        workspace: "e2e-branching",
      },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("parentId", conversationId);
    expect(body).toHaveProperty("atMessageIndex", 1);
  });

  test("POST /api/conversations/:id/branch returns 400 for invalid index", async ({
    request,
  }) => {
    const res = await request.post(`/api/conversations/${conversationId}/branch`, {
      data: { atMessageIndex: -1, workspace: "e2e-branching" },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("POST /api/conversations/:id/branch returns 400 for missing index", async ({
    request,
  }) => {
    const res = await request.post(`/api/conversations/${conversationId}/branch`, {
      data: { workspace: "e2e-branching" },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("GET /api/conversations/:id/tree returns tree structure", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/conversations/${conversationId}/tree?workspace=e2e-branching`
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Tree should have the root conversation and its branches
    expect(body).toHaveProperty("id", conversationId);
    expect(body).toHaveProperty("branches");
    expect(Array.isArray(body.branches)).toBe(true);
  });

  test("GET /api/conversations/:id/branches lists branches", async ({
    request,
  }) => {
    const res = await request.get(
      `/api/conversations/${conversationId}/branches?workspace=e2e-branching`
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("branches");
    expect(Array.isArray(body.branches)).toBe(true);
    expect(body.branches.length).toBeGreaterThan(0);
  });

  test("DELETE /api/conversations/branches/:branchId removes a branch", async ({
    request,
  }) => {
    // Create a branch to delete
    const createRes = await request.post(`/api/conversations/${conversationId}/branch`, {
      data: {
        atMessageIndex: 0,
        label: "to-delete",
        workspace: "e2e-branching",
      },
      headers: { "Content-Type": "application/json" },
    });
    expect(createRes.status()).toBe(201);
    const { id: branchId } = await createRes.json();

    // Delete it
    const delRes = await request.delete(
      `/api/conversations/branches/${branchId}?workspace=e2e-branching`
    );
    expect(delRes.status()).toBe(204);

    // Verify it's gone
    const getRes = await request.get(
      `/api/conversations/branches/${branchId}?workspace=e2e-branching`
    );
    expect(getRes.status()).toBe(404);
  });

  test("DELETE /api/conversations/branches/:branchId returns 404 for unknown id", async ({
    request,
  }) => {
    const res = await request.delete(
      `/api/conversations/branches/nonexistent-id?workspace=e2e-branching`
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});
