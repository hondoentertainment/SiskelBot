import { test, expect } from "@playwright/test";

test.describe("Client UI", () => {
  test("loads the main page with expected title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Siskel Bot/);
  });

  test("has a chat container", async ({ page }) => {
    await page.goto("/");
    const chatContainer = page.locator("#chat-container");
    await expect(chatContainer).toBeVisible();
  });

  test("has a message input and send button", async ({ page }) => {
    await page.goto("/");
    const prompt = page.locator("#prompt");
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveAttribute("placeholder", /message/i);

    const sendBtn = page.locator("#send");
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toHaveText(/send/i);
  });

  test("has a settings toggle", async ({ page }) => {
    await page.goto("/");
    const settings = page.locator("#settings-toggle");
    await expect(settings).toBeAttached();
  });

  test("settings panel expands on click", async ({ page }) => {
    await page.goto("/");
    const settingsToggle = page.locator("#settings-toggle summary");
    await settingsToggle.click();
    const settingsPanel = page.locator("#settings-panel");
    await expect(settingsPanel).toBeVisible();
  });
});
