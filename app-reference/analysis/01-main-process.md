# WorkBuddy 主进程（Electron Main + Preload + 资源 Preload）结构分析报告

> 目的：理解 WorkBuddy 桌面应用（macOS Electron，v5.4.2）主进程的启动链路、模块地图、IPC 通道、服务架构、认证凭证、数据存储、安全机制与 CLI 桥接。只读分析，基于编译后产物（esbuild/rolldown bundle）与其内嵌的 `//#region src/...` 源码注释。
> 路径基准：`app-reference/app_asar/`。所有行号均为分析时的实际文件行号。
> 标注 `[INFERENCE]` 处为推断，其余为注释/代码直接证据。

---

## 0. 结论先行（TL;DR）

- **启动链路**：`index.js` 是唯一主进程入口，本质是 `WorkbuddyDesktopApp.main()`。分「whenReady 前 Layer1」+「whenReady 后 Layer2」，再由 `bootstrapMainProcess()` 驱动的 **StartupPipeline 六阶段状态机**（PreAppInit→AppConfig→WindowBringup→DaemonBringup→RendererReady→PostReady）做深度装配。
- **主进程不是 HTTP server**：主进程内 no `http.createServer` / `net.createServer` / `listen()`。真正的业务后端是 **daemon 子进程**（`daemon-app-server-entry.js`，以 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 二进制执行），与主进程通过 **stdio 帧（JSON-Lines over stdin/stdout）** 通信（`workbuddy-server` 的 `stdio-server/stdio-connection/stdio-framing`）。仅 agent-cli sidecar 才起 `127.0.0.1` 随机端口 HTTP `/api/v1/*`。
- **IPC 分两层**：preload `contextBridge` 暴露给 renderer 的「宿主桥」（`workbuddy:*` 通道 + `wb:invoke` 泛型 RPC）；以及 renderer→main→daemon 的领域 RPC（`auth:*`/`session:*`/`chat:*`/`cli:*`/`docs:*`/`filesystem:*` 等，经 `wb:invoke` 或 daemon-frame MessagePort 到达 daemon celljs 模块）。
- **认证真源在 daemon**：`module.app-server.js` 的 `WorkbuddyBootstrapAuthenticationStorage` / `WorkbuddyAuthenticationManager`；token 用 `credential-protection.js` 的**at-rest 加密**（32 字节对称密钥 + AES-GCM，`request/response` 字段级加密，密钥来自 `electron.workbuddyStorage.loggerGet()`，即原生层注入的 keychain 密钥）后落盘到**共享数据目录** `CodeBuddyExtension/Data/Public/auth/<authenticationId>.info`（macOS `~/Library/Application Support/...`，供 CLI 子进程共享读取）。
- **存储**：SQLite `~/.workbuddy/workbuddy.db`（better-sqlite3 + drizzle-orm），表：`sessions`/`workspaces`/`automations`/`automation_runs`/`automation_runtime_state`/`automation_delivery_outbox`/`session_usage`/`migration_meta`。
- **安全**：fs-protection 猴子补丁保护凭证/日志不误删；Windows-only log-acl-guard 给日志目录加 NTFS deny-delete ACL；gateway-secret 修复 sidecar REST 未授权 RCE；crash-reporter 同步写崩溃日志。
- **CLI 桥接**：`cli-prewarm-pool.js` 预热 `cbc`（agent-cli）进程池，`process-reap-utils.js` 用 control/data socket 做 sidecar JSON-RPC + 进程树对账。

---

## 1. 启动链路：初始化顺序

### 1.1 入口（`main/index.js` 尾部，约 `:33000-33031`）

`index.ts` 只保留三段（见 `:32059-32063` 注释）：
1. **副作用 import**（顺序敏感，必须在一切重型 import 前）：
   - `early-open-url-capture`（`:82-182`）：模块加载即 `app.on('open-url')` 同步注册，buffer 冷启动早到达的 `workbuddy://` URL，`setHandler` 后一次性 drain。macOS 专用，解决冷启动深链丢失（Issue #40430/#36686）。
   - `early-open-file-capture`（`:378`）：等价地捕获 macOS `open-file`（微信 ZIP 传文件）。
   - `startup-reset-zoom`（`:329`）、`fs-protection.js`（`require("./fs-protection.js")`，首行即猴子补丁）。
2. **早期打点段**（A1~A6）：`repairHomedirIfBroken`（homedir-guard，`:183-328`，防御中文用户名乱码 HOME）→ `installEarlyExceptionHooks` → `initMainStartupContext` → `installCrashWriter`（crash-reporter）→ `startShellEnvLoad` → `logger.initialize`。
3. **`new WorkbuddyDesktopApp({ crashWriter, startupLog }).main().catch(...)`**（`:33016-33026`），失败则 `app.exit(1)`。

`index.js` 是单文件 bundle（33k 行），内含全部主进程模块，按 `//#region src/main/...` 分节。

### 1.2 `WorkbuddyDesktopApp.main()`（`:32150` 起）—— 装配顺序

**whenReady 前（Layer 1）**：
1. `loadMainCredentialProtectionBootstrap(...)`（`:32152`）：读 at-rest 加密 mode 与密钥（`electron.workbuddyStorage.loggerGet()`），不存在则 `disabled/missing-key`。
2. `applyFfmpegGuard()`（`:32163`）：Windows 校验 ffmpeg.dll，缺失则置 `ffmpegFatalBail` + 弹框退出。
3. `applyCliCommandLineSwitches()`：CLI 开关（debug 等）。
4. `applyProxyAndTlsBootstrap()`：代理 + TLS 免校验（`tls-verification.js`）。
5. `applyElectronAppConfiguration()`：Chromium/协议等静态配置。
6. `registerPreReadyIpcAndBridges()`（`:32178`）：一次性注册 ~22 条 pre-ready IPC（见 §3）+ 腾讯文档 debug handler。
7. `registerDeepLinkSchemes()`（`:32180`）：`workbuddy://` scheme 注册（`getRegisteredDeepLinkSchemes`）。
8. `setupEarlyOpenUrlFileHandoff()`（`:32181`）：把 buffer 的 open-url/open-file 交给 `DeepLinkRouter`/`OpenFileRouter`。
9. `runEarlyPreflightAndMaybeBail()`：极早期 preflight（`requestSingleInstanceLock` 之前，`:31054` 起）。
10. `acquireSingletonLock()`（`:32183`）：`app.requestSingleInstanceLock()`；失败即退出（RepairApp 接管）。
11. `processInitialArgvAndSetupSecondInstance()`（`:32185`）：冷启动 argv 挑深链 URL + 挂 `second-instance` handler（热启动 / focus 已有窗口 / `ensureMainWindow`）。
12. `await app.whenReady()`（`:32186`）。

