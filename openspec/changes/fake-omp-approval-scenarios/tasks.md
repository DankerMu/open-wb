# Tasks: fake-omp-approval-scenarios（#458）

## 6. omp-test-harness — fake-omp

- [ ] 6.3 scenario `approval`（解析 `--approval-mode`；仅 argv 含 `write` 时按真实次序先发 `tool_execution_start` 再发审批 select，未应答不发后续帧；`Approve` 继续、`Deny` 发 `tool_execution_end{isError}` 再完成）、`approval-parallel`（同一回合两个 bash 同时发两个 select，分别应答各发自己的 `tool_execution_end`；两条都应答后：至少一条 `Approve` 且未收到 abort → 正常完成；全部为拒绝且未收到 abort → 同 `abort-ok` 挂起等待 abort；任一 select 挂起时到达的 `abort` 在两条都被应答前不产生任何帧，之后以 `message_end aborted`、`agent_end`、`response{command:"abort"}` 兑现）、`approval-then-abort`（select 挂起时收到 abort 不响应，直到 select 被应答并发出其 `tool_execution_end` 后兑现；应答后未收到 abort 则同 `abort-ok` 挂起等待 abort，不发完成帧——宿主「先 Deny 后 abort」的停止次序因此得到确定的 aborted 收尾）。验证：新建契约测试断言三场景帧序列与 `yolo` 下不发 select；`approval-parallel` 两条挂起时收到 abort → 无帧，两条均 Deny 后两个 `tool_execution_end{isError}`，再 aborted 结束；两条均 Deny 且无 abort → 挂起；一条 Approve 一条 Deny → 正常完成；`approval-then-abort` 先 Deny 后 abort → aborted 结束

## 实现要点与必需证据

### 帧形状（钉在 omp v18.0.10 `33cc6b9a`；`coding-agent/` 与 `agent/` 指 `resource/oh-my-pi/packages/` 下的包）
常量：`C1 = {id:"tool-1", name:"bash", args:{command:"echo workbuddy-smoke"}}`（即既有 `TOOL_ID`/`TOOL_NAME` 与 `normal` 的参数）；`C2 = {id:"tool-2", name:"bash", args:{command:"echo workbuddy-smoke-2"}}`（只在 parallel 中出现）。两个调用的成功输出都是既有 `TOOL_OUTPUT`（`"workbuddy-smoke"`），不随命令变化。
- toolUse 结束（仅门控启用时）：`{type:"message_end", message:{role:"assistant", content:[{type:"toolCall", id, name:"bash", arguments:<args>}…], stopReason:"toolUse"}}`。每个调用一块，按调用顺序排列。块形状依据 `ai/src/types.ts:827-831`；归约器不读 `content`（`server/src/sessions/events.ts:212-219`）。
- `tool_execution_start`：`{type:"tool_execution_start", toolCallId, toolName:"bash", args}`，与 `emitToolRound`（`fake-omp.mjs:415-420`）同形。依据 `agent/src/agent-loop.ts:2548-2554`：`intent` 为 undefined 时被 JSON 丢弃。真实 omp 先发 start，再在 `tool.execute` 内部由 wrapper 询问（父 D8）。
- 审批 select：`{type:"extension_ui_request", id:"r1"|"r2", method:"select", title:"Allow tool: bash\nCommand: <args.command>", options:["Approve","Deny"]}`，恰这五个键。依据：
  - 调用点 `coding-agent/src/extensibility/extensions/wrapper.ts:332` 调 `select(prompt, ["Approve","Deny"])`，不传 dialogOptions。
  - 标题由 `tools/approval.ts:267-287` 与 `tools/bash.ts:580-584` 生成：`Allow tool: bash` 加一行 `Command: …`；无 reason 时没有 `Reason:` 行。
  - 帧由 `modes/rpc/rpc-mode.ts:546-581,692` 输出：字符串 options 不产生 `optionDetails`，`timeout: undefined` 被 JSON 丢弃。
  - 这个形状恰好满足父 omp-runtime「RPC IO and child observation」的识别规则：`method` 为 `select`、options 恰为 `["Approve","Deny"]`、title 以 `Allow tool: ` 开头，首行解析出 `tool=bash`。
  - id 按调用顺序分配 `r1`、`r2`（#464 验收字面依赖）。真实 omp 为 Snowflake（`rpc-mode.ts:656`）。
