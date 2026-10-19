# Proposal: web-test-scheduler-drain

## Why

`unit-tests-web` 在无关 PR 与 master 上偶发红，每次落在不同用例（#1541：run 39244491129 / 39115292608 / 39109541037）。共同根因已确定性复现：`findBy*` / `waitFor` 在 DOM 一出现就 resolve，RTL `asyncWrapper` 收尾只 drain 一个 `setTimeout(0)`；而那次 commit 排进 React Scheduler 的工作（被动 effect、transition、effect 里 setState 的后续渲染）在切片超 5ms 时改由 `setImmediate` 续投，CPU 争用下落在那个 timer 之后。紧随其后的同步断言或交互于是发生在 React 收敛之前。同一类问题已逐例修过四次（#235、#369、#375、#1362）；把 Scheduler 的 tick 推迟 3ms 的扰动下，web 全量恰红 5 例（3 例 CI 红 + 2 例潜伏）。

## What Changes

- **测试基建**：web 的 vitest 新增一个 `setupFiles`，包裹 RTL 现有 `asyncWrapper`：回调 resolve 后、RTL 自己的 `setTimeout(0)` drain 之前，等一个 IdlePriority 的 Scheduler 回调。只挂 `web/vitest.config.ts`。
- **依赖**：`web/package.json` devDependencies 加 `scheduler`，钉锁文件已解析的 `0.27.0`（react-dom 19.2.8 自身依赖的版本，不新增安装内容）。理由：React 没有公开 API 能观察「Scheduler 队列已排空」；在同一 Scheduler 实例上排一个 Idle 任务是唯一有原理保证的屏障。
- **5 个用例按既有规范修正**（`verification-harness`「Web assertions await the committed outcome they check」）：断言改等它检查的结果本身。
- **回归测试**：一个确定性用例证明屏障的契约（去掉 setup 红、加上绿）。

## Capabilities

### Modified Capabilities

- `verification-harness`：MODIFIED「Web assertions await the committed outcome they check」——三个场景原样保留；正文一处措辞扩大：「a side effect performed in a React passive-effect cleanup」改为「… in a React passive effect or its cleanup」，即规则也覆盖 effect 本身的副作用（D4 中 `previewers-loading` 的 `loadPreviewer` 调用是 effect 本身发起的，以此为据）；正文末尾新增 harness 级保证（RTL 等待返回时 Scheduler 已排空）；新增两个场景。

## Impact

- 改动面：`web/vitest.config.ts`、新 `web/test/` setup 文件、`web/package.json` + 根 `package-lock.json`、5 个测试文件、1 个回归测试文件。不碰 `server/`、`vitest.shared.mjs`、CI workflow、任何超时 / 重试 / pool 配置、产品代码。
- 另案：`workspace-browser.tsx` 的 `path` effect 迟到时清掉用户新选中并重复请求（复现时取栈确认），另案 #1542，不在本 change。

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 每一个 web 用例的 findBy/waitFor 语义；屏障若写错，可能整套变慢、挂起到超时或掩盖真实错误
Selected risk packs: Concurrency / shared state / ordering; Config / project setup; Release / packaging / dependency compatibility; Error handling / rollback / partial outputs
Evidence floor: 扰动配置下 web 全量 0 红（前 5 红）；回归用例去 setup 红 / 加 setup 绿；npm test --workspace web（含 coverage）绿且耗时同量级；5 文件满载循环 N 次绿；waitFor 回调始终抛错时以原错误拒绝（1.1 第二例）；make check 绿
```
