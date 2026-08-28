<!--
Generated from instructions/agents/shared.md and instructions/agents/codex.md
by the project-instruction-bootstrap skill. Edit those sources, then re-run the skill.
Do not hand-edit this file.
-->

# open-workbuddy — Agent 指南

WorkBuddy AI 桌面应用（macOS arm64, v5.4.2）的参考副本、只读结构分析文档与功能演示原型；无构建系统、无可执行源码工程。

## 非显而易见的约定

- **`app-reference/` 全树只读**：它是上游应用的原始副本（`WorkBuddyAI.app/`、`app_asar/`），任何情况下都不要修改、重打包或"顺手修复"其中的文件。本仓库的自有产出只写在 `app-reference/analysis/`、`resource/`、根文档。
- **分析文档写作纪律**：路径基准写 `app-reference/app_asar/`；引用需给真实行号；推断结论必须标 `[INFERENCE]`，不得与代码/注释直接证据混写。
- **归属义务**：上游版权为 `Copyright © 2026 Tencent Technology (Shenzhen) Company Limited`，捆绑第三方库各自保留许可。新增派生内容须按 `ATTRIBUTION.md` 保留归属；仓库**尚无根级 LICENSE**，在补齐许可声明前不要对外发布或再分发。
- `resource/workbuddy-live-demo.html` 的设计 token 取自上游 WorkBuddy 5.3.11 的 token 文件——编辑该文件时保留文件头的来源注释。
<!-- TODO: 若后续引入构建/测试工具链或新增领域不变量，在此补充并重跑 project-instruction-bootstrap -->

## 文档路由

| 需求 | 去这里 |
|---|---|
| 项目是什么、目录布局 | `README.md` |
| 应用整体结论（进程模型/数据流/能力面/安全） | `app-reference/analysis/00-overview.md`（分析入口） |
| Electron 主进程、preload、IPC、存储、CLI 桥接 | `app-reference/analysis/01-main-process.md` |
| 渲染层 UI 技术栈、路由表、聊天渲染管线 | `app-reference/analysis/02-renderer-ui.md` |
| 渲染层深挖（组件/状态/交互细节） | `app-reference/analysis/05-renderer-ui-deep.md` |
| 内置 agent CLI（CodeBuddy Code）后端 | `app-reference/analysis/03-cli-backend.md` |
| 原生模块层 | `app-reference/analysis/04-native-modules.md` |
| 版权、许可、第三方归属 | `ATTRIBUTION.md` |
| 功能演示原型 | `resource/workbuddy-live-demo.html` |

## 能力路由

- 已装能力以投影目录为准：`.claude/skills/`、`.claude/agents/`（Claude Code）、`.omp/skills/`（omp）。本文件不复述清单。
- 执行编排走 `subagent-workflow` + 原生子代理（implementer/reviewer/verifier），不要默认套 `codeagent`——后者仅限确需外部 CLI 执行的场景。
- 已装 `agentic-issue-delivery` 与 `codebase-stewardship` 两个 pack：前者管交付链路（分阶段改动、交叉评审、issue 化），后者管仓库健康（架构改进、熵审计、控制面审计）；具体搭配见各 pack 的 `README.md`。

## 项目本地适配（living 文件，按需创建）

- `openspec/project-profile.md` — workflow 适配（入口/契约/风险轴）；`subagent-workflow` 首次运行可自动 bootstrap。
- `openspec/glossary.md` — 领域术语单一来源；由 `grill-me` docs mode / `improve-codebase-architecture` 维护。
- `docs/adr/NNNN-slug.md` — 长期架构决策账本（难回退 + 无背景会困惑 + 真实权衡，三者同时成立才写）。

## 反熵约定

根指令保持精简：只留重要规则与文档路由。能力的操作细节下沉到各自 `SKILL.md` / pack `README.md`，分析细节下沉到 `app-reference/analysis/`，不在本文件展开；子树需细化时就近新增 scoped 指令文件。

## Codex Notes

- 仓库级指令集中在根 `AGENTS.md`；子树需细化时新增 scoped `AGENTS.md`，勿膨胀根文件。
- Codex runtime 尚未在本项目投影（无 `.agents/` / `.codex/`）；如需启用，用 `my-agents install ... --platform codex` 安装后重跑本 skill 更新简表。

## 已装能力简表

<!-- Codex 无自动 skill listing，这份简表是它的发现面；以 .claude/skills/ 与 .omp/skills/ 的实际内容为准 -->
- 交付链路：`stage-change-pipeline`、`subagent-workflow`、`risk-adaptive-cross-review`、`implementation-planning`、`handoff`、`gh-create-issue`
- 仓库健康：`improve-codebase-architecture`、`repo-entropy-audit`、`control-plane-auditor`、`future-aware-architecture`
- 问题诊断与质询：`diagnosing-bugs`、`grill-me`、`blind-spot-pass`、`clarify`
- 工程基建：`eng-init`、`architecture-design`、`git-worktree-workflows`、`project-documentation`、`project-instruction-bootstrap`
