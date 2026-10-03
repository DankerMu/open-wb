# Design：项目级 skills 与项目配置文件的产品面（#773）

Fixture level: expanded。Risk packs: 跨 uid 可写目录的读取（工作空间由 omp uid 可写）、鉴权（按工作空间取数）、与 omp 版本耦合。

## 背景与实测事实

决议以官方 omp **v18.0.10** 的实际行为为准。下表全部由真二进制实跑得到（RPC `get_available_commands` 与 `get_state.systemPrompt` 中的标记串），
读码出处为 vendored `resource/oh-my-pi/packages/coding-agent/src/`。

**skills（`get_available_commands`）**

| 事实 | 出处 |
| --- | --- |
| cwd 下 `.omp`、`.claude`、`.codex`、`.agents`、`.agent`、`.opencode`、`.github` 的 `skills/` 都加载 | 实跑 |
| 祖先目录只加载 `.omp`、`.claude`、`.agents`、`.agent`；`.codex`、`.opencode`、`.github` 只看 cwd | 实跑 |
| 上溯在带 `.git` 条目的那一级停（含该级）；没有 `.git` 且 `HOME` 不是祖先时一路到文件系统根，越过沙箱根 | 实跑；`discovery/builtin.ts:284`、`capability/fs.ts:84-95` |
| 托管 `HOME` 下 `~/.claude`、`~/.codex`、`~/.agents`、`~/.agent` 的 `skills/` 加载 | 实跑（ADR-0012 已登记的残余） |
| 同名：`.omp` 项目 skill 胜过平台 skill，近的胜过远的；同级 `.omp` 胜过 `.claude`/`.codex`/`.agents`；平台 skill 胜过 `.claude` 项目 skill | 实跑 |

**指令文件与 agent 定义（`get_state.systemPrompt`）**

| 事实 | 出处 |
| --- | --- |
| 观察到进入系统提示：cwd 的 `AGENTS.md`、`.omp/AGENTS.md`、`.omp/RULES.md`、`.omp/SYSTEM.md`、`.claude/CLAUDE.md`；上一级的 `AGENTS.md`、`.agents/AGENTS.md` | 实跑 |
| 同一层只有一个说明文件生效：cwd 同时有 `AGENTS.md` 与 `.claude/CLAUDE.md` 时只有后者；有 `.omp/AGENTS.md` 时它胜出 | 实跑 |
| `.omp/AGENTS.md`、`.omp/RULES.md` 只取最近的非空 `.omp` 目录；cwd 有 `.omp` 时上一级的不生效 | 实跑；`discovery/builtin.ts:90-99` |
| `.omp/agents/*.md` 取最近的非空 `.omp` 目录，不受 `.git` 边界限制 | 实跑；`task/discovery.ts` |
| 上一级的 `.omp/SYSTEM.md` 未观察到生效 | 实跑 |
| 未观察到进入系统提示：`CLAUDE.md`（根目录）、`GEMINI.md`、`.cursorrules`、`.windsurfrules`、`.clinerules`、`.codex/AGENTS.md`、`.github/copilot-instructions.md`、`.opencode/AGENTS.md`、`.cursor/rules`、`.windsurf/rules`、`.claude/rules` | 实跑（多文件同置，存在同层去重的干扰，未逐个单测） |

未逐项单测的部分（上一级的 `.claude/CLAUDE.md`、`.omp/rules/*.md`、除两组之外的跨目录同名优先级）由实现任务的真二进制用例定案（见 D4、任务 3）。

## 决议

### D1 目录来源与粒度

- 会话 cwd 只由 `(ownerId, workspaceId)` 决定（`server/src/sessions/session-cwd.ts`），目录按它计算：有 `workspaceId` 为工作空间根，没有为 owner 根。
- **宿主自己扫描**，不询问 omp 进程：候选面板在新建对话、未发首条消息时就要用，此时没有进程。
- **只扫 `.omp/skills`**，从 cwd 上溯到带 `.git` 的那一级（含）或沙箱根（含）。理由：列出的名字执行的就是列出的 skill（实测 `.omp` 与平台 skill 不被其它目录的同名 skill 覆盖）；
  复刻 7 个目录、三种上溯规则与跨目录优先级会把宿主与 omp 版本强耦合。
- 接口：`GET /api/commands` 增加可选的 `workspaceId`，不带查询串的旧调用继续有效。不换路由、不拆两级。
- `workspaceId` 经 owner 作用域的 `rootOf` 鉴权，未知、他人、格式错误同为 404（与创建会话一致），否则该路由会泄露他人工作空间的 skill 名称与描述。
- 部署前提（宿主不检查）：沙箱根以上的目录不放 `.omp` 等配置目录。开发机把沙箱放在本仓库内时，omp 会加载仓库自己的 `.omp/skills`，宿主不列。

### D2 信任与可见性

- 条目带 `source:"project"`，候选面板标注「项目」；与平台 skill 同名时只出项目那一条并带 `overrides:true`，面板标注「项目 · 覆盖平台技能」。
- 读取复用 `listSkills` 的全部限制（每个 `skills` 目录内的内核 realpath 包含检查、原始字节路径、`O_NOFOLLOW|O_NONBLOCK|O_NOCTTY`、普通文件且不超过 262144 字节、256 条上限、名称规则）。
  包含边界是该 `skills` 目录本身（比「工作空间根」更严，且与平台目录同一份代码）。
