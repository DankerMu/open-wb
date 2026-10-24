# Tasks: s1d-experts-skills-followups

> 三个 issue 各一个 PR，按 1 → 2 → 3 串行；本 fixture 随第一个 PR 合入。owner 2026-10-23「处理 follow-up，完成该 epic 全部任务」。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Error handling / rollback / partial outputs | 是 | 组 1：删除失败的报告与退出处理不受影响（1.2）；组 2：删除失败时焦点回到卡片（2.2） |
| Concurrency / shared state / ordering | 是 | 组 1：`exit` / `close` 双到达只删、只报一次（1.2）；组 2：列表重取与 Radix 回焦的先后（2.2 慢重取）；组 3：作用域与持有集合跨导航的先后（3.2） |
| Public API / CLI / script entry | 是 | 组 1：生产入口 stderr 契约（1.3 入口级断言） |
| Documentation / migration notes | 是 | 组 2：CE-03 措辞（2.3），格式由 `web/test/functional-checklist.test.ts` 守住 |
| Legacy compatibility / examples | 是 | 组 1：`session_fault` 记录逐字不变，`log` 两类记录不变（1.3）；组 2/3：现有用例断言不改 |
| Config / project setup | 否 | 无配置项 |
| File IO / path safety / overwrite | 否 | 删除的路径与时机不变，只改失败上报 |
| Schema / columns / units / field names | 否 | 无数据面改动 |
| Auth / permissions / secrets | 否 | 报告不带路径、消息或凭据（`session_fault` 无 extra key） |
| Resource limits / large input / discovery | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无新增依赖 |

## 1. 会话配置文件删除失败的通道（#1722）

- [x] 1.1 核对 Context：`server/src/sessions/omp/session-config.ts:68-90`、`process.ts:64-105`、`runtime.ts:70-90,160-170,431-450`、`pool.ts:240-275`、`supervisor.ts:100-170`、`index.ts:110-165`、`branch-temp.ts:43`、`branching.ts:209`、`branching.ts:255`、`undo.ts:133`（fork / undo 经 `BranchTemps` 共用 supervisor 的 `#spawn` 端口，`supervisor.ts:173-176`）、`session-delete.ts:50-75`、`server.ts:205-220,350-360`；用例 `server/test/omp-session-config-exit.test.ts`、`omp-session-config.test.ts`；规格 omp-runtime「子进程 spawn 契约」第 37 行与 http-service-skeleton「服务启动与装配」的 `session_fault` 一段。
- [x] 1.2 测试先行（场景「会话配置文件删除失败只报告一次」）：在 `omp-session-config-exit.test.ts` 让 `rmSync` 对会话配置文件抛错（可注入或 mock），覆盖三种情况：
  - 带专家：`.yml` 与 `.md` 都失败，子进程依次触发 `exit`、`close`，报告回调恰两次；
  - 只有 `.yml` 失败：恰一次；
  - spawn 同步抛错：同步失败分支的 `remove()` 之后，没有 `exit` / `close` 再触发重复报告。
  - 写入回滚：`writeSessionConfig` 写 `.md` 失败、且回滚里 `.yml` 删除也失败时，报告回调恰一次，原写入错误照常抛出（`session-config.ts` catch 里的 `remove()` 与返回的 `remove` 是同一个报告路径，不能只把回调接在返回值上）。

  前三种（有子进程的）情况都要断言：退出处理照常完成，`OmpProcess` 的 `exit` 照常发布；报告回调抛错不打断退出。修复前至少「双到达报两次」与「经 `emitWarning`」两条为红（记录输出）。
- [x] 1.3 入口级断言：按 `server/test/server-handshake-log.test.ts` 的写法（生产装配经 `createApp`、采集 application stderr、断言 `session_fault` 行），删除失败用进程内 mock / 注入 `rmSync` 造出（不用 chmod：`ensureOmpStateLayout` 每次 spawn 都重新校正权限，CI 以 root 跑时也没有 EACCES），application stderr 除 `node:sqlite` ExperimentalWarning 外只有受管 JSON 行，`{"event":"session_fault"}` 的条数等于失败文件数，没有 `WorkbuddySessionConfig` 文本。另断言 `git grep -n emitWarning -- server/src` 为空（作为测试，或写进 PR 的验证命令）。
- [x] 1.4 实现 design D1：`remove` 幂等加报告回调；从 sessions `onError` 原样透传到 `spawnOmp`，fork / undo 临时进程同一路径；去掉 `emitWarning`；注释同步，去掉「the next startup's sweep clears what is left」这句过于乐观的说法，改为写明报告通道。
- [x] 1.5 `npm test --workspace server`（含 coverage）与 `make check` 通过。

Suggested fixture level: expanded - 共享 spawn 入口的接线、进程生命周期与 application stderr 契约。

