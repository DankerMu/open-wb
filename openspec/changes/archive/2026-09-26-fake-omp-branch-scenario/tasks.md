# Tasks: fake-omp-branch-scenario（#457）

## 6. omp-test-harness — fake-omp

- [ ] 6.2 scenario `branch`：解析 `--session-dir`；`get_branch_messages` 回固定用户消息列表、`branch{entryId}` 返回 text 并真实在 session-dir 下建新文件、后续 `get_state.sessionFile` 变为新路径。验证：新建契约测试断言新文件存在与 `get_state` 变化

## 实现要点与必需证据

### 帧形状（钉在 omp v18.0.10 `33cc6b9a`，`resource/oh-my-pi/packages/coding-agent/src/`）
- `get_branch_messages` 成功：`{id, type:"response", command:"get_branch_messages", success:true, data:{messages:[{entryId,text},…]}}`。列表包在 `data.messages` 里，不是裸数组：见 `modes/rpc/rpc-mode.ts:1347-1349` 和 `modes/rpc/rpc-client.ts:847-849`；条目形状见 `session/agent-session.ts:9272`。
- `branch` 成功：`{id, type:"response", command:"branch", success:true, data:{text:<该 entry 的 text>, cancelled:false}}`，见 `rpc-mode.ts:488-491,1101-1105`。
- `branch` 未知 entryId：`{id, type:"response", command:"branch", success:false, error:"Invalid entry ID for branching"}`，回显 id，不带 `data` 与 `code`。依据：`agent-session.ts:8628-8629` 抛出该消息，`rpc-mode.ts:401` 的 `errorResponse(command.id, command.type, message)` 与 `:754-755` 的 `error()` 负责成帧。下列情况都算未知：`entryId` 不在固定列表中、缺失、不是字符串。
- `get_state`：沿用既有 `sessionState()`（`fake-omp.mjs:161-188`），只把 `data.sessionFile` 的来源 `resume ?? DEFAULT_SESSION`（`:186`）换成进程级「当前文件」变量，初值不变。

### 夹具实现
- `parseArgs`（`fake-omp.mjs:68-79`）增加 `--session-dir`，取最后一次出现的值，与既有 `--scenario`/`--resume` 循环一致。原因：helper 的 `OMP_FLAGS` 已带 `--session-dir /tmp/sessions`（`fake-omp-helpers.ts:16-17`），`extraArgs` 追加在其后（`:65`），测试靠后出现者覆盖。缺省场景永不向 session-dir 写入。
- 固定列表是模块常量，在夹具内以注释文档化，后续消费者逐字依赖：`[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]`。它在进程生命周期内不变，不随 `--resume`、`branch` 或 prompt 变化。
- 只有 `scenario === "branch"` 时 `dispatch` 才挂 `get_branch_messages`/`branch` 两个处理器，写法同 `ABORT_SCENARIOS`（`fake-omp.mjs:111`）。其它场景仍落入既有无 id 的 `unsupported` 兜底（`:118-123`）。`branch` 场景下 prompt 与其它命令完全等同 `normal`。
- `branch` 对已知 entry：
  - 用 `writeFileSync(path, content, {flag:"wx"})` 同步写出新文件：不覆盖已有文件，不 mkdir。生产 `server/src/sessions/omp/process.ts:57` 预建 session-dir。
  - 文件直接位于 session-dir 下，扩展名 `.jsonl`，每次 branch 的文件名都带 `randomUUID()`（`node:crypto`）唯一成分（如 `branch-<uuid>.jsonl`，不得只用时间戳）。这样 4.4 回收后以 `--resume <new>` 重启、在同一 session-dir 再次 branch 时，也不会因 `wx` 撞名而报 EEXIST。真实 omp 的命名是 `<ts>_<id>.jsonl`（`session/session-manager.ts:2693`），测试不依赖具体文件名。
  - 内容：恰一行 `{"type":"session","parentSession":<切换前的当前文件>}`（仅保证非空 `.jsonl`；内容不属契约，消费者只读 `get_state.sessionFile`）。
  - 写成功后才切换当前文件，然后发成功响应。写失败路径不作契约（生产侧 `process.ts:57` 与真实 omp `session-manager.ts:565` 都预建目录）；实现上 `branch` 处理器须 catch 写异常并回错误帧，避免 reject 卡死串行 `queue`，但不设证据。
