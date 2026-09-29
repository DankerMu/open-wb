# Tasks: approval-frame-order（#620）

## 1. fake-omp

- [ ] 1.1 四个审批场景在 write 下改为先 select 后 `tool_execution_start`（并行：两 select 先于两 start），chain 分支同步（design「Must add/change」）。验证：C1、C2、C4。
- [ ] 1.2 四个审批场景的每个 `tool_execution_end` 之后发该调用的 toolResult `message_end`；审批回合经 abort 收尾时发实测的空 aborted 回合。验证：C1–C3。
- [ ] 1.3 `fake-omp.mjs` 保持 ≤800 行；非审批场景出站帧逐字不变（既有 fake 测试全绿即证据）。

## 2. 测试缺省与 yolo 残留

- [ ] 2.1 `fake-omp-helpers.ts` 的 `OMP_FLAGS` 改为 `--approval-mode write`，与生产 spawn argv 一致；依赖「缺省即 yolo」的用例改为显式 `--approval-mode yolo`：
  - `fake-omp-metadata-scenarios.test.ts:207`「default argv (yolo)」及 `:430`；
  - `fake-omp-approval-chain.test.ts:296-302` 的基线；
  - `fake-omp-approval.test.ts:219-224`「default or last flag」；
  - `fake-omp-approval.test.ts:331-378`「existing scenarios under --approval-mode write」：它拿 `run(scenario, script, [])` 与 `WRITE` 比较，改 write 后会变成 write 对 write、空转变绿；基线须改为显式 `--approval-mode yolo`；
  - 以及实现时发现的其它此类用例。
  验证：C5。
- [ ] 2.2 删除已成空操作的替换：
  - `omp-runtime-exit-pending.test.ts:77,94`；
  - `omp-approval-requests.test.ts:66-68`，并更新 `:3-4` 的注释；
  - `session-supervisor-pool-helpers.ts` `gateApprovals`（删除函数及其调用，或改为不追加参数）。
  删除后对应用例仍按门控运行且全绿。

## 3. 服务端测试

- [ ] 3.1 R13 与并行用例的次序断言与回放断言改为新次序（S1）；R13、R19 的扣帧触发点按 S1b 改写，保住原意图。
- [ ] 3.2 S2：点名或新增 select 挂起时 stop 的用例（Deny 先于 abort，`stopped`，审批 `deny`，步骤 `failed`）。
- [ ] 3.3 S3：全部既有审批/停止/结算/快照测试在新 fake 下全绿。改动过期望的用例逐条列出（文件、用例、改动、理由），只允许三类改动：改帧序或次序；补新增帧；design S1/S1b 列明的触发点与回放断言替换。

## 4. 证据与收尾

- [ ] 4.1 红/绿：C1–C4、S1 在旧 fake 上为红，把失败摘要记入报告。
- [ ] 4.2 `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 全部退出 0；`wc -l server/test/support/fake-omp.mjs` 记入报告。
- [ ] 4.3（编排者）归档 PR 同步父 change A（design D5 事件次序句、D7 fake 描述、tasks 6.3/6.6 措辞、omp-test-harness 与 tool-approval delta 块）与 change B（omp-test-harness delta 块）中的同名文字。
- [ ] 4.4 `openspec validate approval-frame-order --strict --no-interactive` 通过。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | 钉住旧次序的 fake 与服务端测试、缺省 yolo 基线用例须迁移而不弱化；非审批场景逐字不变 → S3、C5、1.3 |
| Concurrency / shared state / ordering | yes | select/start 相对次序、并行两 select 先于两 start、Deny 先于 abort、事件 ring 次序 → C1–C4、S1、S2 |
| Public API / CLI / script entry | yes | fake-omp 出站协议（审批场景新增 toolResult 与空 aborted 回合）与测试缺省 argv → C1–C5 |
| Documentation / migration notes | yes | 两份主 spec 次序句，以及父 change A、change B 同名块的同步 → spec delta、4.3 |
| Schema / columns / units / field names | no | 无 schema 或事件形状变化 |
| Config / project setup | no | 无配置键 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Auth / permissions / secrets | no | 不涉鉴权 |
| Error handling / rollback / partial outputs | no | 服务端结算路径不变，S2/S3 守护既有行为 |
| Resource limits / large input / discovery | no | 不涉池与资源 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |

## 通用纪律

- [ ] 源码边界：`server/src/**` 零 diff；只改 `server/test/**`（含 `support/fake-omp.mjs`）。服务端测试在新次序下暴露生产 bug 时，停下上报，不修。
- [ ] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