- 成功结束（Approve）：`{type:"tool_execution_end", toolCallId, toolName:"bash", result:{content:[{type:"text",text:"workbuddy-smoke"}], details:{exitCode:0}}}`，不带 `isError` 键，与 `emitToolRound`（`:421-426`）逐字相同。
- 拒绝结束（非 Approve）：`{type:"tool_execution_end", toolCallId, toolName:"bash", result:{content:[{type:"text",text:"Tool call denied by user: bash"}], details:{}}, isError:true}`。依据：`wrapper.ts:337-340` 抛出该消息；`agent-loop.ts:2625-2631` 把异常转成 `{content:[{type:"text",text:e.message}],details:{}}` 与 `isError=true`；`:2690` 与 `:2465-2471` 负责成帧。
  - `Deny`、其它值、缺少 value、`cancelled` 为真（即使同时带 `value:"Approve"`）都产生这一个字节相同的帧。依据：`rpc-mode.ts:524-531` 在 cancelled 为真值时返回 undefined，`wrapper.ts:337` 的判断是 `choice === "Approve"`。
- 正常完成：既有 `finishTurn()`（`:430-436`），即 `message_end{role:"assistant",content:[],stopReason:"stop"}` 加 `agent_end{messages:[],isTerminal:true}`。父 spec parallel 段写的「normal text」按 `normal` 理解，也就是工具轮之前的 3 段 delta；工具之后不追加 delta。
- aborted 三帧：`message_end{role:"assistant",content:[],stopReason:"aborted"}`、`agent_end{messages:[],isTerminal:true}`、`{id:<abort id>,type:"response",command:"abort",success:true}`。与 #456 的 `handleAbort`（`:373-378`）逐字相同，不带 `data`（`rpc-mode.ts:743-752,1086-1088`）。
- 未知或重复的应答 id：真实 omp 在 `rpc-mode.ts:280-285` 查不到挂起项时静默丢弃；应答后 `cleanup`（`:660-664`）删除该 id，重复应答同样查不到。fake 同样不发帧、不改状态。
- abort 等 select：审批 select 不带 signal，`requestRpcDialog` 不挂 abort 监听（`rpc-mode.ts:654,665-675`），只有应答能兑现它。另外，`extension_ui_response` 是越过串行命令队列的控制帧（`rpc-mode.ts:280-285,365`），`abort` 则是串行命令（`:1086-1088`）。

### 夹具实现（`fake-omp.mjs`，净增目标 60–80 行、≤100 行；超出须在 PR body 说明原因）
- `parseArgs`（`:81-95`）增加 `--approval-mode`，与既有键一样取最后一次出现的值。helper 的 `OMP_FLAGS` 已带 `--approval-mode yolo`（`fake-omp-helpers.ts:20-21`），`extraArgs` 追加在其后（`:65`）；`session-supervisor-helpers.ts:95-100` 把 `--scenario` 追加在生产 argv 之后。
- 按 design.md 状态表实现：
  - 新增 `APPROVAL_SCENARIOS`、`gated`、`pendingSelects`（`Map<selectId, call>`，与 `pendingUi` 分开）、`approvedAny`、`deferredAbort`；`abortTurn` 增加 `selecting` 态。
  - `dispatch` 在 `gated` 时把 `extension_ui_response` 映射到新处理器，否则仍映射到 `handleUi`。`abort` 处理器注册在 `ABORT_SCENARIOS` 或（`gated` 且 scenario ≠ `approval`）时。
  - `handlePrompt` 在 `gated && abortTurn === "idle"` 时发门控回合并**返回**，写在既有 `ABORT_SCENARIOS` 分支旁。
  - `handleAbort`：`selecting` 态执行 `deferredAbort ??= {id}` 后返回；随后保持原有判断，即 `scenario === "abort-ignored"` 或非 `pending` 时返回，否则调 `emitAbortedEnd(frame.id)`。
  - aborted 三帧抽成 `emitAbortedEnd(id)`，它负责置 `abortTurn = "done"`。成功结束帧可以从 `emitToolRound` 抽成 `toolEnd(call)`，但必须逐字节不变（证据 11 守护）。
- 不给 `approval-chain-abort-ignored`（6.6）预留分支；6.6 在同一状态机上扩展。

### 后续消费者依赖的契约
- 2.1a #460（`approval`）：
  - select 帧形状即识别规则的正例；`r1` 挂起期间 fake 不发任何帧。
  - `{id:"r1",value:"Approve"}` 之后是成功结束与正常完成；`{id:"r1",value:"Deny"}` 之后是拒绝结束与正常完成。
  - fake 静默忽略重复应答，所以「第二次调用不写帧」必须靠回合后 probe 的 `frames=`（6.4 #459）或 stdin 计数证明，不能靠 fake 输出。
  - 回合结束后的 probe prompt 走缺省路径。
