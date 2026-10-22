# omp-runtime Spec Delta

> s1d-experts-skills：「子进程 spawn 契约」的 argv 在宿主 overlay 的 `--config` 之后加会话配置文件的 `--config` 与（有专家时的）`--append-system-prompt`，新增「会话配置文件」一段（内容与 YAML 写法、原子写、子进程结束即删、各 spawn 路径同一规则），并改写三个断言 argv 的场景、加三个场景；「OMP_STATE_DIR 托管布局」布局表与路径函数加 `session-config/`（`2710`）与 `sweepSessionConfig`，加启动清扫一句与一个场景（design D1）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc-ui --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL> --approval-mode <MODE> --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml --config <OMP_STATE_DIR>/session-config/<key>.yml` 启动（第一个 `--config` 的取值由「宿主 overlay」规定，恒为绝对路径；第二个是本次 spawn 的会话配置文件，见下文「会话配置文件」，同样恒为绝对路径），会话有有效专家时（experts「专家提示词注入」）在其后再追加 `--append-system-prompt <OMP_STATE_DIR>/session-config/<key>.md`，没有时 SHALL NOT 传该参数；**仅当** `chat_sessions.omp_session_file` 非 null 时在上述参数（含可选的 `--append-system-prompt`）之后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--mode rpc-ui`（#1563，owner 2026-10-20）而不是 `rpc`：omp v18.12.3 的浏览器是 `eval` 工具的 prelude，它的每次宿主调用在 `write` / `always-ask` 档要经 prelude 自己的审批，而这类审批走工具 UI 上下文，只有 `rpc-ui` 把它作为 `extension_ui_request{select}` 送到协议上，plain `rpc` 下没有 UI、调用直接失败（`Eval prelude "browser" requires approval but no interactive UI is available`）。两种模式的握手、帧层与命令相同；`rpc-ui` 另把 `ask` 一类工具 UI 请求也送到协议上，宿主对非审批形状照旧 cancel（「RPC IO and child observation」）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`<MODE>` SHALL 是调用方给出的该会话的有效审批档位，取 `always-ask`、`write`、`yolo` 三个字面量之一（session-permission-tier「档位与 omp 审批模式」）：`write` 使 omp 仅对 exec 档工具（bash/eval/task）经 `extension_ui_request` 请求审批，文件读写不触发审批（本 change 之前唯一的取值）；`always-ask` 使写文件类工具同样请求审批；`yolo` 使工具不因档位请求审批。spawn SHALL NOT 自行决定、缺省或改写档位：调用方给出的值不是这三个字面量之一时 SHALL 不 spawn 任何子进程（视同目录准备失败），不得回退为某个档位。档位在一个进程的生命期内不变：omp 没有运行期切换审批模式的命令，宿主 SHALL NOT 向存活进程发送任何试图改变档位的帧，也 SHALL NOT 由 overlay 或其它配置文件按会话改写它；会话的档位改变后，由调用方在两个回合之间退役该进程并以新档位重新 spawn（chat-sessions「派发前按会话设置对齐进程」）。`<MODEL>` SHALL 是调用方给出的该会话的有效模型 id（模型白名单内的一项，model-selection「模型白名单配置」；未配置白名单时即 `MODEL_ID`）：它决定冷启动会话的初始模型；宿主 SHALL NOT 依赖它在 `--resume` 时的效果（每个 generation 的第一次派发之前另经 RPC 应用模型与推理强度，见「模型与推理强度命令」）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, PI_CODING_AGENT_DIR, PI_CONFIG_FILES, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, WORKBUDDY_MODEL_TOKEN, PI_BROWSER_RELAY, PI_BROWSER_CMUX, PUPPETEER_PROXY, PUPPETEER_PROXY_IGNORE_CERT_ERRORS, OTEL_SDK_DISABLED, no_proxy, NO_PROXY, PUPPETEER_EXECUTABLE_PATH}`（`LANG`/`TMPDIR` 缺席时不设；`PUPPETEER_EXECUTABLE_PATH` 只在部署配置了 `BROWSER_BIN` 时设置、取值恰为 `BROWSER_BIN` 的值（browser-runtime「浏览器可执行文件配置」），SHALL NOT 取自 `process.env` 的同名键——omp 以它为浏览器可执行文件，不再自动发现或下载），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；`PI_CODING_AGENT_DIR` SHALL 显式设为 omp 的默认 agent 目录本身——即 `<HOME 的取值>/.omp/agent`，与 `ompAgentDir(stateDir)` 同一字符串（omp 以字符串相等判断 agent 目录是否为默认值，只在相等时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」）；`PI_CONFIG_FILES` SHALL 设为「宿主 overlay」的文件路径；`PI_CONFIG_DIR` SHALL 为 `.omp`，`OMP_PROFILE` 与 `PI_PROFILE` SHALL 为 `default`（omp 把它规范化为「无 profile」；空串不行——dotenv 会覆盖空值）。五者的取值与不设时 omp 的行为相同，显式设置的目的是「工作目录 dotenv 钉住」：omp 启动时加载 `<cwd>/.env` 等文件，但不覆盖已有的非空环境变量。`PI_BROWSER_RELAY` 与 `PI_BROWSER_CMUX` SHALL 恒为字面量 `0`，不论是否配置 `BROWSER_BIN`（owner 2026-10-19，#1529）：omp 以这两个变量为浏览器中继与 cmux 的最终开关，非空时压过设置与参数（v18.12.3 `tools/browser/relay/kind.ts:36`、`tools/browser/cmux/rpc.ts:187-197`；`browser.open({app:{relay:true}})` 也经同一开关），未设时模型写进工作目录 `.env` 的 `PI_BROWSER_RELAY=1`（或 `OMP_BROWSER_RELAY=1`，omp 把 `.env` 里的 `OMP_*` 镜像成 `PI_*`）在下一次 spawn 时生效，绕过宿主 overlay 的 `relay: false` / `cmux: false` 与 `cdpUrl: ""`，且工具参数里不出现 `app`，确认卡与审计都看不到；字面量 `0` 是非空值，dotenv 不覆盖（空串会被覆盖，挡不住）。它们使中继与 cmux 在任何设置与参数下都不启用，`app.relay: true` 的调用退回本地浏览器（读源码得出，由下文真实 omp 场景实测）。`PUPPETEER_PROXY` SHALL 恒为字面量 `direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS` SHALL 恒为字面量 `0`（owner 2026-10-19，PR #1549 审查）：omp 起本地浏览器时从自身环境读这两个变量，拼成 `--proxy-server=<值>` 与 `--ignore-certificate-errors`（v18.12.3 `tools/browser/launch.ts:591-601`，经 broker 启动的共享浏览器也用同一份参数），未设时工作目录 `.env` 能给浏览器挂任意代理并关掉证书校验，卡与审计都看不到；`--proxy-server=direct://` 使 Chromium 一律直连，同时压过它从环境读的 `http_proxy` 一类变量，`0` 不在 omp 认作真的取值里。宿主的闭合白名单本就不给浏览器任何代理，钉住不改变既有部署；SHALL 不继承 `process.env` 中任何其它键。owner 2026-10-20 有意不钉 `PI_BROWSER_TERN`（与 `browser.tern`）和 `PI_AUTO_QA`（与 `dev.autoqa`）：工作目录 `.env` 经 `TERN_PANE_SOCKET` / `TERN_PANE` 走 Tern 浏览器分支、经 `PI_AUTO_QA_PUSH=1` 把模型写的报告推到 `PI_AUTO_QA_PUSH_URL`，登记为已知风险（ADR-0012）。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。cwd 就绪之后、`spawnImpl` 之前 SHALL 按「会话工作目录的仓库根标记」确保 `<CWD>/.git` 存在，标记建不出时视同目录准备失败。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>`、`<MODE>`、`<MODEL>` 与会话配置文件的内容按同一规则取自其所服务的会话行（fork 临时进程取源会话的工作目录、有效档位、有效模型与有效能力）。 `OTEL_SDK_DISABLED` SHALL 恒为字面量 `true`（#1575）：omp 的 OTLP 导出只看环境里的 `OTEL_EXPORTER_OTLP_*` 端点，工作目录 `.env` 能注入端点（及 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 等内容采集开关），把 trace / log / metric 从服务器发到任意地址；v18.12.3 在 `!telemetry.otlpExportEnabled || OTEL_SDK_DISABLED=true` 时不注册导出（`telemetry-export.ts:82`），两者各自独立生效——这一环境钉与「宿主 overlay」的 `telemetry.otlpExportEnabled: false` 是两道独立的关，不依赖该设置键在以后的 omp 版本里继续存在；值非空，dotenv 覆盖不了。 `no_proxy` 与 `NO_PROXY` SHALL 恒为字面量 `*`（#1615）：宿主的模型端点是明文回环（`http://127.0.0.1:<port>/v1`，「托管 models.yml」），omp 的推理请求走 Bun 原生 `fetch`，它从环境读 `HTTP_PROXY` / `http_proxy` / `ALL_PROXY`（及 `HTTPS_PROXY`，目标为 https 时）并对回环目标同样走代理，除非 `no_proxy` / `NO_PROXY` 覆盖它（omp 自己的回环豁免只在设了 `PI_PROXY` 或 `PI_PROXY_<PROVIDER>` 时生效，v18.12.3 `packages/ai/src/utils/transport-fetch.ts:25-47`、`proxy.ts:24-66`）；不钉的话工作目录 `.env` 一行 `HTTP_PROXY=` 就让每个模型请求（全部对话与 `WORKBUDDY_MODEL_TOKEN`）以明文转经任意地址，并把代理的回复当作模型输出，确认卡与审计都看不到。代理变量本身钉不住：Bun 把任何非空值当作代理地址，没有「直连」取值，空串又会被 dotenv 覆盖；所以钉的是豁免。两个大小写都钉：Bun 先读小写 `no_proxy`，只钉大写时 `.env` 再写一行不匹配的小写 `no_proxy` 就重新走代理（#1615 实测）；omp 自己的豁免判断先读大写（`proxy.ts:68`，`NO_PROXY || no_proxy`），只钉小写时 `.env` 写一行不匹配的 `NO_PROXY` 就能让同一 `.env` 里的 `PI_PROXY` 代理 omp 的非回环出站。`*` 豁免所有主机，不随 models.yml 的主机写法（`127.0.0.1`、`[::1]`）变化。副作用（接受）：omp 不从子 shell 剥掉继承的环境，助手经 bash / eval 跑的程序也看到 `no_proxy=*` 与 `NO_PROXY=*`。认这两个变量的工具不走环境代理，libcurl 系工具（curl、git 的 http 传输）连显式配置的代理（`curl -x`、`.curlrc` 的 `proxy`、git 的 `http.proxy`）也会被绕过、改为直连；出站必须经代理的部署里，需要代理的命令须自行去掉豁免（如 `env -u no_proxy -u NO_PROXY …` 或 `curl --noproxy ''`）。宿主的闭合白名单本就不给子进程代理变量，受影响的只是子 shell 里自设的代理与工具配置里的代理。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

