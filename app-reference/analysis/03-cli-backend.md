# 03 WorkBuddy 内置 agent CLI（CodeBuddy Code）后端分析

> 分析对象：`app-reference/WorkBuddyAI.app/Contents/Resources/app.asar.unpacked/cli/`（以 unpacked 为准）
> 产品：`@tencent-ai/codebuddy-code` v2.132.0-dev（CodeBuddy Code，腾讯的 Claude Code 级终端 agent；被 WorkBuddy AI 桌面 app 内嵌）。
> 性质：只读分析（前端 UI、后端逻辑、数据流），非漏洞挖掘。minified bundle 以字节偏移+可读片段取证；product.json 有真实行号。标注 `[INFERENCE]` 的为推断。

---

## 0. 目录结构快照

```
cli/
├── bin/
│   ├── codebuddy           # Node 启动器：路由到 TUI bundle 或 headless bundle
│   └── cbc-prewarm         # prewarm 预热进程管理 CLI（纯 Node，不加载主 bundle）
├── package.json            # @tencent-ai/codebuddy-code
├── product.json            # 1990 行产品配置（endpoint/auth/models/agents/commands/tools）
├── sandbox-config.json     # macOS app-sandbox / 应用组配置
├── dist/
│   ├── codebuddy.js        # 21.5MB 交互 TUI bundless（commander 主命令定义在此）
│   ├── codebuddy-headless.js # 17.6MB headless bundle（--print/--acp/daemon/--bg）
│   └── web-ui/             # 远程控制 Web 应用（SPA/PWA）+ 内置 CLI 文档站 + MCP sandbox proxy
└── vendor/
    ├── ripgrep/            # rg 二进制 + ripgrep.node（NAPI 加速 grep 工具）
    ├── toybox-macos/       # toybox coreutils 集合 + toybox.sb（Seatbelt 沙盒 profile）
    ├── zsh-macos/          # 捆绑 zsh 二进制
    ├── genie-trash/        # Rust 安全删除（移到 OS 废纸篓）
    ├── shim/               # Node/Python/Bash 沙盒运行时 shim（safe-delete/brokered-fs/toybox dispatch）
    ├── sandbox/5.4.3/      # @tencent-ai/sandbox-cli v5.4.3（sandbox-cli/sandbox-center/betterleaks + tsbx_rules.json）
    ├── assets/icon.png
    └── native-builds.json  # toybox/zsh 源码仓库构建记录
```

---

## 1. CLI 定位

### 1.1 package.json（`cli/package.json`）
- `name`: `@tencent-ai/codebuddy-code`；`version`: `2.132.0-dev.9772d7b.202608221848`
- `description`（L4）："Use CodeBuddy, Tencent's AI assistant, right from your terminal. CodeBuddy can understand your codebase, edit files, run terminal commands, and handle entire workflows for you." —— 明确是**终端里的 AI coding agent**。
- `main`: `lib/node/index.js`（L5，包入口为 Node library，`dist` 为 bundle 运行时）。
- `bin`（L8-13）：`codebuddy-code` / `codebuddy` / `cbc` 都指向 `./bin/codebuddy`；`cbc-prewarm` 指向 `./bin/cbc-prewarm`。
- `dependencies={}`，可选依赖（L15-26）：
  - `@lydell/node-pty@1.2.0-beta.14` + 各平台包（交互式 TUI 的 PTY 支撑）
  - `@tencent-ai/sandbox-cli@5.4.3` + 各平台包（Bash 沙盒后端）
- `optionalDependencies` 里没有罗列 dist 里实际打包的 `@modelcontextprotocol/sdk@1.29.0`、`@openai/agents@0.5.2`、`@openai/agents-core@0.5.2`、`@tencent/agentdr-sdk`、`@tencent/galileo-node-sdk` 等 —— 这些被打进了 bundle（在 `codebuddy.js:6..` 附近包依赖清单可查）。

### 1.2 product.json 定位与鉴权（`cli/product.json`，1990 行）
关键字段与行号：
- `endpoint`（L11）：`https://www.workbuddy.ai` —— **产品网关（平台 API）基址**。
- `stagingEndpoint`（L12）：`https://staging-codebuddy.tencent.com`
- `officialEndpoints`（L13-17）：`copilot.tencent.com`、`staging-copilot.tencent.com`、`www.codebuddy.ai`、`staging-codebuddy.tencent.com`
- `authentication`（L19-57）：
  - `id: workbuddy-desktop-ai`，`type: cli-external-link`，`label: TencentCloud`（外部浏览器 OAuth 式登录到腾讯云）。
  - `usernameHeader: X-User-Id`，`usernameEncode: URLEncode`（userId 放进用户头并 URL 编码）。
  - `tokenHeader: Authorization`，`tokenType: bearerToken`（登录后令牌以 `Authorization: Bearer <token>` 携带）。
  - `startChatAfterCompleted: true`、`prefixPath: /plugin`
  - 域分类：`internalDomain`（copilot.tencent.com / staging / www.codebuddy.cn）、`externalDomain`（www.codebuddy.ai / staging-codebuddy.tencent.com / www.workbuddy.ai / staging.workbuddy.ai）、`iOADomain`（tencent.sso.copilot.tencent.com 等）、`cloudHostedDomain`（`*.sso.copilot.tencent.com`、`*.copilot.qq.com`、`*.sso.codebuddy.cn` 等）。
  - `platform: workbuddy-ai`
