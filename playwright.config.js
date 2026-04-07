import { defineConfig } from "@playwright/test";

const PORT = 3847;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // No extra launch options — API tests use request context only
  },
  projects: [
    {
      name: "api",
      testMatch: /\b(health|chat|knowledge|conversations\.api|knowledge\.api|recipes\.api|workspaces\.api|webhooks\.api|mcp\.api)\.spec\.js$/,
      use: {
        // API-only tests — no browser needed
      },
    },
    {
      name: "ui",
      testMatch: /\b(client|admin|eval)\.spec\.js$/,
      use: {
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    command: `BACKEND=ollama PORT=${PORT} node server.js`,
    port: PORT,
    timeout: 15_000,
    reuseExistingServer: !process.env.CI,
    env: {
      BACKEND: "ollama",
      PORT: String(PORT),
      NODE_ENV: "test",
    },
  },
});
