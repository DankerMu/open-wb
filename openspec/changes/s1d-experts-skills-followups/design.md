# Design: s1d-experts-skills-followups

## D1 会话配置文件删除失败的通道（组 1，#1722）

Change surface：`writeSessionConfig` 返回的 `remove`（`session-config.ts`）；`spawnOmp` 的两处挂载与同步失败分支（`process.ts:93-104`）；从 sessions 选项到 `spawnOmp` 的接线（`index.ts` → supervisor → `pool.ts` 的 `shared` → `buildSessionRuntime` → `OmpSessionRuntime` → `OmpProcess` → `spawnOmp`；fork / undo 的临时进程经同一个 `buildSessionRuntime`，见 `branch-temp.ts:43`、`branching.ts:209`；supervisor 的 `#spawn` 端口（`supervisor.ts:173-176`）加一个字段，原样携带 `options.onError`）。

决定：
- `remove` 改为幂等：第一次调用置 `done`，之后的调用直接返回。`.yml` 和 `.md` 在第一次调用里各尝试一次，每个失败的文件恰调用一次报告回调（参数为该次 `rmSync` 抛出的 `Error`；不是 `Error` 时包成 `Error`）。报告回调同步、返回 `undefined`；回调本身抛错时吞掉，不能打断退出处理。
- 报告回调是 sessions 选项的 `onError` 原样透传，不经 supervisor 的 `retainFault`，所以不进入保留故障、不在关停时暴露。这与会话删除清理失败（`session-delete.ts:72`）走同一条路，生产入口的 `emitSessionFault`（`server.ts:355-357`）把它写成一行 `{"event":"session_fault"}`，不新增事件种类、不扩展 `SpawnLog`。
- 没有提供回调的装配（测试直接构造 runtime 等）丢弃报告，与 `log` 缺省时的处理一致。
- 规格只改 omp-runtime（理由见 proposal Impact）。http-service-skeleton「服务启动与装配」里「同一个 `onError` 也接收会话删除清理会话文件失败时的报告」这句的清单，由 omp-runtime 条文引用补足；等 `s1d-connectors` 与 `s1b-workspace-mounts` 归档后，再在下一次修改该 requirement 时把来源并进清单。

Must preserve：
- 删除时机：`exit` / `close` 双挂、spawn 同步失败时立即 `remove()`。
- 其它存活进程的文件不删。
- 退出处理与 `OmpProcess` 的 `exit` 发布不受删除失败影响。
- `remove` 声明的「idempotent, never throws」契约。
- 握手超时、上游失败两类 `log` 记录不变。
- `session_fault` 记录逐字不变（无 extra key）。

Governing invariant：application stderr 只有受管 writer 写出的 LF-terminated JSON 行，唯一例外是 `node:sqlite` ExperimentalWarning（http-service-skeleton「服务启动与装配」）。

Sibling surfaces：
- `server/src` 里没有别的 `emitWarning`：用 `git grep` 确认，并作为验收断言。
- 启动清扫 `sweepSessionConfig` 的失败已经使启动以 `state_layout` 阶段失败，不在本组范围。
- `session-delete.ts` 的报告路径是先例，不改。
- `writeSessionConfig` 写入失败的回滚（catch 里 `remove()` 后再 throw）用同一个报告回调：回调作为 `writeSessionConfig` 的参数传入，回滚和返回的 `remove` 共用。

## D2 删除后的焦点（组 2，#1731）

照搬 `web/src/features/center/models/use-models.ts:146-165` 与 `models/panel.tsx:93-96`：
- `confirmRemove(onGone?: () => void)` 在 `deleteExpert` 成功后先 `onGone?.()`，再 `setRemove(null)`，再 `await reload()`；失败分支不调 `onGone`。
- 专家规格的删除失败语义是「卡片仍在」，模型 tab「非信封 500 也视为已删」的分支不移植。
- `panel.tsx` 传入 `() => { opener.current = null; }`；`panel.tsx:31` 的注释改成与 `models/panel.tsx` 一致的说法。
- 回归用例移植 `center-models-list.test.tsx:216-238` 的 `slowNextList` 写法：下一次 `listExperts` 在一个 10 ms 宏任务之后才结算。
- 在途提交的两层守卫（`form-dialog.tsx:135` 与 `use-experts.ts:98`）串联，必须各自单独观测，才能拿到突变红证据（tasks 2.4）。守卫代码不改。

## D3 弹层作用域的归档半条与欢迎态持有集合（组 3，#1735）

- 用例：挂载 `/?session=A`，打开「能力」；经列表连接派发 `sessions.changed`，重取返回已归档的 A；看到归档提示后点「恢复」；输入框重新可用后，弹层仍是关的。`requestedSessionId` 全程不变。
- 红证据：临时去掉 `page.tsx:76` 的 `archived ?`，这条用例必须变红（记录输出），然后恢复。
- `use-session-capabilities.ts` 的 `sessionId === undefined` 分支加 `hold(null)`：回到会话时，第一次提交里没有已持有的集合，专家标签与停用过滤按「未取得」处理，不再依赖弹层作用域重置来兜底。
- 用例：A → 欢迎态 → A，断言回到 A 的第一次提交里 `capabilities` 为 null（hook 级或页面级均可）。
- 这是一帧内部状态，不是规格行为，不改 spec。
