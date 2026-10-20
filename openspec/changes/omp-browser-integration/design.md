# Design: omp-browser-integration

## Context

动机见 proposal「Why」。现状（master `41c16a65`，组 1 开工核对于 `786f18b7` 重核、行号已更新；omp v18.0.10 源码 `33cc6b9a`，路径在 `packages/coding-agent/src/` 下）：

- **omp 怎么调浏览器**：`browser` 工具是 `discoverable`、不在顶层（`tools/browser.ts:156`、`tools/xdev.ts:83-86` `isMountableUnderXdev`），`tools.xdev` 缺省为 `true`，模型只能经 `write` 写虚拟路径 `xd://browser`，`content` 是一个 JSON 字符串 `{action:"open"|"close"|"run", name?, url?, code?, app?:{path?, cdp_url?, relay?}, timeout?, all?, kill?, ...}`（`tools/browser.ts:48-74`；`app.args` 是 `app.path` 的启动参数；`app.target` 只按子串选窗口、不越界，不标出）。`write` 的审批与执行都先解开 `[path]` / `[path#XXXX]` 包装（`plan-mode-guard.ts:57-74`），`parseXdUrl` 去首尾空白、`xd://` 前缀不分大小写、设备名区分大小写（`internal-urls/xd-protocol.ts:10-16`），所以 `[xd://browser]`、`XD://browser` 与 `xd://browser` 是同一个设备；但执行侧以**未去空白**的原串判 `canHandle`（`write.ts:1141`），首部带空白或控制字符的路径走普通文件写入。执行前 `write` 还对 `content` 做 hashline 前缀剥离（`write.ts:1136` `stripWriteContent`，`:332-363`；规则在 `hashline/src/prefixes.ts:129-137`）：hashline 模式下（`edit.mode` 缺省 hashline，`deepseek-v4.1-flash` 不在 `catalog/src/identity/family.ts:443-450` 的排除名单里），每个非空内容行都带 `N:`/`N|` 前缀时剥掉再 `JSON.parse`——模型从 `read` 输出照抄前缀时就会这样；审批 `Content:` 与 `tool_execution_start.args.content` 都是剥离前的原文。三类帧：
  - 审批（只在 `always-ask` 与 `write` 档；`browser` 是 exec 档，`yolo` 不问——`tools/approval.ts:37-41`、`tools/browser.ts:141`）：`extension_ui_request{method:"select", options:["Approve","Deny"], title:"Allow tool: write\nPath: xd://browser\nContent:\n<content>"}`；`<content>` 按字段截到 2000 个 UTF-16 码元后加 `[…<n>ch elided…]`（`approval.ts:262-290`、`write.ts:~562`），截断后不是合法 JSON；整段截掉时 `app` 也可能不在可见部分。title 恰为这三行是因为 xd 设备的审批决定不带 `reason`（带时 `formatApprovalPrompt` 插入 `Reason:` 行，`approval.ts:274-276`；弹窗经 `extensibility/extensions/wrapper.ts:325` 发出），升级 omp 时重验。select 先于 `tool_execution_start` 到达。
  - `tool_execution_start{toolCallId, toolName:"write", args:{path:"xd://browser", content:"<JSON 字符串>"}}`（`packages/agent/src/agent-loop.ts:2548-2554`）。
  - `tool_execution_end{toolCallId, toolName:"write", result:{content, details:{xdev:{tool:"browser", mode:"execute", args, tier:"exec", inner}}}, isError}`（`write.ts:1196-1203`、`xdev.ts:416-473`）；`inner` 为 `BrowserToolDetails{action, name?, url?, screenshots?:[{dest, mimeType, bytes, width, height}], ...}`（`browser.ts:80-90`、`browser/tab-protocol.ts:30-36`）；抛错时 `isError:true`、`xdev` 无 `inner`（`xdev.ts:467-473`），内层返回 `isError:true` 而不抛时仍带 `inner`（`:458`），截图候选按「帧与结果都未失败」排除两者。`result.content` 是浏览器自己的文本与 `{type:"image"}` 块。
