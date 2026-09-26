# Tasks: fake-omp-slow-ready（#461）

## 6. omp-test-harness — fake-omp

- [ ] 6.5 scenario `slow-ready`：解析 `--ready-delay-ms <n>`（非负整数，缺省 500），延迟到期前扣住 `ready` 帧、到期后以正常字段发出，此后行为与 `abort-ok` 完全一致（held 回合；收到 abort 以 `message_end aborted` + `agent_end` + `response{command:"abort"}` 兑现，之后可继续 prompt）；延迟期间 stdin 关闭则干净退出。验证：新建契约测试（真实子进程）断言 `--ready-delay-ms 300` 时 `ready` 不早于 300ms、缺省 500ms 生效、延迟期间 stdin 关闭干净退出；ready 后 prompt → abort → 上述三帧，之后再 prompt 正常完成

## 提交 1：纯搬迁拆分（先于 slow-ready 单独提交，单独验证全绿）
- [ ] 按 design.md「拆分」的搬迁清单，把 `fake-omp.mjs:596-793` 移到新建的 `server/test/support/fake-omp-proxy.mjs`：
  - 不改任何函数体，只给 `parseToolCall`/`loadBaseUrl`/`postChat` 加 `export `；
  - 主文件删 `:9-10` 与 `:595-793`，并在 `node:readline` 导入之后加 `import { loadBaseUrl, parseToolCall, postChat } from "./fake-omp-proxy.mjs";`；
  - commit 形如 `refactor(test): split fake-omp call-proxy client into fake-omp-proxy.mjs (#461)`。
- [ ] S1 形状：
  - 提交 1 只触及这两个文件；
  - `git ls-files -s server/test/support/fake-omp.mjs` 仍为 `100755`，新模块为 `100644`、无 shebang；
  - `node --check` 两个文件都通过；
  - `wc -l` 为 593 / 207。偏差超过 ±3 行时须在 PR body 说明原因。
- [ ] S2 搬迁恒等（以下三条命令输出均为空，`BASE=origin/master` 即 `679c267`）：
  ```sh
  diff <(git show $BASE:server/test/support/fake-omp.mjs | sed -n '596,793p') \
       <(tail -n 198 server/test/support/fake-omp-proxy.mjs | sed -E 's/^export function /function /')
  diff <(git show $BASE:server/test/support/fake-omp.mjs | sed -e '9,10d' -e '595,$d') \
       <(grep -vxF 'import { loadBaseUrl, parseToolCall, postChat } from "./fake-omp-proxy.mjs";' server/test/support/fake-omp.mjs)
  ```
  第三条核对 import 头逐字恰为四行（输出为空）。前两条只比函数体；漏写或错写 `httpsRequest` 导入只会在 https 上游时抛 ReferenceError，被 `runProxy` 兜底吞成 `"proxy failed"`，与正常失败逐字节相同，S3 抓不到：
  ```sh
  diff <(grep '^import' server/test/support/fake-omp-proxy.mjs) <(printf '%s\n' \
    'import { readFileSync } from "node:fs";' \
    'import { request as httpRequest } from "node:http";' \
    'import { request as httpsRequest } from "node:https";' \
    'import { join } from "node:path";')
  ```
