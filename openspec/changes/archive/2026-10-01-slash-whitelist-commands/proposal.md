# Proposal: slash-whitelist-commands（#551）

## Why
父 change `s1c-session-metadata-presentation` tasks 10.4a（epic #509，design D15「白名单常量」「分类与转义」「`GET /api/commands`」）。omp 对任何 `/` 开头文本按内建命令精确查表执行，宿主目前没有白名单概念：REST 把 trim 后的 `/…` 原样交给 omp，且自 10.3（#554）起命令输出成为助手正文。本刀落下白名单的唯一真相（两条内建 + 平台 skills）、分类/转义纯函数与命令目录路由，以及 `agentDir` 的单一来源接线；prompt 路由转义与 regenerate/fork 对位由 10.4b（#555）消费。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 新公共 REST 路由 `GET /api/commands`；`registerSessions`/`registerSessionRoutes` 装配签名（`agentDir` 必填）；`process.ts` spawn 的 `PI_CODING_AGENT_DIR` 取值改为经导出函数；后续三刀（10.4b/10.5/10.6）依赖的白名单与转义规则。
Selected risk packs: Public API / CLI / script entry（新路由：401/400/200 形状与顺序）；Auth / permissions / secrets（cookie 守卫、白名单是安全边界——误判会让非白名单命令原样到 omp 或把普通文本当命令）；File IO / path safety / overwrite（同步枚举 `<agentDir>/skills`、不可读/缺失文件、点目录）；Config / project setup（`agentDir` 与 spawn `PI_CODING_AGENT_DIR` 同源）；Legacy compatibility / examples（spawn env 不变、既有路由与装配测试）
Evidence floor: 新建 `server/test/slash-commands.test.ts` 与 `server/test/commands-rest.test.ts` 覆盖 design「Required evidence」；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- 新建 `server/src/sessions/slash-commands.ts`：`BUILTIN_COMMANDS`、`listSkills(agentDir)`、`classifyPrompt(text, skills)`、`toWireText(text, skills)`。
- 新建 `server/src/sessions/rest-commands.ts`：`GET /api/commands`。
- `server/src/sessions/omp/process.ts`：导出 `ompAgentDir(stateDir)`，spawn 内部 `join(stateDir, "agent")`（:70）改为调用它。
- `server/src/sessions/index.ts`：`RegisterSessionsOptions.agentDir`（必填），注册命令路由并透传给 `registerSessionRoutes`；`server/src/sessions/rest.ts`：依赖类型增 `agentDir`（本刀不消费）；`server/src/app.ts`：传 `ompAgentDir(runtime.stateDir)`。
- 两个新测试文件；既有夹具只补键。

## Capabilities
- ADDED `chat-sessions`「Slash 命令白名单与命令目录」：父 delta 该 Requirement 的前两段（白名单/`listSkills`/`classifyPrompt`/`toWireText`；`GET /api/commands`）与 Scenario「Whitelist classification and wire form」「Skills are read from the platform directory under omp's rules」「Command directory」。**不含** Branch alignment 段与 Scenario「Command-anchored regenerate and fork」（10.4b 以 MODIFIED 补入）。
- MODIFIED `chat-sessions`「会话 REST」：main 原文 + `registerSessionRoutes(app,{store,supervisor,agentDir})` + `GET /api/commands` 注册句；如实写明 prompt 路由**尚未**应用 `toWireText`（10.4b）。父 delta 的其它漂移（regenerate/fork 命令锚点 400、对位、`draft`、fork 预建行等）不并入。
- MODIFIED `chat-sessions`「Session module registration and teardown」：main 原文 + `agentDir` 子句。父 delta 中该 Requirement 的 `retire` 句落后于 main（#526 的 pump 排空），以 main 为准。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. 既有夹具补键：`registerSessionRoutes` 依赖类型增必填 `agentDir` 后，`server/test/session-rest-helpers.ts:60` 的直接调用须补一行 `agentDir`（2.2 `cwd` 必填化的同款先例）；其它直接构造 `RegisterSessionsOptions` 的夹具同理，只允许补键，在 PR 列出。
2. 父「Slash 命令白名单与命令目录」届时应为 MODIFIED（ADDED→MODIFIED 漂移）；10.4b 补 Branch alignment 段时同时删去「会话 REST」里的「尚未应用」过渡语。
3. `listSkills` 文字相对父 delta 的修正（fixture review 对照 vendored omp v18.0.10 得出；父「Slash 命令白名单与命令目录」须同步）：
   - 名字规则 `^[^\s/]+$` 是**宿主规则**，不是 omp 的丢弃规则（omp 只 trim，`discovery/helpers.ts:404-406`）；父文把它括进「omp itself drops」并说 `bad name`「for the same reasons omp would not load」不实。
   - 块标量 `description: >`/`|`（主 checkout 222 个 SKILL.md 中 88 个如此）按折叠/逐行读取，否则目录里的描述是字面量 `>`。
   - 符号链接目录被跟随（omp `helpers.ts:429-431`）；同名 skill 取 SKILL.md 路径码点序最小者；`skills` 的任何枚举错误 → `[]`（omp `helpers.ts:384-392`）；`name` 为空同缺失；CRLF 归一；未闭合 frontmatter 视为无。
   - 路由：未登录带 query/body 为 401（守卫先于 400）。
4. issue 行号基于旧 master：`process.ts:55` → `:70`；`index.ts:31-60` → `:18-80`；`app.ts:150-160` → `:159-167`。

## 已知范围外（只报不修）
- 白名单内的 `/todo import|export <path>` 经 omp `resolveToCwd` 接受绝对路径、`~` 与 `..`：一条不经模型的文件写入与内容读回通道（无步骤行、无 `files.changed`），且 `toWireText` 管不到它（`/todo` 在白名单内）；父 design D15 的「相对会话 cwd 读写」与事实不符。**不是**审批绕过（宿主以 `--approval-mode write` 启动，write 档本就自动放行）。已立 #704（依赖本刀），本刀不处理：`classifyPrompt` 按父 spec 把 `/todo …` 整体判为 `builtin`。
- 10.4b 合入前，白名单外命令仍可被原样调用且其输出可见（#554 归档说明）。

## Impact
- server：两个新 src 模块；`process.ts`、`index.ts`、`rest.ts`、`app.ts` 接线；两个新测试文件 + 夹具补键。web 无改动。
- 依赖：A #467 已合并。

## Non-goals
- prompt 路由转义与 regenerate/fork 对位（10.4b）；web 候选面板（10.5）；harness（10.6）；项目级 skill 发现；`command_output` 中文化。