- **超时根因**：`ensureChromiumExecutable()`（`tools/browser/launch.ts:192-270`）先看 `PUPPETEER_EXECUTABLE_PATH`；否则 macOS 优先下载 Chrome-for-Testing（下载失败才退回系统 Chrome，`launch.ts:197,254-266`）、Linux 先找系统浏览器（`PATH` 上五个名字与 `/usr/bin/chromium`、`/snap/bin/chromium` 等固定路径，`launch.ts:339-349`）再下载（181 MB，验收日志可见，下载未完 30 s / 90 s 期限先到）。下载缓存是 `getPuppeteerDir()` = XDG cache 根下的 `puppeteer`（浏览器下载在其 `chrome/` 子目录；`puppeteer/` 本身在每次加载 puppeteer 时就会建出并写 `package.json`，`launch.ts:138,150-155`）（`utils/src/dirs.ts:701-702,338-366`），宿主的托管布局使它落在 `<OMP_STATE_DIR>/xdg/cache/omp/puppeteer`；下载前 omp 写日志 `Downloading Chromium for puppeteer`（`launch.ts:221`），omp 日志缺省只写文件（`<OMP_STATE_DIR>/xdg/state/omp/logs/`，`utils/src/logger.ts:4-6`），不进容器的 stdout。omp 恒带 `--no-sandbox`（`launch.ts:438`）。
- **截图落点**：`dest = browser.screenshotDir ? path.join(browser.screenshotDir, "screenshot-<时间>.<ext>") : path.join(os.tmpdir(), …)`（`tools/browser/tab-worker.ts:1930-1950`）；`expandPath` 只展开 `~`、不解析相对路径（`tools/path-utils.ts:159-173`）；写文件的 tab worker 是 omp 进程内的 Bun `Worker`（`tab-supervisor.ts:1087-1091`），相对路径因此相对 omp 进程的工作目录——宿主 spawn 时它恒等于会话 `<CWD>`（omp-runtime「子进程 spawn 契约」）。这一条是读代码推出，**未实测**（任务 2.3 本机实测，组 6 的容器用例在 CI 里再证）。
- **设置键**（`config/settings-schema.ts:4486-4560`）：`browser.enabled`（缺省 `true`）、`browser.cdpUrl`、`browser.relay`（`false`）、`browser.relayUrl`、`browser.headless`（`true`）、`browser.cmux`（`true`，需 `CMUX_SOCKET_PATH`）、`browser.screenshotDir`；都是普通键，项目层可写、overlay 可压（ADR-0012 已登记「浏览器 CDP 地址未钉」）。工具参数 `app.path` / `app.cdp_url` / `app.relay` 优先于设置（`browser.ts:91-130`），是参数不是设置，钉不住。`browser.enabled` 为假时工具不挂载（`tools/index.ts:670`）。
- **看图**：图片块送给 `input` 不含 `image` 的当前模型时被换成 `[image omitted: …]`（`sdk.ts:3309-3323`，只看当前模型）；`modelRoles.vision` 是当前模型不能看图时 `inspect_image` 与图片附件描述回退所用的模型（`tools/inspect-image.ts:197`、`image-vision-fallback.ts`），经 overlay 可压过项目层（合并次序 global → project → overlay → overrides，`config/settings.ts:2649-2653`；`#deepMerge` `:2667-2688` 只在两边都是对象时递归，所以 overlay 的 `modelRoles` 只压住它写出的键）。当前模型能看图时，omp openai-completions 在一串带图的工具结果之后补一条 `user` 消息 `[{type:"text",text:"Attached image(s) from tool result:"}, …image_url]`（`ai/src/providers/openai-completions.ts:2338-2357`）（只在当前模型能看图、且 provider 不要求 tool 结果后先接 assistant 时——缺省 `requiresAssistantAfterToolResult=false`，`catalog/src/compat/openai.ts:788`）——假上游今天的「最后一条 user 文本」查找（`fake-upstream.mjs:423-431`）会取到这条合成消息、丢掉真实用户的标记，`toolRoundScope:"turn"` 下还会把它当成新的用户回合、发出缺省 bash（`:500-514,523`）；缺省作用域的轮次判定（`hasToolRole`，`:489-493`）本来就不受影响。本仓库单模型配置固定 `vision: false`（`server/src/model-catalog.ts:60`），`vision` 在 web 只决定模型选择器里的「看图」标签（`web/src/features/chat/model-picker.tsx:136`），服务端决定 `models.yml` 的 `input` 三行（键与两项，`server/src/model-proxy/models-yml.ts:57`）与 overlay 看图块（组 2 起，`server/src/server.ts:549` 取白名单里第一个 `vision:true` 的模型）。钉单模型 `vision:false` 的现行陈述：session-composer-settings「输入框选项端点」场景「缺省配置」、thinking-fold「关闭 reasoning」与 http-service-skeleton「单模型时写出的字节不变」、`smoke/session-meta.hurl:206,310`。
- **宿主侧**：
  - 审批：`server/src/sessions/omp/ui-requests.ts:20-37` 只取 title 首行的工具名，`write`。审批与步骤按工具名配对（`server/src/sessions/approval-pairing.ts` `takeApproval(name)`），所以审批的工具名与步骤名必须同时改。
  - 步骤落库：`turn-control.ts:248-263` 的 step.start 分支以归约器事件的 `name` 配对审批（`steps.takeApproval(name)`）并经 `store.startStep`（`store-segments.ts:82-113` 的 `runOwnedTransaction`）插入步骤行；它只拿到归约器给的 `{messageId, stepId, name, detail}`；`startStep` 只有 `turn.sessionId`、没有 `owner_id`（审批结算在同一事务里 JOIN `chat_sessions` 取，`store-approvals.ts:142-147`）。store 的 `emit` 是可选项（`store.ts:152-153`），审批结算缺它时 fail closed。
  - 步骤：`server/src/sessions/events.ts:219-245` 以帧的 `toolName` 登记步骤名、detail 为 args 的单行 JSON；`:247-302` 只对 `edit`/`write`/`todo` 派生 `files.changed` / `todo.updated`；`write` 候选要 `details.resolvedPath`，xd 写入没有，故今天无文件变更（`file-changes.ts:40-57`）。step.end output 里的图片块是 `[图片]`。
  - web：步骤卡与提问卡的工具名按原文显示，只有 `bash` 有专门图标（`step-card.tsx:43`、`approval-card.tsx:26-37`）；步骤摘要取 detail 的第一行（detail 是 JSON 对象时取 `text`/`content`/首键，`step-summary.ts:33-45`）。
  - overlay：`server/src/sessions/omp/host-overlay.ts:27-60` 无任何 `browser.*` / `modelRoles`（`:30` 的 `approval: []` 整体替换项目层的逐工具审批记录，`yolo` 不问的前提由此成立）；omp-runtime「宿主 overlay」要求内容逐字节等于一份字面量。
  - spawn 环境：`server/src/sessions/omp/process.ts:114-145` 组 env，`:145` 的 sudo `--preserve-env=` 是写死的字符串；精确断言在 `server/test/omp-spawn-dotenv-pins.test.ts:95-107,138`、`session-supervisor-helpers.ts:394`（`sudoPrefix()`，经它间接钉的有 `omp-spawn-cwd.test.ts:335`、`server-assembly.test.ts:242,304`、`server-startup-omp-user.test.ts:71`、`session-supervisor.test.ts:206`）、`omp-process.test.ts:63-75,146-178,526-554`、`omp-state-layout.test.ts:535-549`（真实 fake-omp 报告的 env 键集 `toEqual`）；`linux/uid-isolation.test.ts:58-71,513` 是子集断言（`toContain`）；规格 omp-uid-isolation「OMP_USER 配置与 sudo spawn 前缀」逐字钉 argv；ADR-0010 `:23,102` 以占位写键列表、不逐键。`ompUser` 的接线链是 `server.ts:145` → `supervisor.ts:85` → `pool.ts:241` → `omp/runtime.ts:71,435` → `process.ts`，`browserBin` 走同一条；`new SessionRuntime` 在 `src/` 只有 `supervisor.ts:500-516`（会话；regenerate 经 `branching.ts:86` → `ports.acquire` 也落在这里）与 `branch-temp.ts:98-114`（fork 临时进程，取 `supervisor.ts:222` 的同一 runtime 设置）两处，都经 `pool.ts:222-253` 的 `sessionRuntimeOpts`，所以只在那里加一个字段即三种入口都到（#1529 开工核对）。官方二进制夹具（`test/support/omp-official.ts:159`、`omp-official-proxied.ts:158`、`omp-rpc.ts:266,350`）绕过这条链直接构造运行时。
  - 工作目录 `.env` 与浏览器中继（#1529 开工核对，读 omp 源码）：omp 在模块加载时按 `<cwd>/.env`、agent 目录、配置根、`$HOME` 的次序读四个 `.env`，只写未设或为空的变量（`utils/src/env.ts:227-247`，文件里的 `OMP_*` 镜像成 `PI_*`）；官方二进制关了 Bun 自带的 dotenv（`scripts/compile-binary.ts:58-61`）。`PI_BROWSER_RELAY` / `PI_BROWSER_CMUX` 是中继与 cmux 的最终开关，非空时压过设置，`app.relay: true` 也经同一开关（`tools/browser/relay/kind.ts:36`、`cmux/rpc.ts:187-190`、`browser.ts:102-107`；`parseFlag` 只认 `1|y|true|yes|on` 为真，`utils/src/env.ts:424-427`）。宿主今天不设它们，模型写进工作目录的 `.env` 在下一次 spawn 时生效，绕过 overlay 的 `relay: false` / `cmux: false`，且参数里没有 `app`，卡与审计都看不到。中继地址为本机时 omp 会拉起一个全机共享的 broker 守护进程（`registry.ts:215-224`、`relay/daemon.ts:54`；`isLoopbackRelayUrl` 只认 `127.0.0.1`/`localhost`/`::1`，`relay/daemon.ts:39-46`）。本地无头浏览器也不是 omp 进程直接启动：编译版二进制的 headless 一律经每个项目一个的 broker（`registry.ts:175-183` → `shared-daemon.ts:66-110` → `launch/client.ts:308-323`，`detached: true` 且 `unref()`），浏览器可执行文件由 broker 执行、取 broker 自己的 env（`launch/broker.ts:780`），每次 acquire 最多试 3 次（`shared-daemon.ts:27`），最后一个客户端断开后 broker 再活 3 s（`broker.ts:34`），运行目录在 `$XDG_STATE_HOME/omp/run/daemons/<hash>`（`utils/src/dirs.ts:953-961`，托管布局下即状态目录之内）。broker 自成会话，不在 omp 的进程组里；它随该工作目录最后一个客户端断开后 3 s 退出，生产上不另设回收（Non-Goals「浏览器进程的资源上限与空闲回收」）。
  - 审计：`kind` 是至少两段点分小写名（`030_audit_events.sql` CHECK、audit-core），无封闭列表；现有 `session.approval` 只在审批结算时写。
  - 夹具：官方二进制对照用例只在 CI `uid-isolation` job 里以 `WORKBUDDY_OMP_TEST=1` 运行（`.github/scripts/ci-uid-isolation.sh:292`）；假上游的工具轮由最后一条 user 文本里的标记决定（`server/test/support/fake-upstream.mjs:515-547`，规格 omp-test-harness「受控上游思考与写入标记」）；假 omp 文件已 797 行、规格钉死其模块集合（omp-test-harness `:10,196`）。
- **部署**：仓库没有 app 的 Dockerfile（system.md 9.7 第 2 条，`system.md:414`）；`converter/` 是部署方自建、不发布的 sidecar 镜像先例；CI `office-sidecar` job 是「现场构建镜像 + 容器里实测」的先例（`ci.yml:159-169`：checkout → setup-node → `npm ci` → build → `docker build` → 脚本；合同在 `scripts/test-ci-harness.sh:187-196` 与 `AGENTS.md:153`，`constraints.yaml` 没有按 job 的行，其 `ci.matrix` 已含 `ubuntu-24.04`）。测试主机缺 `docker0`，默认 bridge 网络不可用，`docker build` 与 `docker run` 都要 `--network host`。
- **omp 浏览器标签页**：`run` 要求标签页还活着（`tab-supervisor.ts:509-512`：`Open it first with action:"open"`），标签页属 omp 进程；两回合之间进程被退役则第二回合的 `run` 失败。

## Goals / Non-Goals

**Goals:**

- 浏览器工具在部署方给出可执行文件时可用、在不给时不存在；任何情况下 omp 都不下载浏览器。
- 浏览器调用在确认卡、步骤卡与审计里都是可读的浏览器操作，目标地址与「启动外部程序 / 连接外部浏览器 / 经中继」三种越界形态一眼可见。
- 截图能被能看图的模型看到，并作为文件出现在会话里。
- 给出能构建的参考部署镜像，并由 CI 在真实容器里证明整条链路。

**Non-Goals:**

- 访问范围限制：不屏蔽内网、元数据地址或 `file://`（owner Q2：不限制）；不做 URL 白名单 / 黑名单、不做宿主侧自动拒绝。
- omp 进程内的写边界：`run` 是全权 JS，与 bash 同级；写范围由容器挂载决定（owner Q5），宿主不在 omp 内另加限制。
- 下载目录：omp 不配置页面下载落点，登记为残余，不处理。
- 用户在界面里直接操作这个浏览器；截图的缩略图内嵌在步骤卡（owner Q9 选文件变更卡）。
- 前端改动：工具名徽章、步骤图标、摘要规则都不改（`browser` 显示为原文与通用图标）。
- `tools.xdev: false`（让 `browser` 成为顶层工具）。
- `MODEL_VISION_ID` 一类的看图模型指定变量；看图模型恒取白名单里第一个 `vision:true` 的模型。
- 镜像发布流水线、镜像仓库引用、kb-service 与 converter 进同一镜像。
- 浏览器进程的资源上限与空闲回收：omp 的共享 daemon 随该工作目录最后一个 omp 进程退出而停（`browser/shared-daemon.ts`），宿主不另设。

## Decisions

### owner 的裁定（2026-10-18，已定，不是选项）

| 编号 | 分支 | 结论 |
|---|---|---|
| Q1 | 浏览器来源 | 容器部署，镜像里预装 Chromium（不在运行期下载） |
| Q2 | 访问范围 | 不限制（不屏蔽内网 / 元数据地址）；可写范围仅工作空间或临时工作空间 |
| Q3 | 卡片呈现 | 服务端识别 `xd://browser`，改写步骤名与卡标题；`app.path` / `app.cdp_url` 显著标出 |
| Q4 | 看图 | 白名单有 vision 模型就钉 `modelRoles.vision`，没有就纯文本 |
| Q4' | 当前模型 | deepseek-v4.1-flash 是视觉模型 |
| Q5 | 写范围 | 由容器挂载决定，omp 内不再限；截图目录指到工作空间（相对路径先实测，不成落到状态目录）；下载目录登记残余 |
| Q6 | 镜像 | 本 change 新增参考 Dockerfile（app + omp + chromium + 字体）与 compose 片段 |
| Q7 | 路径确定 | `BROWSER_BIN`（绝对路径）透为 `PUPPETEER_EXECUTABLE_PATH`；未设则禁用浏览器 |
| Q8 | 单模型看图 | `MODEL_VISION=on\|off`，缺省 on |
| Q9 | 截图呈现 | 复用「文件变更」卡 |
| Q10 | 身份 | 两个 uid，按 ADR-0010 的 sudoers 进镜像 |
| Q11 | 验证 | CI 新 job：构建参考镜像，容器里真 omp 打开工作空间内 html 并截图（即批准 CI 改动） |

