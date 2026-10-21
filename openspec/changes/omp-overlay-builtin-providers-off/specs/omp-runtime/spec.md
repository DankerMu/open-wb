## MODIFIED Requirements

### Requirement: 宿主 overlay
omp 把会话 cwd 下的项目层设置（`.omp/config.yml`、`.claude/settings.json` 等）与全局层深合并，而 cwd 是 agent 在 `write` 与 `yolo` 档下无需审批即可写的目录；argv 的 `--approval-mode` 只决定档位一个键。宿主 SHALL 用 omp 的 `--config` overlay 层（优先级：全局 < 项目 < overlay < CLI runtime override）钉住会绕过审批或在审批之外执行命令的设置键。overlay 文件 SHALL 位于托管 agent 目录、名为 `host-overlay.yml`，路径只有一个来源（与「OMP_STATE_DIR 托管布局」的路径函数同模块导出 `ompHostOverlayPath(stateDir)`）；它 SHALL 在服务启动时、托管布局建立之后与托管 `models.yml` 一起写入，使用与 `models.yml` 相同的替换方式（独占创建的临时文件、mode 精确 `0640`、rename；宿主内只有一份该实现），内容 SHALL 逐字节等于下面的固定块，其后紧接本要求后文规定的浏览器块与（条件出现的）看图块。翻转之前（钉住版本仍为 v18.0.10 期间；#1570 已翻转、四行已删）固定块在 `python:` 块之后曾另含四行 `ruby:\n  interpreter: ""\njulia:\n  interpreter: ""`（owner 2026-10-20 B：18.0.10 的 spawn 预检会不经审批执行项目层指定的 `ruby.interpreter` / `julia.interpreter`，实测，删键即开口子；翻转时随 `OMP_VERSION` 一起删，字节钉点与本要求同步）；翻转前固定块以 `ask:` 两行结尾，翻转时在其后加上 `advisor:` 与 `ida:` 各两行（`ida` 为 Epic #1563 (f) 缺省方案；`advisor` 为 fixture review r2 的裁定，见下）。