- [ ] S3 新旧逐字节对照（沿用 #458 的做法；脚本放 scratchpad，不入库）：
  - 旧版：`git show $BASE:server/test/support/fake-omp.mjs > <tmp>/old/fake-omp.mjs`，它可以单独运行。新版是工作区的两个文件。
  - 每格都用 `env -i PATH=$PATH`（call-proxy 格另加下述 env）、相同 argv（`fake-omp-helpers.ts` 的 `OMP_FLAGS` + `--scenario X`，需要时加 `--approval-mode write`）、相同 stdin（一次写入后关闭），比较 stdout、stderr、退出码。三者都要逐字节相同。
  - 矩阵：
    - `normal`：握手 + prompt + probe prompt，probe 路径固定在 `<tmp>`；
    - `missing-session`、`new-session`、`no-ready`：握手；
    - `chunked`、`interleaved`：v2 握手 + `get_state`；
    - `error`、`crash`、`crash-after-deltas`：握手 + prompt；
    - `extension-ui`：握手 + prompt + `{type:"extension_ui_response",id:"ui-confirm-1",cancelled:true}`；
    - `abort-ok`：握手 + `[prompt, abort]` + prompt；
    - `abort-ignored`：握手 + prompt + abort，然后关闭 stdin；
    - `approval`、`approval-parallel`、`approval-then-abort`：各跑 write 与 yolo，带 `r1`/`r2` 应答与 abort；
    - `branch`：`get_branch_messages` + 未知 entryId 的 `branch` + `get_state`。不做成功的 branch，因为文件名含 `randomUUID`；
    - `call-proxy`，这是搬迁代码的主面，逐格列出：
      - (a) 不带 token/agent dir；
      - (b) token 加空 agent dir（无 `models.yml`）；
      - (c) `models.yml` 为 `providers: []`；
      - (d) 合法配置指向已关闭的 `127.0.0.1` 端口；
      - (e)–(g) 合法配置指向脚本内的确定性 SSE 桩：(e) 纯文本一轮；(f) 第一轮带 tool_calls 分片、第二轮给回答；(g) HTTP 500。
      - 不用 `fake-upstream.mjs`，它的 id 用 `randomUUID`。
  - PR body 列出矩阵与「全部相同」的结果。
- [ ] S4：`npm test --workspace server` 全绿，且既有测试零 diff。`make lint`、`make typecheck`、`make anti-drift` 退出 0。这些都在加 slow-ready **之前**完成。

## 提交 2：slow-ready（`fake-omp.mjs` 净增目标 ≤35 行；提交后 ≤630 行，硬上限 740）
- `parseArgs`：`--ready-delay-ms` 的原值存为 `argv[++i] ?? ""`，取最后一次出现的值。
- 只在 `scenario === "slow-ready"` 时解析：
  - 未出现 → 500；
  - `/^\d+$/u.test(raw) && Number(raw) <= 2_147_483_647` → `Number(raw)`；
  - 否则在模块求值时 `throw new Error(\`invalid --ready-delay-ms: ${JSON.stringify(raw)}\`)`，结果是退出码 1、stdout 无帧。
  - 不要用 `stderr.write` 加 `process.exit`：macOS 管道上 stderr 异步，消息会丢。
- 计时器在模块求值时同步启动，参考写法：
  ```js
  let readyTimer; // 仅在 slow-ready 扣住 ready 期间有值
  const readyGate = scenario === "slow-ready" ? delayReady(readyDelayMs) : Promise.resolve();
  // `:57` 分支改成 queue = readyGate.then(() => emit({ ...原 ready 字段不变 }))
  function delayReady(ms) {
    const { promise, resolve } = Promise.withResolvers();
    readyTimer = setTimeout(() => {
      readyTimer = undefined;
      resolve();
    }, ms);
    return promise;
  }
  ```
  `rl.on("close")` 的 hang 判断之后插入 `if (readyTimer !== undefined) { process.exit(0); }`，该分支到此为止，不再走 `queue.then(...)`；计时器已到期时照旧走 `queue.then(...)`。
- `ABORT_SCENARIOS`（`:24`）加入 `"slow-ready"`，不新写任何回合代码。
- 注释写明：knob 与 `--scenario` 的位置无关；非 `slow-ready` 的 scenario 忽略它；延迟期间关闭 stdin 零帧退出。
- commit 形如 `test(fake-omp): add slow-ready scenario with --ready-delay-ms (#461)`。

## 后续消费者依赖的契约
- 2.2b #488（runtime 的「派发回执后 abort」）与 4.2b #490（supervisor 停止意图）：
  - 经 `createRealFakeRuntime().setScenario("slow-ready")` 使用。`session-supervisor-helpers.ts:95-100` 只追加 `--scenario`，没有传 knob 的入口，所以得到缺省 500ms 窗口。要自定延迟，就在消费者自己的新测试文件里写 spawnImpl，追加 `--ready-delay-ms <n>`。本 issue 不改 helper。
  - 延迟用的是真实时钟，runtime/supervisor 的计时器用的是注入的 `TestClock`。消费者等待窗口期间不得把注入时钟推过握手或 idle 界限。
  - 持有回合与 abort-ok 相同：每进程只持有首个 prompt 回合；只兑现 `pending` 态的第一个 abort，其它状态下的 abort 不回帧（#456 约定）；aborted 回合之后的 prompt（例如 probe）走缺省路径。
  - probe 精确值为 `negotiate_protocol,get_state,prompt,abort,prompt`（E6）。
  - #490 的获取失败分支继续用 `no-ready-hang`，它不受影响（G2 与既有 `omp-runtime.test.ts:330`）。
