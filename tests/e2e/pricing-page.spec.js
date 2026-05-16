import { test, expect } from "@playwright/test";

test.describe("Pricing page", () => {
  test("serves pricing.html with plan content", async ({ page }) => {
    await page.goto("/pricing.html");
    await expect(page).toHaveTitle(/Pricing.*Siskel Bot/i);
    await expect(page.locator("h1")).toContainText(/pricing/i);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(".plans")).toBeVisible();
    await expect(page.getByRole("link", { name: /trust/i })).toBeVisible();
  });
});