- `updates`（L59-66）：`apiVersion v2`、`download.scene=saas`。
- `knowledgeBases`（L68-71）：`provider: Tencent`。
- `config`（L72-...）：`creditPurchaseActions`（升级专业版/获取 Credits 的 URL）、`threatDatabaseUrl`（`client-pkg-1258344699.cos.accelerate.myqcloud.com/workbuddy/saas/security/workbuddy_channel.db` — 安全威胁/域名拦截库）、`customUserDataDir: .workbuddy-ai`。
- `links`（L80-...）：文档、feedback、`sandboxHelpDocument=https://www.codebuddy.ai/docs/cli/bash-sandboxing`、`hooksHelpDocument`、`mcpHelpDocument`、`poiCityTreeUrl=https://static.workbuddy.cn/workbuddy/poi-city/city-tree.json`。
- `completion`（L107-...）：行内补全参数（`maxInputTokens 4000`、`jumpToHere.model=codewise-navi-v1-2-taco`），与 IDE 相关的补全逻辑。
- `deploymentType: SaaS`（L1694）、`isOversea: true`（L1955）、`smhHost: https://smh38ewydmp37j7v.ap-singapore.api.tencentsmh.com`（L1956，腾讯云存储）、`dataFolderName: .workbuddy-ai`（L1957）。

---

## 2. 命令体系

### 2.1 启动路由（`bin/codebuddy`）
- 顶部抑制 `DEP0040` 警告；记录真实进程启动时间 `global.__CODEBUDDY_PROCESS_START_TIME__`；校验 Node ≥18.20.8；启 V8 compile cache 加速（~37%）。
- `--version/-v` 快速路径：无位置参数时直接输出版本退出，不加载 bundle。
- **Headless 判定**（`bin/codebuddy:136-158`）：
  ```
  isHeadless = args.includes('--print') || '-p'
             || '--acp'
             || '--input-format' / '--input-format=*'
             || '--output-format' / '--output-format=*'
             || '--version' || '-v' || '--help' || '-h' || 'help'
             || args[0]==='daemon'
             || ['ps','logs','attach','kill'].includes(args[0])
             || '--bg' || '--background'
  ```
  - true → `require('../dist/codebuddy-headless')`（17.6MB，非交互/后台）
  - false → `require('../dist/codebuddy')`（21.5MB，交互 TUI）
  - 若 headless bundle 不存在则回退到全量 bundle。

### 2.2 顶层命令 / 选项（从 `dist/codebuddy.js` commander 定义提取，偏移 ≈7,475,397 起）
主命令 `codebuddy`（别名 `cbc`，`-v/--version`）。核心选项（可读片段取自 bundle）：

| 类别 | 选项 | 说明 |
|---|---|---|
| 调试 | `-d, --debug [filter]` / `-d2e, --debug-to-stderr` / `--verbose` | 调试/详细日志 |
| 非交互 | `-p, --print`、`--output-format <text\|json\|stream-json>`、`--input-format <text\|stream-json>`、`--json-schema <schema>`、`--include-partial-messages`、`--replay-user-messages` | headless 输出/输入格式化 |
| 权限 | `-y, --dangerously-skip-permissions`、`--permission-mode <mode>`、`--permission-mode-before-plan`、`--subagent-permission-mode` | acceptEdits/bypassPermissions/default/plan/dontAsk/auto |
| 工具 | `--tools`、`--allowedTools`、`--disallowedTools` | 限制/允许/拒绝内置工具 |
| MCP | `--mcp-config <fileOrString>`、`--strict-mcp-config` | 加载 MCP 配置 |
| 会话 | `-c, --continue`、`-r, --resume [sessionId]`、`--fork-session`、`--session-id <uuid>`、`--no-session-persistence` | 会话控制 |
| 工作区 | `-w, --worktree [name]`、`--worktree-branch`、`--tmux`、`--tmux-classic`、`--add-dir <dirs...>` | git worktree / 额外目录 |
| 模型 | `--model`、`--text-to-image-model`、`--image-to-image-model`、`--fallback-model`、`--effort <level>`、`--max-turns <n>` | 模型选择/推理强度 |
| 服务 | `--serve`、`--open`、`--port <n>`、`--host <s>`(默认 127.0.0.1) | 启动本地 HTTP/Web UI 网关 |
| ACP | `--acp`、`--acp-transport <stdio\|streamable-http>` | Agent Client Protocol 模式 |
| Sandbox | `--sandbox [url]`(container/E2B URL)、`--sandbox-upload-dir`、`--sandbox-new`、`--sandbox-id`、`--sandbox-kill`、`--teleport <value>` | Bash 沙盒/E2B |
| Prompt | `--system-prompt`、`--system-prompt-file`、`--append-system-prompt`、`--prompt-vars-file`、`--agent <agent>`、`--agents <json>`、`--settings`、`--setting-sources` | 系统提示/agent/设置 |
| 渠道 | `--channels`、`--dangerously-load-development-channels`、`--remote-control [client]`、`--plugin-dir <dirs...>` | 渠道/远程控制/插件 |
| 后台 | `--bg`、`--background`、`--name`、`--exec <command>`、`--swarm` | 后台/团队 |
| Prewarm | `--prewarm`、`--prewarm-id <id>`、`--prewarm-force` | 预热待命 |
| Teammate | `--teammate-mode`、`--team-name`、`--agent-name`、`--agent-type`、`--agent-color`、`--leader-endpoint <url>` | swarm/teammate |
| 其他 | `--ide`、`-H, --header <headers...>`、`--headers` | IDE 连接 / 自定义 HTTP 请求头 |

### 2.3 子命令表（`codebuddy <sub>`）

