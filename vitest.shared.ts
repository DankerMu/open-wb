import { defineConfig } from "vitest/config";

/** server/web 共用的 vitest 配置：覆盖率阈值以 constraints.yaml testing 段为准。 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
