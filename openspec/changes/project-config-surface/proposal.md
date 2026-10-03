# 项目级 skills 与项目配置文件的产品面（#773）

## Why

#708 的 owner 决议把会话 cwd 下的项目级 skills、指令文件与 agent 定义认作功能，但产品面上它们不可见：
命令目录 `GET /api/commands` 与会话无关、只列平台 skills；`/skill:<项目 skill>` 被宿主记为纯文本而 omp 照常执行；
界面上没有任何地方说明一个工作空间里有哪些配置文件在影响回复。本变更是 #773 的设计结论与规格，实现按 `tasks.md` 的分组拆成子 issue。

## What Changes

- 命令目录按会话 cwd 给出项目 skill：`GET /api/commands` 接受可选的 `workspaceId`，条目新增 `source:"project"` 与 `overrides`。
- 宿主白名单用同一份集合分类：prompt 路由、regenerate、fork 对项目 skill 的分类与 omp 的分派一致。
- 新路由 `GET /api/project-config`：列出 omp 会读取的位置上存在的项目配置文件（只判断存在，不读内容）。
- web：候选面板按工作空间取目录并标注来源；会话顶栏新增只读的「项目配置」入口。
- 项目级 MCP 与 `.omp/tools`：长期不支持按工作空间开启（只记结论，无实现）。

## Impact

- 规格：chat-sessions「Slash 命令白名单与命令目录」「REST prompt 受理与补偿」「会话 REST」（修改）、「项目配置文件列表」（新增）；chat-web「API 客户端扩展」「会话页」（修改）；session-sidebar 的「顶栏重命名入口」场景所在需求（修改一句）。
- 代码：`server/src/sessions/slash-commands.ts`、`rest-commands.ts`、`rest.ts`、`branching.ts`、`index.ts`，新增 `rest-project-config.ts`；
  `web/src/lib/api-commands.ts`、`web/src/features/chat/slash-menu.tsx`、`page.tsx`。
- 不改：vendored omp（ADR-0001）、宿主 overlay（ADR-0012）、`OMP_STATE_DIR` 布局（ADR-0010）、sudoers。
- 兼容：`GET /api/commands` 不带查询串的调用仍然有效，条目多一个键 `overrides`；web 严格解析，前后端同版本发布。