**会话配置文件**（change s1d-experts-skills）。每一次 spawn——会话 slot 的进程与 fork / branch 的临时进程同样，没有第二条路径——SHALL 在按「OMP_STATE_DIR 托管布局」准备好目录之后、`spawnImpl` 之前，在 `<OMP_STATE_DIR>/session-config/` 下写出本进程专属的会话配置文件，并以它们组装上文 argv 中的第二个 `--config` 与可选的 `--append-system-prompt`。`<key>` SHALL 是每次 spawn 新生成的随机十六进制串，与会话 id、owner 无关，同一 key 不复用。文件内容由调用方给出的有效能力决定（chat-sessions「派发前按会话设置对齐进程」：会话 slot 取该会话的有效能力，fork / branch 临时进程取源会话的有效能力），spawn SHALL NOT 自行读取会话行或专家来决定、缺省或改写它们：
- `<key>.yml` SHALL 恰有一个顶层键 `disabledExtensions`，其值为字符串数组，元素去重后按字典序排列；元素为会话停用技能的 `skill:<名称>`（skill-switches「停用技能对 omp 生效」）。文件内容 SHALL 恰为一行 `disabledExtensions: [<e1>, <e2>, …]` 加换行：每个元素写作 JSON 字符串（双引号包围、按 JSON 规则转义，JSON 字符串同时是合法的 YAML 双引号标量），元素之间以 `, ` 分隔，为空时写作 `disabledExtensions: []`；宿主 SHALL NOT 以未加引号的 YAML 标量写元素（技能名可以含 `:`、`#`、`"` 等 YAML 记号）。该文件 SHALL NOT 含其它键，不进 `PI_CONFIG_FILES`（它仍只指向宿主 overlay）。
- `<key>.md` 只在会话有有效专家时写出，内容为该专家 `prompt` 的原文（UTF-8）；没有有效专家时不写该文件，argv 也不含 `--append-system-prompt`。路径是不含换行的绝对路径，omp 按文件读取它；omp 读该文件的**任何**错误（不只是缺失）都会使它把路径字面当作提示词文本，所以该文件 SHALL 在 spawn 前写成、对 omp uid 可读（目录见「OMP_STATE_DIR 托管布局」，文件 `0640`），且在该子进程结束之前不被删除。有专家时 omp 不再自行发现项目或用户层的 `APPEND_SYSTEM.md`（omp 只在没给该参数时发现它；接受）。
- 两个文件 SHALL 经与托管 `models.yml` 相同的替换实现原子写入（独占创建的临时文件、mode 精确 `0640`、rename）；任一写入失败视同目录准备失败：已写出的本次文件被删除，SHALL 不 spawn 任何子进程。
- 该子进程以任何原因结束时（正常关停、空闲回收、退役、驱逐、崩溃、启动或握手失败），宿主 SHALL 删除它的 `<key>.yml` 与 `<key>.md`；删除失败只记日志，不改变退出处理。其它存活进程的文件 SHALL NOT 被删除。

