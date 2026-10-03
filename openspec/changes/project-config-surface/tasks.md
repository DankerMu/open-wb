# Tasks

Fixture level: expanded。每个任务组对应一个实现 issue；本变更在四组全部完成后归档。

## 1. server：项目 skill 的目录与分类

- [ ] 1.1 `slash-commands.ts`：抽出按目录读取 skill 的公共部分，新增 `listProjectSkills(cwd, sandboxRoot)` 与 `sessionSkills(agentDir, cwd, sandboxRoot)`（上溯、`.git` 边界、沙箱根边界、近者优先、描述截断、同名覆盖）。
- [ ] 1.2 `rest-commands.ts`：`workspaceId` 查询串（400 / 404 规则）、`source:"project"`、`overrides`。
- [ ] 1.3 prompt 路由、regenerate、fork 改用会话自己的 `sessionSkills`；cwd 解析失败时项目集合为空。
- [ ] 1.4 用例：规格新增的三个场景与修改后的「Command directory」场景；越界链接、FIFO、超大文件、256 上限在项目目录下同样成立；`.omp` 或 `.omp/skills` 为链接、`SKILL.md` 为硬链接、目录超过 4096 条、工作空间根不可用。
- [ ] 1.5 真二进制用例（v18.0.10）：目录列出的每个 `skill:<name>` 都在该 cwd 的 `get_available_commands` 里，描述一致或为其前 200 码点；进程启动后新建的 skill 的行为（规格登记的不一致）；`.omp` 项目 skill 胜过平台与其它目录的同名 skill；被分类为 `skill` 的回合在分支列表里没有 `user` 条目。

## 2. web：候选面板

- [ ] 2.1 `api-commands.ts`：`listCommands(workspaceId)`、六键严格解析、`source` 增加 `project`。
- [ ] 2.2 `slash-menu.tsx`：目录按 client 与工作空间 id 持有；`项目` / `项目 · 覆盖平台技能` 标注；不显示其它工作空间的目录。
- [ ] 2.3 用例：「命令目录方法」「候选面板按工作空间取目录」与既有候选场景；ui-walk 覆盖一个带项目 skill 的工作空间。

## 3. server：项目配置文件列表

- [ ] 3.1 真二进制用例为位置表逐行定案（每个位置只放该文件，depth 0 与 depth 1 各一次，查 `get_state.systemPrompt` 中的标记；agents 查 task 工具的 agent 列表）；与规格不符的行先改规格。
- [ ] 3.2 `rest-project-config.ts`：路由、鉴权、`lstat`、排序、agents 的 64 条上限。
- [ ] 3.3 用例：「Files present at the read locations」场景；符号链接（文件与中间目录）、目录、不可读位置不列出；最近 `.omp` 与最近 `.omp/agents` 分别定位；`.omp` / `.omp/agents` 为链接或超过 4096 条时查找在该层结束。

## 4. web：项目配置入口

- [ ] 4.1 `api-commands.ts`：`listProjectConfig(workspaceId)` 与严格解析。
- [ ] 4.2 会话顶栏 `项目配置` 按钮与只读弹层；空、等待、失败时不渲染。
- [ ] 4.3 用例：「项目配置入口」场景与修改后的「顶栏入口」「顶栏重命名入口」（session-sidebar）场景；ui-walk 覆盖。

## 5. 收尾

- [ ] 5.1 ADR-0012 补充：项目 skill 的列出范围与「不列出但会执行」的残余；D5 的方向。
- [ ] 5.2 四组完成后归档本变更。
