# Spec delta: omp-test-harness（#459 probe `frames=` 与入站帧记录）

> 本 delta 并入父 delta 的两条 requirement。
> - 「假 omp probe 回报」：整条由本 issue 交付，按父 delta 逐字重述，包括主 spec 已有的 4 个 Scenario 和新增的「probe 报告带 frames 字段」「入站帧次序回报」。后者依赖的 `approval-then-abort` 已由 #458 并入主 spec。
> - 「假 omp 入站帧记录」：主 spec 没有这条，所以用 ADDED。段落逐字取自父 delta，只带 Scenario「记录只含类型且按到达顺序」。Scenario「延迟握手期间停止 → 帧序 prompt,abort」依赖 `slow-ready`，留给 6.5 #461，它归档时以 MODIFIED 并入。
> - 「假 omp 进程契约」不在本 delta。它剩余的 S1c 段：`slow-ready` 与 Scenario「延迟握手」归 6.5 #461；`approval-chain-abort-ignored` 与 Scenario「审批链上 abort 被忽略」归 6.6 #470。这两条 requirement 里没有任何部分要留给 #470。

## MODIFIED Requirements

### Requirement: 假 omp probe 回报
For prompt `probe:<pid>:<writePath>`, the fake omp SHALL first attempt to write UTF-8 `probe` at the complete writePath using its own credentials, then attempt to read `/proc/<pid>/environ`. It SHALL emit one text delta with fields in order `uid=<uid> gid=<gid> env=<comma-separated sorted environment keys> home=<HOME> agent=<PI_CODING_AGENT_DIR> environ=<readable|errno> wrote=<ok|errno> frames=<inbound frame record>`, based on its own process and actual IO outcomes; the trailing `frames=` value is exactly the inbound frame record defined by Requirement `假 omp 入站帧记录`. Adding `frames=` changes the exact probe string, so its two consumers SHALL be updated in the same change: the expected-report builder `expectedProbeReport` in `server/test/fake-omp.test.ts` (exact string equality) and `REPORT_LABELS` in `server/test/linux/uid-isolation.test.ts`, which gains `"frames"` as the new last label consumed by `parseLabeledReport` (the last label takes the remainder, and the comma-joined, space-free `frames` value keeps the ` frames=` split unambiguous); the Linux uid-isolation job SHALL stay green. It SHALL reuse normal prompt acknowledgement and assistant stop/terminal agent_end frames even when either IO operation fails. It SHALL not disclose arbitrary environment values or proc contents. Non-probe behavior SHALL remain unchanged.

#### Scenario: 同 uid 成功
- WHEN an ordinary Linux real child receives a probe for its same-uid parent with a writable test-owned path containing colons and spaces
- THEN identity equals that of the parent, environment keys are sorted, HOME/agent equal supplied values, environ is readable, wrote is ok, and exact file content is probe before normal completion

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
- **THEN** the delta ends with ` wrote=<ok|errno> frames=negotiate_protocol,get_state,prompt`, `expectedProbeReport` in `fake-omp.test.ts` equals it exactly, and `parseLabeledReport` in `uid-isolation.test.ts` yields `wrote` without the frames suffix and `frames` as its own label

#### Scenario: 入站帧次序回报
- **WHEN** an `approval-then-abort` child receives a prompt, a `select` answer `Deny`, then `abort`, and afterwards receives a probe prompt
- **THEN** the probe delta's `frames` field ends with `…,prompt,extension_ui_response,abort,prompt`, listing types only, and the preceding fields keep their order and semantics

## ADDED Requirements

### Requirement: 假 omp 入站帧记录
The fake omp SHALL keep, per process, an ordered record of the `type` of every inbound JSONL frame it has received on stdin, appended in arrival order at the moment the line is parsed, including `negotiate_protocol`, `get_state`, `prompt`, `extension_ui_response`, `abort`, `get_branch_messages` and `branch` and including the probe prompt that triggers the report. The record SHALL contain frame types only — never ids, payloads, message text or other field values — joined by `,` with no spaces; blank lines, lines that fail JSON parsing and parsed values without a string `type` are not recorded. It is reported only through the probe `frames=` field, so host tests can prove inbound ordering (for example that `extension_ui_response` precedes `abort`, or that a stop's `abort` follows the `prompt` it interrupts) through a real subprocess; it SHALL NOT alter any emitted frame of any scenario.

#### Scenario: 记录只含类型且按到达顺序
- **WHEN** a child receives `negotiate_protocol`, `get_state`, a prompt whose message text contains `secret-marker`, then a probe prompt
- **THEN** the probe `frames=` value is exactly `negotiate_protocol,get_state,prompt,prompt` and the delta does not contain `secret-marker` or any request id
