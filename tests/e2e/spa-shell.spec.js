import { test, expect } from "@playwright/test";
import { loginAsTestUser } from "./_helpers.js";

/**
 * SPA shell + command palette coverage.
 *
 * Routing assumption: the shell uses History-API (path) routing — see
 * client/src/router.js (pushState/popstate). Navigating to /app loads the
 * shell; subsequent navigation happens client-side via router.navigate().
 */

test.describe("SPA shell and command palette", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsTestUser(page);
    await page.goto("/app");
    // Shell bootstraps on DOMContentLoaded; wait for the root-level structure.
    await page.locator(".sb-shell").waitFor();
  });

  test("loads header, nav, and main view", async ({ page }) => {
    const header = page.locator('header.sb-header[role="banner"]');
    const nav = page.getByRole("navigation", { name: /primary/i });
    const main = page.locator("#sb-main");

    await expect(header).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(main).toBeVisible();

    // Brand + search button are in the header.
    await expect(page.getByText("SiskelBot", { exact: false }).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /open command palette/i }),
    ).toBeVisible();
  });

  test("Meta+K opens palette, typing filters, Enter navigates", async ({ page }) => {
    // Route that "chat" should land on.
    await page.keyboard.press("Meta+K");

    const palette = page.getByRole("dialog", { name: /command palette/i });
    await expect(palette).toBeVisible();

    const input = palette.locator(".sb-palette-input");
    await input.fill("chat");

    // Filtered results should include "Go to Chat"; top result selected by default.
    const options = palette.getByRole("option");
    await expect(options.first()).toContainText(/go to chat/i);

    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("Meta+/ toggles the inspector", async ({ page }) => {
    const shell = page.locator(".sb-shell");
    const inspector = page.getByRole("complementary", { name: /inspector/i });
    const wasCollapsed = await shell.evaluate((el) =>
      el.classList.contains("is-inspector-collapsed"),
    );

    await page.keyboard.press("Meta+/");

    const nowCollapsed = await shell.evaluate((el) =>
      el.classList.contains("is-inspector-collapsed"),
    );
    expect(nowCollapsed).toBe(!wasCollapsed);
    // Inspector element is always present; visibility toggles via class.
    await expect(inspector).toBeAttached();
  });

  test("Meta+Backslash toggles navigation collapse", async ({ page }) => {
    const shell = page.locator(".sb-shell");
    const wasCollapsed = await shell.evaluate((el) =>
      el.classList.contains("is-nav-collapsed"),
    );

    await page.keyboard.press("Meta+\\");

    const nowCollapsed = await shell.evaluate((el) =>
      el.classList.contains("is-nav-collapsed"),
    );
    expect(nowCollapsed).toBe(!wasCollapsed);
  });

  test("g c chord navigates to /chat", async ({ page }) => {
    // Ensure focus is on the body, not any input (chords ignore typing contexts).
    await page.locator("body").click({ position: { x: 2, y: 2 } });

    await page.keyboard.press("g");
    await page.keyboard.press("c");

    await expect(page).toHaveURL(/\/chat$/);
    const activeNav = page.locator('.sb-nav-link[aria-current="page"]');
    await expect(activeNav).toHaveText(/chat/i);
  });
});
