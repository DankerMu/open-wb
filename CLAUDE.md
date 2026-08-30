# open-workbuddy — Claude Code 注记

工程契约的权威是根 `AGENTS.md`（命令面/验证矩阵/边界/执行索引），领域术语在 `CONTEXT.md`——本文件不复述，只放 Claude 专属内容。

## 能力路由

- 已装能力以投影目录为准：`.claude/skills/`、`.claude/agents/`（Claude Code）、`.omp/skills/`（omp）。本文件不复述清单。
- 执行编排走 `subagent-workflow` + 原生子代理（implementer/reviewer/verifier），不要默认套 `codeagent`——后者仅限确需外部 CLI 执行的场景。
- 已装 `agentic-issue-delivery` 与 `codebase-stewardship` 两个 pack：前者管交付链路，后者管仓库健康；搭配见各 pack `README.md`。

## 项目本地适配（living 文件，按需创建）

- `openspec/project-profile.md` — workflow 适配；`subagent-workflow` 首次运行可自动 bootstrap。
- `openspec/glossary.md` — 术语细化时与根 `CONTEXT.md` 保持单一来源，勿双写。
- `docs/adr/NNNN-slug.md` — 长期架构决策账本。

## Claude Code Notes

- 知识域类 skill 自动触发率低，优先显式 `/skill-name` 调用。
- 已装 skill 的 description 由平台自动载入上下文，不在指令里复述清单。
