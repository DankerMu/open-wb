# Tasks: local-command-wait（#553）

## 10. omp-runtime — 本地完成等待（父 tasks 10.2 原文）

- [ ] 10.2 `server/src/sessions/omp/local-command.ts`（新，纯判定：输入「派发文本是否以 `/` 开头」「本次派发后是否已见 `command_output`」「匹配的 `agentInvoked:false` 回执是否已到」「本帧类型」「注入时钟自回执起的毫秒数」，输出 `complete | await | none`；常量 `LOCAL_COMMAND_GRACE_MS = 120_000`）+ `server/src/sessions/omp/runtime.ts` 接线（`#onFrame` 用该判定替换 `isLocalComplete` 分支：文本不以 `/` 开头、或回执到达且已见输出 → `#completeTurn`（现状）；以 `/` 开头且未见输出 → 记录等待并以注入时钟起 120 s 定时器，首个 `command_output` 或到期 → `#completeTurn`；回合结束/generation retire 取消定时器；等待期帧照常 `turn.stream.push` 并重置 idle）。验证：新建 `server/test/omp-runtime-local-command.test.ts`——纯判定表驱动（非 `/` 文本立即完成 / `/` 文本已见输出立即完成 / `/` 文本未见输出进入等待 / 等待中首个输出完成 / 到期完成 / `agentInvoked:true` 回执永不完成 / 等待中 `agent_end`、匹配失败走常规）+ 真实 fake `slash`：`/todo` 在回执处结束且迭代器含输出帧；手写帧：`hello` 裸回执照旧立即结束、`/x` 先输出再 `agentInvoked:true` 回执再 agent 帧 → 只在 `agent_end` 结束（`slash` 夹具对 `hello` 走 normal，这两例用 wired 假子进程手写帧，同 `omp-runtime-io.test.ts`）；`/compact` 不在回执处结束、在 `command_output` 到达处结束且该帧为迭代器最后一帧；`--compact-silent` 注入时钟推进 120 000 ms 恰好结束、不伪造帧；后续 prompt 复用同一子进程；已结束回合/已 retire 的定时器不影响后续回合（omp-runtime「Local-only outcome waits for late command output」「Prompt lifecycle signals」）；`omp-runtime.test.ts`（790 行）只改期望值不增长；`bash scripts/size-guard.sh` 退出 0（`runtime.ts` ≤800）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 等待状态、宽限定时器与 idle/retire/shutdown/放弃的交互、旧定时器不结束新回合 → design 证据 3、4、5、7、7b、9 |
| Legacy compatibility / examples | yes | 非 `/` 文本 local-only 不变 → 证据 2 + 既有 `omp-runtime*`/`omp-dispatch`/`session-supervisor*` 零改动全绿 |
| Error handling / rollback / partial outputs | yes | 等待中终态、匹配失败、子进程退出 → 证据 6、7 |
| Resource limits / large input / discovery | yes | 定时器泄漏 → 证据 3、7 的 `clock.pending()` |
| Public API / CLI / script entry | yes | 新模块导出与判定表、`SessionRuntime` 签名不变 → 证据 1 + typecheck + knip |
| File IO / path safety / overwrite | no | 不涉 |
| Schema / columns / units / field names | no | 只读既有帧字段 |
| Config / project setup | no | 常量非配置 |
| Auth / permissions / secrets | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/omp-runtime-local-command.test.ts`（≤800 行）；`omp-runtime.test.ts`、`omp-runtime-io.test.ts` 及其它既有测试零改动。
- [ ] `runtime.ts` 改后 ≤ 800 行。
- [ ] 每条新断言先在实现前跑红，再实现跑绿（记录命令与结果）；证据 2 与证据 8 的 `/todo`、`hello` 段为回归护栏，实现前即绿，按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate local-command-wait --strict --no-interactive` 通过；PR head CI 绿。