收敛小结九点 owner 2026-10-18 确认。

### 起草者的技术决定

**D1 `BROWSER_BIN`：可选的绝对路径，设了才有浏览器。** `agent-config.ts` 的同一个 resolver 读它：未设置 → `browserBin` 缺席；设置 → SHALL 是绝对路径、指向一个当前进程可执行的普通文件（`statSync` + `accessSync(X_OK)`，跟随符号链接——Debian 的 `/usr/bin/chromium` 是 shell 包装脚本），否则启动失败，错误只点名 `BROWSER_BIN`、不回显取值（沿用既有配置错误路径）。空串视同非法。它与 `ompUser` 走同一条接线链（Context「spawn 环境」）抵达每一种 spawn。`OMP_USER` 模式下 omp 用户能否执行它由部署保证（system.md 写明；参考镜像里是 `0755` 的系统文件）。http-service-skeleton「服务启动与装配」的配置键清单同步加它。备选：宿主自己在 `PATH` 上找——omp 的自动发现正是不确定的来源，否决。

**D2 overlay 模板化：按部署配置确定、不随会话变。** `writeHostOverlay(stateDir, {browserEnabled, visionModelId})`，字节是这两个启动期取值的纯函数；全部会话、全部档位仍共用这一份文件（omp-runtime「宿主 overlay」的「不随档位变化」保留，「逐字节固定」改为「部署配置的纯函数」是 owner 收敛第 ⑨ 点）。在既有字面量之后追加：

```yaml
browser:
  enabled: <true|false>        # BROWSER_BIN 设置与否
  cdpUrl: ""
  relay: false
  cmux: false
  headless: true
  screenshotDir: screenshots
```

白名单里有 `vision:true` 的模型时再追加 `modelRoles:` / `  vision: "workbuddy/<id>"`（`<id>` 为白名单次序里第一个 `vision:true` 的模型，`JSON.stringify` 引号）；没有则不写 `modelRoles` 键。`visionModelId` 只依赖白名单，`MODEL_CATALOG` 部署从组 2 起就有看图块；单模型部署在组 4（`MODEL_VISION`）之后才有。各键的理由：`enabled` 是 Q7 的禁用开关（Linux 上即使 `PATH` 有浏览器也不挂载工具）；`cdpUrl: ""` 使项目层写的 CDP 地址失效（omp 只在取值为真时使用它）；`relay: false` 与 `cmux: false` 关掉经设置启用的中继与 cmux；`headless: true` 防项目层要求有头窗口；`screenshotDir: screenshots` 是工作空间下的相对目录（Context「截图落点」）。`modelRoles` 是对象，overlay 深合并只能压住 `vision` 一键，项目层写的其它角色照常——登记为残余。取值不经 omp 的 schema 校验，升级 omp 须重验（同既有 overlay）。**实测相对目录不落在工作空间时**（任务 2.3）：按 owner Q5「不成落到状态目录」改钉绝对路径 `screenshotDir: <OMP_STATE_DIR>/screenshots`（仍是部署配置的纯函数；托管布局建出该目录、omp 用户可写），截图不进文件变更卡。实现者在同一 PR 改这些连带处后继续并在 PR 写明：本 design D2/D5/D8、omp-runtime「宿主 overlay」浏览器块与其说明、omp-runtime「OMP_STATE_DIR 托管布局」的目录表（加 `<OMP_STATE_DIR>/screenshots`，`2770`，路径函数同模块导出）、chat-stream「Browser write becomes a browser step」场景里的截图路径、turn-artifacts「浏览器截图进入文件变更」场景、browser-runtime「CI browser-image job」的截图断言（改为截图文件在状态目录下存在、步骤无 `changes`）、tasks 6.x 与验收行 CH-123。

**D3 `MODEL_VISION`：单模型配置的看图开关。** 与 `MODEL_REASONING` 同形（`on`/`off`，其它取值启动失败点名 `MODEL_VISION`；缺省 `on`）；`MODEL_CATALOG` 已设置时 SHALL NOT 同设，同设即启动失败点名 `MODEL_VISION`。单模型项的 `vision` 取其生效值，它同时进 `models.yml` 的 `input` 三行、overlay 看图块与 `GET /api/composer/options`。缺省 `on` 改变既有部署：`models.yml` 单模型项多出 `input` 三行、模型选择器出现「看图」标签、用户上传的图片附件按图片送给模型——上游模型不能看图的部署写 `MODEL_VISION=off`（system.md 升级提示）。连带改的现行陈述见 Context「看图」末句：session-composer-settings、thinking-fold、http-service-skeleton 各一个 MODIFIED，`smoke/session-meta.hurl` 两处响应体改 `"vision":true`（thinking-fold 与 http-service-skeleton 的「字节不变」陈述在 change `epic-acceptance-followups` 改 `maxTokens` 时已经不成立，本 change 的 MODIFIED 改为引用 model-proxy 的定义，一并修正）。

**D4 spawn 环境：设置了 `BROWSER_BIN` 时多一个 `PUPPETEER_EXECUTABLE_PATH`；恒钉 `PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`、`PUPPETEER_PROXY=direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0`。** 直连模式的 env 在 `LANG`/`TMPDIR` 两个可选键之后加 `PUPPETEER_EXECUTABLE_PATH=<BROWSER_BIN>`（未设置即缺席）；sudo 模式的 `--preserve-env=` 列表恒在末尾多 `PUPPETEER_EXECUTABLE_PATH`（列表是固定字符串；变量缺席时 sudo 无可保留，行为不变）。不继承 `process.env` 里的同名键（父进程里的 `PUPPETEER_EXECUTABLE_PATH` 不起作用，只认 `BROWSER_BIN`）。CI uid-isolation 的 sudoers 用 `SETENV:`，不需要改。
另外恒写 `PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`（owner 2026-10-19，#1529 开工核对之后裁定「始终钉」）：不随 `BROWSER_BIN` 变，键集固定；sudo 的 `--preserve-env=` 列表在 `WORKBUDDY_MODEL_TOKEN` 之后依次为 `PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,PUPPETEER_EXECUTABLE_PATH`——只写进直连 env 而不进这个列表，sudo 模式下两个钉会被丢掉。取值必须是字面量 `0`：omp 的 dotenv 只填未设或为空的变量，空串挡不住。效果：工作目录 `.env` 打不开中继与 cmux；`app.relay: true` 的调用不再走中继、退回本地浏览器——ADR-0012 已接受残余里的「`app.relay` 走中继」一项随之堵上，`app.path`、`app.cdp_url` 仍钉不住。卡上的 `⚠ 经中继连接用户自己的浏览器` 与审计 `external.relay` 照旧按参数写出（记录的是模型的请求，多报不漏报；组 1 已合入，不回改）。`CMUX_SOCKET_PATH` 不钉：`PI_BROWSER_CMUX=0` 一个就够，钉成空串反而会被 `.env` 覆盖。
同理恒写 `PUPPETEER_PROXY=direct://`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0`（owner 2026-10-19，PR #1549 安全席 P2）：omp 起本地浏览器时从自身环境读它们拼 `--proxy-server` 与 `--ignore-certificate-errors`（`launch.ts:436-458`，broker 启动的共享浏览器用同一份参数），`.env` 写上即给浏览器挂任意代理、关证书校验，卡与审计都看不到。`direct://` 让 Chromium 一律直连并压过其从环境读的 `http_proxy` 等；`PUPPETEER_PROXY_BYPASS_LOOPBACK` 只在有代理时起作用，不钉。宿主闭合白名单本就不给浏览器代理，既有部署不变。`--preserve-env=` 尾部因此为 `…,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,PUPPETEER_EXECUTABLE_PATH`。
备选：只在设了 `BROWSER_BIN` 时钉——没开浏览器时中继本来就到不了，收益为零而键集随配置变、钉点翻倍，owner 否决；不改、记为残余——owner 否决。
`process.ts`（793）放不下这三个键与注释：env 组装（闭合白名单、两个钉、`PUPPETEER_EXECUTABLE_PATH`、`LANG`/`TMPDIR`）与 `--preserve-env=` 常量抽到同目录新文件 `spawn-env.ts`，`process.ts` 只调用它；不压缩既有代码。

