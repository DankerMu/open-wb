## Context

根 `vitest.shared.ts` 使用 ESM import/export，但根 `package.json` 未声明 `type: module`；server 配置以无扩展名引用它，web 配置则引用不存在的 `.js` 路径。Vite 8.2.2 的 bundle loader 暂时转译这些边界并输出 native-loader 不兼容警告；在当前 Node 24.13.1 / Vitest 4.1.11 上，两个显式 native-loader 命令均以 `ERR_MODULE_NOT_FOUND` 在测试启动前退出 1。

Fixture level: expanded
Repair intensity: medium
Project profile: Generic（TypeScript Web 服务 + Python 知识库，多子系统）
Minimal mergeable slice: 原子重命名共享配置、同步两个 workspace import、Makefile source list 与 `biome.json` root include，并用默认/native loader 完整运行两个 workspace 的测试和覆盖率。

## Goals / Non-Goals

**Goals:**
- 为共享 Vitest 配置建立一个 Node 原生可识别、真实存在且只有一个身份的 ESM 文件边界。
- 保证 server/web 默认 loader 与 native loader 均能实际执行测试和覆盖率，而非只加载配置。
- 保持共享 V8 provider、`src/**` include、四项 80% 阈值，以及 web `jsdom` 和 `e2e/**` exclusion。
- 保持根 package 的现有/未来 `.js` 模块解释不变。

**Non-Goals:**
- 不以 `VITE_CONFIG_NATIVE_IGNORE_WARNING` 或日志过滤隐藏警告。
- 不修改产品代码、测试断言、coverage include/provider/threshold，亦不升级 Vite/Vitest/Node。
- 不在根 `package.json` 添加 `type: module`，不增加依赖或 declaration shim。
- 不把本次小型文件身份修复扩展为通用 config-loader 框架。

## Decisions

1. 将 `vitest.shared.ts` 原子重命名为 `vitest.shared.mjs`，保留其纯 JavaScript ESM 内容。`.mjs` 由 Node 文件扩展名直接定义 ESM，不依赖根 package scope。备选根 `type: module` 会改变所有根 `.js` 的解释范围，影响远大于本问题；`.mts` 则仍依赖 loader 对 TypeScript config module 的处理，不是最窄 native boundary。
2. `server/vitest.config.ts` 与 `web/vitest.config.ts` 均使用逐字 `../vitest.shared.mjs`。不保留旧文件、别名、wrapper 或 fallback；git 历史承担回滚，唯一真实文件避免 bundle/native loader 解析不同身份。
3. Makefile lint/fmt source list同步为 `vitest.shared.mjs`，并将 `biome.json` 根级 `*.ts` include 原子替换为 exact `vitest.shared.mjs`。当前根目录唯一命中 `*.ts` 的 tracked 文件就是待重命名共享配置，故无需保留无消费者的泛化 glob；CI 中受现有 oracle 约束的 `npx biome check server web scripts` 保持不变。默认 `make check` 继续通过 workspace 现有 `test` scripts 使用默认 loader，以证明正常命令面无兼容警告；两条显式 `--configLoader native` 命令分别验证 native path。不给默认 script 强制加 native 参数，否则会绕开默认 loader 验收并重复定义命令面。
4. 运行证据必须证明 tests 与 V8 coverage 实际完成：server 和 web 均有测试文件计数与 coverage 表，且四项 threshold 仍达标；仅 `vitest --configLoader native --help` 或只加载 config 不算通过。

## Risk Packs Considered