- `description` 截到 200 个码点；前端按纯文本渲染（React 文本节点，现状即如此）。
- 可见性不另设规则：能通过 `rootOf` 的账号即可见。不追踪放置者（宿主没有文件级作者信息）。

### D3 白名单分类

- 项目 skill 归入 `classifyPrompt` 的 `skill` 类。三个调用点都改用会话自己的集合 `sessionSkills(agentDir, cwd, sandboxRoot)`：
  `server/src/sessions/rest.ts:202`（prompt 路由）、`server/src/sessions/branching.ts:389`（regenerate / fork 的 `isCommand`，经 `server/src/sessions/index.ts:68` 的 `skills` 端口）。
  端口从 `skills()` 改为按会话取（`ownerId`、`workspaceId`）；cwd 解析失败时项目集合为空，不抛错。
- **不保证**宿主记为文本的 `/skill:<name>` 不执行：omp 的 skill 分派先 `trimStart()`（`extensibility/skills.ts:454-456`），空格前缀挡不住。
  其它目录、托管 `HOME`、沙箱根以上、以及被宿主读取规则跳过的 skill 仍会执行而被记为文本；这类消息上的 regenerate / fork 与今天的「句中 skill」一样得到 502。登记为残余（ADR-0012 的项目层残余同类）。
- 同名优先级跟 omp：项目胜平台，近胜远。协作者可以用同名项目 skill 替换平台 skill；标注让用户看得见，但不拦。

### D4 项目配置文件的呈现

- 含义是「omp 会读取的位置上**存在**的项目配置文件」，不是「生效中的规则」：同层去重与优先级宿主不复刻，界面文案如实说明。
- 新路由 `GET /api/project-config[?workspaceId=]`，请求规则与鉴权同 D1；宿主只 `lstat`，不读内容、不跟符号链接。
- 位置表写在规格里（chat-sessions「项目配置文件列表」）。表中每一行都要有真二进制用例支撑（只放该文件，分别在 depth 0 与 depth 1，各看标记是否进入 `systemPrompt`）；
  omp 不读的位置从表中删除，只在 cwd 读的限制为 depth 0——在路由发布前改规格，而不是照列。
- web：会话顶栏 actions 区、`重命名` 之前的 `项目配置` 按钮，列表非空才出现；只读弹层按层级分组，无编辑入口。欢迎态不显示（没有顶栏按钮）。
- 用户级（`<state>/home/.omp/agent` 下）的文件不显示：平台托管、对 omp uid 只读（ADR-0010）。

### D5 项目级 MCP 与 `.omp/tools`

- **长期不支持**按工作空间开启。项目级 MCP 已由 overlay 的 `mcp.enableProjectConfig: false` 关闭（ADR-0012），此处无新工作。
- 理由：skill 与指令文件是提示词，仍受审批约束；MCP 与项目工具是以 omp uid 直接执行的代码。opt-in 需要权限模型、审批与审计，目前没有需求。
- 需要 MCP 时由管理员装到平台级配置。出现真实的按工作空间需求时另开 issue，以管理员开启加审计为起点。
- `.omp/tools` 等项目工具仍是 ADR-0012 登记的已接受残余，本变更不改变它。

## 与 #708 / #706 的一致性

- #708（ADR-0012）：overlay 不关任何 provider，所以其它目录的 skill 与指令文件照常被 omp 加载——本设计把它们列为「不列出但会执行 / 只列存在」而不是试图拦截。
- #706（ADR-0010）：平台 skills 在 `<state>/home/.omp/agent/skills`，对 omp uid 只读；项目 skills 在 omp uid 可写的沙箱内，所以读取限制必须与平台目录同等严格，且不得更宽。

## 残余

1. 其它 provider 目录、托管 `HOME`、沙箱根以上的 skill：能执行、不列出、宿主记为文本。
2. 宿主读取规则跳过的项目 skill（超 256 条、越界链接、超大文件、名称含空白或 `/`）：同上。
3. 项目配置列表只表示存在；实际生效的文件可能更少。
4. 宿主扫描规则与位置表绑定 omp v18.0.10：升级 omp 时真二进制用例必须重跑，失败即改规格。

## 备选（弃）

- **询问活着的 omp 进程（`get_available_commands`）**：最准确，但新建对话与空闲会话没有进程。它被用作测试里的对照，不作数据源。
- **复刻全部 7 个目录**：目录最全，但规则多、与版本强耦合，且跨目录优先级未测全。
- **复刻指令文件的生效规则**：同上，规则更绕（同层去重、最近 `.omp`、provider 优先级）。
- **保证未列出的 `/skill:` 不执行**：需要一种 omp 不 `trimStart` 掉的转义，依赖 omp 解析细节。

## 拆分

| 任务组 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | server：`listProjectSkills`、`sessionSkills`、`GET /api/commands?workspaceId`、三个调用点的分类、真二进制对照用例 | — |
| 2 | web：`listCommands(workspaceId)`、候选面板按工作空间取目录与来源标注 | 1 |
| 3 | server：位置表的真二进制定案、`GET /api/project-config` | — |
| 4 | web：`listProjectConfig`、顶栏「项目配置」入口 | 3 |

目录与分类必须同一刀交付（任务组 1），否则宿主目录与白名单会再次不一致。
