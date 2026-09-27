# Tasks: fake-omp-thinking-scenarios（#518）

## 6. omp-test-harness — fake-omp（父 tasks 6.1 原文）

- [ ] 6.1 `server/test/support/fake-omp.mjs` 新 scenario `thinking`（`agent_start` 后 `thinking_start{contentIndex:0}`、恰三段 `thinking_delta`（`先读需求，`/`再列要点，`/`最后作答。`）、`thinking_end`、≥3 段正文 delta、content 含 thinking 块与文本块的 `message_end{stop}`、`agent_end`；任何 `--approval-mode` 下无工具帧与 select；可选 argv `--thinking-repeat <n>`（正整数，缺省 1）把三段 delta 按序重复 n 次，足够次数使合计超过 32768 码点；可选 `--hold-after-thinking` 在 `thinking_end` 之后像 `abort-ok` 一样挂起直到收到 `abort`，随后以 aborted 尾部结束）与 `edit-write`（`agent_start` 后先发与 `thinking` 相同的 `thinking_start`/三段 `thinking_delta`/`thinking_end`，再一个双工具 `message_end{toolUse}`；`edit` args 恰 `{input}`、end 帧 `details:{path:"<cwd>/notes.md", diff:"+1|a\n+2|b\n-3|c\n 4|d"}`；`write` args `{path:"out/report.html", content}`、end 帧 `details:{resolvedPath:"<cwd>/out/report.html"}` 无 diff；工具结束后再发至少两段正文 delta、`message_end{stop}`、`agent_end`（工具前无正文）；`<cwd>` 为 fake 的 `process.cwd()`，每个 end 帧前真实写出所报告文件（建 `out/`）；无审批）。验证：新建 `server/test/fake-omp-metadata-scenarios.test.ts`（真实子进程）断言两场景帧序列、thinking 拼接常量、`--thinking-repeat 3` 恰九段且顺序循环、非法 repeat 值启动失败、`--hold-after-thinking` 在 `abort` 前无后续帧且收到后以 aborted 尾部结束、文件真实存在、`yolo`/`write` 下均无 select

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新场景名与两个 argv 旋钮 → design 证据 1–3 |
| Concurrency / shared state / ordering | yes | hold 与 abort 早到/晚到次序 → 证据 4 |
| File IO / path safety / overwrite | yes | `<cwd>` 下真实写文件、`out/` 创建、路径以 cwd 为根 → 证据 5、6 |
| Legacy compatibility / examples | yes | 既有场景与 argv 不变、旋钮对其它场景无效、模块划分 → 证据 3(a)(b)、7 + 全部既有 fake-omp 测试零改动全绿 + PR head CI `uid-isolation` 绿 |
| Resource limits / large input / discovery | yes | 6555 帧的大回合、partial 不累积 → 证据 2（`--thinking-repeat 2185`，stdout < 4 MiB） |
| Error handling / rollback / partial outputs | yes | 非法 repeat 在任何帧前失败 → 证据 3；写失败时 end 帧 `isError` 由代码审查覆盖（不构造只读目录用例：异 uid/root 下不可移植） |
| Schema / columns / units / field names | no | 帧形状即 CLI 契约，归 Public API 包的证据 1、5 逐字段断言 |
| Config / project setup | no | 不涉 |
| Auth / permissions / secrets | no | 不读环境凭证；CI `uid-isolation` 回归归 Legacy 包 |
| Release / packaging / dependency compatibility | no | 仅测试支撑文件 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/fake-omp-metadata-scenarios.test.ts`（≤800 行）；既有测试文件与 `fake-omp-helpers.ts` 零改动。
- [ ] 按 design 新建纯构建模块 `fake-omp-thinking.mjs`（与 spec MODIFIED「假 omp 夹具模块划分」同 PR）；改后 `fake-omp.mjs` ≤ 720 行；PR 偏离记录写明新模块。
- [ ] 每条新断言先在 fixture 未改时跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-thinking-scenarios --strict --no-interactive` 通过；PR head CI `uid-isolation` 绿。
