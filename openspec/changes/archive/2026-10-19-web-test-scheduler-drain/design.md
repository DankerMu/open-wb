# Design: web-test-scheduler-drain

## 机理（#1541 已复现）

1. commit 发生在 promise 续延里时走 DefaultLane；它的被动 effect 作为 Normal 任务排进 React Scheduler（react-dom `scheduleCallback$1(NormalPriority$1, … flushPassiveEffects …)`），effect 里的 setState 与 transition 也是 Normal 任务。
2. Scheduler 每片 `frameInterval = 5ms`，超了就让出，经 `setImmediate` 续投（`node_modules/scheduler/cjs/scheduler.development.js:207-218`，check 阶段）。
3. `findBy*` / `waitFor` 由 MutationObserver 或 50ms 轮询判定通过；RTL `asyncWrapper` 收尾只等一个 `setTimeout(0)`（timers 阶段）。从这个 timer 排入到下一次 check 阶段之间过了 ≥1ms（CPU 争用、coverage 插桩、长渲染）时，timer 先到，测试继续。

扰动：`setupFiles` 在 Scheduler 加载前（排在任何会导入 RTL / react-dom 的 setup 文件之前）把 `globalThis.setImmediate` 换成延迟 3ms 的 `setTimeout`，第 3 步的次序就从「偶发」变成「每次」。原文（scratch，不入库）：

```ts
const real = globalThis.setTimeout;
globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...args: unknown[]) =>
  real(() => fn(...args), 3)) as typeof setImmediate;
```

## 决策

- **D1 屏障**：新 setup 文件在导入 `@testing-library/react`（它在导入时 `configure` 自己的 `asyncWrapper`）之后，取 `getConfig().asyncWrapper` 为 `previous`，再 `configure({ asyncWrapper: (cb) => previous(async () => { const result = await cb(); await schedulerDrained(); return result; }) })`。`schedulerDrained()` 在 `scheduler` 包的同一实例上反复排 `unstable_scheduleCallback(unstable_IdlePriority, resolve)`：等完一个 Idle 后再排一个探针，两次探针之间除屏障自己的探针外没有任务入队（id 区间里只有屏障探针）即已排空，撤掉探针返回；否则等它再探。一次 Idle 不够（实施时实测）：effect 里 setState 引起的渲染由 React 先 `queueMicrotask`、在微任务里才 `scheduleCallback`，那个 effect 与 Idle 同片时 Idle 先跑、渲染后入队——D5 第一例在只等一次 Idle 时仍红。`id` 是 `unstable_scheduleCallback` 返回记录的内部字段，版本钉在 0.27.0，字段消失时每次等待显式抛错。
  - 多个等待并发（如 `Promise.all([findBy…, findBy…])`）：屏障自己排的探针 id 记在模块级集合里，判断「两次探针之间有没有任务入队」时不把别的屏障的探针算作外来工作，否则两个循环互见对方的探针、永不终止（review r1 F1）。
  - 覆盖面：只覆盖已进 Scheduler 的工作，以及离 Idle 回调只隔一跳微任务就进 Scheduler 的工作（React 对 effect 内 setState 的 `queueMicrotask` → `scheduleCallback` 正是一跳）。用户代码多绕一跳 promise 后才 setState、`React.lazy` 的 ping、经 react-dom `scheduleTimeout`（`setTimeout`）节流或挂起的 commit 不在其内；这些情况仍须按规范原文等所断言的 DOM 本身。
  - 屏障跑在 `previous` 之内：RTL 此时已把 `IS_REACT_ACT_ENVIRONMENT` 置为 false，与那批工作被排进真实 Scheduler 时的环境一致，不触发 act 警告；屏障在 RTL 自己的 `setTimeout(0)` drain 之前，flush 出来的 effect 再排的 timer 仍被那次 drain 接住。
  - Idle 任务的过期时间是 `maxSigned31BitInt`，Scheduler 按过期时间取最小者，因此它排在所有已排队的、以及 flush 期间级联新排的 Normal / UserBlocking / Low 任务之后。
  - 不以 IdlePriority 排工作的代码不受影响；本仓 `web/src` 没有直接用 Scheduler。
- **D2 依赖**：`scheduler@0.27.0` 进 web devDependencies，版本等于 react-dom 自己的依赖，锁文件不新增包；外部 node_modules 由 Node 原生加载，`import "scheduler"` 与 react-dom 的 `require("scheduler")` 是同一个模块实例（实验已证：屏障在扰动下把 5 红清零）。`scheduler` 不带类型：在 setup 文件旁写最小的模块声明，只声明用到的导出（`unstable_IdlePriority`、`unstable_scheduleCallback`、`unstable_cancelCallback`）与任务记录的 `id` 字段（`SchedulerTask`），不用 `any`。
- **D3 只挂 web**：`web/vitest.config.ts` 的 `test.setupFiles`；`vitest.shared.mjs` 是 server 共用的，不动。
- **D4 用例修正**（每例只改等待，不改断言强度）：
  - `previewers-loading.test.tsx:177`：`loadPreviewer` 的调用记录改在 `waitFor` 里等到 `[["code"]]`；后面「再选 other.ts 不再加载」的终态断言不变。
  - `chat-permission-tier.test.tsx`「缺省档位是 全部自动…」：第一次发送后、`router.navigate("/")` 之前先 `await screen.findByRole("button", { name: "停止" })`，等新会话页收敛到运行中再离开（与 `leaveForWelcome` 注释的「创建—发送交接未完成时不离开」同一前提）。实施时实测：在 `clickSend` 前等「发送」不成立——没收敛就回欢迎态时，欢迎态按钮停在「停止」超过 1s（范围外观察，另行登记）。
  - `chat-message-waiting.test.tsx:110-113` `expectNeither`：两个 `toBeNull` 放进同一个 `waitFor`。
  - `previewers-archive.test.tsx:365`：等的是新列表本身：在 `waitFor` 里断言行文字为 `["new-1.txt", "new-2.txt"]`，不靠立即命中旧表的 `findByRole("table")`。
  - `workspace-browser-only-paths.test.tsx`「选中后 file 答 404…」：点 x.md 之前须等宿主套用 `path=null`。这个交错没有可等的 DOM 信号，由 D1 保证（`waitFor` 返回时宿主的 `path` effect 已执行）；用例文本不改，复现表证明它在扰动下由红转绿。