**whenReady 后（Layer 2）** `onReady()`（`:32189`）：
- `runPostReadyPlatformHooks` / `configureRendererSessionProxy`（persistedProxyMode）。
- `new SplashOrchestrator(...)`：管理 splash 窗口（`main/splash/splash.html` + `splash-preload.js` + `claw.png`）。
- **P1 UI 前置**：`_p1UiPrelude`（应用菜单 + bootstrap 卡死看门狗 `bootstrapQuitGuard.armStallWatchdog()` + splash 消息初值）；`_p1EnsureVendorAssets`（解压 vendor，如 PortableGit，首次 30–90s，写 `CODEBUDDY_CODE_GIT_BASH_PATH` 等 env）。
- **P2 引擎装配**：`_p2Bootstrap`（调用 `bootstrapMainProcess(...)`，见 §1.3）；`_p2AwaitMigrationAndCloseSplash`（等 history 迁移/DB 修复，无进展看门狗）；`_p2EnsureMainWindowIfNeeded`。
- **P3 收尾**：`_p3DrainPendingDeeplinks`（回放 deep-link/open-file 队列）；`_p3CleanupStaleFiles`（清理微信 ZIP）；`_p3FlushPendingTelemetry`（flush repair/install/update/fs-protection 5 组）；`_p3StartLogAclGuard`（Windows 日志 ACL 守护）；`_p3InstallInspirationCodeClipboardWatcher`（`$12345678$` 口令）；`_p3LoadDevToolsExtension`；`_p3SchedulePostBootstrapTasks`。
- 成功/失败走 `handleBootstrapFailure`（关 splash / fallback 建主窗 / 弹「启动失败」对话框）。

### 1.3 `bootstrapMainProcess()`（`:23548` 起）—— 深度装配 Pipeline

`main-bootstrap.ts` 三件事：装配 StartupLifecycle 状态机 → 声明式注册 StartupPipeline step → 产出 `createMainBootstrapHandle`。

**阶段顺序**（`startup-phase.ts` `:488-572`）：`PreAppInit → AppConfig → WindowBringup → DaemonBringup → RendererReady → PostReady`。状态机迁移：`init→app-ready→window-created→daemon-connecting→daemon-ready→renderer-mounted→ready`（`STARTUP_STATE_TRANSITIONS` `:525`；`daemon-ready` 由 wire-daemon 握手显式驱动，`renderer-mounted/ready` 由 `renderer:ready` IPC 驱动）。

**Pipeline 注册的全部 step**（`:23568-23624`）：
`createPlatformStep` / `createWindowManagerStep` / `registerDesktopHostIpcStep` / `installWbInvokeStep` / `ensureMainWindowStep` / `createDatabaseStep` / `initCellJSContainerStep` / `bindDaemonProvidersStep` / `resolveCellDepsStep` / `setupAuthAndSidecarStep` / `startCrashExporterStep` / `initializeDatabaseStep` / `createMonitorServiceStep` / `runStartupMigrationStep` / `mergeFallbackAndRepairStep` / `prepareDaemonContextStep` / `selectDaemonRuntimeStep` / `wireDaemonBridgesStep` / `wireWbInvokeStep` / `createDesktopDaemonStateStep` / `registerDesktopHostRpcStep` / `startAppServerBackgroundStep` / `schedulePostDaemonTasksStep` / `registerSelfCheckStep` / `prefetchTuringDeviceTokenStep` / `reconcileAutoLaunchStep` / `assembleHandleDepsStep`。

**关键子机制**：
- `StartupPipeline`（`:808` 起）：每 step 超时（`Promise.race`）+ 失败/超时决策（critical→abort，否则 continue）+ 阶段预算核对（`DEFAULT_PHASE_SPECS` `:635`：AppConfig 800ms / WindowBringup 2s / DaemonBringup 60s / RendererReady 60s）+ 拓扑排序（`topoSort`，禁止后阶段依赖前阶段）。critical step 必须声明 `timeoutMs` 否则注册期抛错。
- `onStuck(9e4, ...)` 看门狗（`:23563`）：90s 无进展强制 failed。
- `assembleHandleDepsStep`（`:23720`）：从 typed capability 汇总 handle deps（windowManager/daemon/database/evalProxyServer/mcpAppsHost/... 及 20+ dispose 回调）。
- `createStartupDiagnosticLog`（`:23803`）：追加写 `<configDir>/logs/startup/startup-<date>.log`，失败静默。

### 1.4 daemon 启动（`startDaemonChildProcess` `:15405` 起）

非 evalMode 下 daemon 作为独立子进程拉起（见 §4）。核心：`buildDaemonProcessEnv`（代理/startup context/product/locale/qimei 五组 env + `WORKBUDDY_FS_PROTECTION_ROLE=daemon` + `WORKBUDDY_LEGACY_LOCALSTORAGE_MIGRATION_RESULT_PATH`）→ `new DaemonAppServerProcessManager(...)` → `start()` spawn 并等 ready（60s）。

---

## 2. 模块地图：`main/` 文件分组

按职责分组，列出与本分析相关的关键文件（以 `//#region` 注释与文件名推断，`/Users/danker/Desktop/open-source/open-workbuddy/app-reference/app_asar/main/`）：

