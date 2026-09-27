# Spec delta: chat-web（#489 page.tsx 纯搬迁拆分）

> 父 delta 没有会话页源码模块划分的 requirement，本条依据父 design「模块拆分（size-guard）」自写，与「API 客户端源码模块划分」（#471）同形。本刀只搬入既有的 prompt 派发簇。停止（7.2）、重新生成（7.3a）、分叉（7.3b）与审批作答（7.4）的 handler 由各自 issue 落入同一模块，不需要改写本条。审批事件归约属于 `stream-approvals.ts`（5.3），不在本条范围内。

## ADDED Requirements

### Requirement: 会话页源码模块划分
`web/src/features/chat/` 下的会话页实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。

`ChatPage` SHALL 保持定义在 `page.tsx`，并经 `index.ts` 导出。`index.ts` 是会话页 feature 的唯一公共入口。

`turn-actions.ts` SHALL 承载会话页回合操作的 handler 及其所有权 fence，包括：
- prompt 派发、受理前后的失败回退与草稿恢复；
- 停止、重新生成、分叉与审批作答。

这些 handler SHALL 以只由 `ChatPage` 调用的 hook 或辅助函数形式提供，`turn-actions.ts` SHALL 不渲染 UI。

`page.tsx` 与 `turn-actions.ts` 之间的值导入 SHALL 只沿 `page.tsx → turn-actions.ts` 方向，`turn-actions.ts` SHALL 不导入 `./page.js`。`turn-actions.ts` 的导出 SHALL 只供 `page.tsx` 使用，不经 `index.ts` 对外暴露，也不新增未被引用的导出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 web 测试
- **THEN** 同时满足以下各项：
  - size-guard 退出 0；
  - knip 报告无未引用导出；
  - `turn-actions.ts` 不导入 `./page.js`；
  - 既有调用方仍从 `features/chat/index.js` 取得 `ChatPage`；
  - web 测试全绿。
