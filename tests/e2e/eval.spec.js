import { test, expect } from "@playwright/test";

test.describe("Eval harness page", () => {
  test("loads the eval page with expected title", async ({ page }) => {
    await page.goto("/eval");
    await expect(page).toHaveTitle(/Siskel Bot Eval Harness/);
  });

  test("has a header with Eval title", async ({ page }) => {
    await page.goto("/eval");
    const heading = page.locator("header h1");
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(/eval/i);
  });

  test("has a link back to the main client", async ({ page }) => {
    await page.goto("/eval");
    const backLink = page.locator('header a[href="/"]');
    await expect(backLink).toBeAttached();
  });
});
