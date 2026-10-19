# Spec Delta

## MODIFIED Requirements

### Requirement: 宿主 overlay
omp 把会话 cwd 下的项目层设置（`.omp/config.yml`、`.claude/settings.json` 等）与全局层深合并，而 cwd 是 agent 在 `write` 与 `yolo` 档下无需审批即可写的目录；argv 的 `--approval-mode` 只决定档位一个键。宿主 SHALL 用 omp 的 `--config` overlay 层（优先级：全局 < 项目 < overlay < CLI runtime override）钉住会绕过审批或在审批之外执行命令的设置键。overlay 文件 SHALL 位于托管 agent 目录、名为 `host-overlay.yml`，路径只有一个来源（与「OMP_STATE_DIR 托管布局」的路径函数同模块导出 `ompHostOverlayPath(stateDir)`）；它 SHALL 在服务启动时、托管布局建立之后与托管 `models.yml` 一起写入，使用与 `models.yml` 相同的替换方式（独占创建的临时文件、mode 精确 `0640`、rename；宿主内只有一份该实现），内容 SHALL 逐字节等于下面的固定块，其后紧接本要求后文规定的浏览器块与（条件出现的）看图块：

```yaml
tools:
  approval: []
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
ruby:
  interpreter: ""
julia:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
images:
  urls:
    enabled: false
    command: null
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: false
```

固定块之后 SHALL 紧接浏览器块，`<enabled>` 在部署配置了 `BROWSER_BIN` 时为 `true`、否则为 `false`（browser-runtime「浏览器可执行文件配置」）：

```yaml
browser:
  enabled: <enabled>
  cdpUrl: ""
  relay: false
  cmux: false
  headless: true
  screenshotDir: screenshots
```

模型白名单（model-selection「模型白名单配置」）中至少一项 `vision` 为真时，浏览器块之后 SHALL 再紧接看图块，恰为两行 `modelRoles:` 与 `  vision: <"workbuddy/<id>" 的 JSON 字符串字面量>`，`<id>` 为白名单次序中第一个 `vision` 为真的模型；没有这样的模型时 SHALL 不写 `modelRoles` 键。文件因此是部署配置（`BROWSER_BIN` 设置与否、白名单）的纯函数：启动期确定、此后不变，同一部署配置下重启字节不变。浏览器块各键（omp v18.0.10 `config/settings-schema.ts`，读源码得出，omp 接受该取值由下文真实 omp 场景实测）：`enabled: false` 使 omp 不挂载浏览器工具（`tools/index.ts:670`），未配置浏览器的部署里助手没有浏览器，omp 也不会去下载 Chrome-for-Testing（下载缓存经 XDG 重定向落在 `<OMP_STATE_DIR>/xdg/cache/omp/puppeteer`，下载前 omp 在其日志 `<OMP_STATE_DIR>/xdg/state/omp/logs/` 写一条 `Downloading Chromium for puppeteer`）；`cdpUrl: ""` 使项目层写的外部浏览器地址失效（omp 只在取值非空时连接）；`relay: false` 与 `cmux: false` 关闭经设置启用的浏览器中继与 cmux；`headless: true` 防项目层要求有头窗口；`screenshotDir: screenshots` 使 `tab.screenshot()` 把全分辨率截图写到 omp 进程工作目录（恒为会话 `<CWD>`，「子进程 spawn 契约」）下的 `screenshots/`（omp 只展开 `~`，相对路径相对进程工作目录解析；落点由 browser-runtime「CI browser-image job」在真实 omp 下钉住；若实测不落在 `<CWD>` 下，按 owner Q5 的退路改钉状态目录下的绝对路径 `<OMP_STATE_DIR>/screenshots`，截图不进文件变更卡）。看图块使 omp 的看图角色（当前模型不能看图时，`inspect_image` 与图片附件描述回退所用的模型）为能看图的白名单模型；当前模型自身能否收到截图等图片块只看它的 `input` 是否含 `image`（不含时 omp 把图片块换成文字占位）；`modelRoles` 是对象，深合并只压住 `vision` 一键，项目层写的其它角色照常生效（ADR-0012 登记的残余）。浏览器工具参数 `app.path`、`app.cdp_url`、`app.relay` 是参数不是设置，overlay 钉不住：tool-approval「审批请求识别」与 chat-stream「纯协议事件归约」使其在确认卡与步骤上显著可见，browser-runtime「浏览器调用审计」逐次记录（ADR-0012 登记的残余）。