**D5 `xd://browser` 的识别是一个纯函数模块，三处共用。** 新文件 `server/src/sessions/omp/xd-browser.ts`，规则全文在 browser-runtime「浏览器操作的可读描述」：
- `isBrowserDevicePath(raw)`（全文见 browser-runtime）：照搬 omp 执行路径——方括号解包 → scheme 正则 → `new URL()` → `href` 是否恰为 `xd://browser`（不分 scheme 大小写）；URL 序列化会吃掉尾部控制字符、制表符与换行、空端口、空 userinfo，手写字符串规则总会漏掉某一种，所以直接用同一个解析器。**开工核对改判（#1526，2026-10-19）**：Stage 4.5 加的宽松串判定 (b) 已删——按源码逐行复刻 omp 判定链、Node 24.13.1 与 Bun 1.2.19 各跑 40 万随机样例，与上述判定零差异；(b) 多认的只有首部空白 / 控制字符（omp 当普通文件写入，`write.ts:1141`）与尾部 Unicode 空白（omp 报无此设备），判为浏览器会把真实的文件写入登记成浏览器步骤、漏掉它的文件变更，并多一条没有对应调用的审计。omp v18.0.10 自带的 Bun 1.4.0 未实测，升级 omp 时与本判定一起重核。
- `parseBrowserContent(text)`：`JSON.parse` 成普通对象时成功（`action` 缺席时摘要行为 `浏览器操作`）；原文不成功时照搬 omp 的 hashline 前缀剥离（`stripWriteContent` 的严格规则与松散头行回退，正则取自 `hashline/src/prefixes.ts`）后再解析一次——宿主不知道 omp 是否处在 hashline 模式，取先成功者：omp 不剥离时调用本就失败，多算的只是一条审计；不照搬则 `1:{…"app":{"path":…}}` 这种照抄前缀的参数在 `yolo` 档下审计为三个 `null`、`app.path` 漏记（开工核对发现，#1526）。剥离只对不超过 16384 个码元的文本做（PR #1540 审查：照搬的正则与重复去前缀在超长输入上是平方级，宿主进程为所有会话共用）。
  **审查改判（PR #1540 round 1）**：omp 执行的是 `validateToolArguments` 修复后的参数（`xdev.ts:427,457`；解开多套引号的键、拼回扁平路径键、JSON 字符串转对象、`"yes"` 转布尔、数转字符串），原先的「类型不符视同缺席」会让 `"app":"{\"path\":…}"`、`"app":{"relay":"yes"}` 这类参数在卡上零条 ⚠、审计 `external:null`，而 omp 照样启动外部程序或走中继。照搬整套修复不现实（规则多、随 omp 版本变），改为失败即关闭：参数对象不恰为 omp 浏览器 schema 的形态（键集与类型，browser-runtime「规范与无法确认」）即判为无法确认——标志行末加一行 `⚠ 参数写法不规范，…`、确认卡再附 `原文：` 与原文、审计 `external` 带 `unverified:true`。插入卡片的值另清掉控制字符与双向控制符、截到 200 码点，使步骤 detail 的截断切不到标志行。`name`/`url`/`code`/`app.path`/`app.cdp_url` 取非空字符串，`all`/`kill`/`app.relay` 取布尔，`app.args` 取全部元素为字符串的非空数组，类型不符当缺席；否则失败。
- `browserSummary`、`browserFlags`、`browserAuditFields`：摘要行、⚠ 标志行（`app.path` 行带 `app.args`）、审计字段 `{action, url, external}`，字符串值里的换行换成空格。
三处用法：
1. **审批**（`ui-requests.ts`）：title 以 `Allow tool: write\nPath: ` 开头、其后第一处 `\nContent:\n` 之前的整段文本（路径本身含换行时也是一整段）判为浏览器设备路径时——与步骤侧同一判定，否则两边登记名不同、按名配对的审批会滞留并错配给下一个 `write` 步骤——`tool` 记为 `browser`，`title` 改写为「摘要行 + 标志行 + （`run` 时）`代码：` 与 `code` 全文」，各段以 `\n` 相接；`Content:` 之后的文本解析失败（截断）时改写为 `浏览器操作（参数过长，以下为原文）`、固定一行 `⚠ 参数被截断，无法确认是否启动外部程序或连接外部浏览器`、再接原文——截断可能恰好把 `app` 截掉，卡上必须有一行警示让用户知道看不全。其余审批不变。改写在审批登记（`chat_approvals.tool/title`）、`approval.request` 事件、审计 `detail.tool` 之前完成，所以三者一致。备选：改从先到达的 assistant 消息里取完整参数——未核实 RPC 帧带它，且多一条状态通道，否决。
2. **步骤**（`events.ts` `applyToolStart`）：`toolName` 为 `write` 且 `args.path` 是自有字符串、经 `isBrowserDevicePath` 为真时，登记名为 `browser`，detail 为「摘要行 + 标志行 + `content` 的紧凑单行 JSON（`content` 不是能解析的 JSON 字符串时改用整个 `args` 的紧凑单行 JSON）」，以 `\n` 相接，再走既有 4096 码点截断；映射输出的 step.start 另带 `browser:{action,url,external}`（由完整 `content` 算出，供 D6，不落库、不发布）。web 的摘要规则取 detail 第一行，所以步骤卡摘要即摘要行——前端不改。审批配对用的是登记名（`turn-control.ts:249-250` 取归约器事件的 `name`，已核实）。
3. **截图候选**（`file-changes.ts`）：登记名为 `browser`、帧与结果都未失败、`result.details.xdev` 为普通对象且自有 `tool === "browser"`、`inner` 为普通对象、`inner.screenshots` 为数组时，每个自有 `dest` 为非空字符串的元素产生一个候选 `{path: dest, added:null, removed:null, kind:"write"}`；其余（无截图、`help` 模式、出错）无候选。之后走 turn-artifacts 既有的归属判定：相对路径以 `--cwd` 为基准、空间外与未绑定会话丢弃——截图落到状态目录（D2 退路）时自然丢弃。
备选：前端加工具名映射表——owner Q3 选服务端改写；`tools.xdev: false`——每次请求带全部 discoverable 工具的 schema，否决（Non-Goals）。

**D6 浏览器调用审计：每个浏览器步骤一条 `session.browser`。** `turn-control.ts` 的 step.start 分支见到映射输出带 `browser` 字段时，把它交给 `store.startStep`，由后者在插入步骤行的同一 `runOwnedTransaction` 里经 `emit` 写一条：`kind="session.browser"`、`actorId`=会话 `owner_id`（照 `store-approvals.ts:142-147`，在同一事务里 JOIN `chat_sessions` 取，`StartStepInput` 不加字段）、`title="浏览器操作"`、`detail={sessionId, messageId, action, url, external}`。数据只来自 D5 第 2 条的 `browser` 字段——它由完整参数算出；从 detail 再解析会在长 `run` 脚本截断时丢掉 `external`，而 `yolo` 档下审计是唯一的痕迹。三档都写；审批照旧另写 `session.approval`（`detail.tool="browser"`）。审计失败、或 store 未配置 `emit` 时，该步骤不落库（与审批结算缺 `emit` 时同样 fail closed），沿既有 owned error-sink 处理。`store.ts`（784）与 `supervisor.ts`（782）贴近上限：审计写入放在 `store-segments.ts`（195）或新文件，不加进这两个文件。

**组 1 兄弟面与必须保持（开工核对，#1526）**：
- 映射输出的 `browser` 字段不发布：`turn-control.ts:259-262` 返回显式六键，web 解码器 `stream-segments.ts:80` 以 `hasExactlyKeys` 要求恰为这六键（多一键前端即丢事件），`session-file-changes.test.ts:262-290` 钉了发布形状。
- fork（`store-branch.ts:48,254`）以 SQL 原样复制 `name`/`detail`/`changes`，不经 `startStep`、不写审计——复制的是已审计的历史步骤，不是新调用。生产代码里 `startStep` 只有 `turn-control.ts:252` 一个调用方。
- web：`tool-summary.ts:16,23` 把 `browser` 步骤从「新建 N 个文件」改计入「其它 N 步」（把 xd 写入算成新建文件本就不对，前端不改）；`runtime-convert.ts:43-44` 把 detail 作 `argsText` 交给 assistant-ui，非 JSON 时其 `parsePartialJsonObject` 退回 `{}`（`@assistant-ui/core` `thread-message-like.ts:208`），既有截断 detail 已是这种情形；`export-markdown.ts:25` 只导出步骤名；`session.browser` 在审计页按通用形式显示（web 没有按 `kind` 的映射）。
- 必须保持：`omp-approval-requests.test.ts:494-498`（`ui-requests.ts` 不得 import `./process|runtime|commands.js`、不得出现 `stdin`）；`omp-runtime-exit-pending.test.ts:696-722`（`xd-browser.ts` 不得含 `extension_ui_response`、不得值导入 `ui-requests.js`；`runtime.ts`/`commands.ts` 不提 `approvalRequest` 等）；`delta-coalescer.test.ts:761`（`events.ts` 引用 `TRUNCATED_MARK`、不复制）；路径不是浏览器设备的普通 `write` 照旧（`session-approvals.test.ts:444`、`fake-omp-composer.test.ts:87,456`、`web/test/chat-runtime-convert.test.ts:47,102`）。现有测试没有任何 `xd://` 用例。

