# Design: public-retire（#516）

父设计：design D3 第 3 步（`retire(sessionId)`、`subscribe` 可选 `onEnd`、`sse.ts` 以 `endOwned` 闭包传入）、「落刀次序（三刀）」、Sketch seams「supervisor 公开 retire（4.3a 的独立 seam）」。行号为 origin/master。

- **Change surface**：`server/src/sessions/supervisor.ts` 的 `subscribe`（:216-244）、`sessionStreamSubscriberCount`（:246-248）、`#subscribers` 声明（:106）、`#listenersFor`/`#removeListener`/`#fanout`（:682-715）、新增公开 `retire`；文件底部 `throwCollected`/`asError`/`synchronousSinkViolation`（:766-798）搬至新建 `server/src/sessions/supervisor-faults.ts`；`server/src/sessions/stream/sse.ts:162` 的 `subscribe` 调用；新测试 `server/test/session-retire.test.ts`。
- **Must preserve**：
  - 三参 `subscribe(sessionId, lastEventId, deliver)` 的返回形状、replay/gap/fresh 判定、`unsubscribe` 语义与 `#fanout` 对抛错 deliver 的移除逐字不变；`sessionStreamSubscriberCount` 语义不变。
  - `shutdown()`（:278）仍只 `#subscribers.clear()`、**不**调用任何 `onEnd`（关停时 SSE 连接由 app 关闭路径处理，现状）。
  - `#retireSlot` 本身零改动（关停、token 撤销 `generation.revoked`、`sealGeneration`、`infraFaulted` 时 abandon 审批、`#pool.release`、同一 slot 才从 `#slots` 删除）。
  - `sse.ts` 其它路径（replay/gap/背压/心跳/物理断开/closing）逐字不变；`onEnd` 只经 `endOwned`，不经 `writeFrame`/`writeLive`/`gapFrame`。
  - 三个搬迁函数逐字搬迁、行为不变；`approvals.ts`/`index.ts` 各自的 `asError` 副本不动（非本刀范围）。
  - `session-supervisor-subscribe.test.ts`、`session-sse.test.ts` 及其它既有测试零改动全绿。
- **Must add/change**：
  - 订阅集：`#subscribers: Map<string, Map<SessionStreamLiveHandler, (() => void) | undefined>>`；`subscribe` 第四参 `onEnd?: () => void`，以 `listeners.set(deliver, onEnd)` 登记；`#removeListener` 用 `delete`；`#fanout` 迭代 `[...listeners.keys()]`；`sessionStreamSubscriberCount` 用 `.size`。同一 `deliver` 重复订阅按 Map 键去重（与 Set 现状相同）。
  - `retire`（公开，`Promise<void>`，文档注释注明「删除的回收原语：结束订阅者但不发事件，不写任何 SQLite 行」）：
    ```ts
    async retire(sessionId: string): Promise<void> {
      const slot = this.#slots.get(sessionId);
      if (slot !== undefined) {
        await this.#retireSlot(slot);
      }
      const listeners = this.#subscribers.get(sessionId);
      this.#subscribers.delete(sessionId);
      for (const onEnd of listeners?.values() ?? []) {
        try {
          onEnd?.();
        } catch {
          /* one subscriber's close cannot keep the others open (mirrors #fanout) */
        }
      }
    }
    ```
    - 次序依 spec：先等原生退出（`#retireSlot` 等 `slot.retiring = runtime.shutdown()`）与 slot 丢弃，再取订阅集——`await` 期间新到的订阅也被结束；事件环归属 generation（`generation.ring`），slot 丢弃即环丢弃，无另设的环映射。
    - 「不发布任何事件」的真实保证：空闲 slot 上**没有任何路径走到 `#publish`**——无 pump（上一回合 `pump.finally` 已跑完，`pumpCount`/`dispatchCount` 为 0）、无已登记审批、`infraFaulted` 为 false 故不 abandon。`#retireSlot` 内的同步封存（:726-727 → `pool.ts:307-316`）只拦 `#publish` 的 ring/`#fanout` 半（:645），**不拦** `#onEvent`（:652-656）；因此证据 1 同时断言 SSE 字节与 `onEvent` 序列都不变。
    - 前置条件（JSDoc 写明）：调用方保证该会话 `activeTurn === null`。running 会话上 retire 会经 `runtime.shutdown()` → `#failActiveTurn`（`runtime.ts:207`）→ pump 失败路径 `#commit`/`persistEvent` 写行并发布，`infraFaulted` 时 `abandon` 还会写审批行（`approvals.ts:178`），与 spec 的「SHALL NOT write any SQLite row」冲突；running 会话由 4.3b 的过渡 409 与 4.3c 的停止—等终态路径负责，本刀不加运行时闸门。
    - 无 slot（从未 spawn、已被闲置回收或已 retire、supervisor 已 `shutdown()`）→ 只做订阅集处理后 resolve：不 spawn、不触 store、不升 epoch。
    - 不 `#track`：`shutdown()` 自行 retire 全部 slot 并等待同一 `slot.retiring`。
    - 与并发 prompt/regenerate/fork 的竞态不在本刀排除（4.3b 以控制占用与墓碑承担），不加额外闸门。
  - `sse.ts`：`options.supervisor.subscribe(sessionId, lastEventId, deliver, () => { endOwned(connection, options.clock); })`。`endOwned` → `releaseLogical`（停心跳、`connection.unsubscribe()` 链到 `subscription.unsubscribe()`，此时订阅集已删，`#removeListener` 无操作）→ `raw.end()`。
  - `supervisor-faults.ts`：导出 `throwCollected`、`asError`、`synchronousSinkViolation`（逐字搬迁）；supervisor 改为 `import { asError, synchronousSinkViolation, throwCollected } from "./supervisor-faults.js";`。与 issue PR Boundary 的偏差：issue 只列 `supervisor.ts`/`sse.ts`/测试；`supervisor.ts` 现 798 行、本刀净增约 20 行，必须搬出无关代码才能守住 size-guard，纯函数搬迁是最小手段（父 tasks 说明「B 不再拆既有文件」针对新功能代码落点，此处为守 800 行的纯搬迁，PR 中记录）。
