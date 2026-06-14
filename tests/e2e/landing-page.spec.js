import { test, expect } from "@playwright/test";

test.describe("Marketing landing", () => {
  test("serves landing.html with hero content", async ({ page }) => {
    await page.goto("/landing.html");
    await expect(page).toHaveTitle(/Siskel Bot/i);
    await expect(page.locator(".hero h1")).toBeVisible();
    await expect(page.getByRole("link", { name: /sign up|pricing|trust/i }).first()).toBeVisible();
  });
});
