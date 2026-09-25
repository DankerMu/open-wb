# Tasks: ui-walk-dual-project（#295）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 pass + 4 条 P2 吸收，报告 `.workplans/295/review/fixture-r1.md`）；`openspec validate ui-walk-dual-project --strict --no-interactive` exit 0。

## 2. Implementation
- [x] 2.1 D10 先做纯移动重构（oracle/辅助抽模块，行为不变），CI-env ui-walk 仍 `1 passed`。
- [x] 2.2 D1 config 双 project + D2–D9 分支断言；CI-env ui-walk `2 passed`。
- [x] 2.3 反向注入 1–8 各红并回退，逐条记入 PR（含失败断言行）。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 CI-env ui-walk exit 0（`2 passed`，记录时长）。
- [x] 3.4 archive PR：父 verification-harness「UI 走查」与晋升文本一致（父 delta 该块可改为与晋升相同或移除重复）；父 ui-primitives「图标离线、动效可禁用且归属登记」转为已晋升；勾选父 tasks 6.1；关闭 #295。

## Risk pack mapping
- Not selected Public API / CLI / script entry：`make ui-walk` 命令与 npm script 不变。
- Selected Config / project setup：`playwright.config.ts` projects/globalTimeout。证据：3.3 两 project 行、注入 1/7。
- Not selected File IO / path safety / overwrite：只经 UI 在 caller 沙箱建目录（既有行为）。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：oracle 语义不变，按 project 独立。
- Selected Concurrency / shared state / ordering：两 project 共用服务/沙箱/上游，覆盖层开合与模态 aria-hidden 时序。证据：3.3、注入 2、D5 按 project 分名。
- Selected Resource limits / large input / discovery：globalTimeout 150s 与 CI 15 分钟；walk-out 名 64 码点上限。证据：3.3 时长、注入 4/7；静态资源/跨源 oracle 证据注入 6/8。
- Selected Legacy compatibility / examples：既有 journey 断言在两 project 成立；抽模块行为不变。证据：2.1、3.3。
- Not selected Error handling / rollback / partial outputs：失败传播沿用 Playwright 非零退出。
- Not selected Release / packaging / dependency compatibility：不升级 Playwright。
- Not selected Documentation / migration notes：控制面不变。
