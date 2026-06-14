/**
 * Shared helpers for Wave-1 web feature e2e tests.
 *
 * No existing tests in tests/e2e rely on session auth — the test server runs
 * without USER_API_KEYS configured, so `userAuth` falls through to the
 * "anonymous" user. loginAsTestUser is provided as a no-op so specs can call
 * it unconditionally; if the repo adopts session-based test auth later, wire
 * the real login flow here without touching the specs.
 *
 * @param {import("@playwright/test").Page} _page
 */
export async function loginAsTestUser(_page) {
  // No-op: the test server auths anonymously when USER_API_KEYS is unset.
  return { userId: "anonymous" };
}

/**
 * Create an agent session via the HTTP API for tests to target.
 * Returns the created session object (has an `id` field).
 *
 * @param {import("@playwright/test").APIRequestContext} request
 * @param {{ workspace?: string, title?: string, planSummary?: string }} [opts]
 */
export async function createAgentSession(request, opts = {}) {
  // Agent sessions require a workspace the caller can access (see getWorkspaceAgentAccess).
  // Anonymous users only have `default` (and any workspace ids from POST /workspaces) in their list.
  const res = await request.post("/api/v1/agent/sessions", {
    data: {
      workspace: opts.workspace || "default",
      title: opts.title || "E2E agent run",
      planSummary: opts.planSummary || "Seed session for e2e",
    },
    headers: { "Content-Type": "application/json" },
  });
  if (res.status() !== 201) {
    const body = await res.text().catch(() => "");
    throw new Error(`createAgentSession: expected 201, got ${res.status()}: ${body}`);
  }
  return res.json();
}

/**
 * Mint a replay share token for a given session id. Returns `{ token, url }`.
 *
 * @param {import("@playwright/test").APIRequestContext} request
 * @param {string} sessionId
 */
export async function mintReplayToken(request, sessionId) {
  const res = await request.post(
    `/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/share`,
    {
      data: { ttlMs: 10 * 60 * 1000 },
      headers: { "Content-Type": "application/json" },
    },
  );
  return { status: res.status(), body: res.ok() ? await res.json() : await res.json().catch(() => ({})) };
}