omp 按序深合并配置层，后者胜，只递归普通对象，数组整体替换；会话配置文件位于宿主 overlay 之后的 `--config` 层，高于项目层，所以项目层设置（`.omp/config.yml` 等）里的 `disabledExtensions` 总被它整体覆盖——项目层不能重新启用被会话停用的技能。宿主 overlay 不设 `disabledExtensions`，会话配置文件也不含 overlay 钉住的任何键，二者互不覆盖。

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
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null，有效档位 `write`，有效模型为缺省模型 `<MODEL_ID>`，没有专家、没有停用技能）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--mode rpc-ui`、`--cwd <SANDBOX_ROOT>/u1`，含 `--model workbuddy/<MODEL_ID>`、`--approval-mode write`、紧随 `--no-title` 的 `--config <overlay 路径>` 与其后紧接的 `--config <OMP_STATE_DIR>/session-config/<key>.yml`，无 `--append-system-prompt`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；该会话任何 spawn 的 argv 里 `--approval-mode` 恰出现一次且其后是 `write`（不含 `yolo` 或 `always-ask`）；session-dir、「OMP_STATE_DIR 托管布局」的全部目录、作为 cwd 的所有者根与其下的 `.git` 标记在 spawn 时已存在（事先不存在的由宿主建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir and every directory of the managed layout SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates) and the cwd's `.git` marker, and parent env SHALL remain unchanged

#### Scenario: 绑定空间的会话以空间根为 cwd
- **WHEN** owner `u1` 的会话绑定了 `dir` 为 `proj` 的工作空间（`workspace_id` 非 null），其首个 prompt 触发 spawn，随后 resume spawn，且同一 owner 另有一个未绑定会话 spawn
- **THEN** `<SANDBOX_ROOT>/u1/proj` 在首次 spawn 前已由工作空间创建建出，宿主只校验不创建；绑定会话两次 spawn 的 argv 都含 `--cwd <SANDBOX_ROOT>/u1/proj`，其余参数除会话配置文件路径里的 `<key>` 外与未绑定会话逐字相同（`--session-dir <OMP_STATE_DIR>/sessions/u1` 不随空间变化）；真实 fake 子进程经 probe 回报的 `cwd=` 等于 `<SANDBOX_ROOT>/u1/proj`（`process.cwd()` 的真实路径）；未绑定会话的 `--cwd` 与 probe `cwd=` 仍为 `<SANDBOX_ROOT>/u1`

#### Scenario: 绑定空间根缺失时不创建不 spawn
- **WHEN** owner `u1` 绑定 `proj` 的会话在下一次 spawn 前，`<SANDBOX_ROOT>/u1/proj` 被应用之外的操作删除（或被同名文件占据）
- **THEN** 宿主的存在性检查失败，`spawnOmp` 不被调用、没有子进程、不签发可用 token；`<SANDBOX_ROOT>/u1/proj` 仍不存在（未被 `mkdir -p` 重建）；没有以 `<SANDBOX_ROOT>/u1` 或任何其它路径替代 spawn

#### Scenario: resume 以会话文件头的 cwd 为准
- **WHEN** 一个已持久化 `omp_session_file` 的会话被 resume spawn，而 spawn 传入的 `--cwd` 与该文件头记录的 cwd 不同（例如同一 owner 的另一目录）
- **THEN** 这是宿主依赖的 omp 行为而非宿主实现：真实 omp 在该目录可进入时以文件头 cwd 为会话工作目录，后传的 `--cwd` 不迁移已存在的会话；宿主侧可测的约定是对同一会话（及其 regenerate、fork 进程）的每次 spawn 均传入同一按规则取得的 `<CWD>`，host 测试断言同一绑定会话的首次与 resume argv 中 `--cwd` 逐字相等，fake omp 不模拟此 omp 行为，也不以 fake 结果冒充对它的证明

#### Scenario: 档位与模型按会话进入 argv
- **WHEN** 调用方分别以（档位 `always-ask`、模型 `m3`）、（档位 `yolo`、模型 `m1`）对两个会话 spawn，随后各 resume spawn 一次
- **THEN** 两个会话各自的首次与 resume argv 里，`--approval-mode` 之后分别恒为 `always-ask` 与 `yolo`，`--model` 之后分别恒为 `workbuddy/m3` 与 `workbuddy/m1`；除这两处、`--cwd`、`--session-dir`、`--resume` 与会话配置文件路径里的 `<key>` 外，四份 argv 与 `write` 档缺省模型会话的 argv 逐字相同（都以 `--mode rpc-ui` 开头）；子进程环境白名单与 `PI_CONFIG_FILES`、宿主 overlay 的 `--config` 取值以及会话配置文件的内容不随档位或模型变化

#### Scenario: 非法档位不 spawn
- **WHEN** 调用方给出的档位为 `auto`、空串或缺失
- **THEN** `spawnOmp` 不启动任何子进程、不签发可用 token，调用以失败结束；没有以 `write` 或其它档位替代 spawn

#### Scenario: rpc-ui 下三档回合与 rpc 相同（真实 omp）
- **WHEN** 官方 omp v18.12.3 按本契约（`--mode rpc-ui`）分别以 `always-ask`、`write`、`yolo` 启动，各跑一个含 bash 调用的回合并在回合之间 `get_state`
- **THEN** 三次都正常握手（`ready`）、回合以 `agent_end` 结束；审批请求的有无与 session-permission-tier「档位与 omp 审批模式」一致；`get_state` 应答含 `sessionFile`、`model`、`thinkingLevel`（会话模型 `reasoning` 时；omp 不写值为 undefined 的键）；除审批之外的 `extension_ui_request`（含 omp 每回合即发即弃的 `setWidget` 显示帧）都被宿主 cancel 且回合不因此失败（#1566 实测：启动帧、`get_state` 键集合、审批帧与 `rpc` 下逐项相同）

#### Scenario: 有专家与停用技能时的 argv
- **WHEN** 会话的有效专家提示词为 `P`（含换行与中文）、停用技能为 `deploy`、`omp_session_file` 非 null，调用方以这些有效能力 spawn；测试经注入的 spawn 包装在 `spawnImpl` 被调用时读取 `<OMP_STATE_DIR>/session-config/`
- **THEN** argv 在宿主 overlay 的 `--config` 之后依次为 `--config <OMP_STATE_DIR>/session-config/<k>.yml`、`--append-system-prompt <OMP_STATE_DIR>/session-config/<k>.md`、`--resume <omp_session_file>`（末尾）；`<k>.yml` 解析为恰一个键的 mapping `{disabledExtensions: ["skill:deploy"]}`；`<k>.md` 的字节等于 `P` 的 UTF-8；两者 `mode & 0o7777` 为 `0o640`；`PI_CONFIG_FILES` 仍只是宿主 overlay 的路径；同一会话再 spawn 一次时 `<k>` 不同
- **WHEN** 停用技能为 `a: #"b`（含 `:`、空格、`#` 与 `"`）与 `deploy`，调用方 spawn
- **THEN** `<k>.yml` 的字节恰为 `disabledExtensions: ["skill:a: #\"b", "skill:deploy"]` 加换行；以 YAML 解析得到恰一个键的 mapping，其 `disabledExtensions` 恰为 `["skill:a: #\"b", "skill:deploy"]`（元素逐字符等于输入加前缀）