| 分组 | 关键文件 | 职责 |
|---|---|---|
| **入口/启动编排** | `index.js`、`chunk.js`、`contract*.js`、`startup-context.js`、`startup-type.js`、`runtime-context.js`、`app-instance.js`、`process-role.js` | `WorkbuddyDesktopApp` 装配、StartupPipeline 六阶段、启动上下文、进程角色标识（main/daemon/sidecar）。 |
| **生命周期** | index.js 内 lifecycle/*、`startup-*` | 启动状态机、phase-spec、startup 日志、mark-bridge。 |
| **窗口/UI** | index.js 内 window/*（`window-manager.ts`/`main-window-factory`/`windows-service`/`tray-controller`/`window-state`/`window-permissions`/`url-classifiers`/`external-links` 等）、`menu-builder*.js`、`menu-i18n*.js`、`splash/` | 主窗/子窗创建、托盘、菜单、窗口权限、外部链接、CSP、URL 分类、拖窗、splash。 |
| **服务/daemon** | `server.js`（7MB 后端 bundle，`workbuddy-server` 包）、`server2.js`、`daemon-app-server-entry.js`、`daemon-app-server-main.js`、`daemon-bootstrap.js`（651KB）、`service.js`、`module.app-server.js`、`module-base.js`、`module.desktop-host.js` | daemon 子进程入口、`DaemonServer` RPC、CellJS 容器、app-server addons、会话/自动化/工作区后端逻辑。 |
| **IPC 注册** | index.js 内 `ipc/ipc-registry.ts`、`handlers/*`（`register-*-ipc`）、`renderer-wb-invoke-bridge.ts`、`register-auth-host-capabilities.js` | pre-ready IPC、`wb:invoke` 泛型 RPC 分发。 |
| **认证/凭证** | `module.app-server.js`（`WorkbuddyBootstrapAuthenticationStorage`/`WorkbuddyAuthenticationManager`/`WorkbuddyExternalLinkAuthenticationProvider`）、`credential-protection*.js`、`file-authentication-storage.js`、`legacy-auth-session-migrator.js`、`gateway-secret.js`、`register-auth-host-capabilities.js` | token 存储/加密/迁移、at-rest 加密、sidecar gateway secret。 |
| **数据存储** | `server.js`（`createWorkbuddyServerDatabase`/`WorkbuddyDatabaseService`/drizzle schema）、`localstorage-contract.js`、`localstorage-migration.js`、`at-rest-crypto`（bundled in `dist.js`） | SQLite `workbuddy.db`、renderer localStorage 迁移。 |
| **安全** | `fs-protection.js`、`log-acl-guard.js`、`tls-verification.js`、`safe-storage-startup-probe.js`、`credential-protection*.js`、`threat-database-galileo2.js` | fs 防误删 shim、Windows 日志 ACL、TLS 免校验、safeStorage 探测、威胁事件。 |
| **监控/遥测** | `crash-reporter.js`、`desktop-monitor-service.js`、`process-cpu-sampler.js`、`perf-profiler-handlers.js`、`log-acl-guard.js`（qimei-detector）、`qimei-helper.js`、`threat-database-galileo*.js`、`prompt-trace-reporter.js`、`hub-tracer-handoff.js`、`telemetry` 相关 | 崩溃日志、指标/事件上报、性能剖析、qimei ID、prompt trace、威胁数据库。 |
| **网络/代理** | `network.js`、`network-gate.js`、`proxy-agents.js`、`proxy-env.js`、`runtime-http.js`、`http.js`、`http2.js`、`tls-verification.js` | HTTP 客户端、代理环境、TLS。- |
| **文件/资源** | `graceful-fs.js`、`normalize-path.js`、`tar.js`、`adm-zip.js`、`multipart-parser.js`、`readonly.js`、`safer.js` | 文件操作、压缩包、资源打包解压。 |
| **CLI/sidecar 桥接** | `cli-prewarm-pool.js`、`process-reap-utils.js`、`sidecar-entry.js`、`cli-product-env.js`、`client-info-env.js` | 预热 agent-cli、sidecar 进程对账/通讯、CLI env。 |
| **腾讯文档集成** | `tencent-docs-*.js`、`tdoc-dev-env-cookies.js`、`tencent-docs-document-lifecycle-port.js`、`tencent-docs-main-integration.js`、`tencent-docs-prompt-selection.js`、`tb`（sandbox/在线预览/mqq） | 文档预览、sandbox、在线文档登录、主题/语言桥、debug panel。 |
| **微信/IM 集成** | `wechat-chat-history.js`、`service.js`（wechat-chat-history zip-parser）、`qimei-helper.js`、index.js 内 wechat-chat-history/* | 微信聊天记录 ZIP 解析/分享、微信筹码。 |
| **更新/安装** | index.js 内 update/*（`update-service.*`、`mac-bundle-update-installer`）、`package-and-show-log.js`、`dev-env-override.js` | 应用自更新、启动日志打包。 |
| **自检/诊断** | `self-check.js`、`diagnostic-retention.js`、`startup-perf-exporters.js`、`session-create-timing.js` | 客户端自检、诊断留存。 |
| **第三方桥接**（可跳过） | `axios.js`、`esm.js`、`from.js` | axios 封装、ESM 互操作。 |

> 注：`auth.js` 按任务说明实为 **MCP SDK OAuth/Zod bundle**（region `1276-2314`，`@modelcontextprotocol`），`service.js` 实为微信聊天记录 ZIP 解析，二者命名有误导性，已确认非业务认证/HTTP 服务。

---

## 3. IPC 通道：preload 暴露 + main 侧注册对应表

### 3.1 preload 桥接层（`preload/index.js`，7859 行）

Preload 用 `contextBridge.exposeInMainWorld` 注入全局。**主要全局**（`:`6533-6560 一行行列出）：

| 全局名 | 内容 / 通道 |
|---|---|
| `workbuddyDesktop` | 宿主桥主对象（见下表） |
| `__workbuddyDevtoolsTerminal` | DevTools 终端（`workbuddy:devtools-terminal:*`） |
| `vscode` | VSCode 兼容 API 桥 |
| `__workbuddyStartupPerfD` | startup 性能 drain |
| `__hostPlatform` / `__hostPlatformProbe` | 同步 → `__hostPlatform` sendSync `host-platform:get` |
| `__wbInvoke(channel, context, ...args)` | → `ipcRenderer.invoke("wb:invoke", ...)` |
| `__wbOn` / `__wbOff` / `__wbEventBridge` | → `wb:*` 订阅 |
| `__getTdocImportPreloadUrl` 等 | → `tdoc-import/preview:get-preload-url`、`client-menu:get-preload-url`、`workbuddy:tencentDocs:getWebviewPreloadUrl` |
| `__setTencentDocsLanguage/Theme` | → `workbuddy:tencentDocs:setLanguage/Theme` |
| `__consumeTencentDocsRendererEvents` | → `tencent-docs:consume-pending-renderer-events` |
| `__reportRendererJsError` / `__workbuddyRendererLogWrite` / `__workbuddyRenderLog` | renderer 错误/日志上报 |
| `__workbuddyTelemetry` | `telemetry` 上报 |
| `mqq`（`:7306`/`:7807`） | 腾讯文档 MQQ 桥 |
| `__getStartupTraceid` / `__signalStartupFirstPaint` 等 | 启动性能信号 |
| `__workbuddyStartDragLocalFile` | → send `artifact:start-drag-local-file` |
| `__workbuddyRegisterOnlineDocPreview` 等 | → `workbuddy:registerOnlineDocPreview` 等 |

**`workbuddyDesktop` 对象字段 → preload invoke 通道**（`createWorkbuddyDesktopHost` `:`5384-5520，通道常量定义 `:`83-118）：

| 字段 | 通道名（常量） |
|---|---|
| `.machineId()` | `workbuddy:machineId` |
| `.app.getBootstrapInfo()` | `__bootstrap`（invoke）+ `renderer:ready`（send） |
| `.app.consumePendingOpenUrls()` | `app:consumePendingOpenUrls` |
| `.app.consumePendingWechatChatHistoryChips()` / `.ackWechatChatHistoryChip()` | `app:consumePendingWechatChatHistoryChips` / `app:ackWechatChatHistoryChip` |
| `.invoke(command, args)` | `workbuddy:invoke` |
| `.events.on(event)` | `workbuddy:event:<event>`（raw 通道见下） |
| `.window.*`（minimize/maximize/close/isMaximized/isFullscreen/setFullscreen/toggleFullscreen/openStartupAnalysis/startDrag/stopDrag） | `workbuddy:window:*`（minimize/maximize/close/isMaximized/isFullscreen/setFullscreen/toggleFullscreen/openStartupAnalysis/getStartupTraceId/syncNativeTheme/startDrag/stopDrag） |
| `.opener.openUrl` | `workbuddy:opener:openUrl` |
| `.localFile.open` | `workbuddy:localFile:open` |
| `.dialog.open` / `.saveImage` | `workbuddy:dialog:open` / `dialog:saveImage` |
| `.clipboard.readText/writeText/writeImage` | `workbuddy:clipboard:readText/writeText/writeImage` |
| `.notification.*` | `workbuddy:notification:isSupported/requestRegistration/send` |
| `.globalShortcut.updateToggleWindow` / `.onRegistrationStatus` | `workbuddy:globalShortcut:updateToggleWindow` / event `globalShortcut:registrationStatus` |
| `.ipcRenderer.on/send/sendSync` | 白名单：`startup:message`/`startup:preload-timeout`/`splash-state:update`/`account-snapshot:persist` |
| raw host 事件通道（`RAW_HOST_EVENT_CHANNELS` `:`5extensive） | `app:openUrl`/`app:wechatChatHistory:appendChip`/`app:inspirationShareCode:detected`/`binary:install-progress`/`menu:openNetworkCheck`/`menu:openSelfCheck`/`menu:openHelpFeedback`/`self-check:progress`/`tip-sound:play`/`globalShortcut:registrationStatus` |

**daemon 直连 MessagePort**：`installDaemonTransportPortForwarder`（`:`5608-5625）把 renderer 的 `workbuddy:open-local-daemon-transport-port` postMessage 转成 `ipcRenderer.postMessage("workbuddy:local-daemon-transport:port", ...)` 直达 main→daemon。`invokeDaemonFrame`/`sendDaemonFrameOnce`（`:`5524-5607）走 MessageChannel 做 daemon frame 请求。

**DevTools 终端**（`:`5652-5700）：`workbuddy:devtools-terminal:{create,list,close,rename,attach,detach,input,event}`。

### 3.2 main 侧 `ipcMain.handle` 清单（结合 `/tmp/` 全量 grep）

直接注册在 main/index.js + 其它 main 文件的 handle 通道（`ipcMain.handle("...")` 字面量，`app_asar/main` 下全量 grep）：

```
__bootstrap  app:ackWechatChatHistoryChip  app:consumePendingOpenUrls
app:consumePendingWechatChatHistoryChips  app:getOpenUrlRendererGeneration  app:getVersion
client-menu:get-preload-url  clipboard:writeImage  debug:crashTest  dialog:saveImage
executeMenuCommand  isWindowFullscreen  local-file  tdoc-import:get-preload-url
tdoc-preview:get-preload-url  telemetry:updateQimei36  wb:invoke  wechat:getShareTicket
wechat:launchMiniProgram  wechat:shareFile  wechat:shareLink  wechat:shareMiniProgram
windowUpdateTitleBarOverlay  workbuddy:registerOnlineDocPreview
workbuddy:unregisterOnlineDocPreview  workbuddy:updateDocsFeatureList
```

其中 `registerRendererBootstrapIpc`（index.js `:25805-25928`）专管：
- `__bootstrap`（`ipcMain.handle` → `bootstrapDeferred.promise`，preload 等 daemon RPC 就绪，带 10s→5s 重试/90s 总预算，超时发 `startup:preload-timeout`）
- `renderer:ready`（`ipcMain.on`，触发 WindowManager 白屏守卫解除 + lifecycle `renderer-mounted`→`ready`）
- `app:consumePendingOpenUrls` / `app:getOpenUrlRendererGeneration`（含 `isTrustedOpenUrlSender` 校验，只允许主窗 sender）
- `app:consumePendingWechatChatHistoryChips` / `app:ackWechatChatHistoryChip`

`registerMiscWindowIpc`（`:27578-27640`）：`app:getVersion`、`workbuddy:set-sdk-iframe-focused`（on）、`workbuddy:window:openStartupAnalysis`、`workbuddy:window:getStartupTraceId`、`debug:crashTest`（debugHub 才开）、`renderer-log:write`（on）、`dialog:saveImage`。
`registerCrashAndHostPlatformIpc`（`:27469`）：`crash:renderer-js-error`（on→crashWriter）、`host-platform:get`（on + returnValue 同步）。

### 3.3 renderer→daemon 领域 RPC 通道（经 `wb:invoke` / daemon-frame）

这些都是**领域 RPC**，renderer→preload `__wbInvoke`/`__wbOn`→main `wb:invoke` handler→`daemonConnection.invoke(channel,...)`→daemon celljs 模块处理。**不在主进程用 `ipcMain.handle` 直挂**（主进程只挂 `wb:invoke` 这一条）。
`dispatchWbInvoke`（index.js `:14592-14673`）：非 `wb:` 前缀的 channel 直接 `daemonConnection.invoke(channel,...)`；`wb:*` 前缀走 `daemonConnection.invoke("wb:invoke", channel, trustedContext,...)`。并处理 `wb:windows:*`/`wb:shell:*`（desktop-only dispatch）、`wb:internal:conversation-event-subscription`、`wb:clientTools:complete`、`wb:conversations:register/unregisterClientTools`。

**代表性领域通道**（全量 2666 条里按前缀统计，`main`+`renderer`+`preload` 字面量归一）：

| 前缀 | 数量 | 示例 |
|---|---|---|
| `session` | 56 | `session:create/list/get/load/rename/archive/delete/rollback/sendMessage/navigate/...` |
| `window` | 28 | `window:*`（宿主窗控制）、`windowUpdateTitleBarOverlay` |
| `auth` | 26 | `auth:login/logout/getToken/refreshSession/getUserInfo/statusChanged/claimDailyCheckin/...` |
| `expert` / `genie`/`genieProject` | 25/28 | `expert:*`、`genieProject:listProjects/createProject/deploy/forkProject/getFigmaAuthURL/...` |
| `queue` | 20 | `queue:getStatus/cancel` |
| `mcpApps` | 20 | `mcpApps:*` |
| `skill` | 16 | `skill:*`（技能领域） |
| `history` / `plugin` / `connection` | 16/15/15 | `history:*`、`plugin:install`、`connection:*` |
| `docs` / `localDocs` | 若干 | `docs:getPreviewUrl/previewDocumentFromContent/releasePreviewContext`、`localDocs:getPreviewUrl/activateContext/...` |
| `chat` / `cli` / `filesystem` | 若干 | `chat:*`、`cli:*`、`filesystem:*`（走 `wb:invoke`→`channel:callMethod`/`acpRequest`，见 server.js `channel:*`） |
| `claw` / `clawControl` | 84/2 | `claw:registerChannel/getSavedChannels/weixinQrStart/...`、`clawControl:getSnapshot/refresh` |
| `daemon 侧 handle` | 92（server.js/daemon-app-server-main.js/module.app-server.js/docs.js） | `appearance:*`、`channel:*`、`claw:*`、`genieProject:*`、`license:getSnapshot`、`localDocs:*`、`monitor:*`、`myFiles:*`、`plugin:install`、`queue:*`、`runtime:patchEnv`、`sites:*`、`slot:*`、`spaceNode:*`、`support:*`、`telemetry:updateQimei36` |

> `cli:*`/`filesystem:*`/`chat:*`/`agent:*` 在 renderer 侧以 `acp`/`frame`/`channel:*` 形式经 MessageChannel 到达 daemon（`daemon-frame-channel` + `sendDaemonFrameOnce`），主进程只做纯转发。

---

## 4. 主进程服务架构

### 4.1 `server.js` 是什么

`server.js`（7MB / 181k 行）是 **`workbuddy-server` 包**的完整 bundle（含 drizzle-orm、better-sqlite3、`@larksuiteoapi/node-sdk`、`@wecom/aibot-node-sdk`、yaml 等）。它是 daemon/应用服务器的后端核心，但**在桌面模式不监听 HTTP 端口**：
- `:9087` 注释明确：「It deliberately does not open an HTTP listener or expose any Electron capability; stdio/IPC/remote transports adapt to this」。
- 全文件 `grep http.createServer/net.createServer/.listen(` → **0 命中**。
- 提供 `createStdioDaemonRpcConnection`、`startWorkbuddyAppServerStdioLifecycle`、`DaemonServer`（RPC dispatcher）、`DaemonRpcDispatcher`（`:9031`）、`createCompositeDaemonRpcConnection`、`stdio-framing.ts`（`writeDaemonStdioFrame` `:9501`）等。

**通信模型：stdio 帧**（`stdio-server.ts` `:9564`、`stdio-connection.ts` `:9640`）：daemon 通过 stdin/stdout 按行写 JSON 帧（`{"type":"request"/"response"/"ready"/...}`），与 main 进程的 RPC client 对答。`createStdioParentRpcClient({output: process.stdout})`（daemon-app-server-main.js `:1123`）是 daemon 反向调 main 的通道。

### 4.2 `service.js` / `daemon-app-server-*` / `daemon-bootstrap` 定位

| 文件 | 定位 |
|---|---|
| `service.js` | 实为 `workbuddy-server/src/wechat-chat-history/service.ts` + `zip-parser.ts`：微信聊天记录 ZIP 解析/截断/元数据提取的服务。非 HTTP 服务。 |
| `daemon-app-server-entry.js` | **daemon 子进程真实入口**。加载侧：置 `UV_THREADPOOL_SIZE=16`、`assertDaemonProcessRole`、装 daemon crash writer/memory 诊断/stdio console guard/orphan guard（stdin 断开即退），再 `requireDaemonAppServerMain().runDaemonAppServerEntry()`。 |
| `daemon-app-server-main.js` | daemon 初始化正文：`assertWorkbuddyAppServerStdioMode(process.argv)` → 读 credential-protection mode → `new DaemonServer` → `createStdioParentRpcClient` → `createAppServerDesktopHostBridge`（把 Electron 能力桥回 main）→ CellJS 容器初始化 → `createInitializedWorkbuddyAppServerDatabase(configDir)` → resolveCellJSDeps → 腾讯文档服务/本地文档/自动化等 addon 装配 → `startWorkbuddyAppServerStdioLifecycle`（`emitReady:false`，shutdown/flushCliPrewarmPool/onUnhandledFrame/exit。`DAEMON_SERVICES_STOP_BUDGET_MS=4000` 优雅关停预算）。 |
| `daemon-bootstrap.js` | 651KB，daemon 引导工具库：`initializeCellJSContainer`、`resolveCellJSDeps`、`resolveProxyEnv`、`markQimei36Ready`、celljs baseModules 等。被 main（`buildDaemonProcessEnv`/`resolveProxyEnv`）与 daemon 双侧复用。 |

### 4.3 多进程模型与 spawn（`DaemonAppServerProcessManager`，index.js `:13732` 起）

`spawnAndAwaitReady()`（`:13767`）：
```js
entryPath = resolveEntryPath();            // → ./daemon-app-server-entry.js
args = [...processExecArgv, entryPath, "--stdio"];
spawn(process.execPath, args, {
  stdio: ["pipe","pipe","pipe"],  windowsHide: true,
  env: { ...process.env, ...optionEnv, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: sanitizeNodeOptions(...) }
});
```
- 用 **Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`** 跑纯 Node，入口 `daemon-app-server-entry.js --stdio`。
- `NODE_OPTIONS` 加 `--max-old-space-size=4096`（`:13730`，防 session 1000+ OOM）；`sanitizeNodeOptions` 剥离 `--inspect*`/`--debug*`/`--openssl-legacy-provider`。
- 连接：`createStdioDaemonRpcConnection({ input:child.stdout, output:child.stdin })`（`:13793`）。
- ready 超时 60s（`:13796`）；ready 前退出→reject；ready 后退出→走恢复策略 `DaemonRecoveryPolicy`（`beginRecovery`，decision give-up/retry with backoff）。
- 崩溃恢复回调链：`onCrash→onReconnecting→onRestored | onGaveUp`（`:15558`），`handleDaemonRecoveryGaveUp` 弹窗+落盘失败标记+diagnostics 上报。
- `stop()`：先 `SHUTDOWN` RPC → SIGTERM → SIGKILL 分级（`:13827`）。

**传输模式**（`createDaemonTransport` `:15626`）：`mode==="in-main"` → `bootstrapDaemonInMainProcess`（daemon 逻辑内联在 main 进程，evalMode）；否则 `stdio-fork` → `startDaemonChildProcess`。

**进程模型 ASCII 图**：

```
┌─────────────────────────── Main Process (Electron) ───────────────────────────┐
│ index.js ── WorkbuddyDesktopApp.main() ── WorkerPipeline ── 6-phase state machine │
│  ├─ WindowManager: [main window] [splash] [image-decoder] [debug-panel]         │
│  │   [startup-analysis] [tray] [webview guest windows]                          │
│  ├─ ipcRegistry (pre-ready IPC): __bootstrap / renderer:ready / wb:invoke / ...  │
│  ├─ QuitController / crashWriter / fs-protection shim / homedir-guard            │
│  └─ preload/index.js (isolated world, contextBridge exposes workbuddyDesktop)     │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ spawn(ELECTRON_RUN_AS_NODE=1) + stdio pipes (JSON frames)
                ▼
┌──────────────────────────── Daemon Process ────────────────────────────────────┐
│ daemon-app-server-entry.js → daemon-app-server-main.js (runDaemonAppServerEntry) │
│  ├─ createStdioParentRpcClient(stdout) ──► main (desktop-host bridge:            │
│  │     dialog/window/network/document/monitor)                                   │
│  ├─ DaemonServer (RPC dispatcher) + CellJS container                            │
│  ├─ better-sqlite3+drizzle ──► ~/.workbuddy/workbuddy.db                         │
│  │     tables: sessions/workspaces/automations/automation_runs/                  │
│  │             automation_runtime_state/automation_delivery_outbox/              │
│  │             session_usage/migration_meta                                       │
│  ├─ Tencent Docs engine / localDocs / MCP apps host                               │
│  └─ cli-prewarm-pool + SidecarManager ──► prewarmed cbc (agent-cli)              │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ spawn(sidecar, --prewarm / --serve) + control/data socket
                ▼
┌──────────────────── codebuddy CLI sidecar (agent-cli) ─────────────────────────┐
│  --serve: HTTP server on 127.0.0.1:<random-port> /api/v1/*                     │
│      auth: CODEBUDDY_GATEWAY_AUTH=password + Bearer secret (gateway-secret)    │
│  session ACP endpoints (control socket + data socket, JSON-RPC)                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 认证与凭证

### 5.1 `auth.js`——非业务认证
`auth.js`（2741 行）region `1276-2314` 确认为 **MCP SDK OAuth/Zod bundle**（`@modelcontextprotocol`），是 MCP 协议库，与 WorkBuddy 登录无关。业务认证在 daemon 侧。

### 5.2 `module.app-server.js` 认证组件（row `116-185`）

- `WorkbuddyBootstrapAuthenticationStorage`（`:116-162`）：`@Component(AuthenticationStorage)`，`priority()` 只在 authentication type 非 `CUSTOM_TOKEN` 时返回 `Heigh+2`（`BOOTSTRAP_FILE_STORAGE_PRIORITY`，`:100`），否则 `Disabled`；`store/restore/beginLogout/clean` 全部委托给 `FileAuthenticationStorage`。`getBootstrapAuthenticationType` 从 `ACC_PRODUCT_CONFIG_V2/V3` env 读 `authentication.type`。
- `WorkbuddyAuthenticationManager`（`:163-185`）：继承 `AuthenticationManagerImpl`，rebind 到 `AuthenticationManager`，`syncProductAfterSessionChange` 触发 `workbuddyAuthSessionSyncer`（token 刷新后同步远端产品配置）。
- `WorkbuddyExternalLinkAuthenticationProvider`（`:66-116`）：`CLI_EXTERNAL_LINK` 登录方式，支持 `/`staging 域重写（`PROD_TO_STAGING_DOMAIN_REWRITES`、`STAGING_SSO_DOMAIN_REWRITES`）。
- `WorkbuddyUserinfoProvider`（`:190+`）：给 `@genie/telemetry` 提供当前账号 uid/nickname。

### 5.3 token 存储位置与加密

**存储路径**（`file-authentication-storage.js` `:382`）：`path.join(filePathService.sharedDataPath, "auth", `${authenticationId}.info`)`。即 macOS `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<authenticationId>.info`（Win `%LOCALAPPDATA%`/Linux `~/.local/share`），是与 CLI 子进程**共享**的凭证位（`file-authentication-storage.js:31` 注释“shared location that can be accessed by CLI”）。

**加密方式**：`credential-protection.js` 的 `createCredentialFieldCodec`（`:1122`）创建 `ProtectedJsonFields`（来自 `at-rest-crypto` 包，bundled in `dist.js`）。`file-authentication-storage.js` 的 `encodeSession`(`:453`)/`decodeSession`(`:470`) 用 codec 对 session 做**字段级 AES-GCM 加密**（`AUTH_CREDENTIAL_FIELDS` 列出要加密的字段，`credential-protection.js` `:1507-1560`，含 `accessToken`/`refreshToken`/`encryptKey`/`aesKey` 等）。

**密钥来源**：at-rest 32 字节对称密钥由 `electron.workbuddyStorage.loggerGet()` 提供（`index.js` `:32152`），即 Electron 原生层注入的密钥（macOS Keychain）。`keystore` 处理见 `dist.js`：
- `deriveAtRestKeyId(key)`（`:256`）：key 必须恰 32 字节。
- `normalizeAtRestKeyPayload`（`:260`）：raw 载荷 → `{keyId, key}`。
- `AtRestCrypto`（`:308`）AES-GCM；asymmetric envelope（`:360+`）；`file-permissions`（`:559`）、`AtRestFailureRegistry`（`:636`，失败记录写 `<configDir>/security/at-rest-failures-v1.json`）。

**写入原子性/锁**：`withCredentialFileLock`（`:654`）+ `writeCredentialFileAtomically(Sync)`（`:1320/:1341`）保证崩溃不产生半写文件。

### 5.4 credential-protection bootstrap

- `credential-protection-bootstrap.js`：`readWorkbuddyCredentialProtectionMode(env)`、`DaemonCredentialProtectionBootstrapGate`（daemon 侧把 mode+key 传给 `configureCredentialProtection`）。
- `build-mode.ts`（index.js `:23814`）：`getAtRestEncryptionBuildMode()`（当前 `disabled`）；`loadMainCredentialProtectionBootstrap`（`:23823`）用 `normalizeAtRestKeyPayload(getKey())`，失败则 `symmetricUnavailable:"invalid-key"`。
- `disposeCredentialProtection()`（`:1123`）：密钥 `fill(0)` 销毁。

### 5.5 `gateway-secret.js`（CNVD-ZC-2026-6234 修复）
`workbuddy-server` 进程内生成**一个** 32 字节 random secret（`:getGatewaySecret`，`crypto.randomBytes(32).base64url`），注入 sidecar env：`CODEBUDDY_GATEWAY_AUTH=password`、`CODEBUDDY_GATEWAY_PASSWORD=<secret>`、`CODEBUDDY_GATEWAY_DISABLE_API_DOCS=1`。in-process REST 调用方用 `gatewaySecretHeaders()` 带 `Authorization: Bearer <secret>`。修复了此前 `CODEBUDDY_GATEWAY_AUTH=none` 导致的同机未授权 RCE。secret 仅存内存、不落盘。

### 5.6 `legacy-auth-session-migrator.js`
`legacy-vscdb-auth-reader.ts`（`:9`）+ `legacy-auth-session-migrator.ts`（`:43`）：从旧版 **VS Code DB（vscdb）** 读取历史 auth session，经 `decryptLegacyAuthSession`（desktop-host auth 的 `decrypt`）解密后迁入新凭证体系（在 daemon-app-server-main.js `:1130` 里 `setWorkbuddyLegacyAuthSessionMigrator` 注册）。`file-authentication-storage.js` 的 `ensureSerializedSession`/`scheduleCredentialMigration` 处理 token 结构升级。

---

## 6. 数据存储

### 6.1 SQLite `workbuddy.db`（better-sqlite3 + drizzle-orm）

- DB 文件：`path.join(configDir, "workbuddy.db")`（server.js `:6695`、`:6751`；configDir = `WORKBUDDY_CONFIG_DIR` 或 `~/.workbuddy`）。WAL 模式（`-wal`/`-shm`，`:14025-14030` 提及 checkpoint/清理）。
- 创建：`createWorkbuddyServerDatabase`（server.js `:8356`）→ `WorkbuddyDatabaseService` + drizzle；`createInitializedWorkbuddyAppServerDatabase({configDir})`（`:154823`）在 daemon 初始化时调用。

**表结构**（server.js `:1543-1712` SQL）：

| 表 | 用途 | 关键列 |
|---|---|---|
| `sessions` | 会话主表 | id/cwd/user_id/title/status/created_at/mode/model/expert_id/project_id/plugin_context_json/addon_selection/session_settings/context_window/... |
| `workspaces` | 工作区 | path(PK)/last_opened_at |
| `automations` | 定时自动化 | id/name/prompt/status/schedule_type/next_run_at/cwds/rrule/model_id/skills_json/push_to_wechat/wecom_bot_source/owner_user_id/... + 索引 `idx_automations_owner` |
| `automation_runs` | 自动化运行 | thread_id/automation_id/status/read_at/thread_title/runs_json |
| `automation_runtime_state` | 自动化运行时状态 | automation_id/last_run_at/last_error/running/running_conversation_id |
| `automation_delivery_outbox` | 投递 outbox | id/dedupe_key/channel/automation_id/payload_json/status/attempt_count/next_run_at/lease_owner + unique dedupe 索引 |
| `session_usage` | 会话用量 | session_id/used/size/updated_at/credit_json |
| `migration_meta` | drizzle 迁移元数据 | key/value |

另有 drizzle 迁移表 `__workbuddy_drizzle_migrations`（`:1693`）与 legacy schema 采纳（`:1693+` `CURRENT_REQUIRED_TABLE_COLUMNS` 定义每表必需列，用于旧库补列）。

`session-mutation-policy.ts`（server.js `:8366`）：`enableLegacySessionRowMutations=false`，防止旧多写路径覆盖已收敛的 session status。

### 6.2 at-rest-crypto（bundled in `dist.js`）
见 §5.3：AES-GCM 32 字节对称密钥 + keyId 派生 + asymmetric envelope + 失败注册表（`<configDir>/security/at-rest-failures-v1.json`）+ file-permissions。用于凭证/密钥加密，非业务数据加密。

### 6.3 localStorage 迁移（`localstorage-contract.js` / `localstorage-migration.js`）
- `localstorage-contract.js`：迁移契约常量，`PINNED_CONVERSATIONS_STORAGE_KEY="workbuddy-pinned-conversations"`、`LEGACY_DISPLAY_LANGUAGE_STORAGE_KEYS=["CODEBUDDY_IDE_STORAGE_LANG","workbuddy-language"]`。
- renderer 旧 localStorage（pin/语言/会话索引）在内置的 `LocalStorageMigrationService` / `FileBackedLegacyLocalStorageMigrationService`（daemon-app-server-main.js `:100+`）里迁到 SQLite；主进程侧 `prepareLegacyLocalStorageMigrationResultFile`（index.js `:15490`，仅 WorkBuddy 品牌）把 renderer 旧数据写成临时 JSON 供 daemon 读回。preload `applyPendingLocalStorageMigration`/`__completeLocalStorageMigration` 走 `__bootstrap` 信息里 `pendingLocalStorageMigration` 触发。

---

## 7. 安全机制

| 机制 | 文件 | 机制说明 |
|---|---|---|
| **fs-protection** | `fs-protection.js` | 模块首行 import 即全局猴子补丁 `fs` 的 `unlink/unlinkSync/rmdir/rmdirSync/rm/promises.*`：命中受保护路径（configDir/auth/日志等哨兵）用 `hitsProtectedPath` 判定，拒绝删除并 `writeAudit`（`<configDir>/fs-protection.*.log`，5MB 轮转）。防外部/自身误删凭证与日志。 |
| **log-acl-guard** | `log-acl-guard.js`（`log-acl-guard.ts` `:48417`） | **Windows only**：对 `~/.workbuddy/logs/<YYYY-MM-DD>` 最近 7 天目录用 `icacls` 下发 deny-delete ACL（`DENY_MASK="(OI)(CI)(DE,DC)"`），`REFRESH_INTERVAL_MS=6h` 周期性刷新；`releaseLogAclGuard` 在删旧日志前释放保护。防外网用户遍历清空 `~/.workbuddy`。非 win32 noop。 |
| **tls-verification** | `tls-verification.js` | `disableTlsVerificationForProcess(reason)` 幂等关闭 Node 进程级 TLS 校验（设 `NODE_TLS_REJECT_UNAUTHORIZED=0`），`suppressTlsRejectWarning` 抑制告警；用于调试/代理场景。`tlsLog` 记录。 |
| **gateway-secret** | `gateway-secret.js` | §5.5，sidecar REST 密码认证，修复未授权 RCE。 |
| **crash-reporter** | `crash-reporter.js` | `installCrashWriter` hook `uncaughtException`/`unhandledRejection`，同步写 `{logsDir}/Crash-Log/crash-report-{processName}-{pid}.json`（`CRASH_LOG_DIR_NAME="Crash-Log"`），entry `{type,error}`；`wrapChildProcess` 捕获子进程 `exit/error` 写 `child_process_crash`。主/daemon 各自 install，文件名带 pid 防覆盖。另有 `crash-filter.ts`（`:232`）/`crash-sanitizer.ts`（`:303`）/`crash-log-exporter.ts`（`:360`）做过滤/脱敏/上报。 |
| **threat-database-galileo2** | `threat-database-galileo2.js`（`threat-database-galileo.ts` `:3`） | 遥测事件分类/上报：`isThreatDatabaseGalileoEvent`/`reportThreatDatabaseGalileoEvent`，daemon 侧的事件经 monitor 桥（index.js `:15470`）分流到伽利略，与普通 aegis event 区分。 |
| **safe-storage-probe** | `safe-storage-startup-probe.js` | 启动探测 Electron `safeStorage` 是否可用（at-rest 密钥可用性门控，`:4595` gate）。 |
| **homedir-guard** | index.js `:183` | 防御 macOS 中文用户名乱码 HOME，用 `dscl NFSHomeDirectory` 权威值修复，避免凭证路径 EACCES。 |
| **CSP / window-permissions** | index.js `window/csp/setup-csp.ts`、`window/window-permissions.ts` | renderer CSP 设置、窗口权限（permission request handler 白名单）。 |
| **预飞检** | index.js `:31054` `runEarlyPreflightAndMaybeBail` | `requestSingleInstanceLock` 之前极早期 preflight，异常时 spawn `RepairApp` 接管。 |

---

## 8. 与 CLI 的桥接

### 8.1 `cli-prewarm-pool.js`
`CliPrewarmPool` 预热 agent-cli（`cbc` / codebuddy CLI）进程池，消费 agent-cli `--prewarm` 能力：把新建会话/重启会话的启动等待从 ~3.7s 降到 ~1ms（复用已跑完冷启动、挂本地 IPC 待命的进程）。关键：
- `--prewarm` spawn（`spawnPrewarmEntry`），`waitSocketReady` 探活（`PING_INTERVAL_MS=3s`，Windows `SOCKET_READY_TIMEOUT_MS_WIN=30s`，POSIX 10s）。
- `tryAcquire` 同步只读状态不 ping（避免误杀刚 ready 的健康进程）；`doActivate` 等待 ACP ready ACK（`ACTIVATE_READY_TIMEOUT_MS=180s`，`ACTIVATE_POST_ACTIVE_ACK_TIMEOUT_MS=30s` 分级快速失败）。
- 后台健康探活定时器（首次 20s、稳态 8min、单次 2s）识别 SIGSTOP/死锁假死进程。
- `IDLE_TTL_MS=15min` idle 回收；`REPLENISH_BACKOFF` 补池退避。
- env 命中策略：白名单 `KNOWN_SESSION_ENV_KEYS` 内差异在 activate 时透传，未知差异不静默复用。
- `cli-runtime-env.ts`（`:29`）/`cli-runtime-files.ts`（`:140`）、`sidecar/client.ts`（`:391`）、`sidecar-manager.ts`（`:592`，sidecar 会话表）、`agent-teams-env.ts`（`:2119`）、`runtime-log-redaction.ts`（`:2138`）。

### 8.2 `process-reap-utils.js`
sidecar 进程对账/跨平台工具：
- `workbuddyConfigDir()` = `WORKBUDDY_CONFIG_DIR` / `~/.workbuddy`；`instanceToken` = `sha1(configDir)` 前 12 位（安装域唯一 token）。
- `sidecarRuntimeDir()`：socket + PID 文件目录（0700）；`controlSocketPath`/`dataSocketPath`（POSIX Unix socket / Windows named pipe `\\.\pipe\workbuddy-<token>-sidecar-control`）。
- `pidFilePath`、`sessionJournalDir`（每个会话 `<pid>.json` 落盘账本，sidecar SIGKILL 崩溃后对账）。
- env builder：`buildCliProcessEnv`（`CLI_STATIC_MANAGED_ENV` + `ENV_BLOCKED_PREFIXES`/`ENV_BLOCKED_KEYS` 防宿主泄露）。
- 进程树终止：`killProcessTree`（`isPidAlive` 探活 → `readProcessCommandLine` 身份校验 → SIGTERM/SIGKILL）。
- sidecar _ready 协 议 env：`CODEBUDDY_SIDECAR_READY_SOCKET`/`READY_TOKEN`/`READY_SESSION_ID`、`CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET`。

### 8.3 如何 spawn codebuddy CLI
- **预热**：daemon 内 `SidecarManager`/`CliPrewarmPool` 用 `child_process.spawn(cliPath, ["--prewarm", ...])`（`cli-prewarm-pool.js`/`sidecar-manager.ts`），进程挂在本地 IPC socket 上。
- **会话**：`tryAcquire` 命中 → `doActivate`（`--serve`/`--prewarm` 转正），进程自持 ACP 端口，经 control/data socket 做 JSON-RPC；`session:*`/`channel:callMethod`/`acpRequest` RPC 透传。
- **env**：`buildCliProcessEnv`(managedEnv, hostEnv) 屏蔽宿主敏感 env，注 `CODEBUDDY_GATEWAY_AUTH=password` + secret。
- **网关**：sidecar `--serve` 的 `/api/v1/*` 用 `requireAuth` + Bearer secret（§5.5），/internal 与 /api/v1/acp（loopback 豁免）在 `AcpSecurityMiddleware` 下放行。
- 主进程侧不直接 spawn CLI；CLI 由 **daemon 子进程** spawn（daemon 是 CLI 的父进程），daemon 自身崩溃则由 `DaemonAppServerProcessManager` 按恢复策略 respawn。

---

## 9. 风险 / 待确认项（[INFERENCE] 与后续）

- **`electron.workbuddyStorage.loggerGet()` 具体实现**为原生层注入，未在 JS bundle 内；推断为 macOS Keychain / 系统安全存储，未证实。
- **`server.js` 内 HTTP server 的远程传输**（`remote transports adapt to this` 注释）暗示 server 核心可挂远程/HTTP 传输，但桌面默认走 stdio；未在 bundle 找到监听代码。
- **`chat:*`/`cli:*`/`filesystem:*`/`agent:*` 通道**的实际 daemon 端 handler 由 celljs 组件/`channel:*` 动态注册，未以字面量 `ipcMain.handle` 出现在主进程，故主进程只做转发（正确性依赖 daemon-frame 转发，未逐条验证）。
- `auth.js` 的 `@modelcontextprotocol` 前缀——MCP OAuth/Zod bundle，已标注非业务认证，供主会话汇总端点时忽略。
- 所有网络端点/域名（如 `www.codebuddy.cn`、`staging.codebuddy.cn`、`copilot.tencent.com`、`/v3/config`、`/v2/feature-flag/api/product-config`）已作为证据列出，交由主会话统一汇总为域名清单。

---

## 附录：关键文件清单与行号证据速查

- 入口/启动：`main/index.js:33016`（new WorkbuddyDesktopApp）、`:32150`（main()）、`:32189`（onReady）、`:23548`（bootstrapMainProcess）、`:808`（StartupPipeline）、`:488`（StartupPhase）、`:635`（DEFAULT_PHASE_SPECS）。
- preload：`app_asar/preload/index.js:6533`（expose workbuddyDesktop）、`:5384`（createWorkbuddyDesktopHost）、`:83-118`（通道常量）、`:5524`（daemon-frame）、`:5608`（transport port forwarder）、`:6310`（bootstrapWithRetry）。
- daemon：`main/daemon-app-server-entry.js`（入口）、`main/daemon-app-server-main.js:1097`（runDaemonAppServerEntry）、`main/server.js:9087`（非 HTTP listener 注释）、`:9501`（stdio framing）、`:154823`（createInitialized...Database）、`main/index.js:13732`（DaemonAppServerProcessManager）、`:15405`（startDaemonChildProcess）。
- 认证：`main/module.app-server.js:116`（WorkbuddyBootstrapAuthenticationStorage）、`:163`（WorkbuddyAuthenticationManager）、`main/file-authentication-storage.js:382`（token 路径）、`:453`（encodeSession）、`main/credential-protection.js:1122`（createCredentialFieldCodec）、`:1507`（AUTH_CREDENTIAL_FIELDS）、`main/gateway-secret.js`、`main/legacy-auth-session-migrator.js`。
- 存储：`main/server.js:1543-1712`（表 SQL）、`:8356`（createWorkbuddyServerDatabase）、`:6695`（dbPath=configDir/workbuddy.db）、`main/localstorage-contract.js`。
- 安全：`main/fs-protection.js`、`main/log-acl-guard.js:48417`、`main/tls-verification.js`、`main/crash-reporter.js`、`main/threat-database-galileo2.js`、`main/safe-storage-startup-probe.js`。
- CLI/流程：`main/cli-prewarm-pool.js:2143`（CliPrewarmPool）、`main/process-reap-utils.js`、`main/sidecar-entry.js`。
