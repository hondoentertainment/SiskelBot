import { test, expect } from "@playwright/test";
import { loginAsTestUser, createAgentSession } from "./_helpers.js";

/**
 * Agent-run hero view coverage.
 *
 * Routing note: the SPA router (client/src/router.js) registers "/runs/:id"
 * but client/src/app.js currently wires a placeholder loader to that path.
 * The hero view itself lives at client/src/views/agent-run.js and is not yet
 * attached to the router. Until wiring lands, these tests mount the module
 * directly against #sb-main to exercise the pane + footer contract and the
 * EventSource subscription (network only). Flip over to navigation-only
 * assertions once router.register("/runs/:id", agentRunLoader) lands.
 */

async function mountAgentRun(page, sessionId) {
  await page.evaluate(async (id) => {
    const mod = await import("/src/views/agent-run.js");
    const root = document.getElementById("sb-main");
    root.innerHTML = "";
    window.__agentRunHandle = mod.default(root, { sessionId: id });
  }, sessionId);
}

test.describe("Agent run hero view", () => {
  /** @type {string} */
  let sessionId;

  test.beforeAll(async ({ request }) => {
    const session = await createAgentSession(request, {
      title: "Hero view seed",
    });
    sessionId = session.id;
    expect(sessionId).toBeTruthy();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page);
    await page.goto("/app");
    await page.locator(".sb-shell").waitFor();
  });

  test("renders the 4 panes (Plan, Timeline, Artifacts, Approvals)", async ({ page }) => {
    await mountAgentRun(page, sessionId);

    const runRoot = page.locator(`.agent-run[data-session-id="${sessionId}"]`);
    await expect(runRoot).toBeVisible();

    const paneHeads = runRoot.locator(".ar-pane-head");
    await expect(paneHeads).toHaveCount(4);
    await expect(paneHeads.nth(0)).toHaveText("Plan");
    await expect(paneHeads.nth(1)).toHaveText("Timeline");
    await expect(paneHeads.nth(2)).toHaveText("Artifacts");
    await expect(paneHeads.nth(3)).toHaveText("Approvals");
  });

  test("footer exposes Pause, Resume, and Cancel controls", async ({ page }) => {
    await mountAgentRun(page, sessionId);

    const footer = page.locator(".ar-footer");
    await expect(footer).toBeVisible();

    await expect(footer.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(footer.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(footer.getByRole("button", { name: "Cancel" })).toBeVisible();

    // Status pill and iteration counter are present.
    await expect(footer.locator(".ar-pill")).toBeVisible();
    await expect(footer.locator(".ar-stat").filter({ hasText: /iter/i })).toBeVisible();
  });

  test("subscribes to the SSE event stream without throwing", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    const streamRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes(`/api/v1/agent/sessions/${sessionId}/stream`)) {
        streamRequests.push(url);
      }
    });

    await mountAgentRun(page, sessionId);

    // Poll for the EventSource to open its request. If the server does not
    // implement the stream yet, the client still tries once — which is all we
    // assert here (the view subscribes without synchronous error).
    await expect.poll(() => streamRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
  });
});
