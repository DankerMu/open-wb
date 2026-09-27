# Tasks: fake-omp-probe-cwd（#520）

## 6. omp-test-harness — fake-omp（父 tasks 6.2 原文）

- [ ] 6.2 probe 尾部 `frames=` 之后追加 ` cwd=<process.cwd()>`（最后一个字段）；`server/test/fake-omp.test.ts` `expectedProbeReport` 精确串与 `server/test/linux/uid-isolation.test.ts` `REPORT_LABELS` 以 `"frames", "cwd"` 结尾同 PR 更新（改期望值）；`server/test/fake-omp-helpers.ts` `startFake` 增可选 `cwd`（支撑文件，非测试文件）。验证：新建 `server/test/fake-omp-probe-cwd.test.ts`——在含空格的临时目录下起 fake，probe 末字段 `cwd=` 为该目录且 `parseLabeledReport` 切分正确（omp-test-harness「probe 报告带 cwd 字段」）；本地 fake-omp 测试绿 + CI uid-isolation job 绿的证据

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Schema / columns / units / field names | yes | probe 串追加末字段、标签切分 → design 证据 1、2；`fake-omp.test.ts` 三个 probe 用例精确串 |
| Legacy compatibility / examples | yes | 前 8 字段、非 probe 帧、`startFake` 缺省不变、既有 `frames` 期望值不变 → 证据 3、4、5 + 其余既有 fake-omp 测试零改动全绿 |
| File IO / path safety / overwrite | yes | 含空格与 `=` 的路径、符号链接 tmpdir 需 realpath 比较 → 证据 1、2 |
| Auth / permissions / secrets | yes | 异 uid 下回报切分 → PR head CI `uid-isolation` job 绿；probe 不回显任意环境值（既有 canary 用例回归） |
| Public API / CLI / script entry | no | fake 的 argv 不变；`startFake` 为测试辅助，可选参数由 Legacy 包覆盖 |
| Config / project setup | no | 不涉 |
| Concurrency / shared state / ordering | no | `cwd` 在报告时刻同步读取，无新状态；`frames` 记录点不变 |
| Resource limits / large input / discovery | no | 不涉 |
| Error handling / rollback / partial outputs | no | probe IO 失败语义不变（既有 ENOENT 用例回归） |
| Release / packaging / dependency compatibility | no | 仅测试文件 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/fake-omp-probe-cwd.test.ts`；既有测试只允许 design「Sibling surfaces」列出的六处改动，不删、不放宽；每处列入 PR `偏离记录`。
- [ ] 每条新断言先在 fake 未改时跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-probe-cwd --strict --no-interactive` 通过；PR head CI `uid-isolation` 绿。
