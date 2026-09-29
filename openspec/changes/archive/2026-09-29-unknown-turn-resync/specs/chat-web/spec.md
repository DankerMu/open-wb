## ADDED Requirements

### Requirement: 连接器按需重新同步
`connectSessionEvents` 返回的句柄 SHALL 在 `close` 之外提供 `resync()`。未关闭时，`resync()` SHALL 以与 open 相同的方式开启一次新的完整快照恢复：使旧加载失效（abort 且其迟到结果不安装）、废弃待处理队列、经 `loadSnapshot(signal)` 取快照，只安装属于当前会话且未倒退的快照（倒退则关闭并报告），恢复期间到达的帧排队、安装后按既有游标规则只交付后继；`resync()` SHALL 不调用 `onGap`。已关闭后调用 SHALL 为空操作，不再加载。

#### Scenario: 已安装快照后按需恢复
- **WHEN** 连接已安装快照并交付若干事件后调用 `resync()`，恢复期间又到达两帧，其中一帧游标不超过新快照游标
- **THEN** `loadSnapshot` 恰多调用一次、`onGap` 未调用；新快照经 `onSnapshot` 安装后只交付游标后继那一帧

#### Scenario: 恢复被替代与关闭后调用
- **WHEN** 恢复加载未完成时再次 `resync()`，随后旧加载才完成；或 `close()` 之后调用 `resync()`
- **THEN** 旧加载已 abort 且其结果不安装，由新加载负责恢复；关闭后的调用不触发任何加载或回调

### Requirement: 未知回合触发重新同步
会话页收到一条事件时，若其 `messageId` 不在当前视图的消息中，且视图中存在 assistant 消息、末条 assistant 的状态为 `done`、`failed` 或 `stopped`，页面 SHALL 不把该事件交给归约器，而 SHALL 请求投递该事件的那条连接 `resync()`；同一条连接在其恢复快照安装之前 SHALL 至多请求一次，连接已被关闭或替换时 SHALL 不再请求。恢复快照经既有 `onSnapshot` 整体替换视图。判定 SHALL 基于不落后于已安装快照与已归约事件的视图；页面状态更新函数 SHALL 保持纯函数，不在其中发起 `resync`。视图无 assistant 消息或末条 assistant 仍为 `running` 时，未知 `messageId` 的事件保持既有归约行为。已知 `messageId` 的事件照常归约，不产生额外快照请求。

#### Scenario: 其它标签页的 regenerate 收敛到权威历史
- **WHEN** 页面装入含 user u1 与 done 助手 X（正文 "old"）的快照且未发起任何操作，其连接随后到达新 id Y 的 `turn.start`、`text.delta("new")`、`turn.end(done)`，恢复快照只含 u1 与 done 助手 Y（"new"）
- **THEN** 最终恰一个助手 article，含 "new" 不含 "old"；快照请求恰比无此事件时多一次（StrictMode 下同样恰多一次）

#### Scenario: 本页操作的事件次序
- **WHEN** 本页 regenerate 或 prompt 的 202 先于新回合事件到达，或新回合事件先于 202 到达
- **THEN** 两种次序下最终视图都与权威快照一致、无重复助手行；前者不产生额外快照请求，后者恰多一次

#### Scenario: 正常流式回合不受影响
- **WHEN** 视图末条 assistant 为 running 的 Y，随后到达 Y 的 `text.delta` 与 `turn.end(done)`
- **THEN** 事件照常归约，不产生额外快照请求