- 顺序：入站帧经 `queue = queue.then(onLine)` 串行处理（`fake-omp.mjs:44-47`；真实 omp 的 `RpcInputDispatcher` 同样串行化普通命令，`rpc-mode.ts:351-403`）。因此同一次 `write([branch, get_state])` 中的 `get_state` 必然看到新路径；`branch` 场景的 prompt 在 `handlePrompt` 内跑完整回合，其后排队的 `branch` 在 `agent_end` 之后才处理。

### 后续消费者依赖的契约
- 2.2b #488 runtime `command(frame)`：只在 `branch` 场景下，`get_branch_messages`/`branch`/`get_state` 的成功与错误响应都回显 id 与 command，错误帧为 `success:false` 且带字符串 `error`、不带 `data`。其它场景下这两个命令只得到无 id 的 `unsupported`，#488 的相关性测试须选 `branch`。
- 4.4 #465 regenerate：
  - 末条已知 entry 是 `fake-entry-2`/`second question`，测试须让 SQLite 末条用户消息的 content 等于 `second question`。
  - branch 之后，同一进程上的后续 prompt 与 `get_state` 一直返回新路径（证据 2）。
  - 进程被回收后，以 `--resume <new>` 重启，`get_state` 经既有 resume 路径返回 `<new>`。
  - 列表是静态的，不反映新文件内容。
- 4.5 #466 fork：按序号与文本对齐，第 1、2 条用户消息分别为 `first question`、`second question`。branch 任一已知 entry 都写新文件，`--resume` 的原文件内容不变（证据 1 断言）。
- 不模拟：扩展取消（`cancelled:true`）、列表随会话内容变化、夹具读取 `--resume` 文件、新文件的真实内容（真实 omp 会写 `model_change` 等条目，`sdk.ts:3535`）、真实 omp 在 branch 成功响应前主动发的 `available_commands_update` 帧（`rpc-mode.ts:1102-1103`；#488 的相关性测试不得假设 branch 路径上只有 response 帧）。

### 必需证据
新建 `server/test/fake-omp-branch.test.ts`，只用 `fake-omp-helpers.ts` 的 `startFake`/`HANDSHAKE`/`PROMPT`/`response`/`stopFakeChildren`/`closeSession`/`asRecord`，helper 不改。
- 不用 `startPromptedSession`，它会先发 prompt。统一构造为：`startFake({scenario:"branch", extraArgs:["--session-dir", dir, "--resume", old]})` → 等 `ready` → `write(HANDSHAKE)` → 等 `response("protocol-1","negotiate_protocol")` 与 `response("state-1","get_state")`。
- `dir = mkdtempSync(join(tmpdir(), "fake-omp-branch-"))` 登记进 temps 数组；`old = join(dir, "old.jsonl")` 在 spawn 前由测试写入固定内容。
- `afterEach` 先 `await stopFakeChildren()`，再对每个 temp 执行 `rmSync(dir, {recursive:true, force:true})`，先例见 `fake-omp.test.ts:104-106`。
- `session.wait` 在全部已收帧中查找（`fake-omp-helpers.ts:132`），每个请求须用唯一 id。

1. 列表与末条 branch（先红）
   - 输入：上述构造；`get_state` state-1 的 `sessionFile === old`。写入 `{id:"gbm-1",type:"get_branch_messages"}`，然后记录 `readdirSync(dir).sort()`，应为 `["old.jsonl"]`。之后一次 `write([{id:"br-1",type:"branch",entryId:"fake-entry-2"},{id:"state-2",type:"get_state"}])`，即流水线写入。
   - 期望：
     - gbm-1 帧 `toEqual({id:"gbm-1",type:"response",command:"get_branch_messages",success:true,data:{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}})`。
     - br-1 帧 `toEqual({id:"br-1",type:"response",command:"branch",success:true,data:{text:"second question",cancelled:false}})`。
     - state-2 的 `sessionFile` 记为 `next`，须满足：是字符串；`next.endsWith(".jsonl")`；`dirname(next) === dir`；`next !== old`；`statSync(next).size > 0`。
     - 目录列表变为 `["old.jsonl", basename(next)].sort()`。
     - `old` 的内容与写入值逐字节相等。
   - 为何先红：scenario 未实现时回落为 `normal`，gbm-1 只得到无 id 的 `unsupported`，`wait(response("gbm-1",…))` 超时。
