import { test, expect } from "@playwright/test";

test.describe("Admin dashboard", () => {
  test("loads the admin page with expected title", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveTitle(/SiskelBot Admin/);
  });

  test("shows login gate with Admin heading when unauthenticated", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("#login-screen")).toBeVisible();
    const heading = page.locator("#login-screen h1");
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(/admin/i);
  });

  test("login screen includes API key field and sign-in", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("#admin-key-input")).toBeVisible();
    await expect(page.locator("#login-btn")).toBeVisible();
  });
});