**D7 参考镜像：`deploy/app/`，两 uid，部署方自建。**
- `deploy/app/Dockerfile` 两阶段：构建阶段 `node:24.13.1-bookworm`（与 `.tool-versions` 同一版本）`npm ci`、`npm run build --workspace web`、`npm run build --workspace server`、`bash scripts/omp-fetch.sh`（官方 v18.0.10、SHA256 校验）；运行阶段 `node:24.13.1-bookworm-slim` + `apt-get install --no-install-recommends` 五个 Debian 包 `chromium fonts-noto-cjk fonts-dejavu-core sudo ca-certificates`（容器检查用字体文件路径，不依赖 `fontconfig` 包的 `fc-list`；`setpriv` 属基础镜像的 util-linux，实现时核对），只拷入运行所需产物与 `node_modules` 的生产依赖、omp 二进制到 `/opt/workbuddy/omp`（`0755 root`）。运行期布局为 `/app/node_modules`、`/app/server/{package.json,dist}`、`/app/web/dist` 并列：`repoRoot` 是 `dist/server.js` 往上两级（`server.ts:233`），`server/package.json` 的 `"type": "module"` 必须随 dist 一起拷，否则 ESM 按 CJS 解析；生产依赖只有 `fastify`、`@fastify/cookie`、`@fastify/static`、`yauzl`，用 `npm ci --omit=dev --workspace server`（`node_modules/@workbuddy/server` 是指向 `../../server` 的符号链接，拷贝时一并保留 `/app/server`）。构建上下文是仓库根，没有 `.dockerignore`：本机的 `node_modules`、`var/`（含 darwin 的 `var/omp/omp`，`omp-fetch.sh:42-56` 见哈希不符即 `exit 1`）会被 `COPY . .` 带进去——在 PR 边界内用 BuildKit 认的 `deploy/app/Dockerfile.dockerignore`（只 `COPY` 子目录挡不住 `web/node_modules`、`web/dist` 这类嵌套产物），至少忽略 `**/node_modules`、`**/dist`、`var/`、`resource/`、`.git`、`.workplans/`、`CLAUDE*.md`、`.env*`、`app-reference/`、`kbservice/`。`omp-fetch.sh` 只支持 `Darwin arm64` 与 `Linux x86_64`（`:12-28`），镜像是 `linux/amd64`；Apple 芯片的开发机用 `docker buildx build --platform linux/amd64`。
- 身份（ADR-0010）：`groupadd --gid 10001 workbuddy`；`useradd --uid 10001 -g workbuddy` 应用用户 `workbuddy`、`useradd --uid 10002 -g workbuddy` omp 用户 `omp`（`-M -s /usr/sbin/nologin`，不建家目录、不可登录；omp 的 bash 工具在 `$SHELL` 不是 bash/zsh 时回退到基础 shell，回合实测通过）——主组都是 `workbuddy`（照字面先 `groupadd` 再无 `-g` 的 `useradd workbuddy` 会报组已存在；预览缓存与状态目录的 setgid 位只在进程属于目录所属组时留得住，`dirs.ts:147`；compose 若用数值 `user:` 也不带补充组），uid/gid 钉死（基底已有 `node:1000:1000`，不钉则漂到 1001/1002），宿主挂载目录与 converter 的 `WORKBUDDY_UID/GID`（`converter/compose.yml:19`）按这对数值对齐，system.md 9.8 写明；`/etc/sudoers.d/workbuddy-omp` 两行——`workbuddy ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- /opt/workbuddy/omp *` 与 `Defaults>omp umask=0007`，构建时 `visudo -c` 校验，文件 `0440 root:root`；恰这两行——CI 脚本的 `Defaults:<runner> secure_path=…` 与 `/usr/bin/env` 规则（`ci-uid-isolation.sh:41-45`）是测试探针用的，不进镜像（omp 与 chromium 都走绝对路径，Debian 缺省 `secure_path` 已含 `/usr/local/bin`）；`USER workbuddy`；入口 `deploy/app/entrypoint.sh` 先 `umask 007` 再 `exec node` 启动编译版服务。
- 镜像内固定的环境：`OMP_USER=omp`、`OMP_BIN=/opt/workbuddy/omp`、`BROWSER_BIN=/usr/bin/chromium`、`SANDBOX_ROOT=/srv/workbuddy/sandbox`、`OMP_STATE_DIR=/srv/workbuddy/omp-state`、`DB_PATH=/srv/workbuddy/private/app.db`、`STATIC_ROOT`=镜像内 web 产物、`PREVIEW_CACHE_DIR=/srv/workbuddy/private/preview-cache`（缺省值 repo-root `var/preview-cache` 在只读根下不可写，启动的 `preview_cache` 阶段会失败，`server.ts:555-556,596-602`）、`PORT=3000`、`HOST=0.0.0.0`（缺省 `127.0.0.1`，`server.ts:92`；桥接网络发布端口时连不上；`models.yml` 里的代理地址把 `0.0.0.0` 换成 `127.0.0.1`，`models-yml.ts:62-63`）、`PREVIEW_PORT=3001`（缺省 0 即随机端口，`preview-config.ts:10`，桥接网络下无法发布；`PREVIEW_ORIGIN` 由部署方按对外地址给）。缺省指向仓库根的键恰六个（`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`、`OMP_STATE_DIR`、`SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`），全部钉住；服务启动时创建或写入的每个路径都落在三个挂载或 `/tmp` 下（Chromium 的配置目录在 `os.tmpdir()`，`launch.ts:480-481`，所以 `/tmp` 须对 omp 可写——tmpfs 缺省 `1777`），唯一例外是可选的 `OFFICE_SPOOL_DIR`：配置时服务在 `<spool>/jobs` 建 `0700` 目录（`server.ts:600-601`），它是与 converter 共享的 bind mount（system.md 9.7 第 2 条），由部署方另挂；上游地址与密钥由部署方在运行时给出（不进镜像）。服务没有可配置的认证（只有 dev-stub 与迁移 `010_auth_schema_seed.sql` 预置、口令公开为 `demo` 的演示账号，含管理员 `lisi`，`server/src` 里没有改口令或停用的路径）：compose 注释与 system.md 9.8 端口小节写明真实认证落地前不得对不可信网络放开 `WORKBUDDY_BIND`、反代须自带访问控制（PR #1557 安全席 P1）；认证本身的缺口是范围外的既有问题，另立 issue。
- `deploy/app/compose.yml`：`read_only: true`、`tmpfs: [/tmp]`、`shm_size: 1g`（Chromium 的 `/dev/shm`）、`init: true`、三个可写 bind mount（`${WORKBUDDY_SANDBOX:?}`、`${WORKBUDDY_OMP_STATE:?}`、`${WORKBUDDY_PRIVATE:?}`）、`cap_drop: [ALL]` 加 sudo 降权所需的最小集合（起点 `SETUID`、`SETGID`、`AUDIT_WRITE`，实测定；不得 `privileged`）、`env_file` 由部署方给；`build: { context: ../.., dockerfile: deploy/app/Dockerfile }`（照 converter 写 `build: .` 时上下文是 `deploy/app/`，`COPY` 必然失败）；`ports` 发布 `3000` 与 `3001`，宿主侧绑定地址缺省 `127.0.0.1`（`${WORKBUDDY_BIND:-127.0.0.1}`，对外由部署方放开或前置反代）；healthcheck 内联 `["CMD","node","-e",<fetch http://127.0.0.1:3000/api/healthz，非 200 退出 1>]`（slim 没有 curl/wget，不另加文件）；不分配 tty（不设 `tty: true`、实测不用 `docker run -t`：bookworm 的 `/etc/sudoers` 带 `Defaults use_pty`（#1528 实测第 15 行），有 tty 时 sudo 会插入 monitor 进程，pdeathsig 的保证失效，ADR-0010:70-71）。可写范围即这三个挂载与 `/tmp`——Q5 的落实点。capability 集合（owner 2026-10-19）：起点 `SETUID`、`SETGID`、`AUDIT_WRITE`，**允许**再加 `KILL`——只在实测证明没有它时 SIGTERM 转发失败才加；超出这四项或需要 `privileged` 时停下回 owner。**实测结果（#1528，测试主机）：`SETUID`、`SETGID`、`KILL`**——去掉 `SETUID` 或 `SETGID` 时 sudo 起不来（回合 502），去掉 `KILL` 时转发 `kill(…, SIGTERM): Operation not permitted`、omp 3 s 后仍在；`AUDIT_WRITE` 两项判据都不需要，去掉的代价是 sudo 每次 spawn 在 stderr 写一行 `unable to send audit message`（服务读走不记录）、内核 audit 不留 sudo 记录。理由：退役时应用给 sudo 发 SIGTERM（先关 stdin 等 5 s，`commands.ts:8`、`runtime.ts:705-723`），sudo 以 euid 0 转发给 omp uid 的子进程需要 `CAP_KILL`（`process.ts:126`、ADR-0010:61-69）；转发失败时 3 s 后应用对 sudo 发 SIGKILL、pdeathsig 硬杀 omp，跳过 omp 的 `session.dispose()` 浏览器回收（omp `modes/rpc/rpc-mode.ts:1532-1550`），以 omp uid 运行的 Chromium 留在容器里、应用杀不掉。每个组合的判据两项：(a) 经编译版服务走一次登录与一个回合成功；(b) 信号转发探针——`docker exec -u workbuddy` 手工起 `sleep 600 | sudo -n -u omp -- /usr/bin/setpriv --pdeathsig KILL -- /opt/workbuddy/omp --mode rpc …`（stdin 保持打开，omp 不会因 EOF 自行退出），`kill -TERM <sudo pid>`，从宿主 `docker top` 看 omp 是否在约 1 s 内退出，并保留这次手工 spawn 的 sudo stderr（服务把 omp 子进程的 stderr 读走不记录，`process.ts:412-418`，所以 `/run/sudo/ts`、主机名告警、审计告警只能在手工 spawn 里看到）。`docker stop` 不作判据：容器 PID 命名空间整体销毁，「无残留」恒成立。只读根下 sudo 若必须写 `/run`，用 `tmpfs: ["/run:mode=0755"]`（缺省 `1777` 会让 omp 也能写，扩大可写范围），并同步 browser-runtime「参考部署镜像」的可写范围；若需 `Defaults !fqdn`，它是 sudoers 第三行，停下回 owner（spec 写「恰两条」）。挂载点 mode：app 私有数据目录 `0700`（ADR-0010:37，omp 用户同组却不能动 `app.db`）；沙箱根与状态目录属组 `workbuddy`，由服务启动校正（`3770` / `2750`）。`no-new-privileges` 与 sudo 不能共存，不设（登记）。
- 实测（任务 5.2）：在开发机 `docker buildx build --platform linux/amd64 --network host`（若需）构建，`docker save | ssh … docker load` 传到测试主机运行（S2b 先例）——测试主机磁盘余量小（2026-10-19 约 6 GB），不在上面拉构建基底、不留构建缓存；用完删除镜像、容器与目录。
- system.md 9.7 第 2 条（`system.md:414`）「仓库没有 app 的 Dockerfile」改写为指向 9.8（`:440` 已有，参考镜像部分是追加小节）；converter 与参考镜像仍是两个镜像（Non-Goals）。
- 仓库不发布镜像、不引用镜像仓库（同 converter 先例）。新基底镜像与五个 Debian 包按 `AGENTS.md:40` 在 PR 说明。

