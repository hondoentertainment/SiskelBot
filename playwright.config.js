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
      testMatch: /\b(health|chat|knowledge|conversations\.api|knowledge\.api|recipes\.api|workspaces\.api|webhooks\.api|mcp\.api|phase63-golden-path)\.spec\.js$/,
      use: {
        // API-only tests — no browser needed
      },
    },
    {
      name: "ui",
      testMatch:
        /\b(client|admin|eval|spa-shell|agent-run|replay-share|pricing-page|landing-page)\.spec\.js$/,
      use: {
        browserName: "chromium",
      },
    },
  ],
  webServer: {
    // Rely on `env` for BACKEND/PORT so this works on Windows and Unix shells.
    command: "node server.js",
    port: PORT,
    timeout: 15_000,
    reuseExistingServer: !process.env.CI,
    env: {
      BACKEND: "ollama",
      PORT: String(PORT),
      NODE_ENV: "test",
      ADMIN_API_KEY: "e2e-admin-key",
    },
  },
});
