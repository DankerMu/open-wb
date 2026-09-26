# Tasks: fake-omp-probe-frames（#459）

## 6. omp-test-harness — fake-omp

- [ ] 6.4 probe 尾部增 `frames=`（入站帧类型次序）；`server/test/fake-omp.test.ts:754` 附近 `expectedProbeReport` 精确相等断言与 `server/test/linux/uid-isolation.test.ts` 的 `parseLabeledReport`/`REPORT_LABELS` 同 PR 更新（既有断言改期望值）。验证：本地 fake-omp 测试绿 + CI uid-isolation job 绿的证据（该测试只在 Linux job 运行）

## 实现要点与必需证据

### 夹具实现（`fake-omp.mjs`：净增预计 5 行，上限 +12；最终 ≤800 行）
按下面的最小写法，净增 5 行，从 788 行到 793 行。不做拆分，不改其它函数。
- `:53` 附近的模块状态加一行注释和一行 `const inbound = [];`，数组名由实现者定。
- `onLine`（`:118-131`）在 `try/catch` 之后、`await dispatch(frame)` 之前插入：
  ```js
  if (typeof frame?.type === "string") {
    inbound.push(frame.type);
  }
  ```
  必须用 `?.`：输入 `null` 时 `frame.type` 抛 TypeError，被拒的 queue 让后续所有行都不再处理。
- `probeReport` 的返回模板（`:354`）末尾追加 `` frames=${inbound.join(",")}``，不新增行。该行已超过 100 列，biome 不拆模板字面量。
- 记录点在串行 queue 内的 `onLine`，不在 `rl.on("line")` 回调。理由见 design.md「Recording point」，由证据 5 检验。
- 所有 handler 结局都记录：`unsupported`、静默忽略、延后的 abort，以及 probe prompt 本身。记录按进程累积，probe 不清空它。
- 非契约：字符串 `type` 原样记录，包括空串，以及含 `,` 或空格的值。宿主只发固定标识符，消费者不得依赖这类值的切分。

### 允许的既有测试改动（仅此三处，逐字）
1. `server/test/fake-omp.test.ts:754`
   - 前：``  return `uid=${String(PARENT_UID)} gid=${String(PARENT_GID)} env=${PROBE_ENV_KEYS} home=${PROBE_HOME} agent=${PROBE_AGENT} environ=${environ} wrote=${wrote}`;``
   - 后：``  return `uid=${String(PARENT_UID)} gid=${String(PARENT_GID)} env=${PROBE_ENV_KEYS} home=${PROBE_HOME} agent=${PROBE_AGENT} environ=${environ} wrote=${wrote} frames=negotiate_protocol,get_state,prompt`;``
   - 三个调用点（`:472,481,489`）都经 `runProbe` → `startPromptedSession` 发出 `HANDSHAKE` 两帧和 probe prompt（`fake-omp-helpers.ts:165-175`），所以记录是同一个固定值。函数签名和调用点都不改。
2. `server/test/linux/uid-isolation.test.ts:41`
   - 前：`const REPORT_LABELS = ["uid", "gid", "env", "home", "agent", "environ", "wrote"] as const;`
   - 后：`const REPORT_LABELS = ["uid", "gid", "env", "home", "agent", "environ", "wrote", "frames"] as const;`
   - 改后正好 100 列。如果 `biome check` 把它格式化成多行，格式化后的形式也属于这项允许改动。
3. `server/test/linux/uid-isolation.test.ts:301` 之后插入一行：`    frames: requiredValue(values, 7),`
   - 这一行是必需的：返回类型是 `Record<(typeof REPORT_LABELS)[number], string>`（`:271`），缺这一行时 `make typecheck`（`fast-checks`）就会失败，不必等 Linux job。
- 不许改 `parseLabeledReport` 的循环（`:271-293`）：末标签取余量已经是 `:281-285` 的行为。`wrote` 不带后缀，由既有 `:238` `expect(parsed.wrote).toBe("ok")` 证明；缺 ` frames=` 时解析器抛 `probe report missing frames=`。
- 不许在 `assertIsolation` 新增 `parsed.frames` 断言。经 `SessionRuntime` 时它的值应为 `negotiate_protocol,get_state,prompt`：`process.ts:283-295` 的握手只发这两帧，之后是 `runtime.ts:187` 的 prompt。
- 其余既有测试和 `fake-omp-helpers.ts` 都零改动。