| 命令 | 子命令 | 说明 |
|---|---|---|
| `config` | `get` / `set`(`-g`)、`remove`(`rm`)、`list`(`ls`)、`add` | 配置管理 |
| `mcp` | `add <name> <cmdOrURL> [args]`(`-s scope`, `-t transport stdio/sse/http`, `-e env`, `-H header`)、`remove`、`list`(`ls`)、`get`、`add-json` | MCP server 管理 |
| `sandbox` | `list`(`ls`)、`info`、`kill`、`clean` | 沙盒管理 |
| `plugin` | `validate`、`list`(`--json`)、`marketplace`(add/list/update/remove)、`install`(`i`)、`uninstall`、`prune`、`enable`、`disable`、`update` | 插件/市场管理 |
| `doctor` | — | 自更新健康检查 |
| `update` | — | 检查/安装更新 |
| `install [target]` | — | 安装 native build |
| `daemon` | `start`/`stop`/`status`/`restart`/`install`/`uninstall` | 守护进程管理 |
| `ps` / `logs <pid\|name>` / `attach <pid\|name>` / `kill <pid\|name>` / `stop <pid\|name>` / `rm <id\|name>` / `respawn [id\|name]` | — | 后台会话/进程管理 |
| `agents` | `--jobs`/`--all`/`--cwd`/`--model`/`--permission-mode`/`--agent`；另有独立 `agents --json`（按来源列出 agent） | agent 视图/调度 |
| `auto-mode` | `defaults` / `config` / `critique` | 自动模式分类器配置 |

> 交互模式斜杠命令（bundle 内 `/...` 列表）：`/config`、`/model`、`/model:text-to-image`、`/model:image-to-image`、`/agents`、`/mcp`、`/permissions`、`/tasks`、`/plugin`、`/output-style`、`/memory`、`/add-dir`、`/resume`、`/theme`、`/rename`、`/status`、`/rewind`、`/export`、`/bash`、`/terminal-setup`、`/vim`、`/upgrade`、`/install-github-app`、`/migrate-installer` 等。产品级 slash 命令（product.json `commands`，L1438 起）：`init`、`compact`、`_compact`、`upgrade`、`statusline`、`security-review`、`commit`、`commit-push-pr`、`insights` 等。

### 2.4 headless 与交互模式差异

| 维度 | 交互模式（`codebuddy.js`） | Headless（`codebuddy-headless.js`） |
|---|---|---|
| 触发 | 无 `--print/--acp/--input-format/--output-format`，非 daemon/后台 | `-p/--print`、`--acp`、`--input-format`、`--output-format`、`-v/--help`、`daemon`/`ps`/`logs`/`attach`/`kill`、`--bg/--background` |
| 体积 | 21.5MB（TUI） | 17.6MB（无 TUI 依赖，更精简） |
| UI | 全功能终端 TUI（PTY、消息面板、状态栏、斜杠命令） | 无 UI，`print` 输出 / `stream-json` + ACP(ndJsonStream) |
| 典型用途 | 人在终端交互、`/mcp`、`/agents`、agent 视图 | CI/自动化 `-p`、SDK 集成 ACP、后台 `--bg`、daemon |
| 工具 | 全部内置工具 | 同（但权限 `-y` 在非交互必须显式给出） |

`docs/en/cli/headless.md` 明确：非交互 `-p` 必须带 `-y/--dangerously-skip-permissions` 才能做需授权的操作。

---

## 3. Agent 引擎

### 3.1 模型配置（product.json `models`，L133 起）
模型 ID（id / vendor / 关键参数）：

| id | name | vendor | maxIn | maxOut | 备注 |
|---|---|---|---|---|---|
| `default-model` | Default | e | 176k | 24k | 默认；`supportsReasoning`、`supportsToolCall`、`supportsImages`; `isDefault` |
| `default-model-lite` | Default-Lite | e | 176k | 24k | `tags:["lite"]`，`maxAllowedSize 80k` |
| `gpt-5.5` | GPT-5.5 | e | 1M | 72k | `onlyReasoning`，reasoning.high |
| `gpt-5.4` | GPT-5.4 | e | 272k | 128k | |
| `gpt-5.3-codex` | GPT-5.3-Codex | e | 272k | 128k | |
| `gpt-5.1-codex` | GPT-5.1-Codex | e | 272k | 128k | |
| `gpt-5.1-codex-mini` | GPT-5.1-Codex-Mini | e | 272k | 128k | |
| `gemini-3.1-pro` | | None | | | 原生 Google |
| `gemini-3.0-flash` / `gemini-2.5-flash` / `gemini-2.5-pro` | | None | | | |
| `gemini-3.5-flash` / `gemini-3.1-flash-lite` | | e | | | |
| `deepseek-v3-2-volc` | | e | | | |
| `glm-5.0` | | e | | | |
| `kimi-k2.5` | | f | | | |
| `gemini-3.0-pro-image` / `gemini-3.1-flash-image` / `gemini-2.5-flash-image` | | None | | | 图像模型 |
| `hunyuan-image-v3.0` / `hunyuan-image-v2.0-general-edit` / `hunyuan-video-art` | | None | | | 腾讯混元 generative |
| `fast-model` | | i | | | 快速模型 |
| `balanced-model` | | f | | | 平衡模型 |
| `primary-model` | | e | | | 主力模型 |
| `deep-model` | | e | | | 深度模型 |

`vendor` 值（`e`/`f`/`i`）是内部市场/网关的 vendor 枚举（`e` 为产品主 vendor，`f`/`i` 为其它内部 vendor；`None` 表示走各自官方 API）`[INFERENCE]`。`relatedModels.{lite,reasoning}` 把 lite/推理模型串起来。