2. 持久与二次 branch（先红）
   - 输入：同构造并完成 br-1。写入 `PROMPT`，等到 `response("req_1","prompt")` 与终止 `agent_end`；再写 `{id:"state-3",type:"get_state"}`、`{id:"gbm-2",type:"get_branch_messages"}`，然后写 `[{id:"br-2",type:"branch",entryId:"fake-entry-1"},{id:"state-4",type:"get_state"}]`。
   - 期望：
     - state-3 的 `sessionFile === next`，即切换跨 prompt 持久。
     - gbm-2 的 `data.messages` 与 gbm-1 相同，即列表是静态的。
     - br-2 的 `data` 为 `{text:"first question",cancelled:false}`。
     - state-4 的 `sessionFile`（记为 `next2`）满足：`next2 !== next`、`next2 !== old`、`dirname(next2) === dir`、`.jsonl` 扩展名、非空。
     - 目录恰含 3 个文件。
3. 未知 entryId（先红）
   - 输入：同构造。记录目录列表；写入 `{id:"br-x",type:"branch",entryId:"no-such-entry"}` 与 `{id:"br-y",type:"branch"}`（缺 entryId），再写 `{id:"state-2",type:"get_state"}`。
   - 期望：
     - br-x、br-y 帧分别 `toEqual({id:<该 id>,type:"response",command:"branch",success:false,error:"Invalid entry ID for branching"})`。
     - 目录列表与写入前逐项相等。
     - state-2 的 `sessionFile === old`。
   - 为何先红：缺省兜底不带 id，`wait(response("br-x","branch"))` 超时。「无新文件」与「sessionFile 不变」两条子断言在缺省下本来就是绿的。
4. 缺省守卫（恒绿）
   - 输入：`startFake({extraArgs:["--session-dir", dir]})`（不带 `--scenario`）并完成握手。写入 `{id:"gbm-g",type:"get_branch_messages"}` 与 `{id:"br-g",type:"branch",entryId:"fake-entry-2"}`；两条应答都不带 id，只能按 `frame.type==="response" && frame.command===<cmd>` 等待。
   - 期望：
     - 两帧分别 `toEqual({type:"response",command:"get_branch_messages"|"branch",success:false,error:"unsupported"})`，与 `fake-omp-abort.test.ts:178-190` 同法。
     - state-1 的 `sessionFile === "/tmp/open-wb-fake-session.jsonl"`。
     - `readdirSync(dir)` 为 `[]`。
   - 之后 `closeSession`，退出码 0。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| File IO / path safety / overwrite | yes | 真实写文件 → 新文件只落在 session-dir 直属层、`wx` 不覆盖、`--resume` 原文件不动、目录前后列表对比（证据 1/2/3/4） |
| Error handling / rollback / partial outputs | yes | 未知 entryId 不得建文件或切换 → 证据 3（写失败路径不作契约） |
| Concurrency / shared state / ordering | yes | 串行队列下流水线 `[branch, get_state]` 必须看到新路径；prompt 后的 branch 在 `agent_end` 之后处理 → 证据 1/2 以一次 write 发两帧 |
| Schema / columns / units / field names | yes | `data.messages`、`data.{text,cancelled}`、错误帧字段钉在 omp 源码行号 → 证据 1/3 的 `toEqual` 精确帧 |
| Legacy compatibility / examples | yes | 既有 scenario 与缺省行为不变 → 证据 4 守卫 + 既有 `fake-omp*.test.ts`、`omp-*.test.ts` 零改动全绿 |
| Public API / CLI / script entry | no | `--session-dir` 仅是测试夹具 argv，生产 argv 本就传递（`process.ts:68-69`） |
| Config / project setup | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Resource limits / large input / discovery | no | 文件为几行 JSONL，写在测试临时目录 |
| Release / packaging / dependency compatibility | no | 新增 Node 内置 `node:crypto` 导入（`randomUUID`），仍零第三方依赖 |
| Documentation / migration notes | no | 固定列表在夹具注释内文档化，无外部文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs` 与新建 `server/test/fake-omp-branch.test.ts`；既有测试与 `fake-omp-helpers.ts` 零改动。
- [ ] 正向断言先红后绿：scenario 未实现时 fake 以缺省 `normal` 运行，两个命令只回无 id 的 `unsupported`，证据 1–3 的 `wait(response(id,…))` 超时，是为红；证据 4 为缺省守卫恒绿。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-branch-scenario --strict --no-interactive` 通过。
