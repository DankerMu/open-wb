# Proposal: omp-sudo-umask（#760）

## Why
ADR-0010 的权限模型写「双方 umask `007`」，但 sudo 模式下 omp 的 umask 实际由部署机 PAM（`pam_umask` + `login.defs` + 是否私有主组）决定：Ubuntu 24.04 默认得到 `0002`（omp 写的 `.jsonl` 为 `0664`、目录 `2775`），主组非私有组时为 `0022`（组写位丢失，app uid 无法在 omp 建的目录里 unlink，破坏会话删除）。sudoers(5)：显式 `umask` 覆盖 PAM。

## What Changes
- `.github/scripts/ci-uid-isolation.sh`：生成的 sudoers 加 `Defaults>omp umask=0007`；真实 omp 冒烟后 stat 会话 `.jsonl` 与目录。
- `scripts/test-ci-harness.sh`：sudoers 合同与对应变异。
- `server/test/linux/uid-isolation.test.ts`：mode 断言（探针文件、分支 `.jsonl`、omp 建的目录）。
- `docs/adr/0010-dedicated-omp-uid.md`：补充一节——omp 侧 umask 由 sudoers `Defaults><OMP_USER> umask=0007` 强制、不依赖 PAM；部署 sudoers 行同步（编排方改）。
- 规格：omp-uid-isolation MODIFIED「Linux 隔离证明」「CI uid-isolation job」。

## Non-goals
- 不加 `umask_override`（保留「不低于调用方」的并集语义）。
- 不把 shell 包装放进 sudoers allowlist（备选 1 否决）。
- `<OMP_STATE_DIR>/agent` 组可写（#706）、same-uid 模式不在本刀。