### 3.2 模型请求端点 & 认证（关键取证）
- **认证属性**（product.json L24-27）：`usernameHeader: X-User-Id`、`tokenHeader: Authorization`、`tokenType: bearerToken`。
- **运行时 token 环境**（bundle）：`getAuthEnv()` 逻辑 —— `tokenType==="Bearer"` 时把 accessToken 写入 `CODEBUDDY_AUTH_TOKEN`（→ `Authorization: Bearer <token>`）；`tokenType==="ApiKey"` 时写入 `CODEBUDDY_API_KEY`（→ `X-API-Key: <key>`）。
- **常量**（bundle）：`API_KEY_HEADER = "X-API-Key"`；其它内部头：`X-Product`、`X-Product-Version`、`X-IDE-Type`、`X-IDE-Name`、`X-IDE-Version`、`X-Service-Id`、`X-User-Id`、`X-Userinfo`（=base64(JSON{"sub":uid})）、`X-Enterprise-Id`、`X-Department-Info`、`X-Tenant-Id`、`X-Domain`。
- **认证 HTTP 拦截器**：`authentication_http_interceptor` 在 `restOperations` 请求里若无 `X-API-Key` 且有 `CODEBUDDY_API_KEY`（env 或 settings`env`）则注入 `X-API-Key`；`fetch 拦截器`针对 product endpoint 的 401 触发 `logout()`。
- **模型客户端**（`codebuddy-headless.js` `buildOpenAIClientOptions`）：
  ```js
  createClient(baseURL, apiKey) { return new OpenAI({ baseURL, apiKey, fetch: axiosToFetchAdapter(), maxRetries:0, timeout: resolveRequestTimeoutMs() }) }
  buildOpenAIClientOptions(eA, el) { return { baseURL: eA, apiKey: el, fetch:..., maxRetries:0, timeout:... } }
  ```
  即平台用 **OpenAI 兼容 SDK**，`baseURL` = 产品 endpoint（或 `CODEBUDDY_BASE_URL` 覆盖），`apiKey` = bearer/API key。OpenAI SDK 默认在 baseURL 后拼 `/v1/chat/completions` 或 `/v1/responses` `[INFERENCE]`。
- **endpoint 解析**：`ProductEndpointHttpInterceptor`（`WORKBUDDY_DEV_ENDPOINT_OVERRIDE_ENV="WORKBUDDY_DEV_ENDPOINT_OVERRIDE"`）：对 `/v2/config`、`/v3/config`、`/config/models`、`/config/agents`、`git.woa.com` 直接用 `getEndpoint()`，其余用 `waitConfiguration()?.endpoint`。
- `docs/en/cli/env-vars.md` 佐证：`CODEBUDDY_API_KEY`（模型 API 调用，非交互必用）、`CODEBUDDY_AUTH_TOKEN`（平台 API 认证）、`CODEBUDDY_BASE_URL`（覆盖 API endpoint，如 `https://api.example.com/v1`）、`CODEBUDDY_GATEWAY_AUTH=password|none`、`CODEBUDDY_GATEWAY_PASSWORD`（网关口令）、`CODEBUDDY_GATEWAY_FORCE_TUNNEL=1`。

### 3.3 @openai/agents 用法
- bundle 依赖清单：`"@openai/agents":"0.5.2"`、`"@openai/agents-core":"0.5.2"`（node_modules 比对处）。
- `@openai/agents` 的 `Runner`/`RunState`/`OpenAIProvider`/`OpenAIResponsesModel`/`OpenAIChatCompletionsModel`/`RunResult`/`Handoff`/`GroupChat`/tool 框架都被内联进 bundle（e.g. `new Runner({modelProvider, callModelInputFilter,...})`、`OpenAIProvider=class{...}#Aj(){new OpenAI({apiKey,baseURL})}`、`defineTool`/`invokeFunctionTool`/`registerTool`）。
- 平台自建 `AgentService.runDefault()`、`AgentManager`、`AgentTask`、`SessionRunner`，调用 `Runner`/`RunnerFactory`；有 `toolCallLoopDetector`、`TRUNCATION_RETRY_MARKER`、`SystemReminderAgentRunInterceptor`、`UserInputAgentRunInterceptor`、`ImageFilterAgentRunInterceptor`、`EnvAgentRunInterceptor`、`ImageRehydrationAgentRunInterceptor` 等拦截器。

### 3.4 Agent 编排（对话循环 + 多 agent）
- **主 agent**：`cli`（product.json `agents[].name=="cli"`，L1095 起）。模型：`fast-model/balanced-model/primary-model/deep-model`；tags `["cli","default","model:craft"]`；内置 49 个工具。
- 其它内置 agent：`general-purpose`、`compact`、`contextSummary`、`contentAnalyzer`、`terminalTitleGenerator`、`promptSuggestion`、`memorySelector`、`summaryGenerator`、`autoModeClassifier`、`promptHookEvaluator`、`insightsAnalyzer`、`agentInstructions`、`statusline-setup`、`Explore`、`Plan`、`enhance-prompt`（多个是 `lite` 模型的小型后台 agent）。
- `builtInAgentsName`（L1681）：`["craft","ask","plan","debug","code-explorer"]`。
- `builtInSubagents`（L1674）内置子 agent YAML（如 `code-explorer`：`tools: search_file, search_content, read_file, list_files, read_lints, codebase_search; agentMode: agentic; enabledAutoRun: true`）。
- **多 agent 机制**：`Agent` 工具（子 agent 派生）、`TaskCreate/TaskGet/TaskUpdate/TaskList/TaskStop/TaskOutput`（后台任务）、`TeamCreate/TeamDelete/SendMessage`（swarm 团队）、`DelegateTool`（委派工具）、`Handoff`（@openai/agents 交接）、`--swarm`（teammate 独立进程）、`--teammate-mode/--team-name/--agent-name/--leader-endpoint`。
- **对话循环**：用户输入 → Runner 对话循环（模型调用 + 工具调用回环，`toolCallLoopDetector` 防死循环）→ 工具结果回填 → 模型继续 → 产出响应；`maxTurns`（`CODEBUDDY_CODE_MAX_TURNS`/`--max-turns`）限轮数；`requestMaxStepLimit=100`（product.json L590）限制单请求最大步数；`tokenUsageThresholds`（`compact.emergency 0.4`、`request.emergency 0.9` 等，L570）触发压缩/摘要。