- 4.3 #464（`approval`、`approval-parallel`）：
  - `r1`/`r2` 固定；每条应答只结束自己的调用；超时由宿主发 `Approve`，其后与 allow 完全相同。
  - 两条 select 背靠背发出，没有时间间隔。#464「`r2` 于 T+5000 到达」的时间差只能由宿主的注入时钟在处理 `r1` 与 `r2` 之间推进来制造，fake 不提供。
- 4.2a #473（`approval-then-abort`、`approval-parallel`）：
  - 宿主先 Deny 全部再写 abort 时，结尾确定为 aborted 三帧：两条 select 挂起时 abort 被延后；全部拒绝后回合挂起，等待 abort。
  - abort 被延后时，`response{command:"abort"}` 在最后一条 `tool_execution_end` 之后才到达。runtime 的 `abort()` 在这段时间内处于挂起，这是预期行为。
  - 回合结束后的 probe prompt 走缺省路径。
- 4.6 #474：直接使用 6.6 的场景；「Deny 先于 abort」的帧序以本场景和 #473 为证。
- 6.6 #470：复用 select 形状、`r1`/`r2`、拒绝帧与状态机。
- 6.5 #461：复用 `emitAbortedEnd`。

### 必需证据
新建 `server/test/fake-omp-approval.test.ts`，只用 `fake-omp-helpers.ts` 的 `startFake`/`startPromptedSession`/`HANDSHAKE`/`PROMPT`/`response`/`isTextDelta`/`asRecord`/`closeSession`/`stopFakeChildren`，helper 不改。
- 约定：`WRITE = ["--approval-mode","write"]`；`QUIET_MS = 300`；`afterEach(stopFakeChildren)`。
- 观察窗统一写成 `await expect(session.wait(() => session.frames.length > n, QUIET_MS)).rejects.toThrow(/timed out/)`。helper 的超时分支报 `timed out`（`fake-omp-helpers.ts:127-129`），进程退出分支报 `child exited before frame`（`:138-144`），所以这一条断言同时证明「无帧」和「存活」。
- 「新增帧恰为 X」的写法：先 `wait(() => frames.length >= n + k)`，再开观察窗，最后对 `frames.slice(n)` 做 `toEqual`。
- 每个进程内的请求 id 唯一（`wait` 在全部已收帧中查找）：后续 prompt 用 `req_2`，abort 用 `req_abort`，状态探针用 `state-2`。
- `ACK(n)` 指 `response(id,"prompt")` 帧之后的帧；`SELECTED(k)` 指门控前缀：`agent_start`、3 段 delta、toolUse `message_end`、k 个 start、k 个 select。

1. `approval` Approve（先红）
   - 输入：`startPromptedSession({scenario:"approval", extraArgs:WRITE})`。
   - 期望：
     - ack 之后恰为 `agent_start`、`Hello `/`from `/`fake-omp` 三段 delta、toolUse `message_end`（`content` 恰为 C1 的 toolCall 块）、C1 的 start、`r1` select，全部按上文形状 `toEqual`；随后观察窗无帧。
     - 写 `{type:"extension_ui_response",id:"r1",value:"Approve"}` 后，新增帧恰为：C1 成功结束（`toEqual` 上文形状，`"isError" in frame === false`）、`message_end stop`、`agent_end isTerminal:true`；随后观察窗无帧。
   - 为何先红：场景未实现时回落为 `normal`，没有 select，`wait(select)` 超时。
2. `approval` 拒绝四态（先红，`it.each`）
   - 输入：分别以 `{value:"Deny"}`、`{cancelled:true}`、`{value:"approve"}`、`{cancelled:true,value:"Approve"}` 应答 `r1`。
   - 期望：新增帧恰为 C1 拒绝结束（`toEqual` 上文形状，`isError:true`）、`message_end stop`、`agent_end`，四个实例逐字节相同。
