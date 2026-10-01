# Design: slash-whitelist-commands（#551）

父设计：D15「决定：白名单常量」「决定：分类与转义」「决定：`GET /api/commands`」。行号为 origin/master（01db194）。

- **Change surface**：新建 `server/src/sessions/slash-commands.ts`、`server/src/sessions/rest-commands.ts`；`server/src/sessions/omp/process.ts:70`（`const agent = join(opts.stateDir, "agent")`；770 行）；`server/src/sessions/index.ts:18-80`（选项与装配）；`server/src/sessions/rest.ts`（`SessionRestDependencies` 类型；406 行）；`server/src/app.ts:159-167`；新建 `server/test/slash-commands.test.ts`、`server/test/commands-rest.test.ts`；夹具补键 `server/test/session-rest-helpers.ts:60`。
- **omp 事实（vendored v18.0.10，主 checkout `resource/oh-my-pi/packages/coding-agent/src/`；实现前核对，不符则在 PR 记录）**：
  - 内建命令切分：`slash-commands/helpers/parse.ts:22-36`——只看未 trim 文本 `startsWith("/")`，名字截到首个空白或 `:`，精确大小写查表（`acp-builtins.ts:59-70`）。
  - skill 调用：`extensibility/skills.ts:454-470`——`trimStart()` 后以 `/skill:<name>` 开头，名字按 `indexOf(" ")` 切（`:456-459`，换行属于名字）。
  - 用户级 skill 发现：`<PI_CODING_AGENT_DIR>/skills/<dir>/SKILL.md`，`requireDescription: true`；缺 `description`、`enabled: false`、点开头目录被丢弃（`discovery/builtin.ts:295-300`、`discovery/helpers.ts:93-95,397-403`）。
- **Governing invariant**：白名单 = `BUILTIN_COMMANDS`（恰两条，固定顺序）∪ `listSkills(agentDir)`；宿主对 `/` 开头文本的唯一判定是 `classifyPrompt`，`toWireText` 对未命中者前置恰一个 U+0020（使 omp 的 `startsWith("/")` 门为假）；sessions 模块内 `agentDir` 只有一个来源 `ompAgentDir(stateDir)`，与 spawn 的 `PI_CODING_AGENT_DIR` 同值。
- **Must preserve**：
  - spawn 的 env、argv、目录创建行为逐字不变（`PI_CODING_AGENT_DIR` 仍为 `<stateDir>/agent`；`omp-process.test.ts` 零改动全绿）。
  - 既有十条会话路由、parser 归属集、统一错误信封、模块装配次序（`server-assembly.test.ts:452-479` 的 spy 记录的是模块级 `register*` 调用，`registerSessions` 内部多注册一条路由不改变它）不变；prompt 路由仍转发 trim 后原文（10.4b 才转义）。
  - `registerSessions` 返回值与 supervisor/store 构造不变；`app.test.ts`（790 行）只改期望值不增长。
  - 命令路由不触 SQLite、不触会话/进程、不是 content-parser owner。