#### Scenario: 无专家时只有会话 yml
- **WHEN** 会话没有有效专家、停用集合为空，调用方 spawn
- **THEN** argv 不含 `--append-system-prompt`，宿主 overlay 的 `--config` 之后紧接恰一个 `--config <OMP_STATE_DIR>/session-config/<k>.yml`；该文件内容解析为 `{disabledExtensions: []}`；`session-config/` 下没有 `<k>.md`
- **WHEN** 停用集合为 `["weekly-report", "deploy", "deploy"]`
- **THEN** `disabledExtensions` 恰为 `["skill:deploy", "skill:weekly-report"]`

#### Scenario: 子进程结束后会话配置文件被删除
- **WHEN** 有专家的会话进程分别经空闲回收、服务关停、被 `SIGKILL` 崩溃而结束；另一例 fork 的临时进程完成 `branch` 后退出；再一例子进程在握手前以非零退出；全程另有一个存活的会话进程
- **THEN** 每例在 `onExit` 之后其 `<key>.yml` 与 `<key>.md` 都不存在；fork 临时进程的两个文件在它存活时的内容与源会话的有效能力一致；存活进程的两个文件仍在、字节不变
- **WHEN** 测试令 `<key>.md` 的写入失败
- **THEN** 没有子进程被 spawn，本次的 `<key>.yml` 不留在 `session-config/` 下，调用以目录准备失败结束

