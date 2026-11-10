# Proposal: ci-spec-guardrails-sync

> Issue type: documentation（#1954，在 #1932 实施期间发现）
> Fixture level: spec-only（只改规格文字，CI 文件、oracle、AGENTS.md 一字不改）

## Why

PR #1906（1ac1ff2e，2026-11-07）新增了 CI job `guardrails`，并把 `scripts/inspect-ci-workflow.js` 的期望计数从 11/9 改为 12/10，AGENTS.md Enforcement Index 新增了「守卫自证」一行、删去了 omp-fetch 一行，但没有改 `openspec/specs/`。于是规格仍写着十一个 direct job、checkout/setup-node 11/9、九个 setup-node、十一项聚合依赖，Enforcement Index 仍要求 omp-fetch 行，甚至规定 oracle 的期望计数「SHALL 为 11 / 9」。机器 oracle 是对的，CI 不会红；但照规格办事的 agent 或评审者可能会把 oracle「改回」11/9，或者把 guardrails 当成规格外的 job 从聚合里去掉。

## What Changes

- verification-harness「CI 接线与控制面同步」：
  - direct job 数从十一改为十二，job 清单补上 guardrails。
  - 「工作流共十二个 job」改为十三个。
  - checkout/setup-node 计数从 11/9 改为 12/10，英文场景同步。
  - Enforcement Index 描述去掉 omp-fetch 行，补上「守卫自证」行。
- verification-harness「第三方 CI action 使用 Node 24 runtime」：
  - 使用矩阵补上 guardrails（checkout 与 setup-node 各一次）。
  - 计数改为十个 setup-node、十二项聚合依赖、十二个 direct jobs，inspect 的期望计数改为 12 / 10。
  - 场景里的 job 清单同步。
- omp-uid-isolation「CI uid-isolation job」：场景里的「十一个 direct job」改为十二个，并注明 guardrails 的来历。
- 不改 `.github/`、`scripts/`、`AGENTS.md`、`constraints.yaml`。「十一个 verification.surfaces」数的是 surface，不是 job，不在范围内。