**D8 真浏览器验证：CI job `browser-image`。** `runs-on: ubuntu-24.04`、`timeout-minutes: 20`：checkout → setup-node（同其它 node job 的 `with`）→ `npm ci` → `docker build -t workbuddy-app:ci -f deploy/app/Dockerfile .` → `bash .github/scripts/ci-browser-image.sh`（verification-harness 的计数 11/9 即按此）。脚本：
1. 对镜像跑 browser-runtime「镜像可构建且身份正确」的全部检查（组 5 只在测试主机人工预跑，持续门禁在这里）。
2. 建三个挂载目录，属主为容器内 `workbuddy` 的数值 uid:gid（私有数据 `0700`），准备一个只读挂进容器、不在 `PATH` 上的浏览器包装脚本（执行时在 `/tmp` 留标记再 `exec /usr/bin/chromium`），以 `BROWSER_BIN=<包装脚本>` 覆盖——镜像里 `/usr/bin/chromium` 在 `PATH` 上，omp 即使没收到 `PUPPETEER_EXECUTABLE_PATH` 也会自己找到它，只有包装脚本的标记能证明 D4 生效。
3. 以 compose 同样的安全标志 `docker run`（`--network host` 访问回环上的假上游），`MODEL_CATALOG` / `MODEL_VISION` 不设。
4. `node .github/scripts/ci-browser-e2e.mjs`：进程内 `start({toolRoundScope:"turn"})` 起假上游（同一会话第二个回合的历史里已有 `tool` 消息，缺省作用域会把 `SHOT` 回合当成答复轮；单独进程的假上游只能用缺省作用域），对容器里的服务走：登录 → 建工作空间并上传 `index.html` → 建绑定该空间、档位 `write` 的会话 → 发 `WORKBUDDY_BROWSER_OPEN:file://<空间根>/index.html` → 允许 → 回合结束 → 同一会话发 `WORKBUDDY_BROWSER_SHOT` → 允许 → 回合结束（标签页属 omp 进程，两回合之间不得触发进程退役；任务 6.1 核对 pool 的退役条件）。
断言：browser-runtime「真实浏览器打开工作空间页面并截图」的全部条目——审批与步骤名、title / detail 首行、截图 `changes` 与文件、第二回合请求里有 `image_url`（看图链路，依赖组 4）、两条 `session.browser`、包装脚本标记、`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在（`puppeteer/` 本身每次无头启动都会建、写一个 `package.json`，`launch.ts:138`）、omp 日志无 `Downloading Chromium for puppeteer`。`all-checks-passed.needs` 加它；`scripts/test-ci-harness.sh` 与 `AGENTS.md` Enforcement Index 同步（`constraints.yaml` 不改）。

**D9 假上游的两个浏览器标记与 omp 的图片附件消息。** omp-test-harness 新增要求：`WORKBUDDY_BROWSER_OPEN:<url>`（`<url>` 取冒号后到下一个空白或文本末尾）使工具轮发一个 `write` 调用，`arguments` 为 `{"path":"xd://browser","content":"{\"action\":\"open\",\"url\":\"<url>\"}"}`；`WORKBUDDY_BROWSER_SHOT` 发 `{"path":"xd://browser","content":"{\"action\":\"run\",\"code\":\"return await tab.screenshot()\"}"}`（`tab.screenshot()` 见 omp `docs/tools/browser.md:91,135`）。优先级：错误标记照旧最先；`WORKBUDDY_WRITE` 与 `WORKBUDDY_TODO` 先于两个浏览器标记（带它们的请求逐字节不变，免改既有要求的承诺）；`OPEN` 先于 `SHOT`；空 `<url>` 不算标记。不带这两个标记的请求逐字节不变。另：紧跟 `tool` 消息、`content` 为数组且首元素恰为文本 `Attached image(s) from tool result:` 的 `user` 消息是 omp 补的图片附件，轮次判定（两种作用域）与最后一条 user 文本的查找都跳过它——否则看图开启后截图回合的答复轮会被当成新的工具轮、发出缺省 bash 调用并停在第三次审批上（Context「看图」）。不改假 omp（它的模块集合由规格钉死，浏览器帧的单测用纯函数的帧常量即可）。

**组 2 兄弟面与必须保持（开工核对，#1527）**：
- overlay 字节的钉点：`omp-layout-helpers.ts:31-67`（`HOST_OVERLAY_YAML` 字面量与 `expectHostOverlay` 的 0640 + 全等）、`omp-host-overlay.test.ts:64-82`（解析后的完整对象 `toEqual`）及其 `:58,89,94,122`、`server-startup-layout.test.ts:121,272`；`writeHostOverlay` 的直接调用除四个调用方外还有 `omp-host-overlay.test.ts:54,87,88,93,101,130`。只看路径或阶段名的（`omp-process`、`omp-spawn-cwd`、`omp-spawn-dotenv-pins`、`server-assembly`、`server-startup-failure-reason`、`server-startup-order`、`linux/uid-isolation` 的前后字节对比）不受字节变化影响。状态布局校验（`state-layout.ts`）不读 overlay 内容。仓库里没有别处写 `browser.*` 或 `modelRoles`。
- 官方二进制清单：`.github/scripts/ci-uid-isolation.sh:292`（现 8 个用例）由 `scripts/test-ci-harness.sh:92`（内嵌期望行）与 `:841`（`grep -F`）逐字钉住，两处同步。
- 假上游「最后一条 user 文本」查找（`lastUserTextFrom`，`fake-upstream.mjs:423-431`）同时供错误标记（`:180`）、失败脚本（`:188`）、`serveFinal` 的 THINK / UI_WALK 闸门（`:201-205`）、PACE 与 `toolRoundCall` 使用：图片附件消息的跳过规则放在这一处，全部使用方一起生效；无附件消息的请求逐字节不变（既有标记测试照旧绿）。新标记插在 TODO 之后、缺省 bash 之前。
- 本组未选、留给后续组：`browser.relayUrl` 未钉（只在钉不住的工具参数 `app.relay:true` 下生效），在 ADR-0012 补充里顺带登记。
- 红检查的副作用：在未改动代码上跑「未配置浏览器时浏览器调用失败且不下载」时 `browser.enabled` 缺省为真，macOS 会真的去下载约 181 MB 的 Chrome-for-Testing——红检查用带超时的一次性状态目录，跑完删掉。

**组 3 兄弟面与必须保持（开工核对，#1529）**：
- resolver：`agent-config.ts:74-144` 的可选键用展开写法，键缺席时对象上没有这个属性（`:112-115`）；`resolveOwnedPath`（`:146-159`）会把相对路径拼到仓库根，与 `BROWSER_BIN`「必须绝对」相反，不能复用。仓库里没有现成的「绝对路径 + 可执行普通文件」校验，形状照 omp `tools/browser/launch.ts:262-272` 的 `isExecutableFile`（`statSync().isFile()` + `accessSync(X_OK)`）；两者的原生报错带路径，必须 `try/catch` 后改抛只点名键的固定消息。编译入口 `server.ts:383-391` 吞掉 message，所以点名键只能在 `resolveServerConfig` 的抛错层测；编译入口非法值的写法照 `omp-max-processes-config.test.ts:248-275`；缺席的写法照 `server-config.test.ts:458-462`（`toBeUndefined()` 与 `Object.hasOwn(...) === false`）。
- 配置键清单没有测试钉（只在 http-service-skeleton 规格正文里，基线 35 项）；只合入组 3 时为 36 项，两组都合入后为 delta 的 37 项。
- `writeHostOverlay` 已带 `browserEnabled` 参数（`server.ts:546-550` 现传 `false`，注释写明等组 3）；`server-startup-overlay.test.ts` 与 `omp-layout-helpers.ts:62-79` 的 `hostOverlayBrowserBlock(enabled)` 已参数化，「浏览器块随 BROWSER_BIN」直接复用，`host-overlay.ts` 不改。
- `runtime.ts` 现 799 行，接 `browserBin` 至少四处（接口 `:71`、私有字段 `:118`、构造 `:152`、`openProcess` 的展开 `:435`），裸字段必超。定为：公开选项形状不变——`SessionRuntimeOpts` 保持扁平、只加 `browserBin`（+1 行，到 800；实现时 `ompUser`、`browserBin` 都声明为 `?: string | undefined`——三个测试文件把 `tempOpts()` 的 `OmpProcessOpts` 展开进 `SessionRuntimeOpts`，`exactOptionalPropertyTypes` 下要求两边同形，#1529），`ompUser` 的现有调用方（`server.ts:145`、`pool.ts:241`、`supervisor.ts:85`、`session-supervisor.test.ts:63`、`linux/uid-isolation.test.ts:349-360`、三个官方夹具）不改；私有字段 `:118`、构造 `:152`、`openProcess` `:435` 三处把 `ompUser`/`browserBin` 合成一个私有的 spawn 身份对象，净增 0 行：`SpawnOmpOpts` / `OmpProcess` 选项把两者声明为 `?: string | undefined`（`tsconfig.base.json:8` 开了 `exactOptionalPropertyTypes`），构造里一行 `this.#spawnIdentity = { ompUser: opts.ompUser, browserBin: opts.browserBin };`，`openProcess` 里 `...this.#spawnIdentity`，`spawn-env.ts` 以 `!== undefined` 判断。`runtime.ts` 不新增 import 名（`:39-44` 是一行一个名字的写法，加一个名字就到 801）。合计 800 行；仍放不下时停下报告，不压缩既有代码。
- 钉点见 Context「spawn 环境」：精确钉的随新契约改断言，不删；`linux/uid-isolation.test.ts` 的子集断言加 `PI_BROWSER_RELAY`、`PI_BROWSER_CMUX`（恒在），不加 `PUPPETEER_EXECUTABLE_PATH`（该 job 不设 `BROWSER_BIN`）。
- 必须保持：env 不继承 `process.env` 的其它键（只取 `PATH`、`LANG`、`TMPDIR`）；`TMPDIR=<值>` argv 元素的位置与有无；未设 `OMP_USER` 时直连 argv 不变；fork / regenerate 不另起 argv/env 组装。