### Requirement: OMP_STATE_DIR 托管布局
宿主 SHALL 把 `OMP_STATE_DIR`（下称 `<state>`）分成「托管配置」（app 持有、omp uid 只读）与「omp 运行期状态」（omp uid 可写）两部分，目录与权限位（`mode & 0o7777`）精确如下，全部由 app uid 持有：

| 路径 | mode | 用途 |
| --- | --- | --- |
| `<state>` | `2750` | 根；omp uid 只能进入，不能在其下创建/改名/删除条目 |
| `<state>/home` | `3770` | omp 的 `HOME`；omp uid 可创建自己的条目（工具链缓存等），粘滞位使它不能改名或删除 app 持有的 `.omp` |
| `<state>/home/.env` | `0640`（普通文件） | omp 启动时加载 `$HOME/.env`；由宿主预建（空文件）并持有，粘滞位使 omp uid 不能替换它，见「工作目录 dotenv 钉住」 |
| `<state>/home/.omp`、`<state>/home/.omp/agent` | `2750` | 托管配置：`models.yml`（`0640`）与运维安装的 `skills/` 位于 agent 目录 |
| `<state>/session-config` | `2710` | 托管配置：每次 spawn 的会话配置文件 `<key>.yml` / `<key>.md`（`0640`，「子进程 spawn 契约」），子进程结束即删；组只有执行位——omp uid 能按确切路径打开其中的文件，不能列举、新建、改名或删除；服务启动的 `state_layout` 阶段由 `sweepSessionConfig` 清空其中的残留 |
| `<state>/xdg`、`<state>/xdg/data`、`<state>/xdg/state`、`<state>/xdg/cache` | `2750` | XDG 根 |
| `<state>/xdg/data/omp`、`<state>/xdg/state/omp`、`<state>/xdg/cache/omp` | `2770` | omp 运行期状态（`agent.db`、日志、原生模块缓存等）；omp 只在该目录已存在时才启用对应的 XDG 重定向，因此三者 SHALL 由宿主预先建出 |
| `<state>/sessions` | `2750` | 会话目录的父目录 |
| `<state>/sessions/<ownerId>` | `2770` | `--session-dir`，spawn 时按需建立 |
| `<state>/trash` | `0700` | app 私有：会话删除先把产物目录移到这里再递归删除（session-metadata「会话删除」），临时空间目录的删除同样经它中转（temporary-workspaces「临时空间目录的删除」）；omp uid 不能进入 |
| `<state>/snapshots` | `0700` | app 私有：每个回合开始前的工作空间快照（workspace-snapshots「快照的存放位置」）；omp uid 不能进入、列举或改写 |