- 6.6 #470：在主文件的审批状态机上扩展，不触碰 `fake-omp-proxy.mjs`；场景枚举与「eight scripted scenarios」由它归档时定稿。

## 必需证据：新建 `server/test/fake-omp-slow-ready.test.ts`
约定：
- 只从 `fake-omp-helpers.ts` 导入 `startFake`/`HANDSHAKE`/`PROMPT`/`response`/`isTextDelta`/`asRecord`/`stopFakeChildren`/`Frame`/`Session`；helper 不改。
- 常量：`afterEach(stopFakeChildren)`；`QUIET_MS = 300`；`ABORT = {type:"abort", id:"req_abort"}`；`KNOB = (n) => ["--ready-delay-ms", String(n)]`。
- 帧常量：
  - `READY = {type:"ready",protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1_048_576,maxReassembledFrameBytes:67_108_864}`，键序与 `fake-omp.mjs:59-65` 相同；
  - `ABORTED = [{type:"message_end",message:{role:"assistant",content:[],stopReason:"aborted"}}, {type:"agent_end",messages:[],isTerminal:true}, {id:"req_abort",type:"response",command:"abort",success:true}]`。
- `readyAfter(options)`：`t0 = performance.now()`，然后 `startFake(options)`，`await session.wait(f => f.type === "ready")`，返回 `{session, elapsed: performance.now() - t0}`。
  - 返回时断言 `session.frames` `toEqual([READY])`，且 `session.stdout === JSON.stringify(READY) + "\n"`，即 ready 前无帧、ready 与 normal 逐字节相同。
  - 计时只断言下界、不设容差：子进程的计时器在 spawn 与 Node 启动之后才开始，测到的 elapsed 只会偏大。
  - 慢路径上不设上界。
- jscpd（`.jscpd.json` 扫 `server/**/*.ts`，阈值 3%，由 `make anti-drift` 执行）：新测试文件不得照搬 `fake-omp-abort.test.ts:33-79` 的 `describeFrame`/`expectHeldTurn`/`expectAbortedTurnEnd`，也不能从别的 `*.test.ts` 导入。帧一律用 `toEqual` 对 `READY`/`ABORTED` 常量或短的内联切片断言。S4 与提交 2 之后都跑 `npx jscpd --config .jscpd.json`，clone 数须与基线相同。
- 观察窗统一写成 `await expect(session.wait(() => session.frames.length > n, QUIET_MS)).rejects.toThrow(/timed out/)`。它同时证明无新帧与进程存活（`fake-omp-helpers.ts:127-129` 与 `:138-144` 的报错文案不同）。

先红（未实现时 `slow-ready` 是未知 scenario，走 `normal`）：
- **E1**「延迟握手」首个 WHEN，以及与 abort-ok 逐字节一致：
  - 输入：`readyAfter({extraArgs: KNOB(300), scenario: "slow-ready"})`。
  - 期望 `elapsed >= 300`。
  - 然后执行 `script(session)`；再对 `startFake({scenario:"abort-ok"})` 等到 ready 后跑同一个 `script`。`script` 的步骤：
    1. 写 `HANDSHAKE`，等两条响应；
    2. 写 `PROMPT`，等 ack，再等 `frames.length >= ack + 4`；
    3. 开观察窗；
    4. 断言 ack 之后恰为 `agent_start`、delta `"Hello "`、delta `"from "`；
    5. 写 `ABORT`，等 abort 响应；
    6. 断言新增帧 `toEqual(ABORTED)`；
    7. 写 `{id:"req_2",type:"prompt",message:"again"}`，等 ack 之后的 `agent_end`；
    8. 断言该回合为 `agent_start`、3 段 delta（`Hello `/`from `/`fake-omp`）、`message_end{stopReason:"toolUse",content:[]}`、`tool_execution_start{toolCallId:"tool-1",toolName:"bash",args:{command:"echo workbuddy-smoke"}}`、`tool_execution_end`（`details:{exitCode:0}`，无 `isError`）、`message_end{stopReason:"stop"}`、`agent_end{isTerminal:true}`；
    9. `closeStdin()`，`waitExit()` 为 0。
  - 最后断言 `slow.stdout === abortOk.stdout`，逐字节相等，这同时证明握手响应与 normal/abort-ok 相同。
  - 红的原因：未实现时 elapsed 远小于 300，第 3 步的观察窗也失败。