**组 4 兄弟面与必须保持（开工核对，#1530）**：
- 解析：`model-catalog.ts:57-61` 单模型分支，照 `:58` 的 `resolveOnOff(env.MODEL_REASONING, true, "MODEL_REASONING")` 加 `MODEL_VISION`；互斥检查照 `:65-67`（先 `parseCatalog`，再查 `env.MODEL_VISION !== undefined`，空串也算设置，消息不含 `MODEL_CATALOG`/`MODEL_ID`，同 `model-catalog.test.ts:271-277`）。`models-yml.ts:57`、`server.ts:549`、`rest-composer.ts:50`、`model-picker.tsx:136` 都按 `vision` 字段自动跟随，不改。`app.ts:211` 无白名单时调 `resolveModelCatalog({ MODEL_ID })`，所以 `openWorld(..., "default")` 也得到 `vision:true`。
- 会因缺省翻成 `on` 变红的断言（`vision:false` 的 grep 抓不到后两层）：解析层 `model-catalog.test.ts:65,75,92,361,374`、`server-config.test.ts:94`（就地改，不增行）、`server-config-model-id.test.ts:87`；编译入口 / app 层 `model-proxy-reasoning.test.ts:217-247`（`:233-247` 即 thinking-fold「关闭 reasoning」，按 delta 加 `MODEL_VISION=off`）、`server-startup-layout.test.ts:65-77,120-121,244,272-273`（`expectManagedModels` 与 `expectHostOverlay` 的隐式缺省）、`server-startup-order.test.ts:113-131`、`server-startup-overlay.test.ts:93-115,174-211`、`session-composer-options.test.ts:67,69`（经 `session-meta-fixtures.ts:57-70` 的 `DEFAULT_COMPOSER_OPTIONS`）、`smoke/session-meta.hurl:206,310`。缺省配置的编译入口用例改为显式期望 `input` 三行与看图块 `workbuddy/<MODEL_ID>`（`omp-layout-helpers.ts:79` 的 `HOST_OVERLAY_YAML` 不再是缺省部署的字节，调用点显式传 `HOST_OVERLAY_YAML + hostOverlayVisionBlock(MODEL_ID)`），不靠加 `MODEL_VISION=off` 绕开；omp-runtime「看图块随白名单」第一例归 `server-startup-overlay.test.ts` 新加的一条冷启动用例，它不传 `MODEL_ID`（该文件其余用例都传 `:24` 的 `MODEL_ID`），期望 `HOST_OVERLAY_YAML + hostOverlayVisionBlock("deepseek-v4.1-flash")`，与 spec 字面量一致；`omp-host-overlay.test.ts` 直接调 `writeHostOverlay`、表达不了 `MODEL_VISION`，不放该场景；`models-yml-helpers.ts` 加一个在单模型条目末尾追加 `input` 三行的辅助函数。`server-startup-overlay.test.ts:117-151` 已传 `MODEL_VISION:"off"`、今天绿只因键被忽略，不算红绿证据。
- 注释同步：`omp-layout-helpers.ts:30-31`、`omp-host-overlay.test.ts:31` 不再把「无看图块」叫缺省部署；`server/test/session-meta-fixtures.ts:54-55` 声称与 `web/test/session-meta-fixtures.ts:28` 逐键相同——web 夹具不改（它经 `composerOptionsRoute()` 喂 `web/test/chat-model-picker.test.tsx:602-610`，翻成 `true` 会让该处钉的 `["deepseek-v4.1-flash推理"]` 变红，fixture 审查 P1），只改 server 侧这句注释，说明两边自 #1530 起 `vision` 不同；web 不在本组边界。`smoke/session-meta.hurl:20-21,203` 的前提注释补「未设 `MODEL_VISION`、看图开」。
- 配置键清单没有测试钉；新文件 `server/test/server-config-vision.test.ts` 覆盖缺省 / `on` / `off` / 四个非法值 / 与 `MODEL_CATALOG` 同设（照 `server-config-browser.test.ts`），编译入口一例非法值，以及 model-proxy 的启动期三种取值（缺省 / `on` / `off` 写出的 `models.yml`；或放进 `model-proxy-reasoning.test.ts`，现 248 行，同类 `MODEL_REASONING` 用例在 `:100,180`）。合入后清单 37 项。
- 文档：9.3 的 `:255` 标题「四项都可选」、`:263` 配置表、`:286`（单模型一句加 `MODEL_VISION`，缺省 `on`、`vision` 取其值）、`:288`（「同时设置 `MODEL_REASONING` 则启动失败」并列 `MODEL_VISION`）；9.8 `:481`「单模型配置 `vision` 为假，所以缺省部署没有这两行」同改。升级提示另写一句：当前模型能看图时 omp 不注册 `inspect_image`，`read` 读图片直接返回图片（`utils/inspect-image-mode.ts:37-40`），缺省部署里助手少这一个工具。
- 验收清单：新增 CH-122；CH-73（`functional-checklist.md:140`，已签「通过」）的缺省配置期望「只有一项…带「推理」标签」在缺省 `on` 后不再成立——前提补「也没有设置 `MODEL_VISION`」、期望改「带「推理」「看图」两个标签」，结论按 AGENTS.md:169 改回 `待签`（PR 边界随之含该行）。
- `make smoke-live`（`Makefile:84-88`）只发文本回合，绿只说明真实上游在带 `input: [text, image]` 的 `models.yml` 下仍接受普通回合；图片输入由 CH-122 人工验。官方二进制测试辅助都写死 `vision:false` / `visionModelId:null`（`support/omp-official.ts:233,243`、`omp-official-proxied.ts:147,151`），所以 CI `make smoke` 是真实 omp 第一次带 overlay 的 `modelRoles.vision` 与 `input:[text,image]` 跑缺省部署。

**D10 两个 change 的次序。** 本 change 的 model-selection 与 model-proxy delta 以 `epic-acceptance-followups` 的同名 delta 为底本（`maxTokens` 已在其中），实现上组 4 依赖 #1522 先合入，归档时 `epic-acceptance-followups` 先归档。

### 通用纪律

- 测试先行：每组先改测试并在未改动代码上看到红；既有的精确断言（env 键集、`--preserve-env` 字符串、overlay 字节、单模型 `models.yml` 字节、`smoke/session-meta.hurl` 响应体）改成新规格的断言，不删。
- 开工核对：每组第一个任务核对本 design「Context」的行号与事实，出入先改 design 再继续。
- 公开仓库卫生：测试主机地址、账号、密钥不进任何被跟踪文件（含 PR 正文与镜像配方）。
- 「omp 子进程治理」「沙箱与文件边界」两条 Critical Path 被触及：组 1（审批改写与审计）、组 3（spawn 环境与 sudo 前缀）的 PR 请求人工白盒审查。
- 验收清单随组走（AGENTS.md:169）：改变用户可见行为的组在同一 PR 新增或改写对应行，结论 `待签`。

## 规格影响

见 proposal「Modified Capabilities」与「New Capabilities」。

## Risks / Trade-offs

