# omp-runtime Specification

## Purpose
Defines pinned omp binary supply, least-privilege child spawning, bounded RPC transport, per-session lifecycle, and prompt-dispatch receipt semantics.

## Requirements

### Requirement: 二进制供给
`make omp-fetch` SHALL 只从 `can1357/oh-my-pi` GitHub release **v18.12.3** 拉取与当前 `uname -sm` 匹配的资产（`omp-darwin-arm64` 或 `omp-linux-x64`），对照仓内固定的 SHA256 表（取自该 release 的 `SHA256SUMS.txt`：darwin-arm64 `f2a657b3320fcafa23055053940a45b26a8d3254e1412a158838013d670d6ec5`、linux-x64 `065b5079d65ff6b77d961c935ba808e8f0f569ca6a2cb7b5fb6a1e8da72d7dec`）校验后落到 `var/omp/omp` 并置可执行位；校验失败 SHALL 不留下 `var/omp/omp`；目标已存在且校验通过 SHALL 跳过下载；目标已存在但校验不通过（例如上一个版本的二进制）SHALL 删除它并以非零退出（stderr 报 `existing <path> failed verification` 与摘要不符；再执行一次即重新下载）。不支持的平台 SHALL 显式失败并打印支持矩阵。app-server SHALL 不依赖 PATH 上的任何 `omp`。官方二进制对照用例（`server/test/support/omp-official.ts`）SHALL 钉同一版本：`--version` 不是 `omp/18.12.3` 即拒绝运行。ADR-0001 的 v18.0.10 钉作废（2026-10-20 补充）。

#### Scenario: 首次拉取与幂等
- WHEN 在空 `var/omp/` 下执行 `make omp-fetch`
- THEN 产出 `var/omp/omp`，`var/omp/omp --version` 输出 `omp/18.12.3`；再次执行不产生网络下载且退出 0

#### Scenario: 摘要不符
- WHEN 下载内容的 SHA256 与固定表不一致
- THEN 退出非 0，stderr 含 expected/actual 摘要，且 `var/omp/omp` 不存在
- WHEN `var/omp/omp` 已存在但其 SHA256 是 v18.0.10 的
- THEN 退出非 0、stderr 含 expected/actual 摘要，旧文件被删除；再次执行即拉取 v18.12.3

#### Scenario: 不支持平台
- WHEN uname -sm is neither Darwin arm64 nor Linux x86_64
- THEN the command SHALL fail nonzero with the supported platform matrix without downloading

#### Scenario: Make contract protection
- WHEN an equivalent duplicate `omp-fetch :` target or a changed recipe is injected
- THEN the existing harness oracle SHALL reject the mutation while accepting the intended Makefile

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc-ui --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL> --approval-mode <MODE> --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 启动（`--config` 的取值由「宿主 overlay」规定，恒为绝对路径），**仅当** `chat_sessions.omp_session_file` 非 null 时在其后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--mode rpc-ui`（#1563，owner 2026-10-20）而不是 `rpc`：omp v18.12.3 的浏览器是 `eval` 工具的 prelude，它的每次宿主调用在 `write` / `always-ask` 档要经 prelude 自己的审批，而这类审批走工具 UI 上下文，只有 `rpc-ui` 把它作为 `extension_ui_request{select}` 送到协议上，plain `rpc` 下没有 UI、调用直接失败（`Eval prelude "browser" requires approval but no interactive UI is available`）。两种模式的握手、帧层与命令相同；`rpc-ui` 另把 `ask` 一类工具 UI 请求也送到协议上，宿主对非审批形状照旧 cancel（「RPC IO and child observation」）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`<MODE>` SHALL 是调用方给出的该会话的有效审批档位，取 `always-ask`、`write`、`yolo` 三个字面量之一（session-permission-tier「档位与 omp 审批模式」）：`write` 使 omp 仅对 exec 档工具（bash/eval/task）经 `extension_ui_request` 请求审批，文件读写不触发审批（本 change 之前唯一的取值）；`always-ask` 使写文件类工具同样请求审批；`yolo` 使工具不因档位请求审批。spawn SHALL NOT 自行决定、缺省或改写档位：调用方给出的值不是这三个字面量之一时 SHALL 不 spawn 任何子进程（视同目录准备失败），不得回退为某个档位。档位在一个进程的生命期内不变：omp 没有运行期切换审批模式的命令，宿主 SHALL NOT 向存活进程发送任何试图改变档位的帧，也 SHALL NOT 由 overlay 或其它配置文件按会话改写它；会话的档位改变后，由调用方在两个回合之间退役该进程并以新档位重新 spawn（chat-sessions「派发前按会话设置对齐进程」）。`<MODEL>` SHALL 是调用方给出的该会话的有效模型 id（模型白名单内的一项，model-selection「模型白名单配置」；未配置白名单时即 `MODEL_ID`）：它决定冷启动会话的初始模型；宿主 SHALL NOT 依赖它在 `--resume` 时的效果（每个 generation 的第一次派发之前另经 RPC 应用模型与推理强度，见「模型与推理强度命令」）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, PI_CODING_AGENT_DIR, PI_CONFIG_FILES, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, WORKBUDDY_MODEL_TOKEN, PI_BROWSER_RELAY, PI_BROWSER_CMUX, PUPPETEER_PROXY, PUPPETEER_PROXY_IGNORE_CERT_ERRORS, OTEL_SDK_DISABLED, no_proxy, NO_PROXY, PUPPETEER_EXECUTABLE_PATH}`（`LANG`/`TMPDIR` 缺席时不设；`PUPPETEER_EXECUTABLE_PATH` 只在部署配置了 `BROWSER_BIN` 时设置、取值恰为 `BROWSER_BIN` 的值（browser-runtime「浏览器可执行文件配置」），SHALL NOT 取自 `process.env` 的同名键——omp 以它为浏览器可执行文件，不再自动发现或下载），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；`PI_CODING_AGENT_DIR` SHALL 显式设为 omp 的默认 agent 目录本身——即 `<HOME 的取值>/.omp/agent`，与 `ompAgentDir(stateDir)` 同一字符串（omp 以字符串相等判断 agent 目录是否为默认值，只在相等时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」）；`PI_CONFIG_FILES` SHALL 设为「宿主 overlay」的文件路径；`PI_CONFIG_DIR` SHALL 为 `.omp`，`OMP_PROFILE` 与 `PI_PROFILE` SHALL 为 `default`（omp 把它规范化为「无 profile」；空串不行——dotenv 会覆盖空值）。五者的取值与不设时 omp 的行为相同，显式设置的目的是「工作目录 dotenv 钉住」：omp 启动时加载 `<cwd>/.env` 等文件，但不覆盖已有的非空环境变量。`PI_BROWSER_RELAY` 与 `PI_BROWSER_CMUX` SHALL 恒为字面量 `0`，不论是否配置 `BROWSER_BIN`（owner 2026-10-19，#1529）：omp 以这两个变量为浏览器中继与 cmux 的最终开关，非空时压过设置与参数（v18.12.3 `tools/browser/relay/kind.ts:36`、`tools/browser/cmux/rpc.ts:187-197`；`browser.open({app:{relay:true}})` 也经同一开关），未设时模型写进工作目录 `.env` 的 `PI_BROWSER_RELAY=1`（或 `OMP_BROWSER_RELAY=1`，omp 把 `.env` 里的 `OMP_*` 镜像成 `PI_*`）在下一次 spawn 时生效，绕过宿主 overlay 的 `relay: false` / `cmux: false` 与 `cdpUrl: ""`，且工具参数里不出现 `app`，确认卡与审计都看不到；字面量 `0` 是非空值，dotenv 不覆盖（空串会被覆盖，挡不住）。它们使中继与 cmux 在任何设置与参数下都不启用，`app.relay: true` 的调用退回本地浏览器（读源码得出，由下文真实 omp 场景实测）。`PUPPETEER_PROXY` SHALL 恒为字面量 `direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS` SHALL 恒为字面量 `0`（owner 2026-10-19，PR #1549 审查）：omp 起本地浏览器时从自身环境读这两个变量，拼成 `--proxy-server=<值>` 与 `--ignore-certificate-errors`（v18.12.3 `tools/browser/launch.ts:591-601`，经 broker 启动的共享浏览器也用同一份参数），未设时工作目录 `.env` 能给浏览器挂任意代理并关掉证书校验，卡与审计都看不到；`--proxy-server=direct://` 使 Chromium 一律直连，同时压过它从环境读的 `http_proxy` 一类变量，`0` 不在 omp 认作真的取值里。宿主的闭合白名单本就不给浏览器任何代理，钉住不改变既有部署；SHALL 不继承 `process.env` 中任何其它键。owner 2026-10-20 有意不钉 `PI_BROWSER_TERN`（与 `browser.tern`）和 `PI_AUTO_QA`（与 `dev.autoqa`）：工作目录 `.env` 经 `TERN_PANE_SOCKET` / `TERN_PANE` 走 Tern 浏览器分支、经 `PI_AUTO_QA_PUSH=1` 把模型写的报告推到 `PI_AUTO_QA_PUSH_URL`，登记为已知风险（ADR-0012）。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。cwd 就绪之后、`spawnImpl` 之前 SHALL 按「会话工作目录的仓库根标记」确保 `<CWD>/.git` 存在，标记建不出时视同目录准备失败。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>`、`<MODE>` 与 `<MODEL>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话的工作目录、有效档位与有效模型）。 `OTEL_SDK_DISABLED` SHALL 恒为字面量 `true`（#1575）：omp 的 OTLP 导出只看环境里的 `OTEL_EXPORTER_OTLP_*` 端点，工作目录 `.env` 能注入端点（及 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 等内容采集开关），把 trace / log / metric 从服务器发到任意地址；v18.12.3 在 `!telemetry.otlpExportEnabled || OTEL_SDK_DISABLED=true` 时不注册导出（`telemetry-export.ts:82`），两者各自独立生效——这一环境钉与「宿主 overlay」的 `telemetry.otlpExportEnabled: false` 是两道独立的关，不依赖该设置键在以后的 omp 版本里继续存在；值非空，dotenv 覆盖不了。 `no_proxy` 与 `NO_PROXY` SHALL 恒为字面量 `*`（#1615）：宿主的模型端点是明文回环（`http://127.0.0.1:<port>/v1`，「托管 models.yml」），omp 的推理请求走 Bun 原生 `fetch`，它从环境读 `HTTP_PROXY` / `http_proxy` / `ALL_PROXY`（及 `HTTPS_PROXY`，目标为 https 时）并对回环目标同样走代理，除非 `no_proxy` / `NO_PROXY` 覆盖它（omp 自己的回环豁免只在设了 `PI_PROXY` 或 `PI_PROXY_<PROVIDER>` 时生效，v18.12.3 `packages/ai/src/utils/transport-fetch.ts:25-47`、`proxy.ts:24-66`）；不钉的话工作目录 `.env` 一行 `HTTP_PROXY=` 就让每个模型请求（全部对话与 `WORKBUDDY_MODEL_TOKEN`）以明文转经任意地址，并把代理的回复当作模型输出，确认卡与审计都看不到。代理变量本身钉不住：Bun 把任何非空值当作代理地址，没有「直连」取值，空串又会被 dotenv 覆盖；所以钉的是豁免。两个大小写都钉：Bun 先读小写 `no_proxy`，只钉大写时 `.env` 再写一行不匹配的小写 `no_proxy` 就重新走代理（#1615 实测）；omp 自己的豁免判断先读大写（`proxy.ts:68`，`NO_PROXY || no_proxy`），只钉小写时 `.env` 写一行不匹配的 `NO_PROXY` 就能让同一 `.env` 里的 `PI_PROXY` 代理 omp 的非回环出站。`*` 豁免所有主机，不随 models.yml 的主机写法（`127.0.0.1`、`[::1]`）变化。副作用（接受）：omp 不从子 shell 剥掉继承的环境，助手经 bash / eval 跑的程序也看到 `no_proxy=*` 与 `NO_PROXY=*`。认这两个变量的工具不走环境代理，libcurl 系工具（curl、git 的 http 传输）连显式配置的代理（`curl -x`、`.curlrc` 的 `proxy`、git 的 `http.proxy`）也会被绕过、改为直连；出站必须经代理的部署里，需要代理的命令须自行去掉豁免（如 `env -u no_proxy -u NO_PROXY …` 或 `curl --noproxy ''`）。宿主的闭合白名单本就不给子进程代理变量，受影响的只是子 shell 里自设的代理与工具配置里的代理。
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
- **WHEN** `process.env` 含 `HTTP_PROXY=http://192.0.2.1:9`、`ALL_PROXY=http://192.0.2.1:9`、`no_proxy=example.invalid` 与 `NO_PROXY=example.invalid`，分别在部署未配置与配置了 `BROWSER_BIN` 时 spawn
- **THEN** 两次子进程 env 都恰含 `no_proxy=*` 与 `NO_PROXY=*`，都不含 `HTTP_PROXY` 与 `ALL_PROXY`

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

