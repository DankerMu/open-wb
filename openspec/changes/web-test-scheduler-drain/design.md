# Design: web-test-scheduler-drain

## 机理（#1541 已复现）

1. commit 发生在 promise 续延里时走 DefaultLane；它的被动 effect 作为 Normal 任务排进 React Scheduler（react-dom `scheduleCallback$1(NormalPriority$1, … flushPassiveEffects …)`），effect 里的 setState 与 transition 也是 Normal 任务。
2. Scheduler 每片 `frameInterval = 5ms`，超了就让出，经 `setImmediate` 续投（`node_modules/scheduler/cjs/scheduler.development.js:207-218`，check 阶段）。
3. `findBy*` / `waitFor` 由 MutationObserver 或 50ms 轮询判定通过；RTL `asyncWrapper` 收尾只等一个 `setTimeout(0)`（timers 阶段）。从这个 timer 排入到下一次 check 阶段之间过了 ≥1ms（CPU 争用、coverage 插桩、长渲染）时，timer 先到，测试继续。

扰动：`setupFiles` 在 Scheduler 加载前把 `globalThis.setImmediate` 换成延迟 3ms 的 `setTimeout`，第 3 步的次序就从「偶发」变成「每次」。

## 决策

- **D1 屏障**：新 setup 文件在导入 `@testing-library/react`（它在导入时 `configure` 自己的 `asyncWrapper`）之后，取 `getConfig().asyncWrapper` 为 `previous`，再 `configure({ asyncWrapper: (cb) => previous(async () => { const result = await cb(); await schedulerIdle(); return result; }) })`。`schedulerDrained()` 在 `scheduler` 包的同一实例上反复排 `unstable_scheduleCallback(unstable_IdlePriority, resolve)`：等完一个 Idle 后再排一个探针，探针的任务 `id` 紧接上一个（期间没有任务入队）即已排空，撤掉探针返回；否则等它再探。一次 Idle 不够（实施时实测）：effect 里 setState 引起的渲染由 React 先 `queueMicrotask`、在微任务里才 `scheduleCallback`，那个 effect 与 Idle 同片时 Idle 先跑、渲染后入队——D5 第一例在只等一次 Idle 时仍红。`id` 是 `unstable_scheduleCallback` 返回记录的内部字段，版本钉在 0.27.0，字段消失时每次等待显式抛错。
  - 屏障跑在 `previous` 之内：RTL 此时已把 `IS_REACT_ACT_ENVIRONMENT` 置为 false，与那批工作被排进真实 Scheduler 时的环境一致，不触发 act 警告；屏障在 RTL 自己的 `setTimeout(0)` drain 之前，flush 出来的 effect 再排的 timer 仍被那次 drain 接住。
  - Idle 任务的过期时间是 `maxSigned31BitInt`，Scheduler 按过期时间取最小者，因此它排在所有已排队的、以及 flush 期间级联新排的 Normal / UserBlocking / Low 任务之后。
  - 不以 IdlePriority 排工作的代码不受影响；本仓 `web/src` 没有直接用 Scheduler。
- **D2 依赖**：`scheduler@0.27.0` 进 web devDependencies，版本等于 react-dom 自己的依赖，锁文件不新增包；外部 node_modules 由 Node 原生加载，`import "scheduler"` 与 react-dom 的 `require("scheduler")` 是同一个模块实例（实验已证：屏障在扰动下把 5 红清零）。`scheduler` 不带类型：在 setup 文件旁写最小的模块声明，只声明用到的两个导出，不用 `any`。
- **D3 只挂 web**：`web/vitest.config.ts` 的 `test.setupFiles`；`vitest.shared.mjs` 是 server 共用的，不动。
- **D4 用例修正**（每例只改等待，不改断言强度）：
  - `previewers-loading.test.tsx:177`：`loadPreviewer` 的调用记录改在 `waitFor` 里等到 `[["code"]]`；后面「再选 other.ts 不再加载」的终态断言不变。
  - `chat-permission-tier.test.tsx`「缺省档位是 全部自动…」：第一次发送后、`router.navigate("/")` 之前先 `await screen.findByRole("button", { name: "停止" })`，等新会话页收敛到运行中再离开（与 `leaveForWelcome` 注释的「创建—发送交接未完成时不离开」同一前提）。实施时实测：在 `clickSend` 前等「发送」不成立——没收敛就回欢迎态时，欢迎态按钮停在「停止」超过 1s（范围外观察，另行登记）。
  - `chat-message-waiting.test.tsx:110-113` `expectNeither`：两个 `toBeNull` 放进同一个 `waitFor`。
  - `previewers-archive.test.tsx:365`：等的是新列表本身：在 `waitFor` 里断言行文字为 `["new-1.txt", "new-2.txt"]`，不靠立即命中旧表的 `findByRole("table")`。
  - `workspace-browser-only-paths.test.tsx`「选中后 file 答 404…」：点 x.md 之前须等宿主套用 `path=null`。这个交错没有可等的 DOM 信号，由 D1 保证（`waitFor` 返回时宿主的 `path` effect 已执行）；用例文本不改，复现表证明它在扰动下由红转绿。
