# Tasks: omp-sudo-umask（#760）

Fixture level: compact

实施顺序：本 issue 在 #758 合入之后实施——1.3 的目录断言取 #758 让 fake-omp 建的同名目录及其嵌套子目录（此前 omp uid 在这些用例里只写文件，没有它新建的目录）。

## 1. 实现
- [ ] 1.1 `ci-uid-isolation.sh`：sudoers 生成处加 `Defaults>omp umask=0007`；`visudo -c` 仍通过。
- [ ] 1.2 `scripts/test-ci-harness.sh`：sudoers 合同以 `grep -Fx` 校验该行，新增「去掉该行」的 `cm` 式合同变异被拒（现有 `uid_rule_mutant` 靠运行时 `sudo -l` 拒绝，对 Defaults 行无效，不能照搬）。harness 的 `sg` 桩在 smoke 阶段生成一个 `0660` 的会话 `.jsonl` 与一个 `2770` 的同名目录，使 1.4 的检查在桩环境里有对象；另加两个变异：桩产物 mode 不对 → 脚本失败；桩不产出文件 → 脚本失败。
- [ ] 1.3 `uid-isolation.test.ts`：spec delta 的 mode 断言——探针写出的文件；删除用例中 omp 写的分支 `.jsonl`、它的同名目录及其嵌套子目录与其中的文件（均由 omp uid 经 `sudo → setpriv` 创建，断言须在删除之前取 mode）。
- [ ] 1.4 `ci-uid-isolation.sh` 真实 omp 冒烟阶段之后（仅当该阶段的主结果与清理结果都为 0 时执行）：检查 `OMP_STATE_DIR/sessions` 下 omp 写出的会话 `.jsonl` 全为 `0660`、omp 新建的目录不带 other 位且组可写；**零个 `.jsonl` 即失败**（防空转）；mode 检查用可移植写法（`find -perm`，或 harness 已用的 `stat -c … || stat -f …` 双形态——harness 在 macOS 上以桩运行同一脚本）。检查用 `sudo find`（主 shell 的 runner 没有生效的 `workbuddy` 组，进不了 omp 拥有的 `2770` 目录；不要再加一次 `sg` 调用——harness 断言 `sg` 恰被调用两次）。真 omp 在冒烟里未必新建目录：目录检查可能没有对象，这是允许的，防空转只由 `.jsonl` 承担（它的 `0660` 已能区分 umask `0002`/`0022`/`0007`）。不符则 job 失败；失败输出只打印 mode 与相对路径。
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
