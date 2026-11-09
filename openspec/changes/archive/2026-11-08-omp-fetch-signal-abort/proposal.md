# Proposal: omp-fetch-signal-abort

> Issue type: bugfix（#1935，PR #1934 审查的后续）
> Fixture level: expanded（`make omp-fetch` 是 CI smoke / ui-walk / uid-isolation 与参考镜像构建的共同前置，沿用 `ci-omp-fetch-resilience` 的档位）
> Upstream suggested level: 无（issue 只给了 p2 / S）
> Blast radius: 写错会让取消不生效（现状），或让正常失败不再回退、CI 在主地址 504 时重新全红。
> Selected risk packs: Error handling / rollback / partial outputs；Legacy compatibility（回退、跳过、校验的既有行为不变；CI 文件零改动）
> Evidence floor: `scripts/test-omp-fetch.sh` 新增的信号用例先红后绿（经 `make test-guardrails`），既有八条原样全绿；真实 INT、TERM 送达脚本进程组的用例不再进入回退，退出码分别为 130、143。

## Why

`scripts/omp-fetch.sh` 把 EXIT、INT、HUP、TERM 共用一个只删临时文件、不退出的 `cleanup` trap。主下载期间按 Ctrl-C 或 CI 取消作业时，curl 以 130 或 143 退出，`if ! curl …` 把它当成「主下载失败」，trap 执行完就返回，脚本接着走 API 回退，再下约 190 MB，最后可能以 0 退出。完整性不受影响（回退同样校验 SHA256），但取消不生效、浪费 CI 时间，make 退出后还可能留下孤儿进程。

## What Changes

- `scripts/omp-fetch.sh`：
  - trap 拆开：EXIT 只负责删临时文件；INT、HUP、TERM 各自以 128+信号号退出（130、129、143），退出时由 EXIT trap 清理。
  - 回退只在主地址 curl 的退出码小于 128 时发生；退出码大于等于 128（curl 被信号杀掉）时，脚本以同一退出码退出，不回退。
- `scripts/test-omp-fetch.sh`：新增用例，覆盖假 curl 返回 130 和 143，以及真实 INT、TERM 送达脚本进程组这四种情况。
- 不改 `.github/`、Makefile、`deploy/`、CI 契约 harness。

design.md 见同目录。
