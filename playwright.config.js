import { defineConfig } from "@playwright/test";

const PORT = process.env.CI ? 3000 : 3847;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // No extra launch options — API tests use request context only
  },
  projects: [
    {
      name: "api",
      testMatch: "**/*.api.spec.js",
      use: {
        // API-only tests — no browser needed
      },
    },
    {
      name: "ui",
      testMatch: "**/*.ui.spec.js",
      use: {
        browserName: "chromium",
      },
    },
    // Legacy test patterns (existing specs without .api./.ui. suffix)
    {
      name: "api-legacy",
      testMatch: /\b(health|chat|knowledge)\.spec\.js$/,
      use: {},
    },
    {
      name: "ui-legacy",
      testMatch: /\b(client|admin|eval)\.spec\.js$/,
      use: {
        browserName: "chromium",
      },
    },
  ],
  ...(process.env.CI
    ? {}
    : {
        webServer: {
          command: `BACKEND=ollama PORT=${PORT} node server.js`,
          port: PORT,
          timeout: 15_000,
          reuseExistingServer: true,
          env: {
            BACKEND: "ollama",
            PORT: String(PORT),
            NODE_ENV: "test",
          },
        },
      }),
});
