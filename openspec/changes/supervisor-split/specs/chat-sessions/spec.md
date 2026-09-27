# Spec delta: chat-sessions（#487 supervisor 纯搬迁拆分）

> 本 delta 只交付 `pool.ts` 与 `turn-control.ts` 两个落点。父 design「模块拆分（size-guard）」还规定了第三个落点 `approvals.ts`（审批登记/计时/结算），`supervisor.ts` 中目前没有可搬的审批代码，因此由 4.3（#464）新建该文件，并以 MODIFIED 把它补进本 requirement。

## ADDED Requirements

### Requirement: 会话 supervisor 源码模块划分
`server/src/sessions/` 下的会话 supervisor 实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。

`SessionSupervisor` 及其端口类型（`SessionSupervisorOptions`、`SessionSupervisorRuntime`、`StreamCursor`、`SessionStreamSubscription`、`SessionStreamLiveHandler`）SHALL 保持从 `supervisor.ts` 导出。`supervisor.ts` 是会话派发与回合生命周期的唯一公共入口。

`pool.ts` 与 `turn-control.ts` 的导出 SHALL 只供 `sessions/` 内的 supervisor 模块使用，不经 `sessions/index.ts` 对外暴露。两个模块的职责如下：
- `pool.ts` SHALL 承载 slot 登记：活 slot 与 generation 的记录形状、按回合认领的释放（`releaseClaim`/`releasePumpExit`），以及进程池的准入、驱逐与名额。
- `turn-control.ts` SHALL 承载回合派发辅助：回合事件到 store 的落库映射、预进度失败后的帧排空，以及 stop/regenerate/fork 的回合控制编排。

值导入 SHALL 无环。`pool.ts`/`turn-control.ts` 对 `supervisor.ts` SHALL 只允许类型导入。新模块 SHALL 不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** 同时满足以下各项：
  - size-guard 退出 0；
  - knip 报告无未引用导出；
  - `pool.ts`/`turn-control.ts` 不值导入 `./supervisor.js`；
  - 既有调用方仍从 `sessions/supervisor.js` 取得 `SessionSupervisor` 及其端口类型；
  - supervisor 相关测试全绿。