### 必需证据：新建 `server/test/fake-omp-frames.test.ts`
约定：
- `runRaw(args, lines: (string | object)[])`：
  - 字符串元素原样作为一行写入（`""`、`"   "`、`"{not json"`、`"\"prompt\""` 都按原样写），对象元素先 `JSON.stringify`。如果实现者把字符串也 stringify，证据 2 就测不到空行和非法 JSON 行。
  - `spawn(process.execPath, [FAKE, ...args], {stdio:"pipe", env:{PATH: process.env.PATH ?? "/usr/bin"}})`；
  - 把 `lines.join("\n") + "\n"` 一次写入 stdin，然后 `stdin.end()`；
  - 等 `close`，返回 `{code, frames}`，其中 `frames` 是 stdout 非空行逐行 `JSON.parse` 的结果；
  - 子进程登记进模块级列表，`afterEach` 统一 `SIGKILL` 未退出者（仿 `fake-omp-helpers.ts:40` `stopFakeChildren`；vitest 超时时 `finally` 不执行，故不单靠 `try/finally`）。
- `HS`：两行 `{"id":"rid-neg","type":"negotiate_protocol","protocolVersion":2}`、`{"id":"rid-state","type":"get_state"}`。
- `probe(id)`：`{"id":<id>,"type":"prompt","message":"probe:<process.pid>:<tmp>/probe.txt"}`，`tmp` 取自 `mkdtempSync`，在 `afterEach` 里 `rmSync`。
- `deltaAfter(frames, id)`：`response(id,"prompt")` 之后的第一帧 `isTextDelta` 的 delta 字符串。
- `framesOf(delta)`：`/ wrote=\S+ frames=([^ ]*)$/u` 的捕获组，同时断言 `delta.split(" frames=").length === 2`。不断言 `environ`：macOS 上是 `ENOENT`，Linux 上是 `readable`。
- 每个用例都断言 `code === 0`。

1. 验收：只记类型，按到达顺序（先红；对应 Scenario「记录只含类型且按到达顺序」与「probe 报告带 frames 字段」的 fake 半边）
   - 输入：`runRaw([], [...HS, {"id":"rid-secret","type":"prompt","message":"tell me secret-marker"}, probe("rid-probe")])`
   - 期望：
     - `framesOf(deltaAfter(frames,"rid-probe")) === "negotiate_protocol,get_state,prompt,prompt"`；
     - delta 匹配 `/^uid=\d+ gid=\d+ env=\S* home=.* agent=.* environ=\S+ wrote=ok frames=/u`，即前 7 个字段次序不变。
   - 守卫（恒绿）：delta 不含 `secret-marker`、`rid-neg`、`rid-state`、`rid-secret`、`rid-probe`。必须对 delta 字符串断言，不能对整个 stdout 断言，因为 ack 会回显 id。
2. 不合格行不记录（先红）
   - 输入：`runRaw([], [...HS, "", "   ", "{not json", "null", "42", "\"prompt\"", "[]", "{\"id\":\"rid-typeless\"}", "{\"type\":7}", "{\"type\":null}", probe("rid-probe")])`
   - 期望：`framesOf(…) === "negotiate_protocol,get_state,prompt"`。
   - 出站守卫（恒绿）：`get_state` 应答与 probe ack 之间的帧恰为以下 8 帧，两个空白行不产生帧：
     - `{type:"response",command:"parse",success:false,error:"invalid json"}`；
     - `null`、`42`、`"prompt"`、`[]`、`{id}` 各一帧 `{type:"response",command:"parse",success:false,error:"unsupported"}`；
     - `{type:"response",command:"7",success:false,error:"unsupported"}`；
     - 再一帧 `command:"parse"` 的 unsupported（来自 `{"type":null}`）。
   - 不用 `{"type":["prompt"]}`：`dispatch` 会把它按属性键强转后命中 `handlePrompt`，这是既有行为，见 proposal Non-goals。
3. `unsupported` 与静默忽略的帧也记录（先红）
   - 输入：`runRaw([], [...HS, {"id":"rid-abort","type":"abort"}, {"id":"rid-steer","type":"steer","message":"secret-marker"}, {"id":"rid-gbm","type":"get_branch_messages"}, {"type":"extension_ui_response","id":"rid-ui","cancelled":true}, probe("rid-probe")])`
   - 期望：`framesOf(…) === "negotiate_protocol,get_state,abort,steer,get_branch_messages,extension_ui_response,prompt"`。
   - 守卫（恒绿）：
     - 出站在 `get_state` 应答与 probe ack 之间恰为三帧 unsupported，`command` 依次为 `abort`、`steer`、`get_branch_messages`，都不带 id；
     - `extension_ui_response` 不产生帧，因为 `handleUi` 在 `pendingUi` 为假时直接返回（`:368-371`）；
     - delta 不含 `secret-marker`。
