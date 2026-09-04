import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { defineConfig } from "@playwright/test";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "ui-walk.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 60_000,
  forbidOnly: true,
  reporter: "list",
  outputDir: join(tmpdir(), "workbuddy-ui-walk-results"),
  preserveOutput: "never",
  use: {
    baseURL: env.UI_WALK_BASE_URL ?? DEFAULT_BASE_URL,
    screenshot: "off",
    video: "off",
    trace: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
