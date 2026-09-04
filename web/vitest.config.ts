import { mergeConfig } from "vite";
import { configDefaults } from "vitest/config";
import sharedConfig from "../vitest.shared.js";

export default mergeConfig(sharedConfig, {
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