这些路径 SHALL 只有一个来源：`server/src/sessions/omp/` 下的一个模块导出 `ompTrashDir(stateDir)`、`ompSnapshotsDir(stateDir)`（= `<state>/snapshots`）、`ompHome(stateDir)`、`ompAgentDir(stateDir)`（= `<state>/home/.omp/agent`）、`ompSessionConfigDir(stateDir)`（= `<state>/session-config`）、`ompXdgHome(stateDir, "data"|"state"|"cache")`、`ompSessionDir(stateDir, ownerId)`、`ensureOmpStateLayout(stateDir)` 与 `sweepSessionConfig(stateDir)`；`server.ts`、`createApp`、spawn 与会话删除 SHALL 经它们取路径，不得再拼 `join(stateDir, "agent")` 一类的字面量。旧布局的 `<state>/agent` SHALL 不再被读写（遗留目录原样留在磁盘，宿主不迁移也不删除）。

`ensureOmpStateLayout(stateDir)` SHALL 先在 `<state>` 缺失时以递归 `mkdir` 建出它及缺失的父级（不改父级权限位），再取 `<state>` 的内核 realpath（`OMP_STATE_DIR` 自身可以是运维放置的、指向目录的符号链接——既有部署形态，会话删除按同一 realpath 校验），然后对表中除 `sessions/<ownerId>` 之外的每个目录、以解析后的根为基、按父先于子的顺序调用 sandbox-core「托管目录权限位」的 `ensureOwnedDir(path, mode)`；根以下的各级不得是符号链接。`<state>/home` 缺失时 SHALL 先以不对组开放的权限位建出，待 `home/.omp` 与 `home/.omp/agent` 建好之后才校正为 `3770`——否则冷建期间一个残留的 omp uid 进程可以抢先建出 `home/.omp`，使布局因归属不符而失败；`ensureOwnedDir` 新建目录时 SHALL 直接以目标 mode 的权限位创建（不经过一个更宽的中间状态）。argv 与环境里的路径仍用配置值（未解析）拼出，与此前一致。它 SHALL 在两处被调用：服务启动时写托管 `models.yml` 之前，以及每次 `spawnOmp` 准备目录时（随后对 `sessions/<ownerId>` 以 `2770` 调同一 `ensureOwnedDir`）；因此被外部改宽的权限位在下一次 spawn 前被校正，而不属于 app uid 的目录、符号链接或非目录条目使启动失败（既有 generic `server_start_failed` 路径）或使该次 spawn 以「Directory preparation failure」失败，绝不被跟随或沿用。服务启动时（http-service-skeleton 的 `state_layout` 阶段，`ensureOmpStateLayout` 之后、任何 spawn 之前）宿主 SHALL 调用 `sweepSessionConfig(stateDir)` 删除 `<state>/session-config` 下的全部条目（上次运行遗留，其子进程已不存在；符号链接只删链接本身，不跟随），任一删除失败使启动以该阶段失败；`sweepSessionConfig` 只由 `server.ts` 的这一启动阶段调用，SHALL NOT 是 `ensureOmpStateLayout` 的一部分——每次 spawn 都调用的 `ensureOmpStateLayout` SHALL NOT 清扫它（其中是存活进程的文件）。宿主 SHALL NOT chown、不改进程 umask；组归属由部署经 setgid 继承（ADR-0010）。同 uid 部署（`OMP_USER` 缺席）使用同一布局与同一权限位。

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

#### Scenario: 启动清扫会话配置残留
- **WHEN** `<state>/session-config` 下预置 `a.yml`、`a.md` 与指向 `<state>` 之外某文件 `F` 的符号链接 `b.yml`，服务启动；随后两个会话各 spawn 一次且进程存活，再有第三个会话 spawn
- **THEN** 启动完成时 `session-config/` 为空、`mode & 0o7777` 为 `0o2710`，`F` 仍在且字节不变；第三次 spawn 的目录准备之后前两个进程的会话配置文件仍在、字节不变
- **WHEN** 测试令启动清扫删除某个残留条目失败
- **THEN** 启动以 `state_layout` 阶段失败（http-service-skeleton「服务启动与装配」的失败记录），不进入其后的任何阶段、不输出 success record、不 spawn 任何子进程
