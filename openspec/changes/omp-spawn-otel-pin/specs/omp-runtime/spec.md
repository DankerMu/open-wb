## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc-ui --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL> --approval-mode <MODE> --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 启动（`--config` 的取值由「宿主 overlay」规定，恒为绝对路径），**仅当** `chat_sessions.omp_session_file` 非 null 时在其后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--mode rpc-ui`（#1563，owner 2026-10-20）而不是 `rpc`：omp v18.12.3 的浏览器是 `eval` 工具的 prelude，它的每次宿主调用在 `write` / `always-ask` 档要经 prelude 自己的审批，而这类审批走工具 UI 上下文，只有 `rpc-ui` 把它作为 `extension_ui_request{select}` 送到协议上，plain `rpc` 下没有 UI、调用直接失败（`Eval prelude "browser" requires approval but no interactive UI is available`）。两种模式的握手、帧层与命令相同；`rpc-ui` 另把 `ask` 一类工具 UI 请求也送到协议上，宿主对非审批形状照旧 cancel（「RPC IO and child observation」）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`<MODE>` SHALL 是调用方给出的该会话的有效审批档位，取 `always-ask`、`write`、`yolo` 三个字面量之一（session-permission-tier「档位与 omp 审批模式」）：`write` 使 omp 仅对 exec 档工具（bash/eval/task）经 `extension_ui_request` 请求审批，文件读写不触发审批（本 change 之前唯一的取值）；`always-ask` 使写文件类工具同样请求审批；`yolo` 使工具不因档位请求审批。spawn SHALL NOT 自行决定、缺省或改写档位：调用方给出的值不是这三个字面量之一时 SHALL 不 spawn 任何子进程（视同目录准备失败），不得回退为某个档位。档位在一个进程的生命期内不变：omp 没有运行期切换审批模式的命令，宿主 SHALL NOT 向存活进程发送任何试图改变档位的帧，也 SHALL NOT 由 overlay 或其它配置文件按会话改写它；会话的档位改变后，由调用方在两个回合之间退役该进程并以新档位重新 spawn（chat-sessions「派发前按会话设置对齐进程」）。`<MODEL>` SHALL 是调用方给出的该会话的有效模型 id（模型白名单内的一项，model-selection「模型白名单配置」；未配置白名单时即 `MODEL_ID`）：它决定冷启动会话的初始模型；宿主 SHALL NOT 依赖它在 `--resume` 时的效果（每个 generation 的第一次派发之前另经 RPC 应用模型与推理强度，见「模型与推理强度命令」）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, PI_CODING_AGENT_DIR, PI_CONFIG_FILES, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, WORKBUDDY_MODEL_TOKEN, PI_BROWSER_RELAY, PI_BROWSER_CMUX, PUPPETEER_PROXY, PUPPETEER_PROXY_IGNORE_CERT_ERRORS, OTEL_SDK_DISABLED, PUPPETEER_EXECUTABLE_PATH}`（`LANG`/`TMPDIR` 缺席时不设；`PUPPETEER_EXECUTABLE_PATH` 只在部署配置了 `BROWSER_BIN` 时设置、取值恰为 `BROWSER_BIN` 的值（browser-runtime「浏览器可执行文件配置」），SHALL NOT 取自 `process.env` 的同名键——omp 以它为浏览器可执行文件，不再自动发现或下载），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；`PI_CODING_AGENT_DIR` SHALL 显式设为 omp 的默认 agent 目录本身——即 `<HOME 的取值>/.omp/agent`，与 `ompAgentDir(stateDir)` 同一字符串（omp 以字符串相等判断 agent 目录是否为默认值，只在相等时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」）；`PI_CONFIG_FILES` SHALL 设为「宿主 overlay」的文件路径；`PI_CONFIG_DIR` SHALL 为 `.omp`，`OMP_PROFILE` 与 `PI_PROFILE` SHALL 为 `default`（omp 把它规范化为「无 profile」；空串不行——dotenv 会覆盖空值）。五者的取值与不设时 omp 的行为相同，显式设置的目的是「工作目录 dotenv 钉住」：omp 启动时加载 `<cwd>/.env` 等文件，但不覆盖已有的非空环境变量。`PI_BROWSER_RELAY` 与 `PI_BROWSER_CMUX` SHALL 恒为字面量 `0`，不论是否配置 `BROWSER_BIN`（owner 2026-10-19，#1529）：omp 以这两个变量为浏览器中继与 cmux 的最终开关，非空时压过设置与参数（v18.12.3 `tools/browser/relay/kind.ts:36`、`tools/browser/cmux/rpc.ts:187-197`；`browser.open({app:{relay:true}})` 也经同一开关），未设时模型写进工作目录 `.env` 的 `PI_BROWSER_RELAY=1`（或 `OMP_BROWSER_RELAY=1`，omp 把 `.env` 里的 `OMP_*` 镜像成 `PI_*`）在下一次 spawn 时生效，绕过宿主 overlay 的 `relay: false` / `cmux: false` 与 `cdpUrl: ""`，且工具参数里不出现 `app`，确认卡与审计都看不到；字面量 `0` 是非空值，dotenv 不覆盖（空串会被覆盖，挡不住）。它们使中继与 cmux 在任何设置与参数下都不启用，`app.relay: true` 的调用退回本地浏览器（读源码得出，由下文真实 omp 场景实测）。`PUPPETEER_PROXY` SHALL 恒为字面量 `direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS` SHALL 恒为字面量 `0`（owner 2026-10-19，PR #1549 审查）：omp 起本地浏览器时从自身环境读这两个变量，拼成 `--proxy-server=<值>` 与 `--ignore-certificate-errors`（v18.12.3 `tools/browser/launch.ts:591-601`，经 broker 启动的共享浏览器也用同一份参数），未设时工作目录 `.env` 能给浏览器挂任意代理并关掉证书校验，卡与审计都看不到；`--proxy-server=direct://` 使 Chromium 一律直连，同时压过它从环境读的 `http_proxy` 一类变量，`0` 不在 omp 认作真的取值里。宿主的闭合白名单本就不给浏览器任何代理，钉住不改变既有部署；SHALL 不继承 `process.env` 中任何其它键。owner 2026-10-20 有意不钉 `PI_BROWSER_TERN`（与 `browser.tern`）和 `PI_AUTO_QA`（与 `dev.autoqa`）：工作目录 `.env` 经 `TERN_PANE_SOCKET` / `TERN_PANE` 走 Tern 浏览器分支、经 `PI_AUTO_QA_PUSH=1` 把模型写的报告推到 `PI_AUTO_QA_PUSH_URL`，登记为已知风险（ADR-0012）。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。cwd 就绪之后、`spawnImpl` 之前 SHALL 按「会话工作目录的仓库根标记」确保 `<CWD>/.git` 存在，标记建不出时视同目录准备失败。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>`、`<MODE>` 与 `<MODEL>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话的工作目录、有效档位与有效模型）。 `OTEL_SDK_DISABLED` SHALL 恒为字面量 `true`（#1575）：omp 的 OTLP 导出只看环境里的 `OTEL_EXPORTER_OTLP_*` 端点，工作目录 `.env` 能注入端点（及 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 等内容采集开关），把 trace / log / metric 从服务器发到任意地址；v18.12.3 在 `!telemetry.otlpExportEnabled || OTEL_SDK_DISABLED=true` 时不注册导出（`telemetry-export.ts:82`），两者各自独立生效——这一环境钉与「宿主 overlay」的 `telemetry.otlpExportEnabled: false` 是两道独立的关，不依赖该设置键在以后的 omp 版本里继续存在；值非空，dotenv 覆盖不了。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex
- **WHEN** `process.env` 含 `PUPPETEER_EXECUTABLE_PATH=/opt/other`，分别在部署未配置 `BROWSER_BIN` 与配置为 `/usr/bin/chromium` 时 spawn
- **THEN** 前者子进程 env 不含 `PUPPETEER_EXECUTABLE_PATH`；后者恰含 `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`；两者都不含 `BROWSER_BIN` 键，`/opt/other` 不出现在子进程 env 中
- **WHEN** `process.env` 含 `PI_BROWSER_RELAY=1`、`PI_BROWSER_CMUX=1`、`CMUX_SOCKET_PATH=/tmp/x.sock`，分别在部署未配置与配置了 `BROWSER_BIN` 时 spawn
- **THEN** 两次子进程 env 都恰含 `PI_BROWSER_RELAY=0` 与 `PI_BROWSER_CMUX=0`，都不含 `CMUX_SOCKET_PATH`
- **WHEN** `process.env` 含 `PUPPETEER_PROXY=http://192.0.2.1:9`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS=1`、`http_proxy=http://192.0.2.1:9`，分别在部署未配置与配置了 `BROWSER_BIN` 时 spawn
- **THEN** 两次子进程 env 都恰含 `PUPPETEER_PROXY=direct://` 与 `PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0`，都不含 `http_proxy`
- **WHEN** `process.env` 含 `OTEL_SDK_DISABLED=false`、`OTEL_EXPORTER_OTLP_ENDPOINT=http://192.0.2.1:4318` 与 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`，分别在部署未配置与配置了 `BROWSER_BIN` 时 spawn
- **THEN** 两次子进程 env 都恰含 `OTEL_SDK_DISABLED=true`，都不含 `OTEL_EXPORTER_OTLP_ENDPOINT` 与 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`