### 3.5 工具注册机制（内置工具清单）
product.json `tools`（L1714 起）注册了 **54 个工具名**（含重复/别名），`cli` agent 启用 49 个。工具注入通过 @openai/agents 的 `registerTool/createMcp...` 与平台的 `ToolRegistry`。完整工具清单：

> `Agent`、`Bash`、`PowerShell`、`Glob`、`Grep`、`Read`、`Edit`、`Write`、`NotebookEdit`、`WebFetch`、`ListMcpResources`、`ReadMcpResource`、`WaitForMcpServers`、`TaskCreate`、`TaskGet`、`TaskUpdate`、`TaskList`、`WebSearch`、`EnterPlanMode`、`ExitPlanMode`、`KillShell`、`TaskStop`、`TaskOutput`、`SlashCommand`、`Skill`、`SkillManage`、`AskUserQuestion`、`LSP`、`StructuredOutput`、`ToolSearch`、`DeferExecuteTool`、`ImageGen`、`ImageEdit`、`VideoGen`、`Artifact`、`ArtifactControl`、`ComputerUse`、`TeamCreate`、`TeamDelete`、`SendMessage`、`EnterWorktree`、`LeaveWorktree`、`CronCreate`、`CronDelete`、`CronList`、`DelegateTool`、`WeChatReply`、`WeComReply`、`PushNotification`、`ReportFindings`、`Workflow`、`Monitor`、`REPL`

`cli` agent 工具集（product.json `agents[].tools`）即为上述去掉了 `KillShell/SlashCommand/Artifact/ArtifactControl/REPL` 的 49 个，另含 `Skill/SkillManage`、`ToolSearch`、`StructuredOutput` 等。工具描述通过 `tool-*-description`（prompt 模板）注入系统提示。

---

## 4. MCP

- **SDK**：`@modelcontextprotocol/sdk@1.29.0`（bundle 依赖清单；`failedToImport` 错误提示 "Failed to load the MCP SDK. Please install the @modelcontextprotocol/sdk package."）。
- **角色是 client**（连接外部 MCP server），三种 transport 均已实现：`StdioClientTransport`、`SSEClientTransport`、`StreamableHTTPClientTransport`（bundle 导出）。平台类：`McpConnectionManager`、`McpServerManager`、`McpSubagentToolManager`、`McpCommandExecutor`、`McpReadyService`、`computeMcpConfigFingerprint`。
- **MCP server 来源**：`.mcp.json`（项目，列入危险目录清单），`~/.codebuddy/mcp.json`（用户），以及 `mcp add`/`mcp add-json` 按 `scope=local/project/user` 写入；`--mcp-config <file>` 加载；`--strict-mcp-config` 只用 `--mcp-config`。
- **注册方式**：`codebuddy mcp add <name> <commandOrUrl> [args...] [-s scope] [-t stdio|sse|http] [-e KEY=value] [-H Header:value]`。
- **供 LLM 使用**：`McpTools`/`getAllMcpTools()` 拉取每个 server 的 `listTools()` 转成 agent 工具；`listResources()`/`listPrompts()` 读取资源/提示。ACP 侧 `AcpUtils.convertAcpMcpServersToDynamic()` 把 MCP servers 转成动态工具传给 agent 初始化。
- 工具规格：MCP server 名 → `mcp__<server>_<tool>`。

---

## 5. Sandbox

### 5.1 `cli/sandbox-config.json`
macOS app-sandbox/应用组配置（bundleId、appGroupId `group.com.workbuddy.workbuddy-ai`、fileProvider/networkExtension/helper bundleId、`logSubsystem`、`signingMode:full`）—— 这是 macOS 层的 app group / 网络扩展标识，用于 CLI 与桌面 app 共享数据域，非 bash 沙盒规则。

### 5.2 Bash 沙盒后端
- **`@tencent-ai/sandbox-cli`**（`optionalDependencies` 5.4.3，packaged）。`vendor/sandbox/5.4.3/`：
  - `sandbox-cli`（Mach-O arm64 Rust 二进制；`/Users/chaodong/.../clap`、`sandbox/src/network/proxy.rs`、`sandbox/src/executor/native_executor.rs` 路径表明为 Rust `@tencent-ai/sandbox-cli`，含 `sandbox-cli-gc` 垃圾回收子进程）。
  - `sandbox-center`（3.4MB，沙盒中心服务）。
  - `betterleaks`（21MB，安全加固/泄露检测组件）`[INFERENCE]`。
  - `tsbx_rules.json`（Windows 规则模板：`default_action: deny_write`、`recyclebin_backup`、`file_rules`（`.ssh/.gnupg` no_access，各类缓存 inherit_user）、`white_process`（浏览器白名单）、`network_policy: {enabled:true, default:"allow", deny_ips:[], deny_domains:[]}`，注释说明"双引擎：tsbx 仅 DNS hook 域名拦截，TCP 决策由 Rust LocalProxy 承担"）。
