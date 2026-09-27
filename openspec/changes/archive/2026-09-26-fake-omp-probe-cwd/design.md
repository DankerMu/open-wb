# Design: fake-omp-probe-cwd（#520）

父设计：design D12「probe」段。行号为 origin/master。

- **Change surface**：`server/test/support/fake-omp.mjs` `probeReport` 返回模板（:401）；`server/test/fake-omp-helpers.ts` `StartOptions`（:54-59）与 `startFake` spawn 选项（:69-72）；两处消费方期望；新测试文件。
- **Must preserve**：
  - probe 前 8 个字段（`uid … frames`）的次序、取值与语义不变；`frames=` 记录规则（`onLine` 内记录）不变。
  - probe 回合帧序（ack、`agent_start`、一段 delta、`message_end stop`、`agent_end`）与全部非 probe 场景出站帧逐字节不变。
  - `startFake` 不传 `cwd` 时 spawn 选项与现状逐字相同（`stdio`、`env` 不变，且不出现 `cwd` 键），除 Sibling surfaces 所列六处允许改动外，全部既有直接/间接使用 fake-omp 的测试零改动全绿。
  - `parseLabeledReport` 的解析循环（:271-293）不改；该函数与 `REPORT_LABELS` 不导出。
- **Must add/change**：
  - `fake-omp.mjs`：模板末尾追加 ` cwd=${process.cwd()}`——在 `probeReport` 执行时求值（报告时刻），原样输出，不做 realpath/规范化（Node 的 `process.cwd()` 即 getcwd 物理路径）。
  - `fake-omp-helpers.ts`：`StartOptions.cwd?: string`；spawn 选项为 `{ stdio, env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }` 形状。
- **Governing invariant**：probe 回报恰以 ` frames=<record> cwd=<fixture 报告时的 process.cwd()>` 结尾，`cwd` 是最后一个标签；按「下一个标签 ` <next>=` 切分、末标签取余量」的规则，任何含空格或 `=` 的工作目录路径都能被无歧义地切出，且 `frames` 不带 cwd 后缀。
- **Sibling surfaces**：
  - 必然变红的既有断言：
    - `fake-omp.test.ts:472,481,489` 三个 probe 用例（经 `expectedProbeReport` :753-755 精确相等）；
    - `uid-isolation.test.ts` 的 `parsed.frames`（若不加 `cwd` 标签，`frames` 会解析为 `… cwd=…`）与 `parseLabeledReport` 末标签（只在 CI Linux job 运行）；
    - 以串尾锚定正则提取 `frames` 的三处（change A 新增）：`fake-omp-frames.test.ts:91` `/ wrote=\S+ frames=([^ ]*)$/u`（7 处 `framesOf`）、`fake-omp-slow-ready.test.ts:229` `/ frames=([^ ]*)$/u`、`omp-approval-requests.test.ts:195` `/ frames=(\S*)$/u`（4 处 `probeFrames`）。
  - 允许的既有测试改动恰为：
    1. `fake-omp.test.ts` `expectedProbeReport` 模板末尾追加 ` cwd=${<vitest 进程 cwd 的 realpath>}`（`realpathSync(process.cwd())`；若需 `realpathSync` 导入则同文件导入行增加该名）。
    2. `uid-isolation.test.ts:41` `REPORT_LABELS` 追加 `"cwd"`。
    3. `uid-isolation.test.ts` `parseLabeledReport` 返回对象在 `frames: requiredValue(values, 7),` 之后增 `cwd: requiredValue(values, 8),`（类型所迫，先例 #459）。
    4. `fake-omp-frames.test.ts:91` 正则把串尾锚 `$` 换成 ` cwd=`：`/ wrote=\S+ frames=([^ ]*) cwd=/u`。
    5. `fake-omp-slow-ready.test.ts:229` 同理：`/ frames=([^ ]*) cwd=/u`。
    6. `omp-approval-requests.test.ts:195` 同理：`/ frames=(\S*) cwd=/u`。
    4–6 各只改该一行正则：保留原捕获组字符类（不放宽为无锚 `(\S*)`）、保留同处的其它检查（如 `split(" frames=")` 长度检查）与全部期望值。
    此外零改动；`fake-omp.test.ts`（771 行）增长不超过 2 行、≤800。
  - `fake-omp-helpers.ts` 是支撑文件；除上列六处外，其它直接使用 fake-omp 的测试文件与经 `session-supervisor-helpers.ts`/`server-startup-helpers.ts` 间接使用的测试零改动全绿。
  - 下游消费者：2.2 #521、4.4 #527 以 `cwd=` 值与所选目录 realpath 比较；uid-isolation job 中子进程 cwd 为所有者沙箱根（只解析，不断言值）。
- **Seams under test**：真实子进程，经 `startFake({ scenario: "normal", cwd })`，只看 stdout 帧与 probe delta。
- **Required evidence**（新文件 `server/test/fake-omp-probe-cwd.test.ts`，每条先在 fake 未改时跑红）：
  1. 以 `mkdtemp(join(tmpdir(), "open wb cwd=probe-"))` 建路径同时含空格与 `=` 的临时目录，`startFake({ scenario: "normal", cwd: dir })`，握手（`negotiate_protocol`、`get_state`）后发 probe prompt → probe delta 与本文件构造的完整期望串整段精确相等，且以 ` frames=negotiate_protocol,get_state,prompt cwd=${realpathSync(dir)}` 结尾（macOS `tmpdir` 为 `/var/...` 符号链接，realpath 为 `/private/var/...`，证明比较须用 realpath）。
  2. 本文件自带的等价解析器（标签表 `uid,gid,env,home,agent,environ,wrote,frames,cwd`，按 ` <next>=` 切分、末标签取余量）切出 `frames === "negotiate_protocol,get_state,prompt"`、`cwd === realpathSync(dir)`（含空格与 `=`）。
  3. 同一会话 probe 回合帧序仍为 ack、`agent_start`、一段 delta、`message_end stop`、终态 `agent_end`（恒绿守卫）。
  4. 不传 `cwd` 的 `startFake`：probe `cwd=` 等于 vitest 进程 `realpathSync(process.cwd())`（由改后的 `expectedProbeReport` 三个既有用例证明）。
  5. 允许改动 4–6 之后，既有「入站帧次序回报」类用例（`fake-omp-frames.test.ts` 七处 `framesOf`、`fake-omp-slow-ready.test.ts:229` 的 `negotiate_protocol,get_state,prompt,abort,prompt`、`omp-approval-requests.test.ts` 四处 `probeFrames`）期望值不变且全绿——证明 spec「`frames` 值止于 ` cwd=` 标签之前」。
  - 另：PR head CI `uid-isolation` job 绿（`REPORT_LABELS` 以 `"frames", "cwd"` 结尾后的真实异 uid 回报切分）。
- **Non-goals**：见 proposal。
- **Review focus**：`cwd=` 为最后字段且取报告时刻 `process.cwd()`；`startFake` 缺省路径逐字不变；既有测试只有 Sibling surfaces 所列六处允许改动（4–6 各为单行正则，捕获字符类不变、期望值不变）；新解析器与 `parseLabeledReport` 规则一致；`frames` 切分不被 cwd 路径中的 ` frames=`/`=` 干扰。
