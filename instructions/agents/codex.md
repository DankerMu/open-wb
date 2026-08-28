
## Codex Notes

- 仓库级指令集中在根 `AGENTS.md`；子树需细化时新增 scoped `AGENTS.md`，勿膨胀根文件。
- Codex runtime 尚未在本项目投影（无 `.agents/` / `.codex/`）；如需启用，用 `my-agents install ... --platform codex` 安装后重跑本 skill 更新简表。

## 已装能力简表

<!-- Codex 无自动 skill listing，这份简表是它的发现面；以 .claude/skills/ 与 .omp/skills/ 的实际内容为准 -->
- 交付链路：`stage-change-pipeline`、`subagent-workflow`、`risk-adaptive-cross-review`、`implementation-planning`、`handoff`、`gh-create-issue`
- 仓库健康：`improve-codebase-architecture`、`repo-entropy-audit`、`control-plane-auditor`、`future-aware-architecture`
- 问题诊断与质询：`diagnosing-bugs`、`grill-me`、`blind-spot-pass`、`clarify`
- 工程基建：`eng-init`、`architecture-design`、`git-worktree-workflows`、`project-documentation`、`project-instruction-bootstrap`
