# Design: unknown-turn-resync（#633）

Change surface:
- `web/src/features/chat/stream.ts`：`connectSessionEvents` 返回 `{ close, resync }`；新增纯函数 `isUnknownTurn(view, event)`（若 `stream.ts` 超过 800 行上限则放进邻近的纯模块）。
- `web/src/features/chat/page.tsx`：`openSource` 的 `onEvent` 接线与触发 `resync` 的机制。

Must preserve:
- 归约器 `applyChatEvent` 的语义与纯度不变（spec「纯会话视图归约」逐字不变：未知 assistant 仍可被补建——只是页面在本规则命中时不再把事件交给它）。
- 连接器既有恢复语义不变：open/gap/溢出/非法帧的恢复、generation 失效、未倒退才安装、watermark 去重、close 幂等。
- 本页 prompt 与 regenerate 的既有流程（202 后 close → GET → `installSnapshot` + `openSource`，`turn-actions.ts:181-195`、`:331-336`）、锁定、失败内联、`chat-regenerate-button.test.tsx` R3「助手 article 仍为 1 个」。
- **有意的行为变化（唯一例外）**：本页 prompt 的新回合事件若先于 202 到达，且视图末条 assistant 已终态，这些事件（含 `approval.request`）不再在 202 前直接渲染，而是等恢复快照装入后出现，多一次快照往返。受影响的既有测试 `web/test/chat-approval-bar.test.tsx:603` A13 按下文改写，这是 tasks 2.3「只允许加强」的唯一授权例外。
- 已知 `messageId` 的事件（包括视图里末条助手行仍 running 时的正常流式回合）照常归约，不产生额外 GET。
- 页面所有 `setHistoryState` 更新函数保持纯（StrictMode 双调用安全）；不在更新函数里调用 `resync` 或任何副作用。

Must add/change:
1. 连接器 `resync()`：未关闭时等同一次 `beginRecovery()`（不带 `notifyGap`）：generation 自增、旧加载 abort、队列清空、`recovering=true`，经 `loadSnapshot` 取完整快照，按既有规则安装（倒退则 `fail`）；恢复期间到达的帧排队、安装后按游标过滤再交付。已关闭时为空操作。
2. `isUnknownTurn(view, event)`：`event.data.messageId` 不在 `view.messages` 的 id 集合中，且 `view.messages` 中存在 assistant 行、其中末条 assistant 的状态 ∈ {`done`,`failed`,`stopped`} 时返回 true；否则 false。纯函数，不读时间与外部状态。
3. 会话页：
   - `onEvent` 收到事件时，若对当时的权威视图 `isUnknownTurn` 为真：不归约该事件，并请求**投递该事件的那条连接** `resync()`。同一条连接在其恢复快照安装之前至多请求一次。
   - 机制由实现者选择，但必须满足：判定使用的视图不落后于已安装的快照与已归约的事件（例如在更新函数中判定、以状态标记驱动 effect 调用 `resync`；或同步维护的视图引用）；若那条连接在请求发出前已被关闭或替换（例如本页 202 后的对账 `openSource`），不再请求。
   - 恢复快照经既有 `onSnapshot` → `installSnapshot` 整体替换视图。连接器在恢复期间不交付事件，所以同一回合的后续帧不会再次触发；快照之后到达的后继帧，其 `messageId` 已在视图中，正常归约。
   - 视图中没有 assistant 行（新会话首回合）或末条 assistant 仍 running 时，未知 `messageId` 的事件照旧交给归约器（保持既有行为）。

Governing invariant: 页面视图中的 assistant 行集合只来自权威快照或对已知行的归约；当末条 assistant 已终态时，未知 `messageId` 的事件永远不会在本地变成新的一行，而是经一次未倒退的完整快照收敛到权威历史。

Sibling surfaces:
- 本页 prompt/regenerate 在 202 之前到达的新回合事件：同样命中本规则，多一次恢复 GET；随后 202 的对账 `openSource` 关闭该连接（恢复加载被 close abort 或安装后被替换），最终视图由对账快照决定。
- 连接器的 open 恢复：每次（重）连接本来就会拉一次快照；`resync` 与之共用同一恢复路径与 generation 失效。
- `reconcileSettled`（`turn-actions.ts:241`）：approval 409 与非「未提交」类的 regenerate 错误（如 502）走这条路径，旧连接一直开着直到对账快照到达，本规则同样可能在该连接上命中；预期多一次 GET，最终视图由最后装入的快照决定（连接器 generation 保证迟到结果不安装）。
- 兄弟现象（其它标签页 prompt 时本页缺用户行）：末条 assistant 终态时由同一规则收敛，本刀不另加测试以外的处理。
- `web/test/chat-page-support.tsx` 与 `chat-stream-support.ts` 的假 EventSource/假 API：新测试沿用，不改其既有行为。

Seams under test: `connectSessionEvents`（假 EventSourceCtor + 假 `loadSnapshot`）；`isUnknownTurn` 单元；真实 `ChatPage` 组件在 jsdom 中，经既有页面测试支撑（假 API 客户端计数 `getMessages`、假 EventSource 发命名帧）。