#### Scenario: 工作目录 .env 不能让模型请求走代理（真实 omp）
- **WHEN** 官方 omp v18.12.3 经宿主 overlay 与宿主 spawn 环境、档位 `write` 启动，假上游在本机回环上；另起一个本地监听器充当代理，只记录收到的请求（请求行与到达时间）、不转发、不解析正文。会话工作目录里预置 `.env`，五种情形各跑一个完整回合：（1）`HTTP_PROXY=http://127.0.0.1:<代理端口>`；（2）`http_proxy=…`（同一地址）；（3）`ALL_PROXY=…`；（4）`HTTP_PROXY=…` 加 `no_proxy=example.invalid`；（5）`HTTP_PROXY=…` 加 `NO_PROXY=example.invalid`
- **THEN** 五种情形下回合都正常结束（`agent_end`，回复来自假上游），假上游收到模型请求，代理监听器收不到任何请求
- **WHEN** 同一用例的入库负向对照：`.env` 为情形（1），spawn 环境去掉 `no_proxy` 与 `NO_PROXY`（测试专用的 spawn 包装删除它们）
- **THEN** 代理监听器收到的请求里至少有一个的请求行是指向假上游地址的绝对 URI（`POST http://127.0.0.1:<上游端口>/…`），在有界等待内到达；回合的结局不作断言（代理不转发）

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

### Requirement: RPC 握手与帧层
OmpProcess SHALL reuse spawnOmp, wait for ready, negotiate protocol v2, then request get_state with distinct correlated ids. start SHALL resolve with nonempty data.sessionFile only after both matching successful responses, and SHALL otherwise reject with agent_unavailable and terminate the child within the configured startup failure path. One overall handshake deadline SHALL default to 10000ms. It SHALL start only after the child has been spawned; when the owning SessionRuntime is given a spawn gate (see omp-pool「并发 spawn 上限」), spawning happens only after a permit has been granted, so time spent queued for a permit SHALL NOT count against the deadline. This transport SHALL return sessionFile; persistence belongs to the supervisor.

#### Scenario: Successful handshake
- WHEN the real fake omp advertises v2 and successfully answers negotiation and get_state
- THEN start resolves with its sessionFile and repeated start does not spawn another child

#### Scenario: Failed startup
- WHEN ready is absent, negotiation fails, get_state lacks nonempty sessionFile, or the child exits during startup
- THEN start rejects, never reports readiness, clears pending state and terminates a still-running child

#### Scenario: Correlated responses
- WHEN responses arrive out of order or with a wrong id or command
- THEN only a response matching both id and command settles its request; later same-id prompt failures remain observable frames

#### Scenario: Queue time excluded from the deadline
- WHEN a supervisor with spawn concurrency 1 and handshakeTimeoutMs H cold-starts three sessions at once against fake-omp `slow-ready` with ready delay D, where D < H < 3·D
- THEN all three handshakes succeed and each prompt is accepted (202, dispatched), although the third session's total wait from prompt to ready exceeds H

### Requirement: Bounded lossless RPC transport
The transport SHALL enforce physical and logical limits (at most 1 MiB and 64 MiB respectively), reconstruct ordered contiguous rpc_chunk sequences using validated metadata/base64 and strict UTF-8, and emit only complete JSON objects. Invalid sequences SHALL report a sanitized protocol error and discard partial state without crashing the reading loop. Malformed JSON lines SHALL be recoverable. Outbound frames SHALL be unchunked JSONL within the physical limit.

#### Scenario: Large Unicode frame
- WHEN the real chunked fake emits its greater-than-3-MiB Unicode response over arbitrary pipe boundaries
- THEN consumers receive exactly the original object without corruption or rpc_chunk fragments

#### Scenario: Invalid chunk or interrupted sequence
- WHEN metadata, order, base64, byte length, UTF-8 or limits are invalid, or a normal frame interrupts a chunk sequence
- THEN the decoder rejects the affected sequence, emits no partial payload and can process subsequent independent valid frames

#### Scenario: Invalid line and truncated EOF
- WHEN malformed JSON is followed by valid JSONL or EOF truncates a line/chunk sequence
- THEN malformed input is reported without raw payload disclosure; a following valid frame remains readable, and truncated payload is never emitted