- Public API / CLI / script entry: selected — `make check` 与两个 workspace Vitest 命令是开发/CI 公共命令面。
- Config / project setup: selected — 根共享配置的文件身份和 import specifier 是核心边界。
- Schema / columns / units / field names: selected — coverage provider/include/四个百分比阈值必须逐项保留。
- Release / packaging / dependency compatibility: selected — Node/Vite native ESM resolution 与 package scope 是失效机制。
- Legacy compatibility / examples: selected — 默认 bundle loader、server re-export、web mergeConfig/jsdom 都是现有消费者。
- Error handling / rollback / partial outputs: selected — 任一 loader 在测试前解析失败必须非零；不可用 warning suppression 假绿。
- Documentation / migration notes: selected — Makefile source identity与 OpenSpec evidence 需同步；无部署迁移。
- File IO / overwrite: not selected — 仅 git 原子重命名 tracked config，不处理运行时用户路径。
- Auth/permissions/secrets, concurrency/shared runtime state, resource limits, tenant/sandbox, process lifecycle, SQLite, HTTP envelope, browser runtime, cross-service boundary: not selected — 本变更不触及这些产品/运行时表面。

## Invariant Matrix

Governing invariant: server 与 web 的 config module SHALL 通过同一个完整相对 specifier解析到唯一存在的根 `.mjs` ESM module；默认/native loader 必须消费相同共享 coverage contract，web 只叠加既有环境覆写。

- Producer/source: `vitest.shared.mjs` 的 default config object。
- Consumers: `server/vitest.config.ts` re-export、`web/vitest.config.ts` mergeConfig、Makefile lint/fmt source list、`biome.json` root include。
- Public entries: `npm test --workspaces` / `make check` 与两个显式 native-loader命令。
- Data/schema: provider `v8`、include `src/**/*.{ts,tsx}`、lines/functions/branches/statements `80`。
- Consumer-specific override: web `environment: jsdom` 和 `e2e/**` exclusion；server 不获得 web override。
- Failure paths: missing/wrong/extensionless import、CommonJS package-scope interpretation、warning suppression、test/coverage未实际执行。
- Unchanged consumers: workspace test scripts、tests、product build/runtime、dependencies/lockfile、Vite/Vitest versions。

Regression rows:
- unique `.mjs` + both exact imports -> default and native loaders run each workspace tests and coverage successfully.
- missing/renamed shared module or either stale import -> corresponding native-loader command fails before tests, so acceptance is not vacuous.
- shared threshold/provider/include or web jsdom/exclude drift -> config inspection and coverage/web tests expose mismatch.
- default loader warning reappears -> `make check` output audit fails even if exit code is zero.

## Boundary-Surface Checklist

- Shared helper root: one root shared config module; no wrapper or duplicate implementation.
- Entry/consumer edges: server re-export, web mergeConfig, Makefile lint/fmt, `biome.json` include, workspace test commands.
- Read/resolve edge: complete relative `.mjs` path under root package scope.
- Publish/rollback: no runtime publish; rollback is git revert of the atomic rename/import update.
- Stale state/idempotency: no generated `.js` sibling or build artifact may satisfy the import; clean checkout must resolve tracked `.mjs` directly.
- Unchanged downstream: V8 engine, test discovery, web e2e exclusion and jsdom behavior, coverage gates, CI command structure.

## Risks / Trade-offs

- [`.mjs` loses TypeScript checking of the small shared object] → the file contains no TypeScript syntax; Biome lint plus real Vitest config loading under both loaders validate it. Avoid a declaration shim or package-wide ESM change.
- [Only the import loads but tests do not] → acceptance requires complete test counts and coverage output for both workspaces.
- [Default path warning is hidden rather than fixed] → do not set ignore env vars, change workspace test scripts or filter stderr; audit raw `make check` output.
- [Rename leaves stale identity] → require old `vitest.shared.ts` absent, new `.mjs` unique, and both workspace imports、Makefile、Biome include exact.

## Migration Plan

Atomic repository-only migration: rename shared file, update both workspace imports、Makefile 与 Biome include, run default/native verification, then commit. No application deployment or data migration. Roll back the single commit if loader compatibility regresses.

## Open Questions

无。失效路径、文件边界、consumer 集合与验证命令均已确定。