Required evidence（通用输入约定：假 EventSource 不会自动 open，发帧前测试显式 `emitOpen()`，基线里的「open 恢复」GET 由此产生；恢复快照的 `streamCursor` SHALL ≥ 最后一帧游标，例如帧 `1:1`–`1:3`、快照 `1:3`，否则连接器按倒退 `fail`；`getMessages` 以 `calls(fetchMock, MESSAGES)` 计数，按阶段切换响应沿用 `chat-regenerate-button.test.tsx:82-96` 的做法）:
- C1 连接器 `resync`：
  - 已安装快照后调用 `resync()` → `loadSnapshot` 恰多调一次，`onGap` 未调用；恢复期间到达的帧排队，快照安装后只交付游标后继。
  - 恢复进行中再次 `resync()` → 旧加载被 abort、其迟到结果不安装。
  - 快照游标倒退 → 按既有规则 `onError`。
  - `close()` 之后 `resync()` 为空操作，不再调用 `loadSnapshot`。
- U1 `isUnknownTurn`：已知 id → false；未知 id 且末条 assistant 为 done/failed/stopped → true；未知 id 且末条 assistant running → false；视图无 assistant → false。
- P1（issue 验收 1、2，其它标签页）：页面装入快照 u1 + 助手 X（done，正文 "old"），未发起任何操作；该连接依次到达新 id Y 的 `turn.start`、`text.delta("new")`、`turn.end(done)`，恢复 GET 返回权威快照 u1 + Y（done，"new"）。三帧在同一个 `act()` 批次里发出。断言：最终助手 article 恰 1 个，含 "new" 不含 "old"；无流错误 alert，composer 已解锁；`getMessages` 次数恰为「首次加载 + open 恢复 + 1」（写死总数）。续测：Y 的快照装入后，同一连接再到达新 id Z 的 `turn.start`/`text.delta`/`turn.end`（恢复快照只含 u1 与 Z），`getMessages` 恰再多 1，助手 article 仍恰 1 个——证明「至多一次」在快照装入后复位。master 上为红（2 个 article）。
- P2 正常流式回合不受影响：视图末条 assistant 为 running 的已知 Y，到达 Y 的 delta/turn.end → 正常归约，`getMessages` 次数无增加。
- P3 本页 regenerate，202 先于新回合事件：沿用 R3 场景，`getMessages` 次数与改动前相同，助手 article 恰 1 个。
- P4 本页 regenerate，新回合事件先于 202 到达：中间窗口断言——事件到达、恢复快照已装入、202 仍挂起时，助手 article 恰 1 个（master 上此刻为 2 个，是真正的红）；202 后最终助手 article 恰 1 个；`getMessages` 次数恰比 P3 多 1。
- P5 本页 prompt，新回合事件（`turn.start` 与 `approval.request`）先于 202 到达，恢复快照为含新助手与 pending 审批的 running 快照：恢复快照装入后审批条出现且可作答；最终 user/assistant 行与权威快照一致、无重复；`getMessages` 次数恰比 P5′ 多 1。
- P5′ 本页 prompt，202 先于新回合事件到达（同 P5 的快照与帧）：审批条在 202 对账后出现且可作答，无重复行；`getMessages` 次数为改动前的基线（写死总数）。
- A13 改写（`chat-approval-bar.test.tsx:603`）：帧到达之前把 `page.snapshot` 设为含助手 2 与 pending 审批 9、游标 ≥ `1:2` 的 running 快照；flush 恢复快照之后再断言审批条并作答；GET 次数按新基线重写。其余断言（作答不解锁在途 prompt 等）保持不变。
- P6 StrictMode 下 P1 仍恰一次恢复 GET。
- 红：P1、P4（中间窗口断言）在 master 上为红（重复 article）；C1、U1 在 master 上为红（无 `resync`/`isUnknownTurn`）。变异：去掉「末条 assistant 终态」条件（未知 id 一律 resync）→ U1 红；若实现使用显式的「已请求」标记，去掉该标记的复位 → P1 续测红，去掉该标记本身 → P1/P6 次数断言红（三帧同批发出时才可判别；实现若在 `onEvent` 同步调用 `resync`，连接器进入 recovering 后本就不再交付，此变异不适用，报告中注明）。

Review focus:
1. 判定所用视图不落后（同一 drain 批次内、快照刚安装后的帧）；更新函数保持纯。
2. `resync` 走既有恢复路径，游标不倒退，旧加载失效，close 后为空操作。
3. 请求只发给投递事件的那条连接；连接被替换后不误发。
4. GET 次数断言覆盖其它标签页、本页 202 前后两种次序。
5. 既有测试零放宽。

Non-goals:
- 服务端事件契约（方案 A）。
- `installSnapshot`/`loadHistory` 比较快照游标以丢弃迟到的旧快照（issue「附带」项，同页罕见变体）。
- 通用多标签页实时同步；视图无 assistant 行时的首回合兄弟现象。

Open Questions: 无。