- **运行时 shim**（`vendor/shim/`）：`node-language-shim.cjs`（`NODE_OPTIONS --require` 入口，组合 safe-delete + brokered-fs hooks）、`node-safe-delete-shim.cjs`、`node-brokered-fs-shim.cjs`（把 fs 操作代理到沙盒 broker）、`sitecustomize.py`（Python）、`shell-runtime-bash-env.sh`/`brokered-sandbox-bash-env.sh`/`safe-delete-bash-env.sh`（Bash `BASH_ENV`）、`codebuddy-toybox-dispatch`（toybox 分发）、`broker-ipc-client.cjs`/`broker-program-policy-check.cjs`、`safe-delete-broker-delete.cjs`、`safe-delete-bulk-guard.cjs`、`safe-bin/{rm,rmdir,unlink}`（包 `safe-delete-common.sh`）。
- **隔离机制**：Bash/PowerShell 命令在 sandbox-cli 隔离层执行（UI 里 `sandbox` 开关："Run shell commands inside the sandbox-cli isolation layer"）；macOS/Linux 委托给 sandbox-cli 后端（`BashSandboxManager` 在非 linux 平台 `delegating to sandbox-cli backend, skipping AnthropicSandboxManager.initialize`）；Linux 则检查 `bwrap`(bubblewrap)。macOS 用 **Seatbelt profile**（`toybox.sb`：`(deny default)` + 白名单，文件读写通过 `com.workbuddy.sandbox.read/.read-write` 扩展授权）。`safeDeleteRuntimeEnabled`、`configAllowsAllWritePath`、`excludedCommands`、`allowUnsandboxedCommands`、`enableWeakerNestedSandbox` 等配置项控制安全删除/命令排除。
- CLI 选项：`--sandbox [url]`（`container`=Docker/Podman，或 E2B API URL）、`--sandbox-upload-dir`、`--sandbox-new`、`--sandbox-id`、`--sandbox-kill`、`--teleport <session_{cliSessionId}>`。`/sandbox` 命令与 `sandbox` 子命令（list/info/kill/clean）。

---

## 6. Web UI（`dist/web-ui`）

`cli/dist/web-ui` 是 `--serve` 提供的**本地 Web/远程控制应用**，而非仅文档。内容：
- **SPA/PWA**：`index.html`（`<title>CodeBuddy Code Remote Control</title>`，React SPA，`assets/index-*.js`/`index-B0dxQZal.css`）、`manifest.webmanifest`（PWA standalone）、`sw.js` + `workbox-*.js`（Service Worker）、`logo.svg`/`pwa-icon.svg`、主题 `dark`。
- **`sandbox_proxy.html`**：MCP Apps 沙盒代理页（`@mcp-ui/client AppRenderer` 协议 2026-01-26 的 host 自供异源沙盒页），负责把 MCP server HTML 装入 srcdoc iframe 并在 host↔iframe 间转发 `sandbox-*` postMessage。
- **`docs/`**：内置 CLI 文档站（`en/cli/*.md`、`cn/cli/*.md`，含 `cli-reference.md`、`headless.md`、`http-api.md`、`env-vars.md`、`mcp.md`、`interactive-mode.md` 等），配 `sidebar-*.json`、`search-index-*.json`。
- 通过 `--serve --port N`（默认 127.0.0.1，`--open` 自动打开浏览器）暴露，API Doc：`/api/docs`（Swagger UI）、`/api/openapi.json`；根路径还提供静态资源 `/logo.svg`、`/manifest.webmanifest`、`/sandbox_proxy.html`。

---

## 7. 网络端点（全部 URL/路径 + 数据流）

### 7.1 云端（产品网关，base = endpoint `https://www.workbuddy.ai` / staging `https://staging-codebuddy.tencent.com`）

**产品配置**
- `GET {endpoint}/v2/config`、`GET {endpoint}/v3/config`（product config，`ProductEndpointHttpInterceptor` 直接命中）
- `GET {endpoint}/config/models`、`GET {endpoint}/config/agents`（models/agents 云端配置）
- `GET {endpoint}/console/enterprises/{enterpriseId}/config/models`（`ModelsProductProvider`，企业模型列表；`tq="/console/enterprises/{enterpriseId}/config/models"`）
- `GET {endpoint}/v2/enterprises/{enterpriseId}/member-custom-model-policy/user-check`
- `GET {endpoint}/v2/enterprises/{enterpriseId}/skill-upload-policy/user-check`

**认证/账户**
- `POST {endpoint}/v2/auth/token/refresh`
- `{endpoint}/v2/accounts`（账户信息）

**Agent / 内部**
- `POST {endpoint}/internal/agent`（ACP agent 初始化 `initializeSession`，body 含 `mcpConfig`/`interactive`/`acp:true` 等）
- `POST {endpoint}/v2/service-proxy{path}`（Hook 服务代理，头 `X-Service-Id`、`X-User-Id`）
- `POST {endpoint}/internal/hooks/services/invoke`、`{endpoint}/internal/config`

**计费/遥测/模板/沙盒**
- `POST {endpoint}/v2/billing/meter/get-dosage-notify`（用量提醒）
- `POST {endpoint}/v2/report`（遥测）
- `POST {endpoint}/v2/sandboxes`（沙盒生命周期）
- `{endpoint}/v2/templates{ID}/builds{buildID}`（模板/构建）
- `POST https://api.e2b.dev/...`（`--sandbox` E2B sandbox；另有 `/v1/traces`、`api.openai.com/v1/traces/ingest` 等 OpenTelemetry/trace 上报）

**LLM（OpenAI 兼容）**：模型调用走 `new OpenAI({baseURL, apiKey})`，path 为 `{baseURL}/v1/chat/completions` 或 `{baseURL}/v1/responses` `[INFERENCE]`；`baseURL`=endpoint 或 `CODEBUDDY_BASE_URL`。第三方直连（vendor=None 模型）的 baseURL 见 bundle 常量：`api.anthropic.com`、`api.deepseek.com`、`api.openai.com/v1`、`generativelanguage.googleapis.com/v1beta`、`api.groq.com/openai/v1`、`api.moonshot.ai/v1`、`api.moonshot.cn/v1`、`api.kimi.com/coding`、`api.minimaxi.com/anthropic`、`api.minimax.io/anthropic`、`openrouter.ai/api/v1`、`api.individual.githubcopilot.com` 等。