#### Scenario: 工作目录 .env 不能打开浏览器中继（真实 omp）
- **WHEN** 官方 omp v18.12.3 经宿主 overlay（浏览器块 `enabled: true`、`relay: false`、`cmux: false`）与宿主 spawn 环境（`PUPPETEER_EXECUTABLE_PATH` 指向一个执行时先写标记文件再以非零退出的包装脚本）、档位 `yolo` 启动；会话工作目录里预置 `.env`，写 `PI_BROWSER_RELAY=1`、`PI_BROWSER_CMUX=1`、`CMUX_SOCKET_PATH=<临时目录下一个不存在的套接字路径>`、`PUPPETEER_PROXY=http://192.0.2.1:9` 与 `PUPPETEER_PROXY_IGNORE_CERT_ERRORS=1`，并预置项目层 `.omp/config.yml` 写 `browser: { relay: true, relayUrl: "http://192.0.2.1:9" }`（TEST-NET-1，不是本机地址，omp 不为它拉起中继守护进程）；会话的 prompt 含 `WORKBUDDY_BROWSER_OPEN:about:blank`（omp-test-harness「受控上游浏览器标记」：一个 `eval` 调用，JS 里 `browser.open`），回合结束
- **THEN** 包装脚本的标记文件存在，且它记下的启动参数含 `--proxy-server=direct://`、不含 `192.0.2.1` 与 `--ignore-certificate-errors`（omp 选了本地浏览器启动路径：中继与 cmux 都被关掉时才会走到它）
- **WHEN** 同一用例，但 spawn 环境里去掉 `PI_BROWSER_RELAY` 与 `PI_BROWSER_CMUX` 两个键（测试专用的 spawn 包装删除它们，作为入库的负向对照）
- **THEN** 标记文件不存在，且该次 `eval` 步骤以失败结束、其结果文本含浏览器打开超时或中继不可用的 omp 原文而不含 `Shared browser daemon unavailable`（走了中继；v18.12.3 首跑原文：`ToolError: Browser open timed out after 30000ms while launching or connecting to the browser (relay:http://192.0.2.1:9)`）

