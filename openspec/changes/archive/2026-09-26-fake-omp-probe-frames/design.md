# Design: fake-omp-probe-frames（#459）

Change surface: 只改 `server/test/support/fake-omp.mjs` 的三处：模块状态（`:53` 附近）、`onLine`（`:118-131`）、`probeReport` 的返回模板（`:354`）。两个既有消费者只改期望值与标签表，另新建 `server/test/fake-omp-frames.test.ts`。父设计见父 design D7 末句。
Must preserve:
- 每个 scenario 的出站帧逐字节不变，包括 `invalid json` 与 `unsupported` 兜底（`:126-128,150-155`）。
- probe 前 7 个字段的次序与语义不变（`:353-354`）。
- probe 回合帧仍为 ack、`agent_start`、一段 delta、`message_end stop`、`agent_end`（`fake-omp.test.ts:737-750`）。
- 串行队列 `queue = queue.then(() => onLine(line))`（`:68-70`）不变。
Must add/change:
- 记录规则恰为：`JSON.parse` 成功，且 `typeof frame?.type === "string"`，就把这个 type 追加到记录。必须写 `?.`：输入行 `null` 若用 `frame.type` 会抛 TypeError，被拒的 queue 让后续所有行都不再处理。
- 空行和纯空白行在 `:120` 已返回，不记录；非法 JSON 在 `:127` 已返回，不记录；非对象、缺 `type`、非字符串 `type` 都不记录。
- 所有 handler 结局都记录，包括 `unsupported`、静默忽略（未知或已答的 select id、非挂起态的 `abort`、`abort-ignored`）、`selecting` 态延后的 `abort`。触发回报的 probe `prompt` 本身也记录。
- 记录按进程累积，probe 不会清空它。
- probe 模板末尾追加 ` frames=${记录.join(",")}`。
Governing invariant: 某条 probe 回报里的 `frames=`，恰为 stdin 中排在这条 probe 行之前、以及这条 probe 行本身的全部合格帧的 type，按 stdin 行序排列。
Recording point（强制）:
- 记录发生在串行 queue 内的 `onLine`，不在 `rl.on("line")` 回调里。
- 「到达」指 stdin 行序。readline 按行序触发 `line`，queue 是 FIFO，所以两处记录的相对次序相同；区别在于「probe 时刻记录里有什么」。
- `probeReport` 在 `handlePrompt` 的 `await emit(ack)` 之后同步执行（`:290-318`）。在 await 期间，以及一次读入多行时，readline 会先把后续行的 `line` 事件全部触发完，queue 才开始跑。如果在 `rl` 层记录，probe 之后才到的帧会混进它的 `frames=`，#488/#490「probe `prompt` 是最后一项」的精确断言就会失效。证据 5 检验这一点。
Sibling surfaces:
- 必然变红的既有断言：
  - `fake-omp.test.ts:472,481,489` 三个 probe 用例，都经 `expectedProbeReport`（`:753-755`）做精确相等；
  - `uid-isolation.test.ts:238` 的 `expect(parsed.wrote).toBe("ok")`：若不加标签，`wrote` 会解析成 `ok frames=…`。只在 CI Linux job 运行。
- 允许改动恰为以下三处（逐字见 tasks.md「允许的既有测试改动」），此外零改动：
  - `fake-omp.test.ts:754`；
  - `uid-isolation.test.ts:41`；
  - `uid-isolation.test.ts:301` 之后插入一行。
- `parseLabeledReport` 的循环（`:271-293`）不许改：末标签取余量本来就是 `:281-285` 的行为。
- 其余直接引用 fake-omp 的 9 个测试文件、经 `session-supervisor-helpers.ts`/`server-startup-helpers.ts` 间接使用的测试，以及 `fake-omp-helpers.ts`，都零改动全绿。
- 下游消费者：
  - #460 数 `extension_ui_response` 恰为 1，所以依赖「静默忽略的帧也记录」；
  - #473 依赖「`extension_ui_response` 全在 `abort` 之前」；
  - #488/#490 依赖精确值 `negotiate_protocol,get_state,prompt,abort,prompt`，需要 #461 `slow-ready`，也依赖本文的记录点。
Seams under test: 只看 stdout 帧与 probe delta，不访问夹具内部状态。新文件直接 `spawn(process.execPath, [FAKE, ...args])`，先例是 `fake-omp-abort.test.ts` 的 SIGTERM 用例。写入原始文本后 `stdin.end()`，读到 `close` 后按行解析 stdout。fake 在 `rl` close 后先排空 queue 再 `exit(0)`（`:71-79`），所以结果是确定的。`response`/`isTextDelta`/`asRecord`/`Frame` 从 `fake-omp-helpers.ts` 导入。
Required evidence: tasks.md 证据 1–5。每条的 `frames=` 断言都先红，因为现行 probe 没有这个字段。出站帧与「不含 secret/id」的断言是恒绿守卫。另外，两处既有消费者改完期望值后，在 fake 未改时也是红的：这正是 atomic 的理由。
Non-goals: 见 proposal.md。
Review focus:
1. 记录点在 `onLine` 内，且在 parse 成功之后、`dispatch` 之前；条件恰为 `typeof frame?.type === "string"`。
2. 既有测试只有那三处改动，`parseLabeledReport` 循环没动，也没新增断言。
3. 出站帧零变化：既有 fake-omp 测试零改动全绿，证据 2/3 的出站守卫为绿。
4. PR body 附 `uid-isolation` job 链接，且该 run 在 PR head 上。
