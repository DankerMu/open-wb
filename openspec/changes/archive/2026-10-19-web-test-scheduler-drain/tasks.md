# Tasks: web-test-scheduler-drain

> 跟踪 #1541。只动 web 测试基建与测试文件、`web/package.json` 与根 lockfile；不碰 `server/`、`vitest.shared.mjs`、CI workflow、产品代码，不调超时 / 重试 / pool。
> 测试先行：回归用例与 5 处修正都要在未改动的基建上先看到红（扰动配置或去掉 setup），再看到绿。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 选中：屏障决定每个 `findBy*` / `waitFor` 相对 React Scheduler 的返回次序；须证级联工作被排空、与 RTL 原 `asyncWrapper` 嵌套次序正确、fake timers 文件不受影响 | 2.1、2.2、4.1–4.3 |
| Config / project setup | 选中：`web/vitest.config.ts` 新增 `setupFiles`；不进 `vitest.shared.mjs`（server 共用） | 2.1、4.4 |
| Release / packaging / dependency compatibility | 选中：`scheduler` 进 web devDependencies，钉 `0.27.0`（= react-dom 19.2.8 的依赖），lockfile 不新增包；knip 不报未列依赖。关键兼容风险：react-dom 日后改依赖别的 scheduler 版本会装出第二份，屏障静默失效——由 1.1 回归用例守卫（双实例时它变红），并在 2.1 核对 lockfile 只有一个 `node_modules/scheduler` | 1.1、2.1、4.4 |
| Error handling / rollback / partial outputs | 选中：屏障只在 `cb` resolve 后执行；`waitFor` / `findBy*` 失败时原错误原样传出，不被屏障吞掉或改写 | 1.1（第二例） |
| Resource limits / large input / discovery | 未选，理由具体：屏障不加任何超时或轮询；组件若永不空闲（Scheduler 一直有 Normal 任务），用例在 vitest `testTimeout` 处显式失败，不会静默通过；4.2 的全量耗时对照证明没有整体变慢 | 4.2 |
| Public API / CLI、File IO、Schema、Auth、Legacy compatibility、Documentation | 未选：不改产品代码、接口、文件或文档面；规范只加一处措辞扩大与 harness 级保证（见 proposal） | — |

## 1. 测试先行

- [x] 1.1 新增 `web/test/scheduler-drain.test.tsx`（design D5）：第一例按 D5 的组件与次序（两次渲染都忙等 ≥8ms），`await screen.findByText(标记)` 后同步断言第二次 commit 的 effect 已记 1 次；第二例：`waitFor` 回调始终抛错时以原错误拒绝；第三例：两个并发 `findByText` 在短超时内通过。普通配置、去掉 setup：第一例确定性红（连跑 3 次全红，记录输出），第二例绿；setup 换成只等一次 Idle：第一例红；setup 原样：三例绿
- [x] 1.2 用 #1541 的扰动配置（scratch `setupFiles`：Scheduler 加载前把 `setImmediate` 包成 3ms `setTimeout`）在未改动的 web 上跑全量：记录恰 5 红（3 例 CI + 2 例潜伏）

## 2. 屏障

- [x] 2.1 `web/package.json` devDependencies 加 `"scheduler": "0.27.0"`，`npm install` 同步根 lockfile（只多一条 devDependency 声明，不新增包；核对 `grep -c '"node_modules/scheduler"' package-lock.json` 为 1、`npm ls scheduler --workspace web` 只有 0.27.0）；新 setup 文件（`web/test/` 下）按 design D1：先导入 `@testing-library/react`，取 `getConfig().asyncWrapper` 包一层，回调 resolve 后反复等 `unstable_scheduleCallback(unstable_IdlePriority, …)` 直至两次探针之间除屏障探针外没有任务入队（design D1）；`scheduler` 的最小类型声明（只声明用到的导出，无 `any`）；`web/vitest.config.ts` `test.setupFiles` 挂上它。验证：1.1 转绿（连跑 5 次全绿）
- [x] 2.2 文件头注释写明机理与 #1541、为什么在 `previous` 之内、为什么是 Idle 优先级（一处说明，不在用例里复述）

## 3. 用例按规范修正（design D4，只改等待、不减断言）

- [x] 3.1 `previewers-loading.test.tsx:177`：`loadPreviewer` 调用记录在 `waitFor` 里等到 `[["code"]]`
- [x] 3.2 `chat-permission-tier.test.tsx`「缺省档位是 全部自动…」：第一次发送后、回欢迎态之前 `await screen.findByRole("button", { name: "停止" })`（design D4；原写法实测不成立）
- [x] 3.3 `chat-message-waiting.test.tsx` `expectNeither`：两个 `toBeNull` 放进同一个 `waitFor`
- [x] 3.4 `previewers-archive.test.tsx:365`：在 `waitFor` 里断言新列表行文字 `["new-1.txt", "new-2.txt"]`
- [x] 3.5 `workspace-browser-only-paths.test.tsx`「选中后 file 答 404…」：不改（交错没有可等的 DOM 信号，由 2.1 保证；产品侧交错另案 #1542）
- [x] 3.6 3.1–3.4 每处：在扰动配置、**不带**屏障的基建上该例转绿（证明修正本身成立，不依赖屏障）

## 4. 证据

- [x] 4.1 扰动配置 + 屏障：web 全量 0 红（对照 1.2 的 5 红）
- [x] 4.2 不扰动：`npm test --workspace web`（含 coverage）绿；记录修复前后耗时（同一机器、同一命令）
- [x] 4.3 满载（≥2×核数个 `yes`）下 5 个文件 + `scheduler-drain.test.tsx` 循环 10 次全绿；使用 `vi.useFakeTimers` 的 web 测试文件全绿（随 4.2）
- [x] 4.4 `make check` 绿（含 knip：`scheduler` 已列依赖、新 setup 文件不被判死代码；jscpd；size-guard）
- [x] 4.5 PR 正文：复现方法（scratch 配置原文）、前后对照表、依赖理由（AGENTS.md 依赖政策）、`偏离记录`
