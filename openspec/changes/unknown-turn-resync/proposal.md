# Proposal: unknown-turn-resync（#633）

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (override: 连接器恢复路径与页面状态的次序交错)
Blast radius: 判定过宽 → 正常回合反复拉快照或事件被吞；判定过窄 → 过期视图仍同时显示新旧回答；恢复路径出错 → 游标倒退、重复追加或迟到安装
Selected risk packs: Concurrency/ordering; Error handling/partial outputs; Legacy compatibility; Documentation
Evidence floor: 新 jsdom 页面测试在 master 上为红、修复后绿；GET 次数断言锁定；连接器 resync 单测；全部既有 web 测试全绿；make check；openspec validate --strict
```

## Why
regenerate 提交时，服务端删掉旧助手行、插入一条新 id 的助手行（`server/src/sessions/store-branch.ts:143-145`）。事件流里没有「删行」或「重新同步」这类事件（`server/src/sessions/events.ts:6-35`）。web 归约器遇到未知 `messageId` 会新建一行并追加到末尾（`web/src/features/chat/stream.ts:242-263`），连接器只按游标判断是否投递（`:447-459`）。结果是：快照早于该提交的视图（其它标签页，或点击页在 202 之前的窗口）会同时显示旧回答和新回答，与权威历史不一致。

2026-09-29 owner 拍板采用方案 B，只改 web：收到一条事件，其 `messageId` 不在当前视图里，且末条助手行已是终态时，不在本地追加，改为走连接器的恢复路径重新拉取权威快照，保持游标不回退。不改服务端契约。

## What Changes
- `connectSessionEvents` 的返回句柄新增 `resync()`：以与 open 相同的方式开启一次完整快照恢复（废弃队列、使旧加载失效、只安装未倒退的快照），不调用 `onGap`。
- 纯函数 `isUnknownTurn(view, event)`（放在 `stream.ts` 或邻近的纯模块）：事件的 `messageId` 不在 `view.messages` 中，且视图里存在助手行、末条助手行状态为 `done`/`failed`/`stopped` 时为真。
- 会话页：`onEvent` 对满足 `isUnknownTurn` 的事件不做归约，并请求当前连接 `resync()`，同一次恢复只请求一次；恢复安装的快照整体替换视图。
- spec：chat-web ADDED「连接器按需重新同步」「未知回合触发重新同步」。

## Capabilities
- ADDED chat-web「连接器按需重新同步」、「未知回合触发重新同步」。

## Impact
- `web/src/features/chat/stream.ts`（连接器句柄、判定函数）、`web/src/features/chat/page.tsx`（`onEvent` 接线）。服务端零改动。
- 代价：本视图不认识的新回合会多一次快照 GET；本页发起的 prompt 或 regenerate 如果新回合事件先于 202 到达，也会多一次（由测试锁定次数）。这种次序下，本页 prompt 的审批条会晚一次快照往返才出现（既有测试 A13 按此改写）。
