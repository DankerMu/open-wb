# Proposal: s1d-experts-skills-followups

```text
Issue type: bugfix
Fixture level: expanded（组 1）；compact（组 2、组 3）
Upstream suggested level: 无（三条 issue 未标级别）(agree)
Blast radius: 组 1 做错时，application stderr 出现非 JSON 行或重复记录，或退出处理被打断；组 2 删除后焦点落到 body；组 3 恢复后弹层自行弹出，或回到会话时用旧集合过滤
Selected risk packs: Error handling / rollback; Concurrency / shared state / ordering; Public API / CLI / script entry; Documentation; Legacy compatibility
Evidence floor: 各组 tasks 里列出的先红后绿用例与突变红证据；npm test --workspace server|web；make check
```

## Why

Epic #1654（change `s1d-experts-skills`，已归档）实现期间，审查延后了三条 P2，分别立为 issue。owner 2026-10-23 要求处理这些 follow-up，完成该 Epic 的全部任务：

- #1722：会话配置文件删除失败时，`session-config.ts:81` 调 `process.emitWarning`，往 application stderr 打一行非 JSON 的纯文本，违反 http-service-skeleton「服务启动与装配」「stderr 只有受管 JSON 行」的契约。`process.ts:103-104` 在 `exit` 和 `close` 上各挂了一次 `remove`，同一个文件会报两次。
- #1731：中心「专家」tab 删除成功后，`confirmRemove` 不清 `opener`，而列表重取晚于 Radix 回焦，焦点先回到将被删除的卡片，卡片随后卸载，焦点落到 `body`。模型 tab 的同一问题已在 #1708 修复轮修好，专家 tab 没跟上。另有两处：CE-03 写了卡片不渲染的「分类」；在途提交用例点的是已禁用的按钮，守卫没有真正被执行到。
- #1735：「能力」弹层的作用域 `archived ? undefined : requestedSessionId`（`page.tsx:76`）中，「当前会话原地被归档」这半条没有能区分的用例；欢迎态分支不清已持有的能力集合，回到会话的第一次提交会读到旧集合。

## What Changes

- 组 1（#1722）：会话配置文件每个子进程只删一次；删除失败经 sessions 的 `onError` 报告（生产入口写一行 `{"event":"session_fault"}`，不进入保留故障），`server/src` 不再调 `emitWarning`。omp-runtime「子进程 spawn 契约」写明通道和次数。
- 组 2（#1731）：`confirmRemove(onGone?)` 照模型 tab 的写法改，删除成功时清掉 `opener`；experts「中心「专家」tab」补上删除后的焦点规则和场景。CE-03 措辞改为经分类 chip 看到卡片；在途提交用例改为直接 submit 表单，hook 层守卫另写 `renderHook` 用例。
- 组 3（#1735）：新增「当前会话原地被归档再恢复，弹层保持关闭」页面用例，要求有突变红证据；`use-session-capabilities.ts` 欢迎态分支加 `hold(null)` 并配用例。不改规格。

## Impact

- 规格：omp-runtime「子进程 spawn 契约」、experts「中心「专家」tab」各修改一条。http-service-skeleton「服务启动与装配」不改：它正被 `s1d-connectors` 与 `s1b-workspace-mounts` 两个进行中的 change 修改，再改会给两边都制造旧底。通道和记录形态在 omp-runtime 条文里写全，并引用 http-service-skeleton 的同一处理（design D1）。
- 代码：组 1 改 `server/src/sessions/omp/{session-config.ts,process.ts,runtime.ts}`、`server/src/sessions/{pool.ts,supervisor.ts}` 及接线所需的 fork / undo 临时进程路径；组 2 改 `web/src/features/center/experts/{use-experts.ts,panel.tsx}`；组 3 改 `web/src/features/chat/use-session-capabilities.ts`。三组各自配测试。
- 不动：会话配置文件的删除时机（`exit` / `close` 双挂是 design D1 有意的）；启动清扫 `sweepSessionConfig` 的失败语义；模型 tab；`useSkillsState` 的作用域机制与 `page.tsx:76` 的语义。