4. `approval-then-abort` 入站次序（先红；对应 Scenario「入站帧次序回报」）
   - 输入：`runRaw(["--scenario","approval-then-abort","--approval-mode","write"], [...HS, {"id":"rid-turn","type":"prompt","message":"run"}, {"type":"extension_ui_response","id":"r1","value":"Deny"}, {"id":"rid-abort","type":"abort"}, probe("rid-probe")])`
   - 串行队列保证 Deny 在 select 发出后才处理，接着 `settleSelects` 转为 `pending`，abort 触发 `emitAbortedEnd` 转为 `done`，probe 走缺省路径。
   - 期望：`framesOf(…) === "negotiate_protocol,get_state,prompt,extension_ui_response,abort,prompt"`。
   - 守卫（恒绿，#458 既有契约）：`{id:"rid-abort",type:"response",command:"abort",success:true}` 的下标小于 `rid-probe` ack 的下标。
5. 记录点在 queue 内，且按进程累积（先红）
   - 输入：`runRaw([], [...HS, probe("rid-probe-1"), {"id":"rid-state-2","type":"get_state"}, probe("rid-probe-2")])`，一次写入。
   - 期望：
     - `framesOf(deltaAfter(frames,"rid-probe-1")) === "negotiate_protocol,get_state,prompt"`；
     - `framesOf(deltaAfter(frames,"rid-probe-2")) === "negotiate_protocol,get_state,prompt,get_state,prompt"`。
   - 区分力：一次小写入通常在一个 chunk 内到达，readline 会同步触发全部 `line`。如果在 `rl` 层记录，probe-1 会得到 `…,prompt,get_state,prompt`，因此变红。

既有测试的红/绿：
- `fake-omp.test.ts` 三个 probe 用例改完期望值后，在 fake 未改时为红，实现后为绿；
- `uid-isolation.test.ts` 在 fake 改而消费者未改时，`:238` 为红，只在 CI 可见；
- 其余 fake-omp 消费者零改动全绿，这是出站帧不变的守卫。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | probe 新增末字段 `frames=`，字段序与两处解析同步 → 证据 1 的字段序正则、允许改动 1–3、CI `uid-isolation` |
| Concurrency / shared state / ordering | yes | 记录点必须在串行 queue 内，否则 probe 之后才到的帧会混入 → 证据 4、5 |
| Legacy compatibility / examples | yes | 两处既有消费者必然改期望值，其余消费者零改动 → 允许改动清单、既有 fake-omp 测试全绿、证据 2/3 出站守卫 |
| Error handling / rollback / partial outputs | yes | 空行、非法 JSON、`null` 等不记录，也不得卡死 queue → 证据 2（含 `null` 行与 `code === 0`） |
| Auth / permissions / secrets | yes | 记录只含类型，不泄露 id、payload 或消息文本；`uid-isolation` 仍证明隔离 → 证据 1/3 的 secret/id 守卫、CI `uid-isolation` |
| Public API / CLI / script entry | no | argv 不变 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | probe 写文件逻辑不变 |
| Resource limits / large input / discovery | no | 记录每帧一项、按进程累积；fake 进程都是短命的测试进程，不设上限（proposal Non-goals） |
| Release / packaging / dependency compatibility | no | 零依赖脚本不变 |
| Documentation / migration notes | no | 契约只在 spec 中 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs`，新建 `server/test/fake-omp-frames.test.ts`。既有测试只做「允许的既有测试改动」三处，`fake-omp-helpers.ts` 与其它测试零改动。
- [ ] 新测试只进新建测试文件。正向 `frames=` 断言先红后绿，守卫恒绿；PR body 记 RED/GREEN。
- [ ] `wc -l server/test/support/fake-omp.mjs` ≤800，净增 ≤12；超出预计的 5 行时在 PR body 说明原因。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-probe-frames --strict --no-interactive` 通过。
- [ ] CI 证据：`.github/workflows/ci.yml:121` 的 job `uid-isolation` 在 PR head 上为绿，PR body 附该 job 的运行链接。check 名为 `uid-isolation`，由 `all-checks-passed`（`:152`）聚合。该 job 的同名 step（`:133`）运行 `.github/scripts/ci-uid-isolation.sh:225`，即 `WORKBUDDY_UID_TEST=1 OMP_USER=omp vitest run test/linux/uid-isolation.test.ts`。
