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
  globalTimeout: 150_000,
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
  // 不用 devices[...] 预设：isMobile/hasTouch/UA 会改变交互语义，这里只要视口与配色。
  projects: [
    {
      name: "desktop-light",
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
      },
    },
    {
      name: "mobile-dark",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
    },
  ],
});
