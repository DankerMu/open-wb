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
    // RTL 等待返回前排空 React Scheduler（#1541）；只挂 web，不进 vitest.shared.mjs。
    setupFiles: ["./test/scheduler-drain-setup.ts"],
    // 单例预算放宽到 15 s（#2008）：CI web 分片比本机慢 4–10 倍，最长单例越过 5 s 缺省，诊断确认不是挂起。
    // 只放宽 web；不加 retry，不改 hookTimeout，server 与 vitest.shared.mjs 不动。
    testTimeout: 15000,
    coverage: {
      // 拷入层（registry 原样拷入的组件）不计覆盖率，依据 ADR-0013；只列这两个目录。
      exclude: ["src/components/ui/**", "src/components/assistant-ui/**"],
    },
  },
});