- [不限制访问范围：浏览器能读 omp 用户能读的一切（`file://`）、访问内网与元数据地址] → owner Q2 明确接受；确认卡写明地址（`write` / `always-ask` 档）、每次调用写 `session.browser` 审计（三档都写）、omp 用户与容器挂载限定可见与可写的文件。
- [`yolo` 档下浏览器调用不经确认] → 与 bash 同级，是该档位的既有含义；审计是唯一痕迹，因此审计取完整参数（D6）。
- [`app.path`（含 `app.args`）启动任意可执行文件、`app.cdp_url` 连外部浏览器] → 工具参数钉不住；卡上 ⚠ 行与审计 `external` 字段显著标出；登记为残余（ADR-0012 补充）。`app.relay` 由 spawn env 的 `PI_BROWSER_RELAY=0` 关掉（D4，#1529），卡与审计仍照参数标出，多报不漏报。
- [其它未被宿主设置的 `PI_*` / `OMP_*` 变量仍可经工作目录 `.env` 注入] → ADR-0012 既有残余，无法穷举；本 change 只钉浏览器的两个开关（D4）。
- [截断的审批 `Content` 无法解析、`app` 可能被截掉] → 卡片退回原文，并固定带一行「参数被截断，无法确认是否启动外部程序或连接外部浏览器」；步骤 detail 与审计用 `tool_execution_start` 的完整参数，不受此影响。
- [omp 改了 `xd://` 路径的解包规则或 hashline 前缀剥离规则] → `isBrowserDevicePath` 与 `parseBrowserContent` 的剥离都照搬 omp 并注明来源（`plan-mode-guard.ts`、`internal-urls/`、`hashline/src/prefixes.ts`）；升级 omp 须重核（同 overlay）。
- [照搬的 `read` 元数据正则（`hashline/src/prefixes.ts` `READ_TRUNCATION_NOTICE_RE`）对特制的单行仍是平方级] → 剥离只在文本不超过 16384 个码元时做，实测近 16384 字符的特制行约 113 ms、每行查两到三次，最坏几百毫秒且有上限；行号前缀正则已改成等价的线性写法（PR #1540 修复 1）。登记为残余。
- [omp 的参数修复（`validateToolArguments`）比宿主的「规范」判定认得多] → 不照搬修复，不规范即无法确认（多判只多一行警示与一个审计标记）；「规范」收紧到 omp 首轮校验必然通过（`action` 必填、枚举取值精确、`viewport` 形态精确——PR #1540 复审 1：枚举只查「是字符串」时，夹带 `</arg_key>` 的取值让首轮失败、spill 修复拆出 `app`），修复只在首轮失败后运行，所以规范的参数两边看到的字段一致。升级 omp 时与 schema 一起重核。
- [审计 `detail` 无长度上限（`core/audit/index.ts:55`），`url`、`external.args`、`cdpUrl` 全长写入] → 与审批 `title` 同样不截；接受。
- [审批 title 的 `Path:` 也会被 omp 截到 2000 码元（`approval.ts:258-262`）：浏览器设备路径后接近两千个填充字符时，审批侧看到的是截断路径、判为 `write`，步骤侧用完整参数判为 `browser`，按名配对错开、该审批滞留] → 审计不受影响（来自步骤侧的完整参数）；只是卡片退回普通 `write` 原文且配对滞留，需要模型刻意构造超长路径，登记为残余。
- [`MODEL_VISION` 缺省 on 改变既有部署] → system.md 升级提示；上游不支持图片输入的部署写 `off`。
- [相对 `screenshotDir` 的落点未实测] → 任务 2.3 先测；不成走 D2 的退路（状态目录，owner Q5）。
- [截图写进用户工作空间的 `screenshots/` 目录] → 这正是 Q5「截图目录指到工作空间」；会进入回合快照与撤回范围，与其它写入的文件同等对待。
- [`BROWSER_BIN` 指向的文件运行期被删] → omp 对非空的 `PUPPETEER_EXECUTABLE_PATH` 原样使用、不查存在（`launch.ts:192-194`），浏览器启动失败而不是退回自动发现或下载（#1529 实测：包装脚本非零退出时结果为 `Shared browser daemon unavailable`）；容器只读根下不会发生，登记。
- [容器内 sudo 需要的 capability 集合] → D7 给起点并允许 `KILL`（owner 2026-10-19，实测需要才加），以「回合成功 + 信号转发探针」逐项定；实测为 `SETUID`、`SETGID`、`KILL`（#1528），不含 `AUDIT_WRITE`。持续门禁由组 6 的 CI job 以同一组标志运行。
- [只读根下 fontconfig 无可写缓存] → omp 的 `XDG_CACHE_HOME` 根是 `2750`、omp 只能写其下 `omp/`，`/var/cache/fontconfig` 只读：Chromium 每次启动可能重扫 Noto CJK。5.2 以 omp 身份跑一次 `chromium --headless --no-sandbox --screenshot=/tmp/x.png about:blank` 计时、看有无 `No writable cache directories`；需要构建期 `fc-cache` 时要第六个包 `fontconfig`，停下按 AGENTS.md:40 说明后再加。
- [CI 两回合之间 omp 进程被退役、标签页丢失] → 两回合背靠背；任务 6.1 核对 pool 的空闲退役条件，必要时 job 内调大 `OMP_IDLE_MS`。
- [CI job 时长与 runner 上的 Docker 构建缓存] → `timeout-minutes: 20`；不引入缓存服务。

## Migration Plan

- 升级后未设 `BROWSER_BIN` 的部署：浏览器工具消失（以前会超时失败），无其它变化。
- 未设 `MODEL_CATALOG` 的部署：单模型变为能看图（`models.yml` 多 `input` 三行、`GET /api/composer/options` 的 `vision` 为 `true`、选择器出现「看图」）；不想要写 `MODEL_VISION=off`。
- `OMP_USER` 部署：sudoers 不需改（`SETENV:` 已允许保留环境）；`BROWSER_BIN` 指向的文件须 omp 用户可执行。
- 所有部署：omp 子进程恒带 `PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`，部署方或工作目录 `.env` 里的这两个变量不再起作用（宿主本就不支持中继与 cmux）。
- 回滚即 revert；overlay 下次启动按旧字面量重写。

## Not yet specified

- 截图目录在工作空间里会随回合累积，清理策略（按数量 / 按时间 / 交给用户）现在说不清——要先看真实使用里截图的量。

## Sketch seams under test

- 组 1：`approvalRequest(frame, id)`、`applyFrame(state, frame)`、`fileChangeCandidates(name, result)` 三个纯函数与新的 `xd-browser.ts`（帧常量取自 Context 所列的 omp 源码形状）；审计经 `session-approval-script.ts` 一类的脚本化子进程走 supervisor 的整体挂载（新测试文件）。
- 组 2：`writeHostOverlay` 的输出字节（`omp-host-overlay.test.ts`）与编译入口的 overlay（`server-startup-layout.test.ts` 经 `omp-layout-helpers.ts`）；假上游帧（`fake-upstream-*.test.ts`）；官方二进制对照用例（overlay 被接受、未配置浏览器时不下载）。
- 组 3：`resolveAgentSettings(env, repoRoot)`（新的 `server-config-browser.test.ts`）；spawn 的 argv/env 捕获（`omp-spawn-dotenv-pins.test.ts`、新的 `omp-process-browser.test.ts`）；装配级捕获（新文件，照 `server-assembly.test.ts:261` 的 configured/unset 写法）；官方二进制对照用例「工作目录 .env 不能打开浏览器中继」（`omp-official-browser.test.ts`；夹具 `openOfficialWorld`（`test/support/omp-official.ts`）加 `browserEnabled` / `browserBin` 选项，正例走产品的 `browserBin` 接线，`PUPPETEER_EXECUTABLE_PATH` 指向写标记的包装脚本，不需要真浏览器；入库的负向对照照 `omp-official.ts:100-107` 的 `rewritingSpawn` 加一个只在测试里用的 spawn 包装，从 env 删掉两个钉）。
- 组 4：`resolveModelCatalog(env)`（`model-catalog.test.ts`）、`writeManagedModelsYml` 的输出字节、编译入口 overlay 的看图块、`GET /api/composer/options`、`smoke/session-meta.hurl`。
- 组 5：测试主机 docker 上的构建与容器内检查。
- 组 6：容器里的端到端驱动（`ci-browser-e2e.mjs`）对着真实 omp + Chromium + 假上游；`scripts/test-ci-harness.sh` 的合同与变异。

## 行数预算（800 行硬上限；`scripts/size-guard.sh` 扫 `server/src`、`server/test`、`web/*`、`kbservice/*`、`converter`）

| 文件 | 合入后上限 | 组 |
|---|---|---|
| `server/src/sessions/omp/xd-browser.ts`（新，含照搬的 hashline 剥离与「规范」判定） | ≤ 260 | 1 |
| `server/src/sessions/omp/ui-requests.ts`（现 45） | ≤ 90 | 1 |
| `server/src/sessions/events.ts`（现 540） | 现有 + ≤ 20 | 1 |
| `server/src/sessions/file-changes.ts`（现 103） | ≤ 140 | 1 |
| `server/src/sessions/turn-control.ts`（现 322）、`store-segments.ts`（现 195） | 各现有 + ≤ 30 | 1 |
| `server/src/sessions/store.ts`（现 784）、`supervisor.ts`（现 782） | ≤ 800；审计逻辑不加在这里，`store.ts` 只在 `startStep` 委托处把 `options.emit` 传下去（≤ 2 行），`supervisor.ts` 只加 `browserBin` 透传 | 1、3 |
| `server/src/sessions/omp/runtime.ts`（现 799） | ≤ 800；`browserBin` 放不下时把 spawn 身份 / 环境类选项（`ompUser`、`browserBin`）收成一个对象透传或抽到同目录新文件，不压缩既有代码 | 3 |
| `server/src/sessions/omp/host-overlay.ts`（现 69） | ≤ 110 | 2 |
| `server/test/support/fake-upstream.mjs`（现 649） | 现有 + ≤ 40 | 2 |
| `server/src/agent-config.ts`（组 3 后 272，组 4 不改）、`server/src/model-catalog.ts`（现 259） | 各现有 + ≤ 25 | 3、4 |
| `server/src/sessions/omp/process.ts`（现 793） | ≤ 800；env 组装与 `--preserve-env=` 常量抽到新文件 `server/src/sessions/omp/spawn-env.ts`（≤ 80），不压缩既有代码 | 3 |
| `server/test/server-config.test.ts`（现 795）、`omp-process.test.ts`（现 787）、`server-assembly.test.ts`（现 776）、`session-events.test.ts`（现 721） | 不再往里加，新用例进新文件 | 1、3、4 |
| `deploy/app/Dockerfile` ≤ 60、`compose.yml` ≤ 50、`entrypoint.sh` ≤ 20 | — | 5 |
| `.github/scripts/ci-browser-image.sh` ≤ 200、`ci-browser-e2e.mjs` ≤ 300 | — | 6 |

## Traceability

- owner 裁决：本会话 2026-10-18 grill Q1–Q11 + 收敛确认；账本 `.workplans/batch-33-35-owner-items.md`（本地）。
- 事实基线：omp v18.0.10 源码 `33cc6b9a`（Context 所列路径）；验收日志（超时与下载进度，本地）。