- **Must add/change**：
  - `slash-commands.ts`：
    - `BUILTIN_COMMANDS: readonly {name, label, description, hint}[]`——`compact`（`整理上下文`／`压缩较长对话的上下文，保留要点`／`可选：想保留的重点`）、`todo`（`任务清单`／`查看或修改助手的任务清单`／`可选：append <任务>`），仅此两条。
    - `listSkills(agentDir): {name, description}[]`（逐条对齐 omp `discovery/helpers.ts:384-438` 与 `utils/src/frontmatter.ts:143-152`）：
      - `readdirSync(<agentDir>/skills)` 只取名字，任何枚举错误（ENOENT/ENOTDIR/EACCES…）→ `[]`；跳过 `.` 开头；**不按 dirent 类型分支**，直接读 `<entry>/SKILL.md`，任何读错误即跳过（符号链接目录因此被跟随，普通文件落在 ENOTDIR）。
      - frontmatter：先把 `\r\n?` 归一为 `\n`；内容以 `---` 开头，块止于其后第一条以 `---` 开头的行；无闭合 → 视为无 frontmatter（各键缺失）。块内只认行首无缩进的 `key: value`，键只取 `name`/`description`/`enabled`；值去首尾空白并去一对成对的 `'…'` 或 `"…"`；值恰为块标量指示符（`>`、`|`，可带 `+`/`-`）时取其后缩进更深的连续行，各行去首尾空白，`>` 以单个 U+0020 连接、`|` 以 `\n` 连接。不引 YAML 库。
      - `name` 缺失或为空 → 目录项名；`description` 缺失或空 → 跳过；未加引号的 `enabled` 值为 `false` → 跳过；`name` 不匹配 `^[^\s/]+$` → 跳过（**宿主规则**：omp 不校验名字，但 `/skill:` 按 U+0020 切，这类名字选不中）。
      - 同名去重：保留 `SKILL.md` 路径码点序最小者（omp first-wins，`extensibility/skills.ts:220-221`）；结果按 `name` 码点序排序（不用 locale）；每次调用重算。
    - `classifyPrompt(text, skills)`：按 spec 段落逐条；`text` 视为已 trim。返回 `{kind:"text"} | {kind:"builtin", name} | {kind:"skill", name}`。
    - `toWireText(text, skills)`：`builtin`/`skill` 原样；`text` 且以 `/` 开头 → `" " + text`；其余原样。
  - `rest-commands.ts`：`registerCommandRoutes(app, {agentDir})`——`GET /api/commands`，既有 cookie 守卫（未登录 401 + no-store）、响应 no-store；请求带 query string（`request.raw.url` 含 `?`）或请求体（`content-length` > 0 或 `transfer-encoding`）→ 400 `bad_request` 统一信封，**探测放在 handler 内**（晚于根 `preParsing` 守卫 `http/guard.ts:36`，未登录带 query/body 仍是 401；不得放进路由级 `onRequest`）；200 `{commands:[…]}`：内建两条（`name` 为内建名、`source:"builtin"`）在前，skills 在后（`name:"skill:<name>"`、`label:<name>`、`description` 原样、`hint:"可选参数"`、`source:"skill"`），每项恰五键。
  - `process.ts`：`export function ompAgentDir(stateDir: string): string { return join(stateDir, "agent"); }`，:70 改调。
  - `index.ts`：`RegisterSessionsOptions.agentDir: string`（必填，JSDoc 说明同源约束）；`registerCommandRoutes` 与 `registerSessionRoutes(app, {…, agentDir})`。`rest.ts`：`SessionRestDependencies.agentDir: string`（本刀不读）。`app.ts:159`：`agentDir: ompAgentDir(runtime.stateDir)`（`runtime` 即 :143-149 的装配值）。
  - 为什么不在 `index.ts` 内由 `options.runtime.stateDir` 派生：父 spec「Session module registration and teardown」明文规定 `agentDir` 是 `registerSessions` 的入参、由 createApp 传 `ompAgentDir(stateDir)`（`rest.ts` 没有 `runtime`，10.4b 的路由测试需把它指向临时目录）；同源由证据 8 钉住。
  - `rest.ts` 本刀只扩类型，**不得**解构或读取 `dependencies.agentDir`（否则 lint 未使用变量）；GET 请求体探测只看头（Fastify 不解析 GET body）。