## 2. 中心「专家」tab 删除后的焦点（#1731）

- [x] 2.1 核对 Context：`web/src/features/center/experts/{use-experts.ts:118-136,panel.tsx:25-100,list.tsx:170-185,form-dialog.tsx:130-140}`；先例 `web/src/features/center/models/{use-models.ts:146-165,panel.tsx:25-35,93-96}`、`web/test/center-models-list.test.tsx:216-238`；`web/test/center-experts-{list,form}.test.tsx`、`center-experts-support.tsx:111,259-261`；`docs/acceptance/functional-checklist.md` CE-03（约 :278）。
- [x] 2.2 测试先行（场景「删除后的焦点」）：`center-experts-list.test.tsx` 新增两个用例。
  - 慢重取：下一次 `listExperts` 在 10 ms 宏任务之后才结算。删除自建专家成功后，卡片消失、确认框关闭，`document.activeElement` 为 `新建专家`。修复前必须为红（记录输出）。
  - 删除失败：`deleteExpert` 以 `ApiError` 失败，焦点在该卡的 `删除` 上，页顶显示 message，不调 `onGone`。
- [x] 2.3 实现 design D2；`panel.tsx:31` 注释同步。CE-03 预期改为「列表末尾多出一张带「自建」标记、标签为需求与 PRD 的卡；点分类「产品」后能看到该卡」，结论仍为 `待签`。
- [x] 2.4 在途提交用例（`center-experts-form.test.tsx:95-122`）：
  - 把「再点保存」改为对 `<form>` 直接 `fireEvent.submit`，断言 `createExpert` 恰一次（面板级用例只证明整体不重发；两层守卫各自的突变红证据见下面两条）。
  - 两层守卫串联，从面板入口删掉其中一层，另一层会把它盖住，所以每层单独观测：
    - 对话框层：直接渲染 `ExpertFormDialog`，`pending` 为 true，传入 `onSubmit` spy；对 `<form>` `fireEvent.submit` 后 spy 未被调用。临时删掉 `form-dialog.tsx:135` 的守卫，该用例必须变红（记录输出）。
    - hook 层：`renderHook(useExperts)`，打开表单后调一次 `submit`（`createExpert` 挂起），`await act(...)` 刷一次重渲染，再调新的 `result.current.submit`，`createExpert` 仍恰一次。临时删掉 `use-experts.ts:98` 的守卫，该用例必须变红（记录输出）。`:98` 读的是渲染闭包，同一闭包同步连调两次本来就会两次都过守卫，这不是本组的验收目标，不写这种用例。
- [x] 2.5 `npm test --workspace web`（含 coverage）与 `make check` 通过。

Suggested fixture level: compact - 单个面板的焦点接线，照搬已合入的先例。

## 3. 「能力」弹层归档半条与欢迎态持有集合（#1735）

- [x] 3.1 核对 Context：`web/src/features/chat/{page.tsx:60-80,slash-menu.tsx:140-160,240-245,310-320,use-session-capabilities.ts:135-165,capability-popover.tsx:60-100}`；用例 `web/test/chat-capability-popover-welcome.test.tsx:245-265`、`chat-list-events.test.tsx:42-141`（`dispatch` / `changed` / `replies` / `listOf` 写法）、`chat-stream-support.ts`（`FakeEventSource`、`latestListSource`）、`chat-page-session-meta-support.tsx`（`view`、`A`）、`chat-archive.test.tsx`（恢复的 PATCH 写法）。
- [x] 3.2 测试先行（design D3）：
  - 新增「当前会话原地被归档再恢复，弹层保持关闭」用例：列表重取让 A 带 `archivedAt`；出现 `[data-slot="archived-notice"]`、「能力」按钮消失之后，点「恢复」（PATCH 200）；输入框重新可用后，`skillsDialog()` 为 null。`requestedSessionId` 全程不变。
  - 突变红证据：临时去掉 `page.tsx:76` 的 `archived ?`，新用例必须变红（记录输出），然后恢复。
  - 新增 A → 欢迎态 → A 用例：用一个消费组件在每次渲染时把 `capabilities`（或页面上的专家标签 / 过滤结果）推进数组，逐帧记录，断言回到 A 的那一帧（effect 发起新读取之前的那次渲染）为 null。不能读 `rerender` / settle 之后的 `result.current`：`act` 已经冲掉 effect，修复前读到的也是 null。修复前为红（记录输出）。
  - 需要搬用的 helper，放进现有 support 文件或就地定义。新文件或改动的文件都要守住 800 行上限。
- [x] 3.3 实现：`use-session-capabilities.ts` 的 `sessionId === undefined` 分支加 `hold(null)`，并同步注释。
- [x] 3.4 `npm test --workspace web`（含 coverage）与 `make check` 通过。

Suggested fixture level: compact - 测试补缺加 hook 内一行状态清理。