- **D5 回归测试**：新 `web/test/scheduler-drain.test.tsx`，不靠扰动、在普通配置下给出确定次序。
  - 组件：测试 `resolve` 一个 deferred 后 `await findByText(标记)`；续延里 setState 让第一次 commit 显示标记（act 之外，DefaultLane）；该 commit 的被动 effect 立即 setState；第二次渲染含一个渲染时忙等 **≥8ms**（大于 `frameInterval = 5`）的子组件；第二次 commit 的被动 effect 记一次调用。用例在 `findByText` 之后**同步**断言调用已记录。
  - 去掉 setup 时为何确定性红：第一次 commit 与它的 effect 在同一片里跑完（快）；片结束后的微任务里 MutationObserver 让 `findByText` 通过，RTL 注册 `setTimeout(0)`（时刻 T），React 也在微任务里把第二次渲染排进 Scheduler（`setImmediate`）。下一轮 check 阶段跑第二次渲染：忙等 ≥8ms 使 Scheduler 在 commit 之后让出，第二次的被动 effect 续投到再下一个 `setImmediate`；再下一轮先到 timers 阶段，此时距 T 已 ≥8ms，RTL 的 timer 先执行，测试继续，断言读到 0 次。T 之后的忙等是让 timer 必然到期的原因，不依赖机器负载。
  - 有屏障时：Idle 任务排在第二次渲染与它的 effect 之后，断言读到 1 次。
  - 同一用例文件再加一例：`waitFor` 在回调始终抛错时仍以原错误（不是屏障造成的别的错误）在超时后拒绝——屏障只在 `cb` resolve 之后执行，`await cb()` 抛出时被跳过。
  - 第一例同时守卫「同一 Scheduler 实例」：若以后 react-dom 依赖另一个 `scheduler` 版本、装出第二份，屏障等的是别的实例，本例变红。

## Change surface / 约束

- Change surface：`web/vitest.config.ts`、`web/test/<setup>.ts` + 类型声明、`web/package.json`、`package-lock.json`、D4 五个文件、D5 新文件。
- Must preserve：全部既有断言的强度与用例数；`vitest.shared.mjs`、server 测试；超时 / 重试 / pool 不变；既有 per-test 规则（规范原文）保留。
- Governing invariant：一个 RTL 等待返回时，它所等到的状态已排进 React Scheduler 的工作都已执行完。
- Sibling surfaces：`settle()` / `yieldMacrotask()` / `quiesce()` / 各文件自带的 `flush()`（如 `previewers-archive.test.tsx`）这类不经 `asyncWrapper` 的等待不在屏障内，仍须按规范原文写等待（扰动下全量 0 红即证当前没有这种残留）；`act()` 自带 flush，不受影响；fake timers：屏障用 Scheduler 自己捕获的计时器，不经 `vi.useFakeTimers` 替换的全局（需验证使用 fake timers 的文件仍绿）。
- Seams under test：RTL 公开等待（`findBy*` / `waitFor`）在真实 Scheduler 下的返回时机。
- Required evidence：见 proposal Triage 与 tasks「证据」。
- Non-goals：产品代码；`workspace-browser.tsx` 的 `path` 交错（另案 #1542）；CI job 时长 / 超时余量。
- Review focus：屏障与 RTL 原 `asyncWrapper` 的嵌套次序；Scheduler 实例同一性；屏障会不会在永不空闲的组件上挂起（应以用例超时显式失败，而非静默）；D4 每处是否只改等待、不减断言；回归用例去 setup 时是否确定性红。