```yaml
tools:
  approval: null
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
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
telemetry:
  otlpExportEnabled: false
archive:
  enabled: false
disabledProviders:
  - ollama
  - llama.cpp
  - lm-studio
  - apple
  - abliteration
  - aiand
  - aimlapi
  - alibaba-coding-plan
  - alibaba-token-plan
  - amazon-bedrock
  - anthropic
  - azure
  - baseten
  - bedrock-mantle
  - cerebras
  - charm-hyper
  - cline-pass
  - cloudflare-ai-gateway
  - cloudflare-workers-ai
  - commandcode
  - coralbricks
  - coreweave
  - deepinfra
  - deepseek
  - devin
  - factory-droid
  - firepass
  - fireworks
  - github-copilot
  - gitlab-duo
  - gitlab-duo-agent
  - gmi-cloud
  - google
  - google-antigravity
  - google-gemini-cli
  - google-vertex
  - groq
  - helmcode
  - huggingface
  - kilo
  - kimi-code
  - litellm
  - meta
  - minimax
  - minimax-cn
  - minimax-code
  - minimax-code-cn
  - mistral
  - moonshot
  - muse-code
  - nanogpt
  - novita
  - nvidia
  - ollama-cloud
  - openai
  - openai-codex
  - opencode-go
  - opencode-zen
  - openrouter
  - qianfan
  - qwen-portal
  - sakana
  - sambanova
  - siliconflow
  - siliconflow-cn
  - singularityapi-dev
  - singularityapi-tech
  - snowflake
  - stepfun
  - synthetic
  - together
  - typesafe
  - umans
  - venice
  - vercel-ai-gateway
  - vllm
  - wafer-serverless
  - xai
  - xai-oauth
  - xiaomi
  - xiaomi-token-plan-ams
  - xiaomi-token-plan-cn
  - xiaomi-token-plan-sgp
  - yolo-auto
  - zai
  - zenmux
  - zhipu-coding-plan
ask:
  enabled: false
advisor:
  enabled: false
ida:
  enabled: false
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

模型白名单（model-selection「模型白名单配置」）中至少一项 `vision` 为真时，浏览器块之后 SHALL 再紧接看图块，恰为两行 `modelRoles:` 与 `  vision: <"workbuddy/<id>" 的 JSON 字符串字面量>`，`<id>` 为白名单次序中第一个 `vision` 为真的模型；没有这样的模型时 SHALL 不写 `modelRoles` 键。文件因此是部署配置（`BROWSER_BIN` 设置与否、白名单）的纯函数：启动期确定、此后不变，同一部署配置下重启字节不变。浏览器块各键（omp v18.12.3 `tools/browser/settings.ts`，读源码得出，omp 接受该取值由下文真实 omp 场景实测）：`enabled: false` 使 omp 不提供浏览器 eval prelude（`tools/browser/prelude-definition.ts:22` 实时判断；已捕获的旧函数 fail-closed），未配置浏览器的部署里助手的 JS 里没有 `browser`，omp 也不会去下载 Chrome-for-Testing（下载缓存经 XDG 重定向落在 `<OMP_STATE_DIR>/xdg/cache/omp/puppeteer`，下载前 omp 在其日志 `<OMP_STATE_DIR>/xdg/state/omp/logs/` 写一条 `Downloading Chromium for puppeteer`）；`cdpUrl: ""` 使项目层写的外部浏览器地址失效（omp 只在取值非空时连接）；`relay: false` 与 `cmux: false` 关闭经设置启用的浏览器中继与 cmux；`headless: true` 防项目层要求有头窗口；`screenshotDir: screenshots` 使 `tab.screenshot()` 把全分辨率截图写到 omp 进程工作目录（恒为会话 `<CWD>`，「子进程 spawn 契约」）下的 `screenshots/`（omp 只展开 `~`，相对路径相对进程工作目录解析；落点由 browser-runtime「CI browser-image job」在真实 omp 下钉住）。看图块使 omp 的看图角色（当前模型不能看图时，图片附件描述回退所用的模型）为能看图的白名单模型；当前模型自身能否收到截图等图片块只看它的 `input` 是否含 `image`（不含时 omp 把图片块换成文字占位）；`modelRoles` 是对象，深合并只压住 `vision` 一键，项目层写的其它角色照常生效（ADR-0012 登记的残余）。浏览器 `open` 的参数 `app.path`、`app.cdp_url`、`app.relay`（现在由模型在 eval 的 JS 里直接传）是参数不是设置，overlay 钉不住（`app.relay` 另由 spawn 环境的 `PI_BROWSER_RELAY=0` 关掉，「子进程 spawn 契约」）：执行它们的 JS 在 `eval` 的确认卡上原样可见（tool-approval「审批请求识别」），每次宿主调用由 browser-runtime「浏览器调用审计」逐次记录（ADR-0012 登记的残余）。`browser.tern` 与 `dev.autoqa` 两键 owner 2026-10-20 有意不钉（ADR-0012 已知风险）。

各键的作用（真实 omp v18.12.3 实测；本机实测两个版本都接受这一份文件、启动日志无 settings 警告）：`tools.approval: null` 整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具；数组 `[]` 在 v18.12.3 被 record 类型校验丢弃、回落默认 `{}` 并每次启动写一条 `Settings: ignoring invalid value` 警告——项目值同样没有复活，但语义靠校验失败兜底；`null` 在深合并里走替换分支、被当作未设置而回落默认，两个版本都无警告，v18.0.10 上官方用例 (c) 实测项目层 `{write: allow}` 仍弹卡）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与 `python.interpreter: ""` 使项目层不能指定被宿主执行的可执行文件（v18.0.10 上 `ruby.interpreter` / `julia.interpreter` 同理——项目层指定的解释器在 spawn 预检时被执行、不经审批，O/tools/index.ts:554-570，Ruby 实测、Julia 同路径——所以两键保留到翻转；v18.12.3 的 eval 后端只剩 py 与 js、两键已不存在，翻转时删掉，v18.12.3 对这两行静默忽略、无警告（组 1a 实测），宿主彼时也不跑它）；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）；`images.urls.enabled: false` 关掉图片发布 broker——项目层把它打开后，会话创建时的 prewarm 会按项目给的参数拉起 `ssh`/`cloudflared` 等外部进程，`images.urls.command` 则被直接执行；这一组的效果是读源码得出的，omp 接受该取值已实测。`retry:` 段把 omp 的会话级自动重试封顶为一轮（owner 2026-10-13，#909）：传输层与 provider 层的重试是硬编码，一轮约 12 次上游请求（v18.0.10 实测），缺省 10 次会话级重试时一次 5xx 回合数分钟才失败；`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 缺省值，写出来是为了让项目层改不动重试的时长；`modelFallback: false` 关闭 omp 的模型兜底（缺省 `true`）——否则项目层一条 `retry.fallbackChains` 就能在重试预算用尽时换模型并重置预算，对不可重试的错误（含模型代理的 424）也会换模型重放；这与「多上游切换不在范围内」（owner 2026-10-06）一致。`telemetry.otlpExportEnabled: false` 关掉 OTLP 导出（缺省 `true`，需 `OTEL_*` 端点才真正导出，而工作目录 `.env` 可以注入它们）；`archive.enabled: false` 关掉 `archive` prelude（read 档、不请求审批，读 omp 的 `sessions` 目录——与宿主的 `--session-dir` 不重叠，纯卫生）；`disabledProviders` 列出 omp v18.12.3 的全部内置模型 provider（#1621，owner 2026-10-21）：名单是 tag `v18.12.3` 的 `packages/catalog/src/compat/rules/providers/*.kdl` 条目 id、bundled 模型目录的 provider id 与隐式本机探测的 `llama.cpp`、`apple` 的并集，减去 `cursor`（它同时是能力发现源的 id，列进来会关掉 `.cursor` 下的 MCP / 规则 / 设置发现）与 `local`、`web`（静态合成、不发请求）；所以 omp 启动后的后台模型发现既不探测本机 `ollama`（11434）、`llama.cpp`（8080）、`lm-studio`（1234）端口，也不向第三方模型目录主机（如 `catalog.stencil.so` 的共享目录、各 provider 的公开 `/models`）发请求，满足部署包无公网依赖；托管 `models.yml` 的 `workbuddy` provider 不在名单里、不受影响，名单里也没有能力发现源的 id（`claude`、`codex`、`cline` 等），项目 skills 照常发现。名单随 omp 版本变化：升级钉住版本时 SHALL 按同一规则重新生成。`ask.enabled: false` 使 omp 不创建 `ask` 工具：该工具只在有 UI（`--mode rpc-ui`）时创建，plain `rpc` 下模型本就看不到它；宿主对它的提问帧只会 cancel，而 `ask` 被取消时先中止整个 agent 回合再抛错（v18.12.3 `tools/ask.ts:785-786,909-911`、`session/session-tools.ts:402`），用户会看到回答无故「已停止」——钉掉它使 `rpc-ui` 下的工具集与 `rpc` 下相同（两个版本都有该键；本机实测两者带此键启动无 settings 警告）。`ida.enabled: false` 使 v18.12.3 不挂载 `ida` 工具：缺省 `true`，项目层 `.omp/config.yml` 可设 `ida.installDir`（任意含 `libidalib.*` 的目录）与 `ida.python: ./x.sh`，之后 `read`（任何档位都不经审批）读到带可执行头的文件就会以项目层指定的解释器起进程（PR #1573 安全座席 P1，Epic (f) 缺省方案）；v18.0.10 没有该键、静默忽略；真实 omp 证据（组 6 实跑）：`ida` 是 discoverable 工具、从不进 `get_state.dumpTools`，只在找到 IDA 安装时以 `xd://ida` 设备出现在系统提示里——项目层写 `ida.enabled: true` 与 `ida.installDir`（含一个 `libidalib.*` 文件即被认作安装）时，带 overlay 的系统提示没有 `ida` 设备，去掉 `ida:` 块时有。`advisor.enabled: false`：v18.12.3 的缺省是 `false`（`advisor/settings.ts:12-16` 另有 `protocolDefault: ["rpc","acp"]`），但任何一层配置都压过缺省（`main.ts:261-268`），项目层 `.omp/config.yml` 写 `advisor.enabled: true` 即开启；开启后 `WATCHDOG.md/.yml` 的上溯以 `vcs.repo(cwd)?.root() ?? home` 为界，原生发现要求 `.git/HEAD`、空 `.git` 标记被跳过，会走到文件系统根（PR #1579 安全座席预警 (1)）——与 `ask` / `ida` 同类，零成本钉住；真实 omp 证据（组 6 实跑）：该设置没有 RPC 读回，只能看行为——项目层写 `advisor.enabled: true` 与 `modelRoles.advisor` 时，带 overlay 一个 bash 回合 2 次上游请求、只有 `advisor_cost_changed` 帧，去掉 `advisor:` 块时 5 次并出现 `advisor_yielded`。`tools.approvalMode: write` 的优先级低于 argv：omp 在启动段把 `--approval-mode` 的取值经 `settings.override("tools.approvalMode", …)` 写入高于 overlay 的运行期覆盖层，所以会话的有效档位为 `always-ask` 或 `yolo` 时生效的是 argv 的值，overlay 的这一行只在 argv 缺席时才起作用（argv 恒在，见「子进程 spawn 契约」），作为 `write` 的兜底保留。overlay 的内容 SHALL NOT 随会话、档位或模型变化：全部会话、全部档位共用同一份文件，字节只由上述部署配置决定。其余各键在三个档位下的作用相同——`always-ask` 下项目层的逐工具放行与 bash 放行规则同样被清掉；`yolo` 下工具本来就不因档位请求审批，项目层无从再放宽，而项目层自己写的收紧规则照旧被清掉（ADR-0012 已登记的残余）。「argv 压过 overlay」这一点由 session-permission-tier「档位与 omp 审批模式」的真实 omp 场景钉住。overlay 不做 schema 校验，上述取值依赖 v18.12.3 的消费代码：升级 omp 时 SHALL 重新验证。