各键的作用（真实 omp v18.0.10 实测）：`tools.approval: []` 以数组整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与三个 `interpreter: ""` 使项目层不能指定被宿主执行的可执行文件；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）；`images.urls.enabled: false` 关掉图片发布 broker——项目层把它打开后，会话创建时的 prewarm 会按项目给的参数拉起 `ssh`/`cloudflared` 等外部进程（`blob-broker/service.ts:623`、`exposure.ts:488-503`），`images.urls.command` 则被直接执行（`uploaders.ts:100`）；这一组的效果是读源码得出的，omp 接受该取值已实测。`retry:` 段把 omp 的会话级自动重试封顶为一轮（owner 2026-10-13，#909）：v18.0.10 的传输层（6 次）与 provider 层（整轮重放 1 次）重试是硬编码，一轮 502 约 32 秒 / 12 次上游请求（实测），缺省 10 次会话级重试时一次 5xx 回合约 402.7 秒才失败（实测）；`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 缺省值，写出来是为了让项目层改不动重试的时长；`modelFallback: false` 关闭 omp 的模型兜底（缺省 `true`）——否则项目层一条 `retry.fallbackChains` 就能在重试预算用尽时换模型并重置预算，对不可重试的错误（含模型代理的 424）也会换模型重放（读源码得出，#909 design D12）；这与「多上游切换不在范围内」（owner 2026-10-06）一致，即本 overlay 关闭了 omp 的模型兜底。`tools.approvalMode: write` 的优先级低于 argv：omp v18.0.10 在启动段把 `--approval-mode` 的取值经 `settings.override("tools.approvalMode", …)` 写入高于 overlay 的运行期覆盖层，所以会话的有效档位为 `always-ask` 或 `yolo` 时生效的是 argv 的值，overlay 的这一行只在 argv 缺席时才起作用（argv 恒在，见「子进程 spawn 契约」），作为 `write` 的兜底保留。overlay 的内容 SHALL NOT 随会话、档位或模型变化：全部会话、全部档位共用同一份文件，字节只由上述部署配置决定。其余各键在三个档位下的作用相同——`always-ask` 下项目层的逐工具放行与 bash 放行规则同样被清掉；`yolo` 下工具本来就不因档位请求审批，项目层无从再放宽，而项目层自己写的收紧规则照旧被清掉（ADR-0012 已登记的残余）。「argv 压过 overlay」这一点由 session-permission-tier「档位与 omp 审批模式」的真实 omp 场景钉住。overlay 不做 schema 校验，上述取值依赖 v18.0.10 的消费代码：升级 omp 时 SHALL 重新验证。

overlay 缺失、不可读或不是 YAML mapping 时 omp 以非零退出且不发任何帧——宿主按既有的握手失败处理（`agent_unavailable`），SHALL NOT 回退为不带 `--config` 的 spawn。写入失败 SHALL 走与 `models.yml` 写入失败相同的 partial-start failure 路径。

本要求 SHALL NOT 做的（owner 决定，登记于 ADR-0012）：不拦项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义（它们是功能）；不拦项目层 `.omp/tools`、`.claude/tools`、`.codex/tools` 与项目插件在 spawn 时的执行（受信局域网 + uid 隔离下的已接受残余）；不在 spawn 前扫描或拒绝工作目录。