### Requirement: RPC IO and child observation
The transport SHALL classify every `extension_ui_request` frame into three kinds. (1) An **approval request**: `method` is exactly `select`, the `title` string starts with `Allow tool: `, the tool name parsed from the first line of the title after `Allow tool: ` is not `browser`, and `options` is exactly one of the two closed shapes omp v18.12.3 emits — `["Approve","Deny"]`, or three items whose first is exactly `Approve`, whose last is exactly `Deny` and whose middle item matches `^Approve .+ for this session$` (the mode-raised prompt of bash, write, edit, eval and task; the middle item names omp's policy key, which need not equal the tool name, so it is matched by shape, not pinned to the name). The transport SHALL NOT answer it itself, SHALL expose it to its owner as an approval request carrying the frame `id`, the full `title` and the parsed `tool` name (parsing failure or empty name yields `unknown`, and the request still counts as an approval request), and SHALL keep the child waiting. (2) A **prelude card**: `method` is exactly `select`, the whole `title` is exactly `Allow tool: browser` or exactly `Allow tool: browser\nReason: <one line without a line break>` (nothing else: no further line, no other second line), and `options` is exactly `["Approve","Deny"]` — omp v18.12.3's browser eval prelude asks once per host call (`open`, `close`, `tabs`, `targets`, `run`, every tab helper) inside an `eval` that was already approved (or allowed by the tier); the card carries no action, URL or tool-call id (#1563, owner 2026-10-20). The transport SHALL answer it immediately with `{type:"extension_ui_response",id,value:"Approve"}`, SHALL NOT expose it as an approval request, SHALL NOT register or audit it (the trace is the `session.browser` audit derived from the eval step, browser-runtime「浏览器调用审计」), and SHALL expose only a `preludeApproval{id}` observation to its owner for tests and counting. The title is matched as a whole, not by its first line: `browser` is not a tool in v18.12.3, but omp v18.0.10 — which the host keeps running until the version flip of #1563 — has a real `browser` tool whose card is `Allow tool: browser\nAction: …\nTab: …[\nURL: …][\nCode:\n…]` with the same two options; it is mounted under `xd://` by default but a project-layer `tools.xdev: false` makes it a top-level tool, and the host overlay does not pin that key. Such a card SHALL fall into kind (3) and be cancelled, never auto-approved. (3) Every other extension UI request (any other `method`, a `select` with options of any other shape or a non-matching title, or a request lacking a string `id` handled as before) SHALL be cancelled immediately with `{type:"extension_ui_response",id:<request id>,cancelled:true}` exactly as before. The transport SHALL expose `respondApproval(id, decision)` that writes exactly one `{type:"extension_ui_response",id,value:"Approve"}` for `allow` or `{…,value:"Deny"}` for `deny` — the host never answers with the session-grant label, so omp's per-session approval set is never written; a second answer for the same `id` SHALL NOT be written. Neither the transport nor SessionRuntime SHALL ever answer an approval request on its own under any condition — no timeout answer, no fallback `Deny`, no answer on stop, retirement, shutdown or child exit; `respondApproval` called by the owner is the only writer of an approval answer, and an approval left unanswered when the child exits simply ends with that child (settlement of its record is the owner's concern). The prelude card is the one and only frame the transport answers by itself. It SHALL expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

#### Scenario: Extension UI cancellation
- **WHEN** the fake requests extension UI during a prompt with a non-approval shape (`method` other than `select`; a `select` whose options are `["A","B"]`, `["Approve"]`, `["Approve","Deny","Other"]`, `["Approve","Approve bash","Deny"]` or `["Approve","Approve bash for this session","Deny","X"]`; or a `select` whose title does not start with `Allow tool: `)
- **THEN** it receives {type:extension_ui_response,id:the-request-id,cancelled:true} without user interaction and proceeds

#### Scenario: Approval request is surfaced, not cancelled
- **WHEN** the fake, spawned with `--approval-mode write`, sends `extension_ui_request{method:"select",title:"Allow tool: bash\n…",options:["Approve","Approve bash for this session","Deny"]}` after a bash `tool_execution_start`; separately one with options `["Approve","Deny"]`; separately one with options `["Approve","Approve shell:ls for this session","Deny"]`
- **THEN** no `extension_ui_response` is written for any of them until the owner answers, the owner observes one approval request per frame with that id, `tool` equal to `bash` and the original title, and the fake emits no further turn frames while it waits

#### Scenario: Approval answers map to exact values
- **WHEN** the owner answers an outstanding approval request with `allow`, and separately another with `deny`, and then answers either a second time
- **THEN** exactly one `extension_ui_response{id,value:"Approve"}` respectively `{id,value:"Deny"}` reaches the child (never the session-grant label), the fake proceeds (executing on Approve, reporting `tool_execution_end{isError:true}` on Deny), and the second answer writes nothing
- **WHEN** the title first line cannot be parsed as `Allow tool: <name>`
- **THEN** the request is still surfaced as an approval request with `tool` equal to `unknown` and is not auto-cancelled

#### Scenario: Prelude card is answered by the transport
- **WHEN** during an `eval` step the child sends `extension_ui_request{id:"p1",method:"select",title:"Allow tool: browser",options:["Approve","Deny"]}`, then one with title `Allow tool: browser\nReason: target not yet approved`
- **THEN** each immediately receives `{type:"extension_ui_response",id,value:"Approve"}`, the owner observes `preludeApproval{id}` for each and no approval request, no `chat_approvals` row and no audit row is created for them, and the child proceeds
- **WHEN** the child sends `{method:"select",title:"Allow tool: browser",options:["Approve","Approve browser for this session","Deny"]}`, a `confirm` whose title is `Allow tool: browser`, a `select` whose title is `Allow tool: browser\nAction: open\nTab: main\nURL: https://example.com` with options `["Approve","Deny"]` (omp v18.0.10's real `browser` tool), one whose title is `Allow tool: browser\nReason: a\nb` (a second line after `Reason:`), or one whose title is `Allow tool: browser ` (trailing space)
- **THEN** all are cancelled (not answered `Approve`), none is surfaced as an approval request, and the owner observes no `preludeApproval`

#### Scenario: Unanswered approval is never answered by the runtime
- **WHEN** an approval request is outstanding and the owner does not call `respondApproval`, while the injected clock advances well past 60000ms and the generation is then retired or shut down
- **THEN** no `extension_ui_response` (neither `Approve`, `Deny` nor `cancelled`) is ever written for that id by the transport or runtime; retirement proceeds with the normal stdin→TERM→KILL contract

#### Scenario: Child crash or write failure
- **WHEN** a child crashes, is signalled, fails to spawn, or a command cannot be written
- **THEN** affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

### Requirement: 每会话生命周期
SessionRuntime SHALL lazily acquire one child generation on the first prompt, reuse it across completed turns, reset its injected-clock idle timer on every child frame and accepted prompt, and retire it on idle expiry or shutdown. The runtime SHALL track pending approvals of the current generation as a set keyed by approval id: `markPending(approvalId)` adds the id, `clearPending(approvalId)` removes it, marking an id already present or clearing an id not present SHALL be a no-op, and several ids MAY be pending at once. While the set is non-empty the idle timer SHALL be suspended; when the last pending id is cleared the timer SHALL be re-armed with the full idle duration from that moment. The set SHALL be discarded with its generation. Retirement SHALL close stdin, send SIGTERM if still alive after 5 seconds, and SIGKILL if still alive after a further 3 seconds. Tokens SHALL be issued per generation and revoked exactly once on native death or failed startup without a live child. Caller-provided persisted resumePath and later successful sessionFile SHALL be retained as the last-known-good path for --resume; failed startup SHALL preserve that path, and only startup with no known path SHALL retry cold. Interrupted active turns SHALL fail and report the original child exit once. Every native exit of a generation that obtained a live child — idle expiry, explicit shutdown/retirement (including supervisor-driven eviction), crash during or between turns — SHALL invoke the caller-provided `onExit` callback exactly once with the original code/signal, whether or not a turn was active; the callback SHALL run after the generation's token is revoked and SHALL NOT be invoked for a generation that never obtained a pid. Public shutdown SHALL be idempotent and prevent subsequent prompts.
Local-only completion (`server/src/sessions/omp/local-command.ts`, a pure decision over the dispatched text and the frames seen since dispatch, wired into the runtime's frame handler): a matching `agentInvoked:false` outcome (`response{command:"prompt",success:true,data:{agentInvoked:false}}` or `prompt_result{agentInvoked:false}` with the turn's request id) completes the turn immediately when the dispatched prompt text does not start with `/` (the pre-existing behaviour; after chat-sessions「Slash 命令白名单与命令目录」 only whitelisted commands reach the runtime with a leading `/`) or when at least one `command_output` frame has been seen since that prompt was written; when the text starts with `/` and none has been seen, the turn enters `awaiting-output` and completes at the first `command_output` frame or, failing that, when the injected clock has advanced `LOCAL_COMMAND_GRACE_MS` = 120000 ms since the outcome, whichever comes first. A matching `agentInvoked:true` outcome never completes a turn (the turn ends by agent_end as usual). Frames arriving during `awaiting-output` are pushed to the turn stream and reset the idle timer as usual; a terminal agent_end or a matching failure during the wait ends the turn by the ordinary rules; the grace timer SHALL be cancelled when the turn ends or the generation retires and SHALL never end a later turn. The rule keys on the leading `/` of the dispatched text only; it knows no command names. A `command_output` that arrives after the grace expired is handled like any frame of whatever turn is then active (dropped when none is): the host does not filter it, so a compaction slower than 120 s may append its completion text to the next turn's body — an accepted, documented residual.

#### Scenario: Lazy startup and normal reuse
- **WHEN** a runtime is constructed, then receives and completes two prompts
- **THEN** construction issues no token and spawns no process; both prompts run through one child and expose all ordered frames through the true terminal event

#### Scenario: Idle reset and restart
- **WHEN** child frames or a new prompt arrive before idle expires, then activity stops for the configured duration
- **THEN** each activity resets the deadline; expiry closes stdin and reclaims the child, revokes its token, and the next prompt spawns with a fresh token and the exact last successful sessionFile as --resume

#### Scenario: Pending approval suspends idle expiry
- **WHEN** an approval request is marked pending and the injected clock advances past the idle duration, then the approval is cleared
- **THEN** no retirement occurs while pending; after clearing, the child is retired only once the full idle duration elapses again without activity

#### Scenario: Several pending approvals suspend idle until the last is cleared
- **WHEN** approvals `a1` and `a2` are marked pending, `clearPending(a1)` is called twice, the injected clock advances past the idle duration, and then `clearPending(a2)` is called
- **THEN** no retirement occurs while `a2` is still pending (the repeated clear of `a1` does not re-arm the timer); after clearing `a2` the child is retired only once the full idle duration elapses again without activity

#### Scenario: Every exit reaches onExit once
- **WHEN** a generation exits through idle expiry, through shutdown, through an externally requested retirement between turns, or through a crash
- **THEN** `onExit` is invoked exactly once per generation with the actual code/signal in each case, after its token is revoked; a generation that never obtained a pid produces no `onExit` call

#### Scenario: Persisted resume in a new runtime
- **WHEN** a newly constructed runtime receives a previously persisted sessionFile from its caller, including after an unsuccessful first startup
- **THEN** its first and retry spawns use the exact --resume path until a new successful handshake replaces it; omitted/null initial path produces no --resume argument

#### Scenario: Bounded escalation
- **WHEN** a retiring child exits on EOF, waits for TERM, or ignores EOF and TERM
- **THEN** real process observation respectively proves no unnecessary signal, TERM at 5000ms, or KILL at 8000ms; no signal occurs before its deadline, early death cancels remaining escalation, and shutdown observes actual native exit without fabricating it

#### Scenario: Crash during a turn
- **WHEN** a child exits before a terminal prompt outcome
- **THEN** already received frames remain observable, the active iterator fails, the exit callback receives the original code/signal exactly once, the token is revoked and the next prompt resumes using the successful sessionFile

#### Scenario: Startup failure and shutdown race
- **WHEN** startup fails before a sessionFile is accepted or shutdown races delayed startup
- **THEN** no false successful session path is retained, every acquired child/token is reclaimed, no prompt is sent after shutdown, and cold retry is possible only on a runtime not explicitly shut down

#### Scenario: Prompt lifecycle signals
- **WHEN** an ACK, nonterminal agent_end, unrelated response, matching local-only outcome (for a prompt not starting with `/`, or one preceded by a `command_output`), or matching delayed failure arrives
- **THEN** ACK/nonterminal/unrelated frames do not end the turn; agent_end with isTerminal absent or true completes it, a matching agentInvoked=false completes local-only work immediately for a prompt whose text does not start with `/` and for one that follows at least one `command_output`, and a same-id failure after ACK fails the turn; events before ACK remain visible

#### Scenario: Local-only outcome waits for late command output
- **WHEN** the real fake (`slash`) answers `/todo` (output before the receipt) and, on another turn, `/compact` (receipt before the output), a prompt `hello` is answered by a bare `agentInvoked:false` receipt and a prompt `/x` by a `command_output` then an `agentInvoked:true` receipt then agent frames (both with hand-written frames on the wired fake child, as in the existing local-only tests; the `slash` fixture runs `hello` as a normal turn), and the real fake (`slash --compact-silent`) answers `/compact` with a receipt and no output
- **THEN** the `/todo` turn ends at the receipt with its `command_output` already in the stream; `hello` ends at the receipt as before; the `/compact` turn does not end at the receipt and ends exactly when `command_output{text:"Compaction complete."}` arrives, that frame being the last one exposed by the iterator; the `/x` turn ends only at its terminal agent_end; the silent turn ends when the injected clock advances 120000 ms after the receipt, no later, with no fabricated frame; a subsequent prompt on each runtime reuses the same child, and a cancelled grace timer (turn already ended or generation retired) never ends a later turn

#### Scenario: Concurrency and abandoned consumption
- **WHEN** prompts overlap or a consumer abandons an active iterator
- **THEN** overlap is rejected without a second command/child and abandonment reclaims the active generation instead of making it available for an overlapping turn

#### Scenario: Native death before pipe closure
- **WHEN** native exit precedes buffered terminal frames or stdout is held open
- **THEN** token revocation does not wait for pipe closure, valid buffered frames are drained before logical completion, and held pipes are reclaimed within the 8-second drain budget with unfinished work failed using the original exit

#### Scenario: Retired generation callbacks and transport errors
- **WHEN** old frame/exit/timer callbacks arrive after retirement, or transport failure interrupts an active turn
- **THEN** old callbacks cannot affect the new child, token or turn; transport failure is sanitized, fails the current turn and reclaims its generation rather than silently yielding success

### Requirement: Prompt dispatch receipt
SessionRuntime.prompt(text) SHALL retain its existing single AsyncIterable interface and additionally expose dispatched, a Promise resolving to the exact requestId and validated sessionFile after the prompt write succeeds following handshake. It SHALL NOT infer receipt from ACK, first event or turn completion. Existing consumers that only iterate SHALL preserve frame order, terminal/error delivery, cancellation and native-resource ownership without an unhandled rejection from the added Promise.
Pre-dispatch acquisition, write, cancellation or shutdown failure SHALL reject the receipt and terminate the iterable faithfully; a resolved receipt SHALL never be retroactively rejected by later turn failure. Buffered frames arriving before receipt SHALL remain available in order. The extracted stream SHALL be one canonical implementation and retain the existing bounded native retirement semantics.
prompt() SHALL preserve its existing synchronous closed/busy throws; a receipt exists only when an iterable has been returned. This addition SHALL NOT change existing runtime error sanitization.
#### Scenario: Exact request correlation with early frames
- WHEN a child sends lifecycle frames before its prompt ACK, and send completion is deliberately held
- THEN the iterable preserves those frames, dispatched remains pending until successful write completion, and its requestId equals the actual outbound prompt id rather than any observed response id
#### Scenario: Acquisition and write rejection
- WHEN spawn, handshake, stdin write or pre-dispatch cancellation/shutdown fails
- THEN dispatched rejects, no accepted receipt is fabricated, old iterator consumers observe their existing failure/cancellation behavior and no child/token is leaked
#### Scenario: Successful dispatch is not terminal completion
- WHEN the prompt is written successfully but the child remains in a nonterminal turn
- THEN dispatched resolves without waiting for agent_end, while the iterator remains active and later failure is observable there

### Requirement: Pid-less spawn failure retirement
A SessionRuntime generation whose child never obtained a pid SHALL be treated as having no live child from the moment spawn returns. Retiring such a generation (by shutdown, by the failed acquisition itself, or by cancellation; idle expiry cannot apply because the idle timer is armed only after a successful acquire), even when retirement starts before Node reports the spawn error, SHALL revoke its token exactly once and complete without waiting for any TERM/KILL grace and without awaiting a native exit, independent of whether the failed child ever reports `exitCode` or emits `'error'`. A child that obtained a pid SHALL keep the existing retirement contract even if it later emits `'error'` while still running; such an `'error'` SHALL NOT mark the generation as a failed spawn nor drop its child handle, so its held stdio is still reclaimed within the shutdown drain budget.

#### Scenario: Shutdown races a missing-binary spawn
- **WHEN** shutdown starts inside the spawn call of a missing-binary generation, before the spawn error tick
- **THEN** shutdown settles without advancing the injected clock, no timers remain pending, no signal is sent, the token is revoked exactly once and the prompt rejects with agent_unavailable

#### Scenario: Pid-less child that never reports failure
- **WHEN** spawn returns a pid-less child that never emits `'error'` and never sets `exitCode`
- **THEN** the failed acquisition's retirement and a later shutdown both settle at clock 0 with no pending timers

#### Scenario: Live child emitting error keeps the grace contract
- **WHEN** a child with a pid emits `'error'` while still running and the generation is retired
- **THEN** stdin is closed, SIGTERM is sent at 5000 ms and SIGKILL at 8000 ms unless the child actually exits first

#### Scenario: Live child error before exit keeps held-pipe reclaim
- **WHEN** a retiring child with a pid emits `'error'`, then exits natively before SIGTERM would be sent while its stdout stays open
- **THEN** no signal is sent, its stdout is destroyed exactly when the 8000 ms shutdown budget measured from retirement start elapses and not before, retirement settles only then, and the token is revoked exactly once

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`omp/commands.ts` SHALL 承载 `SessionRuntime` 的模块级辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助）以及 command/abort/pending 计时面，由 `omp/runtime.ts` 引用；它 SHALL 不新增未被引用的导出，且对 `runtime.ts` 只有类型导入。`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名与导入路径 SHALL 保持在 `runtime.ts`/`process.ts`。`omp/ui-requests.ts` SHALL 承载 `extension_ui_request` 的分类（审批请求或即时回绝）、审批 `title` 的工具名解析与 `extension_ui_response` 应答帧形状：它是无状态的纯函数模块，不持有传输状态、不写子进程 stdin，不导入 `./process.js`、`./runtime.js` 或 `./commands.js`；`OmpProcess` 仍是 `extension_ui_response` 的唯一写出者，由它决定是否与何时写出。`runtime.ts` 与 `commands.ts` 对 `./ui-requests.js` SHALL 至多有语句级 `import type`（不得有值导入、副作用导入、动态导入，也不得 re-export 其中的符号），审批请求的类型可由此引入，应答帧的构造与写出不得出现在这两个文件中。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`runtime.ts` 从 `./commands.js` 引用上述辅助而 `commands.ts` 对 `./runtime.js` 只有 `import type`，runtime/process 测试全绿

#### Scenario: UI 请求分类模块边界
- **WHEN** 运行 `knip`、`bash scripts/size-guard.sh`，并检查 `server/src/sessions/omp/` 的导入方向与 `extension_ui_response` 写出点
- **THEN** `process.ts` 从 `./ui-requests.js` 引用分类、工具名解析与应答帧形状；`ui-requests.ts` 不导入 `./process.js`、`./runtime.js`、`./commands.js`；`server/src/sessions/omp/` 中只有 `process.ts` 向子进程 stdin 写出 `extension_ui_response`；size-guard 退出 0，knip 无未引用导出

#### Scenario: 运行时对 UI 请求模块只有类型依赖
- **WHEN** 检查 `server/src/sessions/omp/runtime.ts` 与 `commands.ts` 中引用 `./ui-requests.js` 的全部语句
- **THEN** 每一条都是语句级 `import type`，不存在值导入、副作用导入、动态导入或 re-export；两个文件都不含 `extension_ui_response` 字面量，也不引用应答帧构造函数

### Requirement: 审批请求经 SessionRuntime 转接
SessionRuntime SHALL accept an optional synchronous constructor callback `onApproval(request)` and SHALL forward to it, synchronously and unchanged, each approval request (`{id, title, tool}`, see 「RPC IO and child observation」) surfaced by the `OmpProcess` of a generation, but only when that generation is still the runtime's current generation and a prompt turn whose `prompt` frame has been written is active on that generation — the same generation/turn gate that decides whether a child frame joins the active turn. An approval request surfaced by a generation that is no longer current, or arriving while no such turn is active on the current generation (between turns, or before the turn's `prompt` frame is written), SHALL be dropped: it is not forwarded and not answered, and it simply ends with that child like any unanswered approval. Forwarding SHALL NOT mark the approval pending and SHALL NOT affect the idle timer by itself; `markPending`/`clearPending` remain explicit owner calls. SessionRuntime SHALL expose `respondApproval(id, decision)` that passes the owner's `allow`/`deny` answer unchanged to the current generation's `OmpProcess.respondApproval`, and SHALL be a no-op — no frame, no throw, no spawn — when the runtime has no current generation (before the first acquisition, after retirement, after shutdown) or when the current generation's `OmpProcess` no longer accepts input (for example while it is retiring). SessionRuntime SHALL NOT answer an approval request on its own and SHALL NOT write `extension_ui_response` itself; `OmpProcess` remains its only writer.

#### Scenario: Approval requests reach the owner only from the active turn of the current generation
- **WHEN** the real fake `approval` scenario, spawned with `--approval-mode write`, surfaces select `r1` during an active prompt turn of the current generation, and separately an approval-shaped select is surfaced between turns, before the turn's `prompt` frame is written, or by a generation that is no longer current
- **THEN** `onApproval` is called exactly once with `{id:"r1", title, tool:"bash"}` carrying the original title; the other requests are never forwarded and no `extension_ui_response` is written for them

#### Scenario: respondApproval passes through to the current generation
- **WHEN** the owner calls `respondApproval("r1","allow")` on the runtime for the forwarded request, then calls it again, and separately calls it before any generation exists, while the generation is retiring and after shutdown
- **THEN** exactly one `extension_ui_response{id:"r1",value:"Approve"}` reaches the child, which proceeds to finish the tool call and the turn; every other call writes nothing, throws nothing and spawns no child

#### Scenario: Forwarding alone does not suspend idle expiry
- **WHEN** an approval request is forwarded and the owner does not call `markPending`, and the injected clock then advances by the idle duration
- **THEN** the generation is retired on idle expiry as usual, no answer is written for the outstanding approval, and `onExit` reports the child's actual exit once

### Requirement: 相关命令 API 与回合中断
SessionRuntime SHALL 暴露两类经 `OmpProcess.request` 的相关（correlated）命令 API，均以独立 id 发送并只被 id 与 command 同时匹配的 `response` 结算（沿用「Correlated responses」规则）。
`abort()` SHALL 仅在存在活跃回合（该回合的 `prompt` 帧已成功写出，即自其派发回执 `dispatched`（见「Prompt dispatch receipt」）可兑现之时起）时返回 abort response 的 Promise，并且 SHALL 只在该回合**已开始**之后写出 `{type:"abort",id}`。「已开始」指该回合的 iterator 已收到 `agent_start`，或已收到该 prompt 报告本地完成结果的帧（`response{command:"prompt"}` 的 `data.agentInvoked===false` 或 `prompt_result{agentInvoked:false}`，与本地完成等待同一判定）。原因：真 omp v18.0.10 在回合开始前收到的 `abort` 会让仍在预处理的 prompt 静默放弃，两个 response 都为 success，此后没有该回合的任何帧，用户条目也不写入会话历史。回合已开始时调用 SHALL 立即写出该帧。派发回执已兑现而回合未开始时调用 SHALL 此刻不写帧，返回一个推迟的 Promise：在该回合开始时（处理使其开始的那一帧的同一同步段内）写出恰一帧 `abort`，并以其 response 结算；如果使其开始的帧同时结束了该回合（本地完成且无需再等待输出），SHALL 不写帧并以 `AgentUnavailableError` 拒绝；回合在开始前结束（terminal `agent_end`）、失败、其 iterator 被取消（`return()`），或其 generation 退役、子进程退出时，该 Promise SHALL 以 `AgentUnavailableError` 拒绝且不写帧；在使其开始的帧上写出之前 SHALL 重新核对同一 generation、未在退役、子进程存活，任一不满足同样拒绝。回合开始前对同一回合再次调用 `abort()` SHALL 返回同一个推迟的 Promise，不另登记、不多写帧；回合已开始后的再次调用照常各写一帧（owner 的停止去重保证至多一次，见 turn-control）。此外，没有活跃回合、`prompt` 已被调用但其帧尚未写出（仍在获取/握手）、没有存活子进程、或该回合所在 generation 正在退役时 SHALL 不写任何帧并返回 `false`，不抛错，且不影响那次仍在进行的 `prompt` 调用（其获取、握手与派发照常继续）。在该 prompt 派发回执兑现之前取得的 `false` 对 owner 的语义是"尚无已派发的回合"：owner 据此登记停止意图，并在其等待中的该 prompt 派发回执兑现后再次调用 `abort()`——此时回合已活跃，该调用 SHALL 返回 abort response 的 Promise，`abort` 帧按上文规则在该回合已开始后写出（turn-control 停止生成 REST）；owner 不得把这种 `false` 当作失败或等待崩溃路径。在派发回执已兑现之后取得的 `false`（子进程已死或 generation 正在退役）表示该回合正经失败路径收尾：owner SHALL 丢弃其停止意图，不再重试 `abort()`。runtime 不为停止意图新增任何接口。`abort` 的 response（`command:"abort"`）SHALL 只结算 abort 请求，不得结束或失败当前 prompt 的 iterator；回合是否结束仍由随后的 `agent_end` 决定。
`command(frame)` SHALL 接受 `get_branch_messages`、`branch{entryId}` 与 `get_state` 三种帧：若当前存在活跃回合 SHALL 同步抛出 `SessionBusyError` 而不写帧；若没有存活子进程 SHALL 经与 `prompt` 相同的惰性获取路径（同一 spawn 契约、握手、token、`--resume` 最后已知路径）先获取一个 generation，再发送该帧——这与 `prompt` 触发的获取是**同一种**获取：SHALL 恰调用一次 owner 提供的 `tokens.issue`，与 prompt 获取对 owner 的上报完全一致（会话进程的 owner 借此递增 `stream_epoch` 并建立该 generation 的 ring；fork 临时进程的 owner 接入不递增 epoch 的 token 适配器，runtime 契约不变）；随后在同一 generation 上的 `command`/`prompt` SHALL 复用它而不再次调用 `issue`；返回匹配 response 的 `data`。匹配 response 的 `success` 不为 `true`（例如 `branch` 的未知 `entryId`）时 SHALL 以 `AgentUnavailableError` 拒绝，且不因此回收 generation（是否 retire 由 owner 决定）。`branch` 成功后 `command({type:"get_state"})` 返回的 `sessionFile` SHALL 被视为新的 last-known-good path 供后续 `--resume`。`command` 期间 SHALL 视为活动：重置空闲计时器，且与 `prompt` 互斥（进行中的 `command` 使并发 `prompt`/`command` 抛 `SessionBusyError`）。子进程在 `command` 未结算前退出 SHALL 使该 Promise 以 `AgentUnavailableError` 拒绝并按既有路径回收 generation。`command` 在途时子进程产生协议错误（畸形行、超限行、非法 chunk 元数据）SHALL 与回合内同类错误一样回收该 generation，使该 Promise 以 `AgentUnavailableError` 拒绝，不等待空闲回收。runtime 已 `shutdown` 后调用 `command` SHALL 与 `prompt` 一样同步抛出 `AgentUnavailableError`，不写帧、不 spawn。

#### Scenario: abort during a turn ends the turn as aborted
- **WHEN** a prompt is active on the real fake (`abort-ok`) and `abort()` is called
- **THEN** exactly one `{type:"abort",id}` frame is written, the iterator then observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}` (which the child sends after `agent_end`, so it is not an iterator frame), and a following prompt on the same generation is accepted without a new spawn

#### Scenario: abort without an active turn is a no-op
- **WHEN** `abort()` is called on a runtime with no active turn, before any spawn or between turns
- **THEN** nothing is written to the child, no child is spawned and the call returns `false`

#### Scenario: Branch command family outside a turn
- **WHEN** an idle runtime with a persisted sessionFile receives `command(get_branch_messages)`, then `command(branch{entryId})`, then `command(get_state)` against the real fake (`branch`)
- **THEN** the child is acquired with `--resume <persisted file>`, each call resolves with the matching response data, `get_state` returns the new file created by branch, and that file becomes the `--resume` path of the next acquisition

#### Scenario: abort right after the dispatch receipt
- **WHEN** `prompt()` has been called on a runtime whose real fake is `slow-ready` (delayed `ready`, then `abort-ok` behaviour), `abort()` is called before `dispatched` resolves, and the owner calls `abort()` again as soon as `dispatched` resolves
- **THEN** the first `abort()` returns `false` and writes nothing, while the pending prompt still acquires, handshakes and writes its `prompt` frame; the second call writes exactly one `{type:"abort",id}` frame, after the `prompt` frame and not before the turn's `agent_start` has reached the runtime; the iterator observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation is accepted without a new spawn or a second `issue`

#### Scenario: abort response alone does not end the turn
- **WHEN** a turn has a resolved dispatch receipt but is still waiting for a late `command_output` (real fake `slash --compact-silent`, prompt `/compact`), `abort()` is called and the child answers only `response{command:"abort"}`
- **THEN** exactly one `abort` frame is written, the abort Promise resolves with that response, the response reaches the iterator as an ordinary frame of the still-active turn without ending it, and the turn still ends only when the local-command grace elapses on the injected clock; a following prompt reuses the same child

#### Scenario: Command acquisition reports the generation like prompt
- **WHEN** a runtime with no live child receives `command(get_branch_messages)` and then a `prompt` on the same generation
- **THEN** the owner's `tokens.issue` is called exactly once, before the command frame is written, exactly as for a prompt-triggered acquisition; the following prompt reuses that generation without another `issue` or spawn

#### Scenario: Command during a turn or after child death
- **WHEN** `command(get_branch_messages)` is called while a prompt is active, or the child exits before the command response arrives
- **THEN** the in-turn call throws `SessionBusyError` synchronously without writing a frame; the interrupted call rejects with `AgentUnavailableError`, the generation is reclaimed and its token revoked exactly once

#### Scenario: Command failure response and closed runtime
- **WHEN** `command(branch{entryId})` names an entry the real fake (`branch`) does not know, and separately `command` is called after `shutdown()`
- **THEN** the first rejects with `AgentUnavailableError` while the generation stays current and the next `command` on it resolves without a new spawn or `issue`; the call after shutdown throws `AgentUnavailableError` synchronously, writes nothing and spawns no child

#### Scenario: abort before the turn starts is deferred to agent_start
- **WHEN** a runtime runs the real fake `abort-ok --start-delay-ms 200` (the held turn opens 200ms after the prompt ack) and `abort()` is called as soon as `dispatched` resolves; separately `slow-ready --ready-delay-ms 300 --start-delay-ms 200` where the first `abort()` precedes the receipt and a second follows it
- **THEN** the call after the receipt returns a Promise and no `abort` frame is written until the turn's `agent_start` reaches the runtime; then exactly one `abort` frame is written after the `prompt` frame, the iterator observes `agent_start`, the two deltas, `message_end{stopReason:"aborted"}` and terminal `agent_end`, the Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation completes without a new spawn

#### Scenario: deferred abort is rejected when the turn never starts
- **WHEN** `abort()` is deferred after the receipt and the turn then ends without starting: the real fake `crash` exits after its prompt ack, or the real fake `slash` answers `/todo` with its output and a local completion response that ends the turn
- **THEN** no `abort` frame is written; the Promise rejects with `AgentUnavailableError`; the iterator ends through its existing failure or completion path; after `/todo` the next prompt reuses the same child

#### Scenario: local completion that awaits output opens the deferred abort
- **WHEN** `abort()` is deferred after the receipt of `/compact` on the real fake `slash --compact-silent`, and the local completion response arrives while the turn keeps waiting for a late `command_output`
- **THEN** exactly one `abort` frame is written as that response is processed, the Promise resolves with the abort response, and the turn still ends only when the local-command grace elapses on the injected clock

### Requirement: 握手超时可观测
SessionRuntime SHALL 接受可选同步 `log` 端口（supervisor 经 `sessionRuntimeOpts` 传入；未传则丢弃）。当一次 acquisition 因握手 deadline 到期而失败（`AgentUnavailableError` 原因为 `handshake timeout`）时，runtime SHALL 在该错误向调用方传播之前恰调用一次 `log({event:"omp_handshake_timeout", sessionId, reason:"handshake timeout", elapsedMs})`：`sessionId` 为该 runtime 的会话 id，`elapsedMs` 为自进入该次 acquisition（含排队等待许可）至握手 deadline 失败被 runtime 捕获（在退役该 generation 之前）的整数毫秒，取与握手 deadline 相同的真实单调时间源（不取注入时钟）。其它启动失败（spawn 失败、negotiate/get_state 失败、子进程提前退出、关停取消）SHALL 不产生记录。`log` 抛出或返回 thenable SHALL 被吞掉，原错误照常传播，调用方仍得到 502 `agent_unavailable`。

#### Scenario: 握手超时写一条记录
- **WHEN** fake-omp `no-ready` 子进程使一次 prompt 的握手在 `handshakeTimeoutMs` 后超时
- **THEN** REST prompt 返回 502 `agent_unavailable`；`log` 恰收到一条记录，键集合恰为 `event`、`sessionId`、`reason`、`elapsedMs`，`sessionId` 为该会话 id，`elapsedMs ≥ handshakeTimeoutMs`

#### Scenario: 非超时的启动失败不记录
- **WHEN** `OMP_BIN` 指向不存在的路径使 spawn 报 `ENOENT`，或 `log` 端口自身抛出
- **THEN** 前者 `log` 未被调用；后者 REST 仍返回 502 `agent_unavailable` 且无未处理异常

### Requirement: OMP_STATE_DIR 托管布局
宿主 SHALL 把 `OMP_STATE_DIR`（下称 `<state>`）分成「托管配置」（app 持有、omp uid 只读）与「omp 运行期状态」（omp uid 可写）两部分，目录与权限位（`mode & 0o7777`）精确如下，全部由 app uid 持有：

| 路径 | mode | 用途 |
| --- | --- | --- |
| `<state>` | `2750` | 根；omp uid 只能进入，不能在其下创建/改名/删除条目 |
| `<state>/home` | `3770` | omp 的 `HOME`；omp uid 可创建自己的条目（工具链缓存等），粘滞位使它不能改名或删除 app 持有的 `.omp` |
| `<state>/home/.env` | `0640`（普通文件） | omp 启动时加载 `$HOME/.env`；由宿主预建（空文件）并持有，粘滞位使 omp uid 不能替换它，见「工作目录 dotenv 钉住」 |
| `<state>/home/.omp`、`<state>/home/.omp/agent` | `2750` | 托管配置：`models.yml`（`0640`）与运维安装的 `skills/` 位于 agent 目录 |
| `<state>/xdg`、`<state>/xdg/data`、`<state>/xdg/state`、`<state>/xdg/cache` | `2750` | XDG 根 |
| `<state>/xdg/data/omp`、`<state>/xdg/state/omp`、`<state>/xdg/cache/omp` | `2770` | omp 运行期状态（`agent.db`、日志、原生模块缓存等）；omp 只在该目录已存在时才启用对应的 XDG 重定向，因此三者 SHALL 由宿主预先建出 |
| `<state>/sessions` | `2750` | 会话目录的父目录 |
| `<state>/sessions/<ownerId>` | `2770` | `--session-dir`，spawn 时按需建立 |
| `<state>/trash` | `0700` | app 私有：会话删除先把产物目录移到这里再递归删除（session-metadata「会话删除」），临时空间目录的删除同样经它中转（temporary-workspaces「临时空间目录的删除」）；omp uid 不能进入 |
| `<state>/snapshots` | `0700` | app 私有：每个回合开始前的工作空间快照（workspace-snapshots「快照的存放位置」）；omp uid 不能进入、列举或改写 |

这些路径 SHALL 只有一个来源：`server/src/sessions/omp/` 下的一个模块导出 `ompTrashDir(stateDir)`、`ompSnapshotsDir(stateDir)`（= `<state>/snapshots`）、`ompHome(stateDir)`、`ompAgentDir(stateDir)`（= `<state>/home/.omp/agent`）、`ompXdgHome(stateDir, "data"|"state"|"cache")`、`ompSessionDir(stateDir, ownerId)` 与 `ensureOmpStateLayout(stateDir)`；`server.ts`、`createApp`、spawn 与会话删除 SHALL 经它们取路径，不得再拼 `join(stateDir, "agent")` 一类的字面量。旧布局的 `<state>/agent` SHALL 不再被读写（遗留目录原样留在磁盘，宿主不迁移也不删除）。

`ensureOmpStateLayout(stateDir)` SHALL 先在 `<state>` 缺失时以递归 `mkdir` 建出它及缺失的父级（不改父级权限位），再取 `<state>` 的内核 realpath（`OMP_STATE_DIR` 自身可以是运维放置的、指向目录的符号链接——既有部署形态，会话删除按同一 realpath 校验），然后对表中除 `sessions/<ownerId>` 之外的每个目录、以解析后的根为基、按父先于子的顺序调用 sandbox-core「托管目录权限位」的 `ensureOwnedDir(path, mode)`；根以下的各级不得是符号链接。`<state>/home` 缺失时 SHALL 先以不对组开放的权限位建出，待 `home/.omp` 与 `home/.omp/agent` 建好之后才校正为 `3770`——否则冷建期间一个残留的 omp uid 进程可以抢先建出 `home/.omp`，使布局因归属不符而失败；`ensureOwnedDir` 新建目录时 SHALL 直接以目标 mode 的权限位创建（不经过一个更宽的中间状态）。argv 与环境里的路径仍用配置值（未解析）拼出，与此前一致。它 SHALL 在两处被调用：服务启动时写托管 `models.yml` 之前，以及每次 `spawnOmp` 准备目录时（随后对 `sessions/<ownerId>` 以 `2770` 调同一 `ensureOwnedDir`）；因此被外部改宽的权限位在下一次 spawn 前被校正，而不属于 app uid 的目录、符号链接或非目录条目使启动失败（既有 generic `server_start_failed` 路径）或使该次 spawn 以「Directory preparation failure」失败，绝不被跟随或沿用。宿主 SHALL NOT chown、不改进程 umask；组归属由部署经 setgid 继承（ADR-0010）。同 uid 部署（`OMP_USER` 缺席）使用同一布局与同一权限位。

部署前提（ADR-0010，宿主不检查）：`<state>` 的父目录不得对 omp uid 可写（否则 `<state>` 可被整体改名替换）；`skills/` 及其内容由运维以 app uid（或 root）安装且不对 omp uid 可写。

#### Scenario: 冷布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout` 后再对 owner `u1` spawn
- **THEN** 表中每个目录存在、由本进程 uid 持有且 `mode & 0o7777` 精确等于表值；再次调用不改变任何 mode、不抛错

#### Scenario: 被改宽的目录被校正
- **WHEN** `<state>`、`<state>/home/.omp/agent` 与 `<state>/sessions` 被预先 `chmod 2770`、`<state>/home` 被 `chmod 2770`（无粘滞位）后调 `ensureOmpStateLayout`
- **THEN** 四者回到表值

#### Scenario: 被占位的路径不被跟随
- **WHEN** 根以下的 `<state>/home/.omp` 是指向别处目录的符号链接，或 `<state>/xdg` 是普通文件，或 `<state>/sessions/u1` 是符号链接
- **THEN** `ensureOmpStateLayout`（前两者）/ spawn 的目录准备（第三者）抛错，链接目标的 mode 与内容不变，不 spawn 任何子进程

#### Scenario: 状态根是符号链接
- **WHEN** `OMP_STATE_DIR` 是指向一个既有目录 `D` 的符号链接，服务启动并 spawn
- **THEN** 布局建立在 `D` 之下且 `D` 的 mode 为 `2750`，启动与 spawn 成功，`HOME` 与 `--session-dir` 仍以配置路径（经链接）给出

#### Scenario: 遗留 agent 目录被忽略
- **WHEN** `<state>/agent/models.yml` 与 `<state>/agent/skills/x/SKILL.md` 存在（旧布局），服务启动并 spawn
- **THEN** 托管 `models.yml` 写在 `<state>/home/.omp/agent/`，命令目录不含 `skill:x`，`<state>/agent` 下的文件字节与 mode 不变

#### Scenario: 冷建时 home 在 .omp 就位前不对组开放
- **WHEN** 对不存在的 `<state>` 调 `ensureOmpStateLayout`，并在 `home/.omp` 被创建的那一刻观测 `<state>/home` 的 mode
- **THEN** 此刻 `home` 的组与 other 权限位全为 0；调用返回后 `home` 为 `3770`、`trash` 为 `0700`

#### Scenario: 快照目录属于布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout`；另一次 `<state>/snapshots` 被预先 `chmod 0770`；再一次它是指向别处目录的符号链接
- **THEN** 第一种 `<state>/snapshots` 存在、由本进程 uid 持有且 `mode & 0o7777` 为 `0o700`；第二种被校正回 `0o700`；第三种 `ensureOmpStateLayout` 抛错且链接目标的 mode 与内容不变

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

各键的作用（真实 omp v18.12.3 实测；本机实测两个版本都接受这一份文件、启动日志无 settings 警告）：`tools.approval: null` 整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具；数组 `[]` 在 v18.12.3 被 record 类型校验丢弃、回落默认 `{}` 并每次启动写一条 `Settings: ignoring invalid value` 警告——项目值同样没有复活，但语义靠校验失败兜底；`null` 在深合并里走替换分支、被当作未设置而回落默认，两个版本都无警告，v18.0.10 上官方用例 (c) 实测项目层 `{write: allow}` 仍弹卡）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与 `python.interpreter: ""` 使项目层不能指定被宿主执行的可执行文件（v18.0.10 上 `ruby.interpreter` / `julia.interpreter` 同理——项目层指定的解释器在 spawn 预检时被执行、不经审批，O/tools/index.ts:554-570，Ruby 实测、Julia 同路径——所以两键保留到翻转；v18.12.3 的 eval 后端只剩 py 与 js、两键已不存在，翻转时删掉，v18.12.3 对这两行静默忽略、无警告（组 1a 实测），宿主彼时也不跑它）；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）；`images.urls.enabled: false` 关掉图片发布 broker——项目层把它打开后，会话创建时的 prewarm 会按项目给的参数拉起 `ssh`/`cloudflared` 等外部进程，`images.urls.command` 则被直接执行；这一组的效果是读源码得出的，omp 接受该取值已实测。`retry:` 段把 omp 的会话级自动重试封顶为一轮（owner 2026-10-13，#909）：传输层与 provider 层的重试是硬编码，一轮约 12 次上游请求（v18.0.10 实测），缺省 10 次会话级重试时一次 5xx 回合数分钟才失败；`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 缺省值，写出来是为了让项目层改不动重试的时长；`modelFallback: false` 关闭 omp 的模型兜底（缺省 `true`）——否则项目层一条 `retry.fallbackChains` 就能在重试预算用尽时换模型并重置预算，对不可重试的错误（含模型代理的 424）也会换模型重放；这与「多上游切换不在范围内」（owner 2026-10-06）一致。`telemetry.otlpExportEnabled: false` 关掉 OTLP 导出（缺省 `true`，需 `OTEL_*` 端点才真正导出，而工作目录 `.env` 可以注入它们）；`archive.enabled: false` 关掉 `archive` prelude（read 档、不请求审批，读 omp 的 `sessions` 目录——与宿主的 `--session-dir` 不重叠，纯卫生）；`disabledProviders` 关掉对 `ollama`（11434）、`llama.cpp`（8080）、`lm-studio`（1234）本地端口的隐式探测与 macOS 上的 `apple` 提供者，不影响托管 `models.yml` 的 `workbuddy` provider。`ask.enabled: false` 使 omp 不创建 `ask` 工具：该工具只在有 UI（`--mode rpc-ui`）时创建，plain `rpc` 下模型本就看不到它；宿主对它的提问帧只会 cancel，而 `ask` 被取消时先中止整个 agent 回合再抛错（v18.12.3 `tools/ask.ts:785-786,909-911`、`session/session-tools.ts:402`），用户会看到回答无故「已停止」——钉掉它使 `rpc-ui` 下的工具集与 `rpc` 下相同（两个版本都有该键；本机实测两者带此键启动无 settings 警告）。`ida.enabled: false` 使 v18.12.3 不挂载 `ida` 工具：缺省 `true`，项目层 `.omp/config.yml` 可设 `ida.installDir`（任意含 `libidalib.*` 的目录）与 `ida.python: ./x.sh`，之后 `read`（任何档位都不经审批）读到带可执行头的文件就会以项目层指定的解释器起进程（PR #1573 安全座席 P1，Epic (f) 缺省方案）；v18.0.10 没有该键、静默忽略；真实 omp 证据（组 6 实跑）：`ida` 是 discoverable 工具、从不进 `get_state.dumpTools`，只在找到 IDA 安装时以 `xd://ida` 设备出现在系统提示里——项目层写 `ida.enabled: true` 与 `ida.installDir`（含一个 `libidalib.*` 文件即被认作安装）时，带 overlay 的系统提示没有 `ida` 设备，去掉 `ida:` 块时有。`advisor.enabled: false`：v18.12.3 的缺省是 `false`（`advisor/settings.ts:12-16` 另有 `protocolDefault: ["rpc","acp"]`），但任何一层配置都压过缺省（`main.ts:261-268`），项目层 `.omp/config.yml` 写 `advisor.enabled: true` 即开启；开启后 `WATCHDOG.md/.yml` 的上溯以 `vcs.repo(cwd)?.root() ?? home` 为界，原生发现要求 `.git/HEAD`、空 `.git` 标记被跳过，会走到文件系统根（PR #1579 安全座席预警 (1)）——与 `ask` / `ida` 同类，零成本钉住；真实 omp 证据（组 6 实跑）：该设置没有 RPC 读回，只能看行为——项目层写 `advisor.enabled: true` 与 `modelRoles.advisor` 时，带 overlay 一个 bash 回合 2 次上游请求、只有 `advisor_cost_changed` 帧，去掉 `advisor:` 块时 5 次并出现 `advisor_yielded`。`tools.approvalMode: write` 的优先级低于 argv：omp 在启动段把 `--approval-mode` 的取值经 `settings.override("tools.approvalMode", …)` 写入高于 overlay 的运行期覆盖层，所以会话的有效档位为 `always-ask` 或 `yolo` 时生效的是 argv 的值，overlay 的这一行只在 argv 缺席时才起作用（argv 恒在，见「子进程 spawn 契约」），作为 `write` 的兜底保留。overlay 的内容 SHALL NOT 随会话、档位或模型变化：全部会话、全部档位共用同一份文件，字节只由上述部署配置决定。其余各键在三个档位下的作用相同——`always-ask` 下项目层的逐工具放行与 bash 放行规则同样被清掉；`yolo` 下工具本来就不因档位请求审批，项目层无从再放宽，而项目层自己写的收紧规则照旧被清掉（ADR-0012 已登记的残余）。「argv 压过 overlay」这一点由 session-permission-tier「档位与 omp 审批模式」的真实 omp 场景钉住。overlay 不做 schema 校验，上述取值依赖 v18.12.3 的消费代码：升级 omp 时 SHALL 重新验证。

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

### Requirement: 工作目录 dotenv 钉住
官方 omp 二进制在启动时依次读取 `<cwd>/.env`、`<agent 目录>/.env`、`$HOME/.omp/.env`、`$HOME/.env`，把其中宿主环境里**没有或为空**的变量写入自己的环境（`OMP_X` 在同一文件内镜像为 `PI_X`；`resource/oh-my-pi/packages/utils/src/env.ts:228-247`，官方 v18.0.10 二进制实测）。cwd 是 agent 无需审批即可写的目录，`<state>/home` 对 omp uid 可写，因此未加处理时一份 `.env` 就能把 agent 目录改到 agent 可写的位置（`PI_CODING_AGENT_DIR`，实测 `agent.db` 落到该目录）或让该目录的 spawn 持续失败（`PI_CONFIG_FILES` 指向不存在的文件）。宿主 SHALL：

1. 在 spawn 环境里显式设置决定 omp 从哪里读托管配置的五个变量——`PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`（「子进程 spawn 契约」）——使任何 `.env` 都不能改写它们。后三个是必须的：`PI_CONFIG_DIR` 改变配置根后，显式的 agent 目录不再等于默认值，XDG 重定向关闭（实测：`agent.db` 写回 agent 目录，sudo 模式下即 spawn 失败），与 profile 变量合用时配置根可被移到 cwd 之下（实测：`<cwd>/evil` 下出现 omp 的运行目录）；named profile 生效时 omp 丢弃 agent 目录覆盖并改写 `PI_CODING_AGENT_DIR`（`utils/src/dirs.ts:320,541-544`）。`PI_CONFIG_FILES` 以 `:` 分隔多个文件，故 `ensureOmpStateLayout` SHALL 在 `OMP_STATE_DIR` 含 `:` 时抛错（启动失败，而不是每次 spawn 都因 overlay 找不到而 502）；
2. 在托管布局里预建并持有 `<state>/home/.env`（「OMP_STATE_DIR 托管布局」；sandbox-core「托管文件权限位」的 `ensureOwnedFile`）：缺失时建为空文件，已存在时要求它是 app uid 持有的普通文件并把 mode 校正为 `0640`，其内容不由宿主管理（运维可在其中为 omp 放环境变量）；`<state>/home` 冷建时它 SHALL 在 `home` 对组开放之前建出。它是符号链接、非普通文件或不属于 app uid 时布局失败（与目录同一失败路径）。`<agent 目录>/.env` 与 `$HOME/.omp/.env` 位于 omp uid 不可写的托管目录内，无需预建。

本要求不覆盖的（登记于 ADR-0012）：`<cwd>/.env` 里其它未被宿主设置的 `PI_*`/`OMP_*` 变量仍会生效；宿主不读取、不改写、不拒绝工作目录里的 `.env`（它可能是用户项目的一部分）。

#### Scenario: 托管配置位置不可被 dotenv 改写（真实 omp）
- **WHEN** cwd 下的 `.env` 含 `PI_CODING_AGENT_DIR=<cwd>/evil2`、`PI_CONFIG_FILES=/nonexistent.yml`、`OMP_CONFIG_FILES=/nonexistent2.yml`、`PI_CONFIG_DIR=../<cwd 相对 HOME 的路径>/evil`、`OMP_PROFILE=p`、`PI_PROFILE=q`，随后 spawn 并完成一个回合
- **THEN** 回合 done；cwd 下除 `.env` 外没有 omp 新建的条目，`<state>/home` 下没有新的配置根，`agent.db` 仍在 `<state>/xdg/data/omp`
- **WHEN** 去掉 spawn 环境里的 `PI_CONFIG_FILES`（负向对照）
- **THEN** spawn 失败（omp 以 `Config overlay not found` 退出，宿主呈现 502）
- **WHEN** 只去掉 `PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`（负向对照）
- **THEN** `<cwd>/evil` 下出现 omp 写出的条目，或 `agent.db` 不在 `<state>/xdg/data/omp`

#### Scenario: 状态目录路径含冒号
- **WHEN** `OMP_STATE_DIR` 的路径含 `:`
- **THEN** `ensureOmpStateLayout` 抛错，不创建任何目录

#### Scenario: home/.env 由宿主持有
- **WHEN** 对不存在的 `<state>` 调 `ensureOmpStateLayout`
- **THEN** `<state>/home/.env` 是本进程 uid 持有的空普通文件、mode `0640`，且它在 `home` 的组权限位仍为 0 时已经存在
- **WHEN** 它已存在且内容非空、mode 为 `0666`
- **THEN** 调用后内容字节不变、mode 为 `0640`
- **WHEN** 它是符号链接或目录
- **THEN** 布局抛错，链接目标不变，不 spawn

### Requirement: 模型与推理强度命令
在「相关命令 API 与回合中断」所列的三种帧之外，`SessionRuntime.command(frame)` SHALL 另外接受 `{type:"set_model", provider:string, modelId:string}` 与 `{type:"set_thinking_level", level:string}` 两种帧；它们遵守该条对 `command` 的全部既有规则：以独立 id 发送，只被 id 与 command 同时匹配的 `response` 结算；存在活跃回合或另一条 `command` 在途时同步抛出 `SessionBusyError` 而不写帧；没有存活子进程时经与 `prompt` 相同的惰性获取路径先取得一个 generation（恰一次 `tokens.issue`），其后同一 generation 上的 `command` / `prompt` 复用它；匹配 response 的 `success` 不为 `true`（例如 omp 应答 `Model not found: …`）时以 `AgentUnavailableError` 拒绝且不因此回收 generation；`command` 期间视为活动并重置空闲计时器；子进程在结算前退出或产生协议错误时以 `AgentUnavailableError` 拒绝并按既有路径回收；runtime 已 `shutdown` 后调用同步抛出 `AgentUnavailableError`。
runtime SHALL 把这两种帧原样写出（除补上 `id`），SHALL NOT 校验 `provider`、`modelId` 或 `level` 的取值，SHALL NOT 记住或自动重发它们：何时发、发什么由 owner 决定（chat-sessions「派发前按会话设置对齐进程」）。`set_model` 成功的 response 数据是 omp 报告的模型对象，`set_thinking_level` 成功的 response 没有数据；`command` 的返回值分别是该数据与 `undefined`。这两种帧 SHALL NOT 改变 runtime 记录的 last-known-good 会话文件路径。
依据（官方 v18.0.10 二进制内的打包源码，未经宿主校验）：`set_model` 在 omp 的可用模型里按 `provider` 与 `id` 精确查找，找到后切换；`set_thinking_level` 在 RPC 层不校验 `level`。打包源码读起来 `set_model` 会把推理强度重置为该模型的缺省，实机核对看到的却是强度被带了过去（`off` 仍是 `off`），omp 是否在某些情形下重置未判定（design「实机核对结果」）。owner 发送时 SHALL 先 `set_model` 后 `set_thinking_level`：这一次序在两种情形下都无害，并使每个 generation 上的强度都是显式设置的。

#### Scenario: 回合之间设置模型与强度
- **WHEN** 一个空闲 runtime（真实假 omp）依次收到 `command({type:"set_model",provider:"workbuddy",modelId:"m3"})`、`command({type:"set_thinking_level",level:"low"})`，随后一条 prompt 与一条 probe prompt
- **THEN** 第一次 `command` 触发恰一次获取（一次 `issue`），两次调用各写出恰一帧并以匹配的 response 结算，随后的 prompt 复用同一 generation、没有第二次 spawn；probe 的 `frames=` 为 `negotiate_protocol,get_state,set_model,set_thinking_level,prompt,prompt`

#### Scenario: 模型不存在
- **WHEN** `command({type:"set_model",provider:"workbuddy",modelId:<假 omp 文档化的失败模型 id>})` 被调用
- **THEN** Promise 以 `AgentUnavailableError` 拒绝；子进程仍存活，generation 未被回收；随后对一个可用模型的 `set_model` 与一条 prompt 都成功

#### Scenario: 回合中不可用
- **WHEN** 一条 prompt 的回合在途时调用 `command({type:"set_model",…})` 或 `command({type:"set_thinking_level",…})`
- **THEN** 同步抛出 `SessionBusyError`，没有任何帧写到子进程，在途回合不受影响

### Requirement: 会话工作目录的仓库根标记
omp v18.12.3 从会话 cwd 向上到最近含名为 `.git` 条目的祖先（文件或目录都算；没有则到 omp 的 home）读取项目层：`.omp/SYSTEM.md` 与 `.omp/SYSTEM_TEMPLATE.md`（取最近一个非空 `.omp/`；后者是整份替换系统提示的模板）、`AGENTS.md`、`.omp/` 的 skills，以及 `.agent(s)/` 的 `AGENTS.md`、`SYSTEM.md` 与 `SYSTEM_TEMPLATE.md`（`.claude/` 与 `.codex/` 的 `SYSTEM(_TEMPLATE).md` 只读 cwd，不在遍历上；agent 定义也不在这条遍历上，见本段末「标记封不住 agent 定义」）。沙箱根与 owner 根对 `workbuddy` 组可写，omp 以单一 uid 运行（ADR-0010），所以一个会话能在 `<SANDBOX_ROOT>/.omp/` 或别的 owner 根下写入 `SYSTEM_TEMPLATE.md`，静默替换其它账号下一次会话的整份系统提示；omp 没有关掉这条遍历的设置或环境变量。宿主 SHALL 把遍历钉死在会话 cwd（owner 2026-10-20，#1563 Q3/Q8：工作空间 cwd；未绑定会话的 owner 根也放，是起草者的扩展——不放则这类会话仍受沙箱根 `SYSTEM_TEMPLATE.md` 影响）：每次 spawn 前（「子进程 spawn 契约」，会话、fork 临时进程与 regenerate 都在内，cwd 为绑定空间根或 owner 根）以及每次创建工作空间时（普通空间与会话创建的临时空间两条路径都算），宿主 SHALL 确保 `<cwd>/.git` 存在——`lstat` 发现任何同名条目（目录、文件、符号链接、悬空链接）即不动它；没有时 SHALL 建一个空目录并把权限 `chmod` 为精确 `2770`（与共享目录的新建分量同一写法，不受 umask 影响；属应用用户），使用户随后的 `git init` 直接把它填成真仓库；建不出（`EEXIST` 之外的失败）视同目录准备失败，不 spawn（创建工作空间时则该创建失败）。SHALL NOT 建标记文件（git 会把名为 `.git` 的文件当 gitfile 解析，`git init` 报错）。omp 用户删掉标记只影响到下一次 spawn（omp 只在启动时读系统提示与项目层）。后果（登记于 ADR-0012）：omp 的 `repoRoot` 恒为 cwd，owner 根与沙箱根上的 `.omp/` skills、`AGENTS.md`、`RULES.md`、`SYSTEM(_TEMPLATE).md` 与 `.agent(s)` 的 `AGENTS.md` / `SYSTEM(_TEMPLATE).md` 不再对工作空间会话生效（`.claude` / `.codex` 的 `SYSTEM(_TEMPLATE).md` 本就只读 cwd，不受影响）；宿主的项目配置列表与命令目录的向上遍历（chat-sessions「项目配置文件列表」「Slash 命令白名单与命令目录」）本就止于最近的 `.git`，随之止于 cwd，两边一致。**标记封不住 agent 定义**：omp v18.12.3 的 `task` 工具按 `findAllNearestProjectConfigDirs("agents")` 从 cwd 向上一直走到文件系统根取最近的 `.omp/agents`，不认 `.git`；沙箱根 / owner 根下的 agent 定义对 cwd 没有自己 `.omp/agents` 的其它账号仍可见（批准后子代理 yolo）——登记为 ADR-0012 已接受残余，部署前提「`SANDBOX_ROOT` 的任何祖先目录不得带 `.omp/`」保持必须；宿主的 agent 文件列表照旧不止于 `.git`，与 omp 一致。`.git` 是普通的空目录，会出现在工作空间的文件树与文件页里。omp 把 cwd 当仓库根而 `.git` 为空目录时，git 命令报 `not a git repository`，不影响回合（真实 omp 场景）。

#### Scenario: spawn 前建出标记
- **WHEN** owner `u1` 绑定 `proj` 的会话首次 spawn 时 `<SANDBOX_ROOT>/u1/proj` 下没有 `.git`；同一 owner 的未绑定会话 spawn 时 `<SANDBOX_ROOT>/u1` 下没有 `.git`；随后两者各 resume spawn 一次；另一次 spawn 前 `<SANDBOX_ROOT>/u1/proj/.git` 已是一个带 `HEAD` 文件的真目录；另一次是一个名为 `.git` 的普通文件；另一次是一个悬空符号链接
- **THEN** 前两次 spawn 后 `<SANDBOX_ROOT>/u1/proj/.git` 与 `<SANDBOX_ROOT>/u1/.git` 各是一个空目录，属应用用户、mode 恰为 `2770`（在 umask `022`、父目录无 setgid 位的临时目录里也是）；resume 时它们不变；后三次 spawn 不改动已有条目（真目录的 `HEAD` 仍在、文件仍是文件、链接仍悬空），且都正常 spawn
- **WHEN** `<cwd>/.git` 不存在且 `<cwd>` 对应用用户不可写；另一次 `<cwd>` 本身不存在（绑定空间根已被删）；另一次在宿主 `mkdir` 之后、设权限之前 `<cwd>/.git` 被换成指向他处目录的符号链接
- **THEN** 三次 `spawnOmp` 都不启动子进程、已签发的 token 被撤销（`issued` 恰 1、`revoked` 等于 `issued`、`live` 为空），调用以目录准备失败结束；第二次不重建 `<cwd>`；第三次链接目标的 mode 不变（宿主以 `O_NOFOLLOW` 打开后 `fchmod`，不跟随链接）
- **WHEN** 宿主 `lstat` 未见 `.git` 而 `mkdir` 撞上 `EEXIST`（omp 并发 `git init`）
- **THEN** 视同已有条目：不改动它、正常 spawn

#### Scenario: 创建工作空间即带标记
- **WHEN** owner 经 `POST /api/workspaces` 创建空间 `proj`；另一次经会话创建得到一个临时空间
- **THEN** 两个空间根在创建响应返回时各恰含一个条目 `.git`（空目录、mode `2770`）；创建事务在建出标记之后失败（审计写入或 `COMMIT` 失败、临时空间的调用方事务失败）时，补偿清理按逆序先删标记再删本次新建的空目录，盘上不留空间根；标记本身建不出（空间根建出后不可写）时该创建失败——`POST /api/workspaces` 返回通用 500、不留空间行、不写审计、本次新建的目录被删除，临时空间走调用方的清理；尚未 spawn 过任何会话时 `GET /api/project-config?workspaceId=<id>` 的 walk 已止于空间根（owner 根的 `AGENTS.md` 不在列表里）；`GET /api/workspaces/<id>/tree` 列出 `.git` 这一个目录条目

#### Scenario: 祖先的系统提示不再进入会话（真实 omp）
- **WHEN** 官方 omp v18.12.3 以 cwd `<SANDBOX_ROOT>/u1/proj`（宿主已建 `.git` 标记）启动，`<SANDBOX_ROOT>/u1/.omp/SYSTEM.md`、`<SANDBOX_ROOT>/u1/.omp/SYSTEM_TEMPLATE.md`、`<SANDBOX_ROOT>/.omp/SYSTEM_TEMPLATE.md` 与 `<SANDBOX_ROOT>/u1/AGENTS.md` 各含一个独立标记，`<SANDBOX_ROOT>/.omp/agents/far.md` 定义一个带独立标记的 agent，cwd 下没有 `.omp`
- **THEN** `get_state.systemPrompt` 不含前四个标记中的任何一个；`task` 工具的 agent 列表**仍含** `far`（标记封不住 agent 定义，残余如实钉住）；回合正常结束、没有报错帧、stderr 没有 git 相关噪音进入宿主记录
- **WHEN** 同一布局但以测试专用 spawn 包装在宿主建出标记之后、起进程之前删掉 cwd 下的 `.git`（负向对照；产品没有不建标记的 spawn）
- **THEN** `get_state.systemPrompt` 含 `<SANDBOX_ROOT>/u1/.omp/SYSTEM.md` 的标记

### Requirement: overlay 固定块 advisor / ida 钉的真实 omp 回归
宿主 overlay 固定块里的 `advisor.enabled: false` 与 `ida.enabled: false` 两段（「宿主 overlay」）SHALL 各有一条以钉住的官方 omp 二进制跑的回归用例与一条负对照（`server/test/omp-official-overlay-pins.test.ts`，`WORKBUDDY_OMP_TEST=1` 门下），负对照以去掉对应段的 overlay 变体经 `--config` 与 `PI_CONFIG_FILES` 两路换入，证明观测面可达；观测面以 v18.12.3 为基线：`ida` 是 discoverable 工具、不进 `get_state.dumpTools`，只在项目层 `ida.enabled: true` 且 `ida.installDir` 指向含平台命名库文件（darwin `libidalib.dylib`、linux `libidalib.so`、win32 `idalib.dll`）的目录时以 `xd://ida` 设备出现在 `get_state.systemPrompt`；`advisor` 没有 RPC 读回，只能按行为读——项目层 `advisor.enabled: true` 且 `modelRoles.advisor` 指向白名单模型时，一个 bash 回合的上游请求数与是否出现 `advisor_yielded` 帧。两条回归用例在当前固定块上先绿（对已有钉的特征断言），删去对应段时 SHALL 变红（变异核对记入实现 PR）。用例旁听子进程 stdout 的 tee SHALL 对坏行容错：解析失败或解析结果不是对象（`null`、数组、标量）的行跳过并计数，不抛异常，空白行跳过不计数，同一 chunk 里坏行之后的合法帧与跨 chunk 的半行（含跨 chunk 的多字节 UTF-8 字符）照常按序回调；该 tee 是 `server/test/support/omp-official.ts` 的导出 helper，只挂 `data` 监听、不改变流的读取方式，官方测试的全部 stdout tee（overlay-pins、rpc-ui 的 UI 请求 tee、`support/omp-official-proxied.ts`）复用它，坏行计数随 `[overlay-pins]` 读数一起打印。

#### Scenario: advisor / ida 钉的回归与负对照
- **WHEN** 官方 omp v18.12.3 以产品 overlay 启动，cwd 的 `.omp/config.yml` 写 `ida.enabled: true`、`ida.installDir: <cwd>/fake-ida`（目录内有一个空的平台命名库文件），并读取 `get_state`
- **THEN** `systemPrompt` 的 `xd://` 设备列表含 `ast_edit`、不含 `ida`（`dumpTools` 不含 `ida` 恒成立——discoverable 工具——不作证据）
- **WHEN** 同一配置，但 overlay 变体去掉了 `ida:\n  enabled: false` 两行
- **THEN** 设备列表含 `ida`
- **WHEN** 官方 omp v18.12.3 以产品 overlay 在 `write` 档启动，cwd 的 `.omp/config.yml` 写 `advisor.enabled: true`、`modelRoles.advisor: workbuddy/deepseek-v4.1-flash`，跑一个含 bash 调用的回合并放行审批，回合 `agent_end` 后每 500 ms 读一次假上游的请求数，计数保持不变满 2 s 视为稳定（30 s 内未稳定即失败）
- **THEN** 请求数恰为 2，子进程 stdout 的全部帧（读到稳定为止）里没有 `advisor_yielded`
- **WHEN** 同一配置，但 overlay 变体去掉了 `advisor:\n  enabled: false` 两行
- **THEN** 请求数大于 2，且 stdout 帧里出现 `advisor_yielded`

#### Scenario: stdout tee 容错非 JSON 行
- **WHEN** tee 收到一个 chunk `{"type":"a"}\nnot json\n{"type":"b"}\n`
- **THEN** 回调恰收到 `a`、`b` 两帧按序，坏行计数为 1，没有异常抛出
- **WHEN** 随后收到两个 chunk `{"ty` 与 `pe":"c"}\n`
- **THEN** 拼成一帧 `c` 回调，坏行计数不变
- **WHEN** 随后收到 `{"type":"d"\n{"type":"e"}\n`
- **THEN** 截断行跳过、计数为 2，`e` 照常回调
- **WHEN** 随后收到 `null\n\n  \n`
- **THEN** 计数为 3，没有回调；空白行不计数
- **WHEN** 一帧 `{"type":"中"}\n` 的字节在多字节字符中间切成两个 chunk
- **THEN** 拼成一帧、`type` 为 `中`，计数不变
