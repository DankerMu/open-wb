# Tasks: runtime-command-abort（#488）

## 2. omp-runtime — 命令面与退出上报（父 tasks 2.2b 原文）

- [ ] 2.2b `runtime.ts`/`commands.ts`：`command(frame)` 暴露相关请求（进程存活且非回合中，否则 `SessionBusyError`；无存活子进程时经与 prompt 同一惰性获取路径起进程）；`abort()`（签名 `abort(): Promise<response> | false`；仅在回合 `prompt` 帧已写出时写 `abort` 帧；无进行中回合、`prompt` 帧尚未写出或无存活子进程时不写任何帧并返回 `false`，返回 false 时由 owner 登记停止意图并在派发回执后再次 abort（4.2b））。验证（新建测试文件，真实 fake-omp 子进程）：回合中 `command` 抛 `SessionBusyError`；无进程时 `command` 惰性起进程；「派发回执后 abort」（fake `slow-ready`（6.5）：`prompt` 帧写出前 `abort()` 返回 `false` 且不写帧，派发回执后 `abort()` → iterator 见 `message_end aborted`、`agent_end`，`response{command:"abort"}` 只结算 abort 请求；随后 probe `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`，即 `prompt` 帧后恰一个 `abort` 帧）
- [ ] （本 fixture 追加，见 proposal「偏离与决定」1）第 1 步纯搬迁：`runtime.ts` 的退役/排空计时辅助（`:38-40`、`:627-650`、`:658-721`）按 design「Must add/change」表格改写为 `commands.ts` 模块函数，只允许三种替换；`stdoutEnded`/`destroyStdio`/`raceDelay` 去掉 `export`。验证：design S1
- [ ] （本 fixture 追加，见 proposal「偏离与决定」3–5）abort response 不进 iterator、`false` 以回执兑现为界、`command` 的失败 response 与关停后调用。验证：design A2、A4、A6、A7、C5、C6、C8

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionRuntime` 新增 `command`/`abort`；返回形状 `Promise<data>`、`Promise<response> \| false`；同步抛错类型 → A1–A7、C1–C6 |
| Concurrency / shared state / ordering | yes | abort 帧晚于 prompt 写出完成；prompt/command 互斥；认领在各结算路径释放；单一获取路径 → A2、A3、C3、C4、M1/M4/M5 |
| Error handling / rollback / partial outputs | yes | 子进程先退出、失败 response、关停、正在退役的代各有确定出口，不悬挂认领；回执兑现后的 `false` 让 owner 丢弃停止意图 → A6、A7、C4、C5、C6、C8 |
| Auth / permissions / secrets | yes | 每代 token 恰签发一次、恰撤销一次；command 获取不多签发 → C1、C2、C4 |
| Resource limits / large input / discovery | yes | 退役 5s/8s 升级与 held pipe 8s 预算随搬迁跨文件；不得多起进程 → S1（既有测试零 diff）、C1、C3 |
| Legacy compatibility / examples | yes | prompt/shutdown/onExit/onApproval 行为与签名不变；既有调用方不调新方法 → S1、既有测试零 diff 全绿 |
| Schema / columns / units / field names | yes | `get_branch_messages` 的 `data.messages`、`branch` 的 `data:{text,cancelled}`、abort response 形状原样透传；`sessionFile` 采纳 → C1、C2、A1 |
| Config / project setup | no | 无新配置；`OMP_IDLE_MS` 语义不变 |
| File IO / path safety / overwrite | no | runtime 不写文件；branch 新文件由 fake/omp 写出，C2 只核对存在 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/omp/runtime.ts` 与 `commands.ts`；`process.ts`、`ui-requests.ts`、`frame.ts`、`prompt-stream.ts`、`local-command.ts`、supervisor、store、`app.ts`、`server/test/support/fake-omp*.mjs`、全部既有测试与 helper（含 `session-supervisor-helpers.ts`、`support/omp-*.ts`）零 diff。
- [ ] 搬迁先于功能（可分两个 commit）：第 1 步后 `runtime.ts` ≤705，第 2 步后目标 ≤770、硬上限 785；超过 785 先停下上报（design「行数」）。`commands.ts` 对 `./runtime.js` 只有 `import type`；`runtime.ts`/`commands.ts` 不出现 `extension_ui_response`，对 `./ui-requests.js` 只有语句级 `import type`。
- [ ] 新测试只写进一个新建文件 `server/test/omp-runtime-commands.test.ts`（≤800 行），只经公开 API；argv 记录、stdin tap、`--compact-silent` 追加都在该文件内包装 `createRealFakeRuntime(...).runtime.spawnImpl` 完成；FakeChild 世界照 `omp-dispatch.test.ts:245-282`（A2）与 `omp-runtime-io.test.ts:319-363`（A7、C8）。
- [ ] 既有测试允许的改动：**无**（design「Sibling surfaces」已逐一核对）。
- [ ] 红/绿：A1–A7、C1–C8 在未改源码时失败，失败原因是 `abort`/`command` 不存在，记录失败输出。S1、G1 为守护，恒绿。变异 M1–M8 逐一临时施加，确认对应用例变红，结果记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/omp/{runtime,commands}.ts server/test/omp-runtime-commands.test.ts`（第 1 步后与第 2 步后各一次），记入 PR body。
- [ ] `npm test --workspace server`（覆盖率 ≥80%，Node 24 按 `.tool-versions`）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 不升高）、`bash scripts/size-guard.sh`，全部退出 0；`openspec validate runtime-command-abort --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：父 omp-runtime delta「相关命令 API 与回合中断」逐字采纳本子 delta 的自写精化，推进后按 runbook 改为 MODIFIED 并与主 spec 逐字一致。