#### Scenario: overlay 写入
- **WHEN** 编译入口冷启动
- **THEN** `<OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 是 mode `0640` 的普通文件，内容逐字节等于固定块、浏览器块（`<enabled>` 按该次启动是否配置 `BROWSER_BIN`）与看图块（按白名单）依次相接；同一部署配置下重启后字节不变；agent 目录无残留临时文件

#### Scenario: 项目层放行不再绕过审批（真实 omp）
- **WHEN** 有效档位为 `write` 的会话 cwd 下预置 `.omp/config.yml`，含 `tools.approval: {bash: allow}` 与 `bash.patterns: [{match: "*", approval: allow}]`，随后一个回合里模型调用 bash
- **THEN** 宿主收到该 bash 调用的审批请求（`chat_approvals` 有行），与无项目配置时一致
- **WHEN** 去掉 argv 里的 `--config`（负向对照）
- **THEN** bash 不经审批直接执行

#### Scenario: 项目层 MCP 不在 spawn 时执行（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/mcp.json`，声明一个会写标记文件的 stdio server，然后 spawn 并完成一个回合
- **THEN** 标记文件不存在
- **WHEN** 去掉 `--config`（负向对照）
- **THEN** 标记文件出现

#### Scenario: 默认行为不变
- **WHEN** 有效档位为 `write` 的会话 cwd 下没有任何项目配置
- **THEN** bash 仍请求审批、文件读写不请求，`make smoke` 的全部既有断言通过

#### Scenario: overlay 不随档位变化
- **WHEN** 编译入口冷启动后，先后有 `always-ask`、`write`、`yolo` 三个档位的会话各 spawn 一次
- **THEN** `host-overlay.yml` 的字节在三次 spawn 前后都等于固定块、浏览器块与看图块依次相接的同一内容（固定块仍含 `approvalMode: write`），托管 agent 目录里没有按档位另写的 overlay 文件；三次 spawn 的 `--config` 与 `PI_CONFIG_FILES` 都指向这同一个路径

#### Scenario: 会话级重试封顶一轮（真实 omp）
- **WHEN** 官方 omp v18.0.10 经模型代理连接一个对每次请求都答 503 的假上游，会话发一个 prompt
- **THEN** omp 恰发一个 `auto_retry_start`（`attempt` 1、`maxAttempts` 1），随后 `auto_retry_end{success:false}` 与终止 `agent_end`；上游恰收到两轮请求（v18.0.10 下为 24 次），回合以 `failed` 结束；实测时长写进实现 PR
- **WHEN** 托管 `models.yml` 在同一 provider 下列出两个白名单模型 A、B，会话以 A 运行，会话 cwd 下预置 `.omp/config.yml`，含 `retry: {maxRetries: 10, baseDelayMs: 3600000, modelFallback: true, fallbackChains: {default: ["<provider>/B"]}}`
- **THEN** 结果与上一例相同（overlay 压过项目层）：恰一个 `auto_retry_start`，上游收到的每个请求体的 `model` 都是 A、没有一个是 B

#### Scenario: 浏览器块随 BROWSER_BIN
- **WHEN** 编译入口分别在未设置 `BROWSER_BIN`、以及 `BROWSER_BIN` 为一个可执行普通文件的绝对路径时冷启动（`MODEL_CATALOG` 未设置、`MODEL_VISION=off`）
- **THEN** 前者 `host-overlay.yml` 的浏览器块为 `enabled: false`，后者为 `enabled: true`；两份文件只有这一行不同，都恰以浏览器块的 `  screenshotDir: screenshots` 行结尾、不含 `modelRoles`

#### Scenario: 看图块随白名单
- **WHEN** 编译入口以 `MODEL_CATALOG` 未设置且 `MODEL_VISION` 未设置冷启动；另一次 `MODEL_VISION=off`；另一次 `MODEL_CATALOG` 为 `[{"id":"m1"},{"id":"m2","vision":true},{"id":"m3","vision":true}]`
- **THEN** 第一次文件在浏览器块之后恰为 `modelRoles:` 与 `  vision: "workbuddy/deepseek-v4.1-flash"` 两行；第二次没有 `modelRoles` 键；第三次为 `  vision: "workbuddy/m2"`