- **Sibling surfaces**：`session-delete.ts`（4.3b，尚不存在）是 `retire` 唯一预定调用方；`sessions/index.ts` 只暴露 supervisor 句柄；web 不变。
- **Required evidence**（`server/test/session-retire.test.ts`；supervisor 经 `openRecordingSession`/`openBareSession` 真实 app + `createRealFakeRuntime()` 真实 fake-omp 子进程；SSE 经 `session-sse-helpers.ts` 的 `openEventStream` 走真实 `GET /api/sessions/:id/events`。RED：全部用例在实现前因 `retire` 不存在而红（typecheck-red + 运行时 TypeError），记录；证据 3 的「三参订阅不受影响」半为 characterization 守卫）：
  1. **idle 会话 retire**：prompt 一回合至 `done`（子进程保持空闲存活，`IDLE_MS` 未到），记下该回合 spawn 的 token（`requiredToken`）、子进程句柄、`liveProcessCount()===1`、`streamCursor` 的 epoch；打开两个 SSE 订阅并读到当前字节快照；对库内全部表做全行快照（经 `sqlite_master` 枚举 `type='table'` 的每张表 `SELECT *`，按 rowid 排序；覆盖 `chat_sessions`/`chat_messages`/`chat_steps`/`chat_approvals`/`audit_events` 等）；记下 `world.events.length` 与该回合最后事件 id `E:lastSeq`。`await supervisor.retire(session)` 后：子进程已退出（`exitCode`/`signalCode` 非 null 或 `exit` 事件已触发）；`fixture.tokens.lookup(token) === null`（即 `model-proxy/index.ts:201` 的认证判定）；`liveProcessCount()===0`；两个 SSE 响应均已结束（流 `end`/`raw.writableEnded`）且结束时累计字节与 retire 前快照逐字节相同（无新帧，含无 `replay.gap`）；`sessionStreamSubscriberCount(session)===0`；全表快照与 retire 前 `toEqual`；spawn 调用数不变；`world.events.length` 不变（`onEvent` 通道无新事件）且 `world.errors` `toEqual([])`；slot 与事件环已丢弃：`streamCursor(session)` 为 `{ epoch: E, seq: null }`，`supervisor.subscribe(session, "E:lastSeq", deliver)` 返回 `mode:"gap"`、`replay:[]`（`#readReplay` :673-676），随后 `unsubscribe()`。
  2. **之后 prompt 与重复/无 generation 的 retire**：同一会话再 prompt 一回合至 `done` → spawn 调用数 +1、新 generation 的 `streamCursor.epoch` 等于 retire 前 epoch + 1（并与 `chat_sessions.stream_epoch` 一致）。另：对刚完成 retire（无 slot）的会话再 `retire` 与对从未 prompt 的新会话（带一个 SSE 订阅）`retire` → 均 resolve；spawn 调用数、全表快照、`streamCursor.epoch` 不变；新会话的 SSE 订阅被结束且无新帧。
  3. **未传 `onEnd` 的订阅者**：直接 `supervisor.subscribe(session, null, deliver)`（三参）登记，`retire` 后 `sessionStreamSubscriberCount===0`、`deliver` 未被调用；随后在该会话 prompt 一回合至 `done`，`deliver` 仍零调用（已移出订阅集，新订阅照常收到事件作为对照）。
  4. **retire 期间的订阅**：`const pending = supervisor.retire(session)` 后的**下一条同步语句**直接 `supervisor.subscribe(session, null, deliver, onEnd)`（retire 同步执行到 `#retireSlot` 的 `await slot.retiring` 才挂起，该窗口确定存在；不得用异步的 `openEventStream` 登记）→ `await pending` 后 `onEnd` 恰被调用一次、`deliver` 零调用、订阅集清空。
  5. **onEnd 抛错隔离**：同一会话两个直接订阅者，第一个 `onEnd` 抛错、第二个记录调用 → `retire` resolve、第二个 `onEnd` 被调用一次、订阅集清空。
  6. `session-supervisor-subscribe.test.ts`、`session-sse.test.ts`、`session-sse-lifecycle.test.ts` 零改动全绿；`bash scripts/size-guard.sh` 退出 0 并在 PR 记录 `supervisor.ts` 合入后行数。
