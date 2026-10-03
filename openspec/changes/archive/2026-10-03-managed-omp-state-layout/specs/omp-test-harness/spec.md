## MODIFIED Requirements

### Requirement: 假 omp probe 回报
For prompt `probe:<pid>:<writePath>`, the fake omp SHALL first attempt to write UTF-8 `probe` at the complete writePath using its own credentials, then attempt to read `/proc/<pid>/environ`. It SHALL emit one text delta with fields in order `uid=<uid> gid=<gid> env=<comma-separated sorted environment keys> home=<HOME> xdgdata=<XDG_DATA_HOME> xdgstate=<XDG_STATE_HOME> xdgcache=<XDG_CACHE_HOME> environ=<readable|errno> wrote=<ok|errno> frames=<inbound frame record> cwd=<process.cwd()>`, based on its own process and actual IO outcomes; the `frames=` value is exactly the inbound frame record defined by Requirement `假 omp 入站帧记录`, and the trailing `cwd=` value (S1c B) is the fixture's `process.cwd()` verbatim at report time — the child's actual working directory, which the production spawn sets to the `--cwd` value (omp-runtime `子进程 spawn 契约`); Node reports it as the physical path, so hosts compare it with the realpath of the directory they chose. Adding `frames=` (S1c A) and then `cwd=` (S1c B) changes the exact probe string, so its two consumers SHALL be updated in the same change as each addition: the expected-report builder `expectedProbeReport` in `server/test/fake-omp.test.ts` (exact string equality) and `REPORT_LABELS` in `server/test/linux/uid-isolation.test.ts`, which gains `"frames"` (A) and then `"cwd"` (B) so that after B the labels end `…, "wrote", "frames", "cwd"` and `cwd` is the last label consumed by `parseLabeledReport` (the last label takes the remainder, so spaces or `=` inside the cwd path are safe, and the comma-joined, space-free `frames` value keeps both the ` frames=` and the ` cwd=` split unambiguous); the Linux uid-isolation job SHALL stay green. Replacing `agent=` by the three `xdg*=` fields (#706) again changes the exact probe string: `expectedProbeReport` and `REPORT_LABELS` (`…, "home", "xdgdata", "xdgstate", "xdgcache", "environ", …`) SHALL be updated in the same change. For prompt `rename:<path>` (the whole remainder is the path, so colons and spaces are safe) the fake omp SHALL attempt `rename(<path>, <path> + ".moved")` with its own credentials and emit one text delta `renamed=<ok|errno>`. It SHALL reuse normal prompt acknowledgement and assistant stop/terminal agent_end frames even when either IO operation fails. It SHALL not disclose arbitrary environment values or proc contents. Non-probe behavior SHALL remain unchanged.

#### Scenario: 同 uid 成功
- WHEN an ordinary Linux real child receives a probe for its same-uid parent with a writable test-owned path containing colons and spaces
- THEN identity equals that of the parent, environment keys are sorted, HOME and the three XDG values equal supplied values, environ is readable, wrote is ok, and exact file content is probe before normal completion

#### Scenario: IO 失败独立回报
- WHEN the destination parent does not exist or the target proc pid does not exist
- THEN the failed operation reports ENOENT, the other operation is still attempted and truthfully reported, and the process emits its normal terminal completion

#### Scenario: 非 Linux 不伪造证明
- WHEN the child runs on macOS without procfs
- THEN it reports the actual proc read errno while identity, environment, file content and terminal behavior remain verifiable; this result is not reported as Linux readability or uid isolation proof

#### Scenario: 非 probe 兼容
- WHEN an existing non-probe prompt/scenario is exercised
- THEN the #87 handshake, scenario-specific frame sequence, and normal shutdown remain unchanged

#### Scenario: probe 报告带 frames 字段
- **WHEN** a `normal` child completes the handshake (`negotiate_protocol`, `get_state`) and then receives a probe prompt
- **THEN** the delta contains ` wrote=<ok|errno> frames=negotiate_protocol,get_state,prompt` immediately followed by the ` cwd=` field, `expectedProbeReport` in `fake-omp.test.ts` equals the whole delta exactly, and `parseLabeledReport` in `uid-isolation.test.ts` yields `wrote` without the frames suffix and `frames` as its own label

#### Scenario: 入站帧次序回报
- **WHEN** an `approval-then-abort` child receives a prompt, a `select` answer `Deny`, then `abort`, and afterwards receives a probe prompt
- **THEN** the probe delta's `frames` field ends with `…,prompt,extension_ui_response,abort,prompt` (the value before the ` cwd=` label), listing types only, and the preceding fields keep their order and semantics

#### Scenario: probe 报告带 cwd 字段
- **WHEN** a `normal` child is spawned with working directory `<dir>` whose path contains a space, completes the handshake and receives a probe prompt
- **THEN** the delta ends with ` frames=negotiate_protocol,get_state,prompt cwd=<realpath of dir>`, `expectedProbeReport` equals the whole delta exactly, `parseLabeledReport` yields `frames` without the cwd suffix and `cwd` equal to the realpath of `<dir>` including the space, and the Linux uid-isolation job (where the child's cwd is the owner sandbox root) stays green with `REPORT_LABELS` ending `"frames", "cwd"`

#### Scenario: rename 探针
- **WHEN** the fake omp receives `rename:<path>` for an existing test-owned path containing colons and spaces, then for a path whose parent directory it cannot write
- **THEN** the first reports `renamed=ok` and the entry now exists only as `<path>.moved`; the second reports `renamed=EACCES` (or the actual errno) and nothing moved; both turns complete normally

### Requirement: 假 omp 夹具模块划分
`server/test/support/fake-omp.mjs` SHALL 是假 omp 唯一的可执行入口，负责按 argv 解析结果选定场景、JSONL 帧收发、scenario 状态与出站帧。call-proxy 的上游客户端 SHALL 位于同目录的 `server/test/support/fake-omp-proxy.mjs`，职责包括：读取受管 `models.yml`（`$HOME/.omp/agent/models.yml`，即真实 omp 在未设 `PI_CODING_AGENT_DIR` 时的默认 agent 目录；`HOME` 缺席按配置缺失处理）的 `providers.workbuddy` 配置、向 `baseUrl/chat/completions` 发 POST、重组 SSE 的 delta 与 tool call 分片、解析上游 tool call 参数。argv 解析 SHALL 位于同目录的 `server/test/support/fake-omp-argv.mjs`，职责包括：取值型与布尔型 argv 的表、`--scenario` 等取值的位置无关解析与缺值判定、`--ready-delay-ms` 与 `--start-delay-ms` 的取值校验；它只返回解析结果，不决定场景行为。S1c 会话元数据场景的纯构建部分 SHALL 位于同目录的 `server/test/support/fake-omp-thinking.mjs`，职责包括：确定性思考文本常量、`thinking_start`/`thinking_delta`/`thinking_end` 事件与 `message_end` thinking 块的构建、`edit-write` 的固定 hashline input、post-edit 文件内容、html 内容与 `details` 构建，以及 `--thinking-repeat` 取值校验；它不写文件。`fake-omp-proxy.mjs`、`fake-omp-thinking.mjs` 与 `fake-omp-argv.mjs` SHALL 只导入 `node:` 内建模块，不导入 `fake-omp.mjs`、彼此不相互导入，不持有模块级可变状态，也不发出任何 JSONL 帧；值导入只沿 `fake-omp.mjs → fake-omp-proxy.mjs`、`fake-omp.mjs → fake-omp-thinking.mjs` 与 `fake-omp.mjs → fake-omp-argv.mjs` 三个方向（有向无环）。四个文件 SHALL 各自 ≤800 行（AGENTS.md 的文件行数约定；`scripts/size-guard.sh` 不扫描 `.mjs`，以 `wc -l` 核对）。夹具整体仍不依赖任何第三方包。

#### Scenario: 模块划分可持续验证
- **WHEN** 检查 `server/test/support/` 下四个模块的 import 语句，并运行 `wc -l` 与 server 测试
- **THEN** `fake-omp-proxy.mjs`、`fake-omp-thinking.mjs` 与 `fake-omp-argv.mjs` 的 import 只含 `node:` 说明符、不含 `fake-omp.mjs` 且互不导入；`fake-omp.mjs` 以相对路径 `./fake-omp-proxy.mjs`、`./fake-omp-thinking.mjs` 与 `./fake-omp-argv.mjs` 静态导入它们；四个文件均 ≤800 行；fake-omp、call-proxy 与元数据场景相关测试全绿
