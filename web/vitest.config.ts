import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import { configDefaults } from "vitest/config";
import sharedConfig from "../vitest.shared.mjs";

export default mergeConfig(sharedConfig, {
  resolve: {
    // 与 vite.config.ts 同一映射；不直接复用那份配置，免得把 Tailwind 插件带进测试。
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**"],
    coverage: {
      // 拷入层（registry 原样拷入的组件）不计覆盖率，依据 ADR-0013；只列这两个目录。
      exclude: ["src/components/ui/**", "src/components/assistant-ui/**"],
    },
  },
});