3. `approval` 队列与 id（先红）
   - 输入：select 挂起时写 `{id:"state-2",type:"get_state"}`，然后写 `{type:"extension_ui_response",id:"no-such",value:"Approve"}`；再以 Approve 应答 `r1` 直至 `agent_end`；然后写重复应答 `{…id:"r1",value:"Deny"}`；最后写 `{id:"req_2",type:"prompt",message:"again"}`。
   - 期望：
     - `state-2` 得到应答，证明 prompt handler 已返回，队列没有被阻塞。spec 所说的「no further frame」指回合帧，命令应答不在此列，与既有 `extension-ui` 用例的 `probe-ui` 相同（`fake-omp.test.ts:257-258`）。
     - 未知 id 之后观察窗无帧，且之后 Approve 仍然生效。
     - 重复应答之后观察窗无帧。
     - `req_2` 得到 ack 与完整的缺省回合：≥3 段 delta、成对的 start/end、`message_end stop`、终止 `agent_end`，没有 `extension_ui_request`。这证明 `done` 态走缺省路径。
4. yolo 守卫（恒绿）
   - 输入：`it.each` 遍历 `approval`、`approval-parallel`、`approval-then-abort`，每个用例各起三个进程：一个 `normal` 基线，以及以下两个变体：一个 `startPromptedSession({scenario})`（helper 缺省 yolo），一个 `startPromptedSession({scenario, extraArgs:[...WRITE,"--approval-mode","yolo"]})`（验证取最后一次）。每个进程都等到终止 `agent_end`，再写 `{type:"abort",id:"req_abort"}`，然后等 `command==="abort"` 的应答。
   - 期望：两个变体的完整 `frames` 都与同一用例内的 `normal` 基线 `toEqual`，都不含 `extension_ui_request`，abort 都得到既有无 id 的 `unsupported`。
   - 为何恒绿：未实现时未知场景本来就回落为 `normal`。
5. `approval-parallel` 先 Deny `r2` 再 Approve `r1`（先红）
   - 输入：`startPromptedSession({scenario:"approval-parallel", extraArgs:WRITE})`。
   - 期望：
     - ack 之后恰为 `agent_start`、3 段 delta、toolUse `message_end`（C1、C2 两块）、C1 start、C2 start、`r1` select（`Command: echo workbuddy-smoke`）、`r2` select（`Command: echo workbuddy-smoke-2`）；随后观察窗无帧。
     - 写 `r2` Deny 后，新增帧恰为一帧 C2 拒绝结束；随后观察窗无帧。
     - 写 `r1` Approve 后，新增帧恰为 C1 成功结束、`message_end stop`、`agent_end`；随后观察窗无帧。
6. `approval-parallel` 挂起期间的 abort（先红，`it.each` 三种组合）
   - 输入：`SELECTED(2)` 之后写 `{type:"abort",id:"req_abort"}`，然后依次应答 `r1`、`r2`，组合为（a）Deny、Deny 与（b）Approve、Approve。
   - 期望：
     - abort 之后观察窗无帧。
     - `r1` 应答后新增帧恰为 C1 的结束帧（a 为拒绝，b 为成功）；随后观察窗无帧。
     - `r2` 应答后新增帧恰为 C2 的结束帧加 aborted 三帧（`response` 为 `{id:"req_abort",type:"response",command:"abort",success:true}`），没有 `message_end stop`；随后观察窗无帧。
     - 再写 `req_2` prompt，得到完整缺省回合。
   - 组合（c）：abort 在两次应答之间到达，同时覆盖「id 已答、另一条仍挂起」这一格（`design.md:16`）。
     - 输入：`SELECTED(2)` → Deny `r2`。
     - 期望：新增帧恰为 C2 的拒绝结束帧，随后观察窗无帧。
     - 再写重复应答 `{type:"extension_ui_response",id:"r2",value:"Approve"}`，观察窗无帧。
     - 再写 `{type:"abort",id:"req_abort"}`，观察窗无帧。
     - 最后 Approve `r1`。期望：新增帧恰为 C1 的成功结束帧加 aborted 三帧，其中 `response` 为 `{id:"req_abort",type:"response",command:"abort",success:true}`。不得出现 `message_end stop`，也不得出现第二个 C2 结束帧，即后到的 Approve 不能让被延后的 abort 失效。
     - 之后写 `req_2` prompt，得到完整缺省回合。
7. `approval-parallel` 两条均 Deny、无 abort（先红）
   - 输入：`SELECTED(2)` 之后依次 Deny `r1`、`r2`。
   - 期望：
     - 新增帧恰为两帧拒绝结束（C1、C2）；随后观察窗无帧，即回合挂起、进程存活。
     - 写多余应答 `{…id:"r1",value:"Approve"}` 后观察窗无帧。
     - 写 `{type:"abort",id:"req_abort"}` 后新增帧恰为 aborted 三帧。
     - 再写 `req_2` prompt，得到完整缺省回合。