**静态/第三方**
- `https://download.codebuddy.cn/plugin-marketplace/`（插件市场）
- `https://cnb.cool/codebuddy/marketplace`（`builtInMarketplaces`）
- `https://raw.githubusercontent.com/anthropics/claude-plugins-official/.../plugin-installs.json`
- `https://client-pkg-1258344699.cos.accelerate.myqcloud.com/.../workbuddy_channel.db`（威胁库）
- `https://smh38ewydmp37j7v.ap-singapore.api.tencentsmh.com`（腾讯云存储 smhHost）
- `https://static.workbuddy.cn/workbuddy/poi-city/city-tree.json`、`https://www.codebuddy.ai/docs/...`、`https://cloud.tencent.com/document/.../117896` 等文档链接
- SSO：`tencent.sso.copilot.tencent.com`、`tencent.sso.copilot-staging.tencent.com`、`tencent.sso.codebuddy.cn/v2` 等

### 7.2 本地 `--serve` HTTP 网关（默认 `127.0.0.1:port`）
三层（`docs/en/cli/http-api.md`）：
1. **Public REST** `/api/v1/*`
2. **Public ACP** `/api/v1/acp`
3. **Internal RPC** `/internal/*`（无需兼容承诺）

`/api/v1/*` 端点集合（从 bundle OpenAPI 抽取，节选）：
`/health`、`/info`、`/auth/status`、`/auth/login`、`/auth/account/{login,logout,status}`、`/acp`、`/acp/connect`、`/sessions`、`/sessions/{id}`、`/sessions/{id}/history|replay|rename`、`/sessions/across-projects`、`/runs`、`/runs/{id}`、`/runs/{id}/cancel|stream`、`/workspace-dirs`、`/workspace-dirs/sync`、`/pty`、`/pty/{id}`、`/pty/{id}/input/send|resize|output`、`/process/{start,list,connect,update,stdin/close}`、`/process/input/{send,stream}`、`/process/signal/send`、`/fs/{list,mkdir,move,remove,search,stat,watch}`、`/fs/watcher/{create,events,remove}`、`/settings`、`/settings/{key}`、`/storage`、`/storage/{key}`、`/storage/ns/{namespace}`、`/envs`、`/instances`、`/instances/{id}`、`/plugins`、`/plugins/{enable,disable,update,uninstall,validate}`、`/plugins/marketplaces{/*}`、`/channels{/*}`、`/channels/wechat`、`/channels/wecom`、`/team/messages/{read,send,unread}`、`/scheduled-tasks{/*}`、`/tasks/templates{/*}`、`/webhooks/{platform}`、`/workers`、`/workers/{id}{/logs}`、`/daemon/{start,stop,status,restart}`、`/permission-bridge/request`、`/traces`、`/traces/{traceId}`、`/metrics`、`/stats`、`/stats/session`、`/keybindings{/*}`、`/files/{upload,download,compose}`。

**安全**：所有 API（除豁免路径 `GET /`、`/assets/*`、`/docs/*`、`/manifest.webmanifest`、`/api/v1/auth/status|login`、`*/webhooks/*`、`/api/openapi.json`、`/api/docs*`）须带自定义头 **`X-CodeBuddy-Request: 1`**（强制 CORS preflight，防跨域）。CORS allowlist（本地回环、隧道 URL、`gateway.corsOrigins`、`CODEBUDDY_CODE_CORS_ORIGINS`）。`CODEBUDDY_DISABLE_REQUEST_VALIDATION=1` 关闭校验。`CODEBUDDY_GATEWAY_AUTH=password` + `CODEBUDDY_GATEWAY_PASSWORD` 为网关口令；`CODEBUDDY_GATEWAY_FORCE_TUNNEL=1` 强制隧道。

### 7.3 数据流（用户输入 → agent → 模型 → 响应）

```
用户终端                          CLI 进程 (codebuddy / headless)
   │
   ▼
[bin/codebuddy 启动器]
   │ 判定 isHeadless ──► 无 ──► codebuddy.js（交互 TUI, node-pty 终端渲染）
   │                     └────► codebuddy-headless.js（-p/--acp/daemon/--bg）
   ▼
[commander 解析]（--model/--agent/--tools/--permission-mode/--mcp-config ...）
   │
   ▼
[AgentService.runDefault()]  ←→ @openai/agents Runner（对话循环）
   │  system prompt(指令模板) + user message + 历史(带压缩/摘要 compact)
   │  model = fast/balanced/primary/deep (取决于--model/--agent)
   │
   ├─ 造 OpenAI 客户端: new OpenAI({ baseURL:<endpoint|CODEBUDDY_BASE_URL>,
   │                               apiKey:<CODEBUDDY_AUTH_TOKEN|CODEBUDDY_API_KEY> })
   │   HTTP 头: Authorization: Bearer <token>  (bearerToken)
   │             X-User-Id: <uid>  X-Product: ...  X-Product-Version: ...
   │             (fetch 拦截器对 product endpoint 处理 401→logout)
   │   ──► {endpoint}/v1/chat/completions 或 /v1/responses (OpenAI 兼容 gateway)
   │   ◄── stream SSE: 文本增量 + tool_call
   │
   ├─ tool_call 回环（toolCallLoopDetector 防死循环）:
   │    内置工具 Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch/
   │         Task*/Agent/Team*/MCP(mcp__server__tool)/Skill/Notify...
   │    ├─ Bash/PowerShell ─► sandbox-cli 隔离层（toybox/zsh + Seatbelt/bwrap）
   │    │                     + safe-delete / brokered-fs shim (vendor/shim)
   │    ├─ MCP ─► StdioClientTransport/SSEClientTransport/StreamableHTTPClientTransport
   │    │           → 外部 MCP server（.mcp.json / ~/.codebuddy/mcp.json / mcp add）
   │    └─ 工具结果回填 → 模型继续
   │
   └─ 产出响应（最终文本 / tool 执行结果）
        ├─ 交互: TUI 渲染 + 状态栏 + /slash 命令 (config/model/mcp/agents/...)
        └─ 非交互: output-format text|json|stream-json 写 stdout
             │  (--serve) 另开本地 HTTP 网关 127.0.0.1:port
             │     ├─ /api/v1/* REST    (REST API)
             │     ├─ /api/v1/acp       (JSON-RPC over SSE, 面向 Agent 客户端)
             │     └─ /                → web-ui(Remote Control SPA/PWA + docs)
             │                          └─ /sandbox_proxy.html (MCP Apps sandbox)
             └─ 遥测 POST {endpoint}/v2/report；trace /v1/traces；billing v2/.../dosage
```

