# Spec delta: chat-sessions（#454 store 纯搬迁拆分）

## ADDED Requirements

### Requirement: 会话 store 源码模块划分
`server/src/sessions/` 下的会话 store 实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`createSessionStore` 与 `SessionStore` 类型 SHALL 保持从 `store.ts` 导出，是会话持久化的唯一公共入口；`store-branch.ts`/`store-approvals.ts` 的导出 SHALL 只供 `sessions/` 内的 store 模块使用，不经 `sessions/index.ts` 对外暴露。`store-branch.ts` SHALL 承载消息/步骤行的列集、行形状与视图映射、owned 事务与变更计数原语，以及 regenerate/fork 的事务与行拷贝；`store-approvals.ts` SHALL 承载回合终态结算（完成/失败/释放、启动对账）以及审批行读写、非作答结算与快照投影。值导入 SHALL 只沿 `store.ts → store-approvals.ts`、`store.ts → store-branch.ts`、`store-approvals.ts → store-branch.ts` 三个方向（有向无环），反方向只允许类型导入；新模块 SHALL 不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`store-approvals.ts`/`store-branch.ts` 对 `store.ts` 只有 `import type`，store 相关测试全绿