8. `approval-then-abort` select 挂起时 abort（先红）
   - 输入：`startPromptedSession({scenario:"approval-then-abort", extraArgs:WRITE})`，`SELECTED(1)` 形状同证据 1；写 abort `req_abort`，然后以 `r1` Deny 应答。
   - 期望：
     - abort 之后观察窗无帧。
     - Deny 之后新增帧恰为 C1 拒绝结束加 aborted 三帧；随后观察窗无帧。
     - 再写 `req_2` prompt，得到完整缺省回合。
9. `approval-then-abort` 先应答后 abort（先红，`it.each`：Deny / Approve）
   - 输入：`SELECTED(1)` 之后应答 `r1`，然后写 abort。
   - 期望：
     - 应答之后新增帧恰为一帧 C1 结束（Deny 为拒绝，Approve 为成功）；随后观察窗无帧，不出现 `message_end stop`，回合挂起。
     - 写 abort `req_abort` 后新增帧恰为 aborted 三帧。
10. `approval-then-abort` 流水线早到 abort（先红）
    - 输入：`startFake({scenario:"approval-then-abort", extraArgs:WRITE})`，等 `ready` → `write(HANDSHAKE)` → 等两条握手应答 → 一次 `write([PROMPT, {type:"abort",id:"req_abort"}])`。不用 `startPromptedSession`，它会先等 prompt ack。
    - 期望：
      - prompt ack 之后恰为 `SELECTED(1)`；随后观察窗无帧，因为 abort 在 select 发出后才被处理，被延后。
      - Deny `r1` 后新增帧恰为 C1 拒绝结束加 aborted 三帧。
11. 既有场景在 write 下逐字节不变（恒绿）
    - 输入：对 `normal`（不带 `--scenario`）、`extension-ui`、`abort-ok`、`error` 各起两个进程，一个带 `extraArgs:WRITE`，一个不带。两者执行相同的脚本：
      - `normal`/`error`：`startPromptedSession` 后等终止 `agent_end`。
      - `extension-ui`：等 `confirm` 请求，写 `{type:"extension_ui_response",id:<请求 id>,cancelled:true}`，等 `agent_end`。
      - `abort-ok`：等两段 delta，写 abort `req_abort`，等 abort 应答。
    - 期望：两个进程的完整 `frames` 互相 `toEqual`。
    - 为何恒绿：未实现时 fake 忽略 `--approval-mode`，两者本来就相同；它守护的是 2.1b 把生产 argv 切到 `write` 之后，既有场景仍然不变。

另外，既有 `fake-omp.test.ts`（含 `extension-ui` 用例 `:249-262`）、`fake-omp-abort.test.ts`、`fake-omp-branch.test.ts`、`omp-*.test.ts`、`session-supervisor*.test.ts` 零改动全绿。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 串行队列下 prompt handler 必须返回；延后 abort 与最后一条应答的次序；两条 select 的独立应答 → 证据 3（`state-2` 证明队列未阻塞）、5、6、7、8、10 |
| Legacy compatibility / examples | yes | `abortTurn`/`handleAbort`/`extension_ui_response` 分发与既有场景共用 → 证据 4、11 + 既有 fake-omp 用例零改动全绿 |
| Schema / columns / units / field names | yes | select、结束帧、toolUse 块、aborted 三帧都钉在 omp 源码行号上 → 证据 1、2、5 的 `toEqual` 精确帧 |
| Error handling / rollback / partial outputs | yes | 拒绝/cancelled/其它值、未知或重复 id、多余 abort 不得产生帧，也不得卡住队列 → 证据 2、3、7 |
| Public API / CLI / script entry | yes | 新 argv `--approval-mode`，同名参数取最后一次；只有 `write` 门控 → 证据 1（write 在 yolo 之后生效）、4（yolo 在 write 之后生效） |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Resource limits / large input / discovery | no | 观察窗固定 300ms；最长用例约 4 个观察窗，低于 vitest 缺省 5s |
| Release / packaging / dependency compatibility | no | 零依赖脚本不变 |
| Documentation / migration notes | no | 契约在 spec 与夹具注释内 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs` 与新建 `server/test/fake-omp-approval.test.ts`；既有测试与 `fake-omp-helpers.ts` 零改动。
- [ ] 正向断言先红后绿：场景未实现时 fake 以缺省 `normal` 运行，没有 select，abort 回 `unsupported`，证据 1–3、5–10 失败即为红。证据 4、11 为恒绿守卫。PR body 记录 RED 与 GREEN 的输出。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-approval-scenarios --strict --no-interactive` 通过。
