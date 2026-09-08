## Why

server 与 web 当前以两种不可由 Node native loader 解析的路径引用根共享 Vitest 配置：server 使用无扩展名 import，web 指向不存在的 `.js` 文件；根配置又位于未声明 ESM 的 package scope。默认 bundle loader 暂时掩盖该不一致，但显式 `--configLoader native` 已在测试与覆盖率启动前失败，Vite 后续默认值切换会直接阻断验证门禁。

## What Changes

- 将根共享 Vitest 配置收敛为单一、显式 ESM 的 `.mjs` 模块，使 Node native loader 可按真实文件路径解析。
- 让 server 与 web 配置都以完整 `.mjs` 扩展名导入同一共享模块，并同步 Makefile lint/fmt 文件清单与 `biome.json` 根级 include。
- 保留 V8 provider、`src/**` include、四项 80% 覆盖率阈值以及 web 的 `jsdom`/`e2e/**` 覆写。
- 用默认 loader 与 native loader 的真实测试/覆盖率运行证明两条 workspace 路径均可执行，不以隐藏兼容警告代替修复。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `verification-harness`: 规定 server/web 共享 Vitest 配置的单一 native-ESM 文件边界、完整 import 身份以及默认/native loader 的测试与覆盖率兼容合同。

## Impact

影响根共享 Vitest 配置文件、`server/vitest.config.ts`、`web/vitest.config.ts`、Makefile lint/fmt source list 与 `biome.json` 的根级 include 身份；不修改 CI 中既有 Biome 命令、根 package 的 `.js` 模块语义或依赖版本，也不改变产品代码、测试行为、覆盖率 provider/include/阈值或 web 环境。
