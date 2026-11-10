import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4180",
    channel: process.env.CI ? "chromium" : "msedge",
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4180",
    env: { PORT: "4180" },
    reuseExistingServer: false,
  },
});
