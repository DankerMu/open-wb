## ADDED Requirements

### Requirement: 共享 Vitest 配置的 native ESM 边界
server 与 web SHALL 通过逐字相同的完整相对 specifier `../vitest.shared.mjs` 消费唯一 tracked 根共享配置；该文件 SHALL 以 `.mjs` 自描述为 ESM，不依赖根 `package.json` 的 module type，不得保留 `.ts`/`.js` sibling、无扩展名 import、wrapper、fallback 或 warning suppression。共享配置 SHALL 继续使用 V8 coverage provider、include `src/**/*.{ts,tsx}`，且 lines/functions/branches/statements thresholds 各为 80；web SHALL 只在共享配置之上继续叠加 `environment: jsdom` 与 `e2e/**` exclusion。Makefile lint/fmt source list 与 `biome.json` 根级 include SHALL 指向同一 exact `.mjs` 文件并实际让 Biome 处理它；CI 的既有 Biome 命令、workspace test scripts、产品代码、依赖/lockfile及 Vite/Vitest versions SHALL 保持不变。

#### Scenario: 默认 loader 保持完整验证命令面
- **WHEN** 在 clean checkout 执行 `make check`
- **THEN** server 与 web 均实际执行全部 Vitest tests 和 V8 coverage，四项全局阈值均保持 80%，web tests 在 jsdom 中运行且不发现 `e2e/**`
- **AND** 输出不含 native config loader incompatibility warning、CommonJS shared-config warning 或 module-resolution error

#### Scenario: native loader 对两个 workspace 均真实执行
- **WHEN** 分别执行 `npm exec --workspace @workbuddy/server -- vitest run --coverage --configLoader native` 与 `npm exec --workspace @workbuddy/web -- vitest run --coverage --configLoader native`
- **THEN** 两条命令均解析 tracked `vitest.shared.mjs`、实际运行各自 tests 并生成 V8 coverage summary，退出码为 0
- **AND** 不得以只加载 config、无测试、跳过 coverage 或隐藏 loader warning 充当成功证据

#### Scenario: 文件身份与 consumer 不得漂移
- **WHEN** 共享文件缺失/重命名、旧 `.ts` 或生成 `.js` sibling 被恢复、任一 workspace import 改为无扩展名或不同路径、Makefile source list / `biome.json` root include 不再指向唯一 `.mjs`，或根 package-wide ESM / warning-ignore 配置被加入
- **THEN** fixture inspection、Biome 或默认/native loader 验证非零，不能由 bundle loader 转译、stale artifact、fallback、lint exclusion 或输出过滤假绿
