import { test, expect } from "@playwright/test";

test.describe("Admin dashboard", () => {
  test("loads the admin page with expected title", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveTitle(/Siskel Bot Admin/);
  });

  test("has a header with Admin title", async ({ page }) => {
    await page.goto("/admin");
    const heading = page.locator("header h1");
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(/admin/i);
  });

  test("has a link back to the main client", async ({ page }) => {
    await page.goto("/admin");
    const backLink = page.locator('header a[href="/"]');
    await expect(backLink).toBeAttached();
  });
});