#### Scenario: 工作目录 .env 不能打开 OTLP 导出（真实 omp）
- **WHEN** 官方 omp v18.12.3 经宿主 spawn 环境启动，会话工作目录里预置 `.env`，写 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<本地监听端口>`、`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`、`OTEL_SDK_DISABLED=false` 与缩短导出间隔的批处理设置（四种配置的 `.env` 相同）；分别以（1）产品 overlay 与产品 spawn 环境、（2）去掉 `telemetry:` 块的 overlay（测试专用）、（3）产品 overlay 但 spawn 环境去掉 `OTEL_SDK_DISABLED`（测试专用的 spawn 包装删除它）跑一个完整回合，`agent_end` 之后子进程继续存活一个有界的观察窗口，窗口结束、关停之前断言
- **THEN** 三种配置下本地监听器都收不到任何请求（（2）证明环境钉单独有效，（3）证明 overlay 钉单独有效）
- **WHEN** 同一用例，（4）overlay 去掉 `telemetry:` 块且 spawn 环境去掉 `OTEL_SDK_DISABLED`（入库的负向对照），同样在 `agent_end` 后的同一观察窗口内、关停之前断言
- **THEN** 本地监听器至少收到一个 OTLP 请求（宿主的关停路径不 flush：omp 在 stdin EOF 后直接退出，导出只能在进程存活时由批处理与周期定时器发出）

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null，有效档位 `write`，有效模型为缺省模型 `<MODEL_ID>`）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--mode rpc-ui`、`--cwd <SANDBOX_ROOT>/u1`，含 `--model workbuddy/<MODEL_ID>`、`--approval-mode write` 与紧随 `--no-title` 的 `--config <overlay 路径>`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；该会话任何 spawn 的 argv 里 `--approval-mode` 恰出现一次且其后是 `write`（不含 `yolo` 或 `always-ask`）；session-dir、「OMP_STATE_DIR 托管布局」的全部目录、作为 cwd 的所有者根与其下的 `.git` 标记在 spawn 时已存在（事先不存在的由宿主建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir and every directory of the managed layout SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates) and the cwd's `.git` marker, and parent env SHALL remain unchanged

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
- **THEN** 两个会话各自的首次与 resume argv 里，`--approval-mode` 之后分别恒为 `always-ask` 与 `yolo`，`--model` 之后分别恒为 `workbuddy/m3` 与 `workbuddy/m1`；除这两处、`--cwd`、`--session-dir` 与 `--resume` 外，四份 argv 与 `write` 档缺省模型会话的 argv 逐字相同（都以 `--mode rpc-ui` 开头）；子进程环境白名单与 `PI_CONFIG_FILES`、`--config` 的取值不随档位或模型变化

#### Scenario: 非法档位不 spawn
- **WHEN** 调用方给出的档位为 `auto`、空串或缺失
- **THEN** `spawnOmp` 不启动任何子进程、不签发可用 token，调用以失败结束；没有以 `write` 或其它档位替代 spawn

#### Scenario: rpc-ui 下三档回合与 rpc 相同（真实 omp）
- **WHEN** 官方 omp v18.12.3 按本契约（`--mode rpc-ui`）分别以 `always-ask`、`write`、`yolo` 启动，各跑一个含 bash 调用的回合并在回合之间 `get_state`
- **THEN** 三次都正常握手（`ready`）、回合以 `agent_end` 结束；审批请求的有无与 session-permission-tier「档位与 omp 审批模式」一致；`get_state` 应答含 `sessionFile`、`model`、`thinkingLevel`（会话模型 `reasoning` 时；omp 不写值为 undefined 的键）；除审批之外的 `extension_ui_request`（含 omp 每回合即发即弃的 `setWidget` 显示帧）都被宿主 cancel 且回合不因此失败（#1566 实测：启动帧、`get_state` 键集合、审批帧与 `rpc` 下逐项相同）
