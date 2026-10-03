# Tasks: omp-sudo-umask（#760）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `ci-uid-isolation.sh`：sudoers 生成处加 `Defaults>omp umask=0007`；`visudo -c` 仍通过。
- [ ] 1.2 `scripts/test-ci-harness.sh`：sudoers 合同校验该行；新增「去掉该行」变异被拒（与现有 rule mutants 同法）。
- [ ] 1.3 `uid-isolation.test.ts`：spec delta 的 mode 断言——探针写出的文件；删除用例中 omp 写的分支 `.jsonl` 及 omp 新建的目录（若假 omp 在该用例里不新建目录，对其写出的文件所在的 omp 建目录取一处可得的即可，如实说明选了哪个）。
- [ ] 1.4 `ci-uid-isolation.sh` 真实 omp 冒烟阶段之后：stat 真实 omp 写出的会话 `.jsonl`（期望 `660`）与其父级中由 omp 新建的目录（other 位为 0），不符则 job 失败；输出不含主机路径以外的敏感信息。
- [ ] 1.5 除 `.github/scripts/ci-uid-isolation.sh`、`scripts/test-ci-harness.sh`、`server/test/linux/uid-isolation.test.ts` 与本 change 目录外不改其它被跟踪文件（ADR 由编排方改）。

## Must preserve
- `make test-guardrails` 基线全绿且只增不减；现有 sudoers rule mutants 不失效。
- uid-isolation 既有断言（uid、白名单、EACCES、SIGKILL 回收、删除）不动。

## Required evidence
- E1 `make test-guardrails` 全绿（PASS 数，基线先量）。
- E2 Linux 实证（本机 docker 的 `ubuntu:24.04` 容器或同等一次性 Linux 环境；macOS 上测试本身是 skipped）：按 `ci-uid-isolation.sh` 的装配跑 `uid-isolation.test.ts`——带 Defaults 行全绿；去掉 Defaults 行时新的 mode 断言失败（记录实际 mode，预期 other 位 `r`/`x` 出现）。本机没有可用的 Linux 环境时停下报告，不要以 macOS skipped 充数；编排方可改用 CI 结果与测试 VPS 容器补证。
- E3 真实 omp（官方 v18.0.10 linux-x64，sha256 以 `b13e6b2a` 开头）在带 Defaults 行的 sudo 模式下写出的 `.jsonl` 为 `0660`、目录无 other 位（同一 Linux 环境；需要模型端点时用假上游）。
- E4 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate omp-sudo-umask --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉 Defaults 行 → harness 合同拒绝；Linux 下 1.3 断言失败。
- N2 改成 `umask=0022` → harness 合同拒绝；Linux 下组写位断言失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Permissions / isolation boundary | yes | omp 写出物的 mode → 1.3、1.4、E2、E3 |
| CI / build scripts | yes | sudoers 生成与 harness 合同 → 1.1、1.2、E1 |
| Deployment / docs contract | yes | ADR-0010 部署行同步 → proposal |
| 其它 | no | 无产品代码改动 |