- **E2** 缺省 500：
  - 输入：`readyAfter({scenario:"slow-ready"})`。
  - 期望 `elapsed >= 500`；`closeStdin()` 后 `waitExit()` 为 0。
- **E3** knob 在两种位置都被读取：两个子进程并行。
  - A：`{extraArgs: KNOB(1200), scenario:"slow-ready"}`，knob 在 `--scenario` 之前；
  - B：`{extraArgs: ["--scenario","slow-ready", ...KNOB(1200)]}`，不传 `scenario`，knob 在 `--scenario` 之后。
  - 期望两者 `elapsed >= 1200`。用 1200（大于缺省 500），忽略 knob 的实现就会变红。
- **E4** 延迟期间关闭 stdin（「延迟握手」第二个 WHEN 的后半）：
  - 输入：`startFake({extraArgs: KNOB(30_000), scenario:"slow-ready"})`，随即 `closeStdin()`。
  - 期望 `waitExit()` 解析为 0（helper 上限 4s，远小于 30s，证明不挂起），`stdout === ""`，`stderr === ""`。
  - 红的原因：未实现时 stdout 含 ready 行。
- **E5** 非法 knob 抛错退出：五个子进程并行。
  - 前四个：`{extraArgs: KNOB(v), scenario:"slow-ready"}`，`v ∈ {"-1","1.5","abc","2147483648"}`；
  - 第五个：`{extraArgs:["--scenario","slow-ready","--ready-delay-ms"]}`，缺值。
  - 每个都期望 `waitExit()` 为 1、`stdout === ""`、stderr 含 `invalid --ready-delay-ms`。
  - 红的原因：未实现时进程忽略 knob，stdin 未关就不退出，`waitExit` 超时。
- **E6**「延迟握手期间停止 → 帧序 prompt,abort」：
  - 输入：`readyAfter({extraArgs: KNOB(300), scenario:"slow-ready"})`，期望 `elapsed >= 300`。
  - 写 `HANDSHAKE` 并等两条响应；**一次**写入 `[PROMPT, ABORT]`；等到 `toEqual(ABORTED[2])` 的那一帧。
  - 期望 `PROMPT` ack 之后恰为 `agent_start`、`"Hello "`、`"from "`，接着是 `ABORTED` 三帧。
  - 再写 `{id:"req_probe",type:"prompt",message:\`probe:${process.pid}:${join(tmp,"probe.txt")}\`}`，其中 `tmp` 来自 `mkdtempSync`，在 `afterEach` 中 `rmSync`。
  - 等 ack 之后的首个 text delta。它的 ` frames=` 捕获值（`/ frames=([^ ]*)$/u`，并断言 `split(" frames=").length === 2`）恰为 `negotiate_protocol,get_state,prompt,abort,prompt`。
  - probe 回合以 `message_end{stopReason:"stop"}` 与 `agent_end` 结束。
  - 红/绿说明：红来自 abort 应答与持有回合的断言，未实现时 abort 落入无 id 的 `unsupported`（`success:false`）。`frames=` 的精确值单独看是**恒绿**：`normal` 同样会记录那帧 abort（#459 行为）。

守卫（恒绿）：
- **G1** knob 不泄漏到其它 scenario：
  - 输入：`startFake({extraArgs: KNOB(30_000), scenario:"normal"})` 与 `startFake({extraArgs: KNOB("abc"), scenario:"normal"})`。
  - 两者的 `wait(ready)` 都在 helper 缺省的 8s 内解析。knob 一旦泄漏，前者会先撞上 vitest 缺省 5s 用例超时（`fake-omp-helpers.ts:32`），后者会以退出码 1 报 `child exited before frame`，不引入新的紧上界。
  - 再各写 `HANDSHAKE` 并等两条响应，closeStdin 后退出码 0。
- **G2** `no-ready` 不变：
  - 输入：`startFake({extraArgs: KNOB(0), scenario:"no-ready"})`，写 `HANDSHAKE`。
  - 期望 negotiate 响应 `success:true`，`await expect(session.wait(f => f.type === "ready", QUIET_MS)).rejects.toThrow(/timed out/)`，closeStdin 后退出码 0。
  - `no-ready-hang` 由既有 `omp-runtime.test.ts:330` 与 `omp-rpc.test.ts:67` 零改动守护。