overlay 缺失、不可读或不是 YAML mapping 时 omp 以非零退出且不发任何帧——宿主按既有的握手失败处理（`agent_unavailable`），SHALL NOT 回退为不带 `--config` 的 spawn。写入失败 SHALL 走与 `models.yml` 写入失败相同的 partial-start failure 路径。

本要求 SHALL NOT 做的（owner 决定，登记于 ADR-0012）：不拦项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义（它们是功能；自 #1563 起 skills、`AGENTS.md`/`RULES.md` 只从会话 cwd 读取，agent 定义不受标记约束，见「会话工作目录的仓库根标记」）；不拦项目层 `.omp/tools`、`.claude/tools`、`.codex/tools` 与项目插件在 spawn 时的执行（受信局域网 + uid 隔离下的已接受残余）；不在 spawn 前扫描或拒绝工作目录；不以 overlay 放行 `tools.approval.browser`（对象会与项目层深合并，复活项目的逐工具放行——#1563 事实核查否决）。

#### Scenario: overlay 写入
- **WHEN** 编译入口冷启动
- **THEN** `<OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 是 mode `0640` 的普通文件，内容逐字节等于固定块、浏览器块（`<enabled>` 按该次启动是否配置 `BROWSER_BIN`）与看图块（按白名单）依次相接；`approval` 一行恰为 `  approval: null`、以 `ida:\n  enabled: false` 两行结尾（翻转前以 `ask:\n  enabled: false` 两行结尾）（翻转前另含 `ruby:` / `julia:` 四行，翻转后没有）；同一部署配置下重启后字节不变；agent 目录无残留临时文件

#### Scenario: rpc-ui 下模型拿不到 ask 工具（真实 omp）
- **WHEN** 官方 omp v18.12.3 按「子进程 spawn 契约」（`--mode rpc-ui`）与原样的宿主 overlay、档位 `write` 启动，受控上游在一个回合里发出 `WORKBUDDY_ASK` 标记的工具轮（omp-test-harness「受控上游 ask 标记」：一个 `ask` 调用）
- **THEN** 该回合没有 `method` 为 `select` 且 `title` 不以 `Allow tool: ` 开头的 `extension_ui_request`，也没有其它等待应答的非审批 UI 请求（`confirm` / `input` / `editor`）被 cancel（omp 即发即弃的显示帧如 `setWidget` 不等应答，`rpc` 下同样出现、同样被 cancel，不计入）；回合以 `agent_end` 正常结束、宿主记为 `done`；受控上游记录到的第二个请求携带名为 `ask` 的那次工具调用的错误结果（omp 把未知工具作为错误结果回给模型；#1566 首跑：工具消息 `content` 为 `Tool ask not found`，v18.0.10 与 v18.12.3 相同）；`chat_approvals` 没有新行
- **WHEN** 同一用例以测试专用 spawn 包装把 argv 的 `--config` 与环境变量 `PI_CONFIG_FILES` 都指向一份去掉 `ask:` 块、其余逐字节相同的 overlay（负向对照；omp 先读 `PI_CONFIG_FILES` 再追加 `--config`，只换其一则钉仍生效）
- **THEN** 该回合出现至少一个非审批形状的 `extension_ui_request`，宿主 cancel 它之后回合以 `stopped` 结束（omp 的 `ask` 取消即中止回合）
- **WHEN** 同一进程配置分别以 `--mode rpc-ui` 与（测试专用包装改写为）`--mode rpc` 各跑一个相同的 bash 回合
- **THEN** 受控上游记录到的请求数相同、每个请求的 `model` 相同

#### Scenario: 项目层放行不再绕过审批（真实 omp）
- **WHEN** 有效档位为 `write` 的会话 cwd 下预置 `.omp/config.yml`，含 `tools.approval: {bash: allow}` 与 `bash.patterns: [{match: "*", approval: allow}]`，随后一个回合里模型调用 bash
- **THEN** 宿主收到该 bash 调用的审批请求（`chat_approvals` 有行），与无项目配置时一致；omp 的日志里没有 `Settings: ignoring invalid value`
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
- **WHEN** 官方 omp v18.12.3 经模型代理连接一个对每次请求都答 503 的假上游，会话发一个 prompt
- **THEN** omp 恰发一个 `auto_retry_start`（`attempt` 1、`maxAttempts` 1），随后 `auto_retry_end{success:false}` 与终止 `agent_end`；上游恰收到两轮请求（v18.12.3 首跑实测两轮共 24 次——传输层每轮 6 次尝试、provider 层再重放一次，与 v18.0.10 相同），回合以 `failed` 结束
- **WHEN** 托管 `models.yml` 在同一 provider 下列出两个白名单模型 A、B，会话以 A 运行，会话 cwd 下预置 `.omp/config.yml`，含 `retry: {maxRetries: 10, baseDelayMs: 3600000, modelFallback: true, fallbackChains: {default: ["<provider>/B"]}}`
- **THEN** 结果与上一例相同（overlay 压过项目层）：恰一个 `auto_retry_start`，上游收到的每个请求体的 `model` 都是 A、没有一个是 B

#### Scenario: 浏览器块随 BROWSER_BIN
- **WHEN** 编译入口分别在未设置 `BROWSER_BIN`、以及 `BROWSER_BIN` 为一个可执行普通文件的绝对路径时冷启动（`MODEL_CATALOG` 未设置、`MODEL_VISION=off`）
- **THEN** 前者 `host-overlay.yml` 的浏览器块为 `enabled: false`，后者为 `enabled: true`；两份文件只有这一行不同，都恰以浏览器块的 `  screenshotDir: screenshots` 行结尾、不含 `modelRoles`

#### Scenario: 看图块随白名单
- **WHEN** 编译入口以 `MODEL_CATALOG` 未设置且 `MODEL_VISION` 未设置冷启动；另一次 `MODEL_VISION=off`；另一次 `MODEL_CATALOG` 为 `[{"id":"m1"},{"id":"m2","vision":true},{"id":"m3","vision":true}]`
- **THEN** 第一次文件在浏览器块之后恰为 `modelRoles:` 与 `  vision: "workbuddy/deepseek-v4.1-flash"` 两行；第二次没有 `modelRoles` 键；第三次为 `  vision: "workbuddy/m2"`

#### Scenario: 未配置浏览器时浏览器调用失败且不下载（真实 omp）
- **WHEN** 官方 omp v18.12.3 经宿主 overlay（`enabled: false`）、未设置 `BROWSER_BIN`、档位 `yolo`，会话工作目录里预置项目层 `.omp/config.yml` 写 `browser: { enabled: true }`（overlay 须压过项目层），连接受控假上游；会话的 prompt 含 `WORKBUDDY_BROWSER_OPEN:about:blank`（omp-test-harness「受控上游浏览器标记」：一个 `eval` 调用，JS 里 `browser.open`），回合结束
- **THEN** 该回合恰有一个工具步骤、登记名为 `eval`、以 `failed` 结束（JS 里没有 `browser`，或 prelude 被禁用而 fail-closed），回合以 `done` 结束；`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在；`<OMP_STATE_DIR>/xdg/state/omp/logs/` 下的日志不含 `Downloading Chromium for puppeteer`

#### Scenario: 启动后不向第三方模型目录主机发请求（真实 omp）
- **GIVEN** 全新的 omp agent 目录（没有模型目录缓存），会话工作目录的 `.env` 写 `ALL_PROXY=http://127.0.0.1:<端口>` 指向一个只记录 `CONNECT` 目标的本地监听器，spawn 环境去掉 `no_proxy` / `NO_PROXY` 两个钉以便观测，工作目录放 `.claude/skills/x/SKILL.md`
- **WHEN** 以产品 overlay 启动官方 omp v18.12.3（`--mode rpc-ui`），`get_available_models` 应答之后再等一个观测窗口
- **THEN** 监听器没有收到任何 `CONNECT`；`get_available_models` 列出 `workbuddy/<MODEL_ID>`；`get_available_commands` 含 `skill:x`
- **WHEN** 作为对照，overlay 的 `disabledProviders` 换回 `[ollama, llama.cpp, lm-studio, apple]`，其余相同
- **THEN** 监听器在同一窗口内收到至少一个 `CONNECT`，其中有 `catalog.stencil.so:443`