- **D5 回归测试**：新 `web/test/scheduler-drain.test.tsx`，不靠扰动、在普通配置下给出确定次序。
  - 组件：测试 `resolve` 一个 deferred 后 `await findByText(标记)`；续延里 setState 让第一次 commit 显示标记（act 之外，DefaultLane）；该 commit 的被动 effect 立即 setState；**两次**渲染都含一个渲染时忙等 **≥8ms**（大于 `frameInterval = 5`）的子组件；第二次 commit 的被动 effect 记一次调用。用例在 `findByText` 之后**同步**断言调用已记录。
  - 去掉 setup 时为何确定性红：第一次渲染忙等 ≥8ms，Scheduler 在第一次 commit 之后让出；片结束后的微任务里 MutationObserver 让 `findByText` 通过，RTL 注册 `setTimeout(0)`（时刻 T）。被动 effect 1 在下一个 `setImmediate` 里执行，其 setState 经微任务把第二次渲染排进 Scheduler；第二次渲染的忙等 ≥8ms 开始于 T 之后，并在 commit 之后让出，被动 effect 2 续投到再下一个 `setImmediate`；再下一轮先到 timers 阶段，此时 RTL 的 timer 已到期，测试继续，断言读到 0 次。第二次渲染的忙等开始于 T 之后，是 timer 必然到期的原因，不依赖机器负载。
  - 有屏障时：断言读到 1 次。第一次渲染也忙等，是为了让「只等一次 Idle」确定性红：第一次 commit 之后 Scheduler 让出，第一个探针在被动 effect 1 之前入队；effect 1 与探针同片执行，effect 1 的 setState 经微任务才排第二次渲染，此时探针已跑完——单次 Idle 的屏障在这里返回、读到 0 次；循环屏障看到 id 不相邻，继续等到第二次渲染与它的 effect 之后。
  - 第三例：同一次 commit 显示两个标记，`await Promise.all([findByText(A), findByText(B)])` 在短超时内通过（两个屏障并发不互相卡死）。
  - 同一用例文件再加一例：`waitFor` 在回调始终抛错时仍以原错误（不是屏障造成的别的错误）在超时后拒绝——屏障只在 `cb` resolve 之后执行，`await cb()` 抛出时被跳过。
  - 第一例同时守卫「同一 Scheduler 实例」：若以后 react-dom 依赖另一个 `scheduler` 版本、装出第二份，屏障等的是别的实例，本例变红。

## Change surface / 约束

- Change surface：`web/vitest.config.ts`、`web/test/scheduler-drain-setup.ts` + `web/test/scheduler.d.ts`、`web/package.json`、`package-lock.json`、D4 中改动的四个测试文件（`workspace-browser-only-paths` 不改）、D5 新文件。
- Must preserve：全部既有断言的强度与用例数；`vitest.shared.mjs`、server 测试；超时 / 重试 / pool 不变；既有 per-test 规则（规范原文）保留。
- Governing invariant：一个 RTL 等待返回时，它所等到的状态已排进 React Scheduler 的工作都已执行完。
- Sibling surfaces：`settle()` / `yieldMacrotask()` / `quiesce()` / 各文件自带的 `flush()`（如 `previewers-archive.test.tsx`）这类不经 `asyncWrapper` 的等待不在屏障内，仍须按规范原文写等待（扰动下全量 0 红只证这类等待之后的**肯定**断言当前没有残留；之后的否定断言，如 `previewers-archive.test.tsx` 的 `await flush(); expect(queryByText("stale.txt")).toBeNull()`，在扰动下照样会过，不构成证明）；`act()` 自带 flush，不受影响；fake timers：屏障用 Scheduler 自己捕获的计时器，不经 `vi.useFakeTimers` 替换的全局（需验证使用 fake timers 的文件仍绿）。
- Seams under test：RTL 公开等待（`findBy*` / `waitFor`）在真实 Scheduler 下的返回时机。
- Required evidence：见 proposal Triage 与 tasks「证据」。
- Non-goals：产品代码；`workspace-browser.tsx` 的 `path` 交错（另案 #1542）；CI job 时长 / 超时余量。
- Review focus：屏障与 RTL 原 `asyncWrapper` 的嵌套次序；Scheduler 实例同一性；屏障会不会在永不空闲的组件上挂起（应以用例超时显式失败，而非静默）；D4 每处是否只改等待、不减断言；回归用例去 setup 时是否确定性红。