- **G3** 延迟到期后关闭 stdin 走既有路径，且 knob `0` 合法：
  - 输入：`readyAfter({extraArgs: KNOB(0), scenario:"slow-ready"})`，然后在同一 tick 内写 `HANDSHAKE` 并 `closeStdin()`。
  - 期望 `waitExit()` 为 0，stdout 恰为 ready 加两条 HANDSHAKE 响应。
  - 能力边界：父进程持续读 stdout 时，close 事件到达前排队的响应早已写完，所以「删掉 `readyTimer` 清空语句」这个变异经 `startFake` 不可观测（实测 10/10 仍绿）。只有暂停读 stdout 制造回压才能区分，那需要自建 spawn，偏离「全部经 `startFake`」。取舍：不追这个变异，G3 只守「knob `0` 合法、到期后既有退出路径发出排队响应」。PR body 记录这一点。
  - 未实现时同样为绿（未知 scenario 走 `normal`），所以它是守卫：`0` 不得被当成非法值，到期后 close 走既有路径。
- 既有测试零 diff 全绿，名单见 design.md「Sibling surfaces」。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新 argv knob `--ready-delay-ms`：取值、缺省、非法值、位置无关，其它 scenario 忽略 → E2、E3、E5、G1 |
| Concurrency / shared state / ordering | yes | 计时器与 stdin 关闭竞态；ready 位于串行 queue 队头；`[PROMPT, ABORT]` 一次写入 → E4（延迟期内关闭）、E6、G3（到期后关闭走既有路径；`readyTimer` 清空语句被删的变异经 `startFake` 不可观测，见 G3「能力边界」） |
| Legacy compatibility / examples | yes | 纯拆分加一个新 scenario，既有 scenario 与既有消费测试零变化 → S2、S3、S4、G1、G2 |
| Error handling / rollback / partial outputs | yes | 非法 knob 不得部分运行，延迟期间关闭不得输出半截 → E4、E5（stdout 为空） |
| Auth / permissions / secrets | yes | CI `uid-isolation` 以 omp uid 执行 fake；新模块须可读，sudoers 不变 → PR head 的 `uid-isolation` job 链接；call-proxy token 路径由 S3 (a)–(g) 与既有测试守护 |
| Release / packaging / dependency compatibility | yes | 夹具从单文件变成两个文件，仍零第三方依赖；模式 100755/100644 → S1、ADDED「假 omp 夹具模块划分」 |
| Config / project setup | no | 不改 knip/biome/CI 配置，新 `.mjs` 不进 knip project |
| File IO / path safety / overwrite | no | 不改 branch/probe 的写文件逻辑，搬迁代码只读 `models.yml` |
| Schema / columns / units / field names | no | ready 与 abort 帧字节不变，E1 证明与 abort-ok 逐字节一致 |
| Resource limits / large input / discovery | no | knob 上限 2147483647（`setTimeout` 边界），由 E5 覆盖 |
| Documentation / migration notes | no | 契约只在 spec 中 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs`，新建 `server/test/support/fake-omp-proxy.mjs` 与 `server/test/fake-omp-slow-ready.test.ts`。既有测试与全部 helper 零改动。这是对 issue PR Boundary 的已记录偏离，见 proposal。
- [ ] 纯搬迁 = 既有测试零改动全绿 + S2/S3 + `knip` 零新增（父 tasks.md:6 的纯搬迁验证）。它是独立提交，验证全绿之后才加 slow-ready。
- [ ] 新测试只进新建测试文件。E1–E6 先红后绿（E6 里 `frames=` 精确值单独恒绿，见上）；G1–G3 恒绿。PR body 记 RED/GREEN。
- [ ] 两个提交后都跑 `wc -l server/test/support/fake-omp.mjs server/test/support/fake-omp-proxy.mjs`：分别 ≈593/207，以及 ≤630（硬上限 740）/207。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-slow-ready --strict --no-interactive` 通过。
- [ ] CI 证据：`.github/workflows/ci.yml:121` 的 job `uid-isolation` 在 PR head 上为绿，PR body 附运行链接。
