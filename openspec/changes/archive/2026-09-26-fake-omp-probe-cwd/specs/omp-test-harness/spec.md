# Spec delta: omp-test-harness（#520 probe `cwd=`）

> 整段取父 change `s1c-session-metadata-presentation` delta 的「假 omp probe 回报」。父块与当前主 spec（A #459 已 promoted 的 `frames=` 版）的差异恰为 `cwd=` 字段、两个既有 Scenario 的 cwd 衔接措辞与新增 Scenario「probe 报告带 cwd 字段」。本 issue 交付该 requirement 父 delta 的全部内容。

## MODIFIED Requirements

### Requirement: 假 omp probe 回报
For prompt `probe:<pid>:<writePath>`, the fake omp SHALL first attempt to write UTF-8 `probe` at the complete writePath using its own credentials, then attempt to read `/proc/<pid>/environ`. It SHALL emit one text delta with fields in order `uid=<uid> gid=<gid> env=<comma-separated sorted environment keys> home=<HOME> agent=<PI_CODING_AGENT_DIR> environ=<readable|errno> wrote=<ok|errno> frames=<inbound frame record> cwd=<process.cwd()>`, based on its own process and actual IO outcomes; the `frames=` value is exactly the inbound frame record defined by Requirement `假 omp 入站帧记录`, and the trailing `cwd=` value (S1c B) is the fixture's `process.cwd()` verbatim at report time — the child's actual working directory, which the production spawn sets to the `--cwd` value (omp-runtime `子进程 spawn 契约`); Node reports it as the physical path, so hosts compare it with the realpath of the directory they chose. Adding `frames=` (S1c A) and then `cwd=` (S1c B) changes the exact probe string, so its two consumers SHALL be updated in the same change as each addition: the expected-report builder `expectedProbeReport` in `server/test/fake-omp.test.ts` (exact string equality) and `REPORT_LABELS` in `server/test/linux/uid-isolation.test.ts`, which gains `"frames"` (A) and then `"cwd"` (B) so that after B the labels end `…, "wrote", "frames", "cwd"` and `cwd` is the last label consumed by `parseLabeledReport` (the last label takes the remainder, so spaces or `=` inside the cwd path are safe, and the comma-joined, space-free `frames` value keeps both the ` frames=` and the ` cwd=` split unambiguous); the Linux uid-isolation job SHALL stay green. It SHALL reuse normal prompt acknowledgement and assistant stop/terminal agent_end frames even when either IO operation fails. It SHALL not disclose arbitrary environment values or proc contents. Non-probe behavior SHALL remain unchanged.

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
- **THEN** the delta contains ` wrote=<ok|errno> frames=negotiate_protocol,get_state,prompt` immediately followed by the ` cwd=` field, `expectedProbeReport` in `fake-omp.test.ts` equals the whole delta exactly, and `parseLabeledReport` in `uid-isolation.test.ts` yields `wrote` without the frames suffix and `frames` as its own label

#### Scenario: 入站帧次序回报
- **WHEN** an `approval-then-abort` child receives a prompt, a `select` answer `Deny`, then `abort`, and afterwards receives a probe prompt
- **THEN** the probe delta's `frames` field ends with `…,prompt,extension_ui_response,abort,prompt` (the value before the ` cwd=` label), listing types only, and the preceding fields keep their order and semantics

#### Scenario: probe 报告带 cwd 字段
- **WHEN** a `normal` child is spawned with working directory `<dir>` whose path contains a space, completes the handshake and receives a probe prompt
- **THEN** the delta ends with ` frames=negotiate_protocol,get_state,prompt cwd=<realpath of dir>`, `expectedProbeReport` equals the whole delta exactly, `parseLabeledReport` yields `frames` without the cwd suffix and `cwd` equal to the realpath of `<dir>` including the space, and the Linux uid-isolation job (where the child's cwd is the owner sandbox root) stays green with `REPORT_LABELS` ending `"frames", "cwd"`
