# sidecar-settled-claim — sidecar 不再重领自己已落定的作业（#1601）

## Why

`office-sidecar` CI job 偶发红（run 39547960137，纯文档 PR）：同一作业 id 被 sidecar 领了两次，第一次 `done`（1129 ms），第二次 0 ms 落成 `bad-request`，之后 `jobs/` 不空。sidecar 判「就绪」只看在途表、`request.json` 在、`done` / `failed` 不在（`converter/sidecar.mjs:333-338`），作业退出时同步地移出在途表再写标记，此后挡住重领的只有标记文件本身。app 拿到 `done` 后 `rmSync(job, {recursive, force})`（`server/src/preview/office.ts:168-174`）是逐项删除、不原子：删除途中 `done` 与 `in/` 已删、`request.json` 还在时，下一轮 tick 把它当新作业领取，`in/<input>` 不在 → `bad-request`，`failed` 写进正在被删的目录，app 最后的 `rmdir` 失败、错误被吞，目录残留到下次启动。生产上同样会留残余和一行假的 `failed` 日志；返回给用户的 PDF 不受影响。

## What

- `converter/sidecar.mjs`：内存中的已落定 id 集合。`settle` 加入；`readyJobs` 跳过集合里的 id；每轮 `readdir` 之后把本轮不再出现的 id 移出（有界）。重启后为空。头注释（spool 协议的单一真相）的领取条件同步。
- 测试（真 sidecar，`server/test/support/converter-sidecar.ts` 夹具）：作业 `done` 后测试按「先删 `done` 与 `in/`、保留 `request.json`」拆目录并停留 ≥3 个轮询周期，断言无第二行日志、无 `failed`、最终整目录可删；变异（去掉集合）同用例转红。有界性用例：删除后以同一 id 重建就绪作业，一个轮询周期内被领取。
- 规格：office-preview「转换 sidecar 实现与镜像」（领取条件、已落定集合、两个 Scenario）与「sidecar 转换契约」第 (6) 步（删除非原子、cancel 路径残余登记）。
- 不做：app 侧 `removeJob` 改删除次序或加 `maxRetries`（app 不再等待的作业上首次落定写进删除中目录的残余，已由 owner 接受并登记在案——「终止结束作业的全部进程」、ADR-0014、system.md；design D5）；「`cancelled` 不写标记」（协议变更）；#1574（测试替身的观察问题，已修）；`rmSync` 途中换入符号链接的已登记残余。

## Triage

```text
Issue type: bugfix (cross-process race)
Fixture level: expanded
Upstream suggested level: absent (issue-scribe filed; S, p2)
Level rationale: expanded — Concurrency / state machine trigger (app and sidecar race over a non-atomic recursive delete; the spool protocol is a cross-process contract with a single-source header); the code change is a few lines.
Blast radius: every conversion's claim decision in the sidecar; a wrong set either skips a genuinely new job (conversion never starts → app timeout) or grows without bound
Selected risk packs: Concurrency / state machine (claim condition gains in-memory memory; bounded pruning per tick; restart semantics unchanged); Resource limits (set bounded by `jobs/` directory count); not selected — Auth / secrets, File IO / path safety (no new path handling), Schema (request.json unchanged), Config (no new knob), Public API, Error handling (same swallowed errors), Release / packaging (image unchanged apart from the script)
Evidence floor: re-claim case red before the fix; two mutations (skip off → re-claim red; pruning off → bounded red); green with the fix; `npx vitest run --root server test/converter-sidecar` ×3; `npm test --workspace server`; `make check`; CI `office-sidecar` green, re-run 5× on the PR head (the issue's N green runs; `ci.yml` has no `workflow_dispatch`)
```