---

## 8. 其他 vendor 角色

| 组件 | 角色 |
|---|---|
| **ripgrep/**（`rg` 6.5MB + `ripgrep.node` 6.2MB） | 搜索后端。`ripgrep.node` 为 NAPI 绑定（`napi-2.16.17`，导出 `ripgrep_main`），`rg` 为 cli 版。供 `Grep`/`Glob` 工具做高性能搜索（`ripgrep-src` Rust crate）。 |
| **toybox-macos/toybox**（712KB）+ `toybox.sb` | 沙盒内 coreutils 集合（`cat/ls/grep/find/...`，BusyBox 式），避免在沙盒里加载宿主全量工具链。`toybox.sb` 是 macOS Seatbelt profile（`(deny default)` + 白名单 + `com.workbuddy.sandbox.read/.read-write` 扩展授权）。`codebuddy-toybox-dispatch`（shim/brokered-bin）分发到 toybox。 |
| **zsh-macos/bin/zsh**（1.9MB） | 捆绑的 zsh 二进制，供沙盒 shell/`BASH_ENV` 环境使用。`native-builds.json` 记录其构建。 |
| **genie-trash/darwin-arm64**（907KB） | Rust CLI 帮助器（clap 0.1.0），把文件/目录移到 OS 废纸篓/回收站；macOS 直接调 CoreServices `FSMoveObjectToTrashSync`（~1ms，支持 Put Back）；被 `genie-safe-delete` shims（Node/Python/Bash）调用，统一下层实现。 |
| **shim/** | 沙盒安全运行时：`node-safe-delete-shim.cjs` + `sitecustomize.py`（Python 钩子）+ `safe-bin/{rm,rmdir,unlink}` 提供安全删除；`node-brokered-fs-shim.cjs` 把 Node fs 操作代理到沙盒 broker；`node-language-shim.cjs` 组合钩子；`shell-runtime-bash-env.sh`/`brokered-sandbox-bash-env.sh` 配置 Bash 环境与 toybox PATH。 |
| **sandbox/5.4.3/** | `@tencent-ai/sandbox-cli@5.4.3` 运行时（sandbox-cli、sandbox-center、betterleaks + `tsbx_rules.json`），见 §5。 |
| **native-builds.json** | 记录 `toybox-macos/toybox` 与 `zsh-macos/bin/zsh` 的源码仓库 `tsbx-macos`、commit `bb6dd7af...`、构建脚本（`./build-toybox-macos.sh`、`build-zsh-macos.sh`）、platform=macos、archs=`[x86_64, arm64]` — 原生二进制来源审计。 |
| **assets/icon.png** | 应用图标。 |

---

## 9. 结论先行（TL;DR）

- 这是一套 **CodeBuddy Code**（腾讯 Claude Code 级终端 agent，@tencent-ai/codebuddy-code v2.132.0-dev）作为 WorkBuddy AI 的**内置 agent 后端**；`cli` agent 是主 agent，基于 **@openai/agents 0.5.2 + OpenAI 兼容网关**驱动数十个内置工具。
- 平台网关 endpoint = **`https://www.workbuddy.ai`**（staging `staging-codebuddy.tencent.com`）；认证 = **`Authorization: Bearer <token>`（bearerToken）+ `X-User-Id` 用户头 + `X-API-Key`（ApiKey 模式）**；openai-compatible 模型请求 `{baseURL}/v1/{chat/completions|responses}`。
- 交互/headless 双 bundle：`codebuddy.js`（TUI，21.5MB）vs `codebuddy-headless.js`（17.6MB），由 `bin/codebuddy:136-158` 路由。
- 命令体系完备：主命令 + `config/mcp/sandbox/plugin/daemon/agents/auto-mode/doctor/update/install` 等子命令，外加交互 slash 命令。
- **MCP**：`@modelcontextprotocol/sdk 1.29.0`，client 角色，三 transport（stdio/SSE/streamable-http），配置来自 `.mcp.json`/`~/.codebuddy/mcp.json`/`mcp add`。
- **Sandbox**：`@tencent-ai/sandbox-cli@5.4.3`（Rust 二进制）+ `vendor/shim`（safe-delete/brokered-fs）+ macOS Seatbelt（`toybox.sb`）/Linux bwrap + 捆绑 toybox/zsh；另有 E2B/Docker container sandbox 选项。
- **Web UI** = `--serve` 远程控制 SPA/PWA + 内置翻页文档站 + MCP Apps sandbox proxy（`sandbox_proxy.html`）。
- 本地 HTTP 网关三层：`/api/v1/*`(REST)、`/api/v1/acp`(ACP)、`/internal/*`(内部RPC)，带 `X-CodeBuddy-Request: 1` 防跨域 + CORS allowlist + 可选 gateway password。

> 主要不确定点 `[INFERENCE]`：① OpenAI SDK 模型请求的 `/v1` 路径后缀（SDK 默认行为）；② vendor 枚举 `e/f/i/None` 的精确含义；③ `betterleaks` 组件的作用；④ 终端实际使用的 endpoint 是否由桌面 app 通过 `ACC_PRODUCT_CONFIG_V3`/`WORKBUDDY_DEV_ENDPOINT_OVERRIDE` 覆盖（桌面 app 侧确认）。