#### Scenario: 未配置浏览器时浏览器调用失败且不下载（真实 omp）
- **WHEN** 官方 omp v18.0.10 经宿主 overlay（`enabled: false`）、未设置 `BROWSER_BIN`、档位 `yolo`，会话工作目录里预置项目层 `.omp/config.yml` 写 `browser: { enabled: true }`（overlay 须压过项目层），连接受控假上游；会话的 prompt 含 `WORKBUDDY_BROWSER_OPEN:about:blank`（omp-test-harness「受控上游浏览器标记」），回合结束
- **THEN** 该回合恰有一个工具步骤且它以 `failed` 结束（不论其登记名是 `write` 还是 `browser`），回合以 `done` 结束；会话工作目录里没有名为 `xd:` 的条目（写入没有落成普通文件）；`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在；`<OMP_STATE_DIR>/xdg/state/omp/logs/` 下的日志不含 `Downloading Chromium for puppeteer`

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL> --approval-mode <MODE> --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 启动（`--config` 的取值由「宿主 overlay」规定，恒为绝对路径），**仅当** `chat_sessions.omp_session_file` 非 null 时在其后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`<MODE>` SHALL 是调用方给出的该会话的有效审批档位，取 `always-ask`、`write`、`yolo` 三个字面量之一（session-permission-tier「档位与 omp 审批模式」）：`write` 使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批（本 change 之前唯一的取值）；`always-ask` 使写文件类工具同样请求审批；`yolo` 使工具不因档位请求审批。spawn SHALL NOT 自行决定、缺省或改写档位：调用方给出的值不是这三个字面量之一时 SHALL 不 spawn 任何子进程（视同目录准备失败），不得回退为某个档位。档位在一个进程的生命期内不变：omp 没有运行期切换审批模式的命令，宿主 SHALL NOT 向存活进程发送任何试图改变档位的帧，也 SHALL NOT 由 overlay 或其它配置文件按会话改写它；会话的档位改变后，由调用方在两个回合之间退役该进程并以新档位重新 spawn（chat-sessions「派发前按会话设置对齐进程」）。`<MODEL>` SHALL 是调用方给出的该会话的有效模型 id（模型白名单内的一项，model-selection「模型白名单配置」；未配置白名单时即 `MODEL_ID`）：它决定冷启动会话的初始模型；宿主 SHALL NOT 依赖它在 `--resume` 时的效果（每个 generation 的第一次派发之前另经 RPC 应用模型与推理强度，见「模型与推理强度命令」）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, PI_CODING_AGENT_DIR, PI_CONFIG_FILES, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, WORKBUDDY_MODEL_TOKEN, PUPPETEER_EXECUTABLE_PATH}`（`LANG`/`TMPDIR` 缺席时不设；`PUPPETEER_EXECUTABLE_PATH` 只在部署配置了 `BROWSER_BIN` 时设置、取值恰为 `BROWSER_BIN` 的值（browser-runtime「浏览器可执行文件配置」），SHALL NOT 取自 `process.env` 的同名键——omp 以它为浏览器可执行文件，不再自动发现或下载），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；`PI_CODING_AGENT_DIR` SHALL 显式设为 omp 的默认 agent 目录本身——即 `<HOME 的取值>/.omp/agent`，与 `ompAgentDir(stateDir)` 同一字符串（omp 以字符串相等判断 agent 目录是否为默认值，只在相等时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」）；`PI_CONFIG_FILES` SHALL 设为「宿主 overlay」的文件路径；`PI_CONFIG_DIR` SHALL 为 `.omp`，`OMP_PROFILE` 与 `PI_PROFILE` SHALL 为 `default`（omp 把它规范化为「无 profile」；空串不行——dotenv 会覆盖空值）。五者的取值与不设时 omp 的行为相同，显式设置的目的是「工作目录 dotenv 钉住」：omp 启动时加载 `<cwd>/.env` 等文件，但不覆盖已有的非空环境变量；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>`、`<MODE>` 与 `<MODEL>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话的工作目录、有效档位与有效模型）。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd；见 vendored omp v18.0.10 `coding-agent/src/main.ts:728-775,1697-1712`、`session-manager.ts:2846-2871`），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex
- **WHEN** `process.env` 含 `PUPPETEER_EXECUTABLE_PATH=/opt/other`，分别在部署未配置 `BROWSER_BIN` 与配置为 `/usr/bin/chromium` 时 spawn
- **THEN** 前者子进程 env 不含 `PUPPETEER_EXECUTABLE_PATH`；后者恰含 `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`；两者都不含 `BROWSER_BIN` 键，`/opt/other` 不出现在子进程 env 中

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null，有效档位 `write`，有效模型为缺省模型 `<MODEL_ID>`）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--cwd <SANDBOX_ROOT>/u1`，含 `--model workbuddy/<MODEL_ID>`、`--approval-mode write` 与紧随 `--no-title` 的 `--config <overlay 路径>`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；该会话任何 spawn 的 argv 里 `--approval-mode` 恰出现一次且其后是 `write`（不含 `yolo` 或 `always-ask`）；session-dir、「OMP_STATE_DIR 托管布局」的全部目录与作为 cwd 的所有者根在 spawn 时已存在（事先不存在的由宿主建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir and every directory of the managed layout SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates), and parent env SHALL remain unchanged

#### Scenario: 绑定空间的会话以空间根为 cwd
- **WHEN** owner `u1` 的会话绑定了 `dir` 为 `proj` 的工作空间（`workspace_id` 非 null），其首个 prompt 触发 spawn，随后 resume spawn，且同一 owner 另有一个未绑定会话 spawn
- **THEN** `<SANDBOX_ROOT>/u1/proj` 在首次 spawn 前已由工作空间创建建出，宿主只校验不创建；绑定会话两次 spawn 的 argv 都含 `--cwd <SANDBOX_ROOT>/u1/proj`，其余参数与未绑定会话逐字相同（`--session-dir <OMP_STATE_DIR>/sessions/u1` 不随空间变化）；真实 fake 子进程经 probe 回报的 `cwd=` 等于 `<SANDBOX_ROOT>/u1/proj`（`process.cwd()` 的真实路径）；未绑定会话的 `--cwd` 与 probe `cwd=` 仍为 `<SANDBOX_ROOT>/u1`

#### Scenario: 绑定空间根缺失时不创建不 spawn
- **WHEN** owner `u1` 绑定 `proj` 的会话在下一次 spawn 前，`<SANDBOX_ROOT>/u1/proj` 被应用之外的操作删除（或被同名文件占据）
- **THEN** 宿主的存在性检查失败，`spawnOmp` 不被调用、没有子进程、不签发可用 token；`<SANDBOX_ROOT>/u1/proj` 仍不存在（未被 `mkdir -p` 重建）；没有以 `<SANDBOX_ROOT>/u1` 或任何其它路径替代 spawn

#### Scenario: resume 以会话文件头的 cwd 为准
- **WHEN** 一个已持久化 `omp_session_file` 的会话被 resume spawn，而 spawn 传入的 `--cwd` 与该文件头记录的 cwd 不同（例如同一 owner 的另一目录）
- **THEN** 这是宿主依赖的 omp 行为而非宿主实现：真实 omp 在该目录可进入时以文件头 cwd 为会话工作目录，后传的 `--cwd` 不迁移已存在的会话；宿主侧可测的约定是对同一会话（及其 regenerate、fork 进程）的每次 spawn 均传入同一按规则取得的 `<CWD>`，host 测试断言同一绑定会话的首次与 resume argv 中 `--cwd` 逐字相等，fake omp 不模拟此 omp 行为，也不以 fake 结果冒充对它的证明

#### Scenario: 档位与模型按会话进入 argv
- **WHEN** 调用方分别以（档位 `always-ask`、模型 `m3`）、（档位 `yolo`、模型 `m1`）对两个会话 spawn，随后各 resume spawn 一次
- **THEN** 两个会话各自的首次与 resume argv 里，`--approval-mode` 之后分别恒为 `always-ask` 与 `yolo`，`--model` 之后分别恒为 `workbuddy/m3` 与 `workbuddy/m1`；除这两处、`--cwd`、`--session-dir` 与 `--resume` 外，四份 argv 与 `write` 档缺省模型会话的 argv 逐字相同；子进程环境白名单与 `PI_CONFIG_FILES`、`--config` 的取值不随档位或模型变化

#### Scenario: 非法档位不 spawn
- **WHEN** 调用方给出的档位为 `auto`、空串或缺失
- **THEN** `spawnOmp` 不启动任何子进程、不签发可用 token，调用以失败结束；没有以 `write` 或其它档位替代 spawn