- **Sibling surfaces**：10.4b prompt 路由与 `branching.ts` 对位（消费 `toWireText`/`classifyPrompt`）；10.5 web `listCommands()` 严格键集 `{name,label,description,hint,source}`；10.6 smoke；`http` 统一错误信封的 parser 归属集（本路由不加入）；`server/src/server.ts:291` 另有一处 `join(config.ompStateDir, "agent")`（写 models.yml，sessions 模块外，只报不修）；sudo/uid 分离下 `<stateDir>/agent/skills` 对 app uid 的可读性（uid-isolation job）。
- **残余**：行式解析不是完整 YAML（流式/多文档/锚点、omp 的 HTML 注释剥离与歧义标量修复不复刻）——分歧时该 skill 不进目录、`/skill:x` 判为 `text`，而 omp 侧仍可执行（与项目级 skill 同类，父 design 已留痕）；`listSkills` 同步读每个 SKILL.md 全文（平台安装的少量文件，可接受）；skill 名含 `:` 等字符按 omp 规则原样；`/todo import|export` 路径问题见 proposal「已知范围外」（#704）。
- **Required evidence**（RED：`slash-commands.test.ts` 因模块不存在整文件红；`commands-rest.test.ts` 中证据 4 的 401 今天已由 `/api/*` 兜底给出，只红在 `no-store`，其余路由例红在 404，证据 8 红在 `ompAgentDir` 导出缺失；既有测试为 characterization；以实际运行记录）：
  - `slash-commands.test.ts`：
    1. 分类/转义十三例（skills `[{name:"weekly-report"}]`）：`/todo`、`/todo append 买菜`、`/compact:focus 保留结论` → `builtin`（name 分别 `todo`/`todo`/`compact`）、`/skill:weekly-report 写周报` → `skill`，`toWireText` 原样；`/retry`、`/TODO`、`/session delete`、`/skill:weekly-reportx`、`/skill:`、`/skill:weekly-report\n写周报`、`/etc/hosts 是什么`、`/` → `text`，`toWireText` 恰多一个前导 U+0020（逐字 `" " + 原文`）；`今天 /skill:weekly-report 帮我` → `text`，原样。另：`/todo\t制表`、`/compact\n换行`（空白截名）→ `builtin`；`/todox`、`/compactor` → `text`。
    2. `BUILTIN_COMMANDS` 恰两条、顺序与四个字段逐字。
    3. `listSkills` 临时目录（spec Scenario 原样）：`weekly-report`、`noname`、`nodesc`、`off`、`bad name`、`.hidden`、`empty/`、`folded`（`description: >` + 两行缩进 → `第一行 第二行`）、`linked`（指向别处目录的符号链接）、`zz-copy`（同名后者被去重）→ 恰 `[folded, linked, noname, weekly-report]` 四条逐字；`skills` 不存在 → `[]`；`skills` 是普通文件 → `[]`；新增 skill 后再次调用可见（不缓存）。另各一例：单引号值去引号；`description:` 空值跳过；`name:` 空值取目录名；`enabled: "false"`（加引号，YAML 得到字符串，omp 照常加载）仍被列出；`|` 块标量以 `\n` 连接；CRLF 文件与 LF 同结果；无 frontmatter / 未闭合 frontmatter 的 SKILL.md 跳过；frontmatter 之后正文里的 `name:`/`description:` 行不被读取；缩进（嵌套）的 `description:` 不被当作顶层键；`skills` 下的普通文件被忽略；不可读 SKILL.md（`chmod 000`，`process.getuid?.() === 0` 时跳过该例）不抛。
  - `commands-rest.test.ts`（production `createApp`，`app.inject()`；skill 写进 `<stateDir>/agent/skills`）：
    4. 未登录 → 401 统一信封 + `Cache-Control: no-store`；未登录带 query、未登录带 JSON body 同样 401（守卫先于 400）。
    5. 两个可加载 skill → 200、no-store、恰四条、每条键集恰为 `name,label,description,hint,source`、顺序与取值逐字（内建两条 → skills 按名）。
    6. 带 query string → 400 `bad_request`；带 JSON body → 400 `bad_request`（信封字节同既有 400）。
    7. 无 `skills` 目录 → 恰两条内建。
    8. 同源：以记录型 `spawnImpl` 直接调用 `spawnOmp(opts, spawnImpl)`（`omp-process.test.ts` 的既有方式，不起真进程），断言记录到的 `env.PI_CODING_AGENT_DIR === ompAgentDir(opts.stateDir)`；且证据 5 的 skill 正是写进 `join(ompAgentDir(stateDir), "skills")` 后被 `createApp`（`assembly.runtime.stateDir = stateDir`）的路由读到。落在哪个新文件由实现者定；既有 `server-assembly.test.ts:240`、`omp-process.test.ts` 的 `join(stateDir,"agent")` 断言零改动仍绿。
    9. 路由不触库（与证据 5 同例，先断言 200）：请求前后 `audit_events`/`chat_sessions` 行数不变，`app.sessions.supervisor.liveProcessCount()`（`supervisor.ts:273`）为 0。
  - 既有：`omp-process.test.ts`、`server-assembly.test.ts`、`session-rest*.test.ts`、`app.test.ts` 全绿；`app.test.ts` 不增长；夹具只补 `agentDir` 键。
  - 门禁：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0。
