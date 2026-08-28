# WorkBuddy AI 5.4.2 前端 UI 结构分析报告 (renderer-ui)

> 分析对象：`app-reference/app_asar/renderer/`（Vite 产物，149MB，1198 个资产文件）+ `app-reference/app_asar/resources/` 中 UI 相关资源。
> 结论先行：这是 **Tencent 出品的 React 18 + TodoUI(自研 dui/lib-chat-ui) + Vite(rolldown 打包) 的单页桌面客户端 UI**。源码来自 monorepo，`//#region` 注释保留了源路径，可精确回溯到 `packages/agent-ui`、`packages/context-viewer-components`、`packages/conversation-render`、`packages/workbuddy-app` 等包。页面全部由一张集中式路由表驱动；与主进程通信统一走 preload 暴露的 `workbuddyDesktop` / `__wbInvoke` 桥；聊天核心是一个「块渲染 + 工具调用卡片 + 沙箱 widget」的三层管线。

---

## 1. 框架与技术栈结论 + 证据

| 层 | 结论 | 证据 |
|---|---|---|
| UI 框架 | **React 18.3.1**（`react-dom@18.3.1` / `react@18.3.1` / `createRoot`） | 资产中出现大量 `react-dom@18.3.1_react@18`、`react@18.3.1` 版本串（`grep -o "\"(18\|19)\.x\.y\""` 命中 `"18.3.1"`）；`index.html:30-221` body 由 `#root` 挂载 |
| 渲染机制 | `createRoot(...).render(<Root/>)` 双根（主 UI + 独立 WindowControls 迷你根） | `index-D3SrJ2Mw.js`：`createRoot(document.getElementById("root")).render(<Root/>)` 与 `createRoot(windowControlsContainer).render(<WindowControls/>)` 两处 |
| 状态管理 | **Jotai**（原子状态）+ **Immer**（不可变更新），未用 Redux/Zustand | `vendor-state-CCy1L3i9.js`：`createStore×5 / jotai×11 / immer×11`（无 redux、无 zustand、无 vue/pinia） |
| 路由 | **React Router v6/v7**（BrowserRouter/HashRouter/MemoryRouter，经自封装 RouterProvider、按 adapter 类型选模式） | `ui-docs-viewer-CTU4bllw.js`：`packages/agent-ui/src/router/router-provider.tsx`（`routerMode === "memory"/"hash"/"browser"`）；`router/route-config.ts` 定义 `SHELL_ROUTE_CONFIGS` / `STANDALONE_ROUTE_CONFIGS` |
| 构建工具 | **Vite + Rolldown**（rolldown-vite 系）：`__vite__mapDeps`、`import.meta.url` 预载、`rolldown/runtime.js` 内联运行时、hashed chunk 命名 | `index-D3SrJ2Mw.js` 头部 `__vite__mapDeps`；`rolldown-runtime-D5a2oYpF.js` 首行 `//#region \0rolldown/runtime.js`；`index.html` 大量 `<link rel="modulepreload">` |
| UI 组件库 | 腾讯自研 **`@tencent/dui`**（桌面）+ **`@tencent/dui-mobile`**、`lib-chat-ui`（聊天 UI 库）、`context-viewer-components`（预览）、`conversation-render`（聊天渲染） | 资产 region 路径含 `@tencent+dui@1.28.2`、`@tencent+dui-mobile@1.9.0`、`@tencent+smart-doc-editor@2.122.6`、`@tencent+xtable-core` |
| 代码编辑 | **Monaco Editor 0.55.1**（内嵌 VS Code 编辑器） | `editor.api2-DK204rF2.js` region `monaco-editor@0.55.1/.../nls.messages.js`；`ts.worker` / `css.worker` / `html.worker` / `json.worker` 拆为独立 worker chunk |
| 文档/表格 | **PDF.js 5.4.296** 预览 PDF；**腾讯 SmartCanvas / SmartSheet（xtable）** 渲染表格画布 | `pdf-preview-component-Eq6zTNIw.js` region `pdfjs-dist@5.4.296`；`BlockType.SMART_SHEET="smartsheet"`、`SMART_CANVAS="smartcanvas"`、`DASHBOARD` 等（`registry-BMZi7sjT.js`） |
| 数学/图表 | **KaTeX 0.16.47** + **Mermaid** + **Excalidraw 0.18.0** + **Shiki 3.23.0**（语言/高亮） | `vendor-katex-pADfELwm.js`（katex@0.16.47）、`vendor-mermaid-BbbAOXTS.js`、`@excalidraw/excalidraw@0.18.0`、`@shikijs/langs` / `@shikijs/themes` |

**命名坑提示**：任务提示里「kimi/berry/crystal/aurora」被当作主题/品牌，实际核查结论（见 §4.5）：`berry`、`crystal` 是 **Shiki 编程语言语法**（`@shikijs/langs/dist/berry.mjs`、`crystal.mjs`），`aurora-x` 是 **Shiki 配色主题**（`@shikijs/themes/dist/aurora-x.mjs`），三者都不是 App UI 皮肤主题；只有 `kimi` 才是真正的**第三方模型 Provider 品牌**（Moonshot 的 Kimi）。

---

## 2. 入口与引导

### 2.1 `renderer/index.html`（341 行）
- 单页入口，`<title>WorkBuddy</title>`，`#root` + `#skeleton-root`。
- **首屏 account snapshot 内联 IIFE**：当 URL 带 `?accountSnapshot=<encoded>` 时立即解出 `window.__initialAccount`，供 `main.tsx` 顶部同步 `accountService.setAccount(...)`，跳过等 daemon `getAccount`（≈2.6s）的窗口（契约来自 `packages/workbuddy-app/src/shared/account-snapshot.ts`，详见注释 `index.html:8-27`）。
- **骨架屏样式**：`:root` 定义 `--sk-*`（bg/titlebar/sidebar/content/statusbar 色 + `--sk-titlebar-h:38px`、`--sk-sidebar-w:220px`、`--sk-statusbar-h:22px` + shimmer 动画），注释明确背景兜底**不跟随** `prefers-color-scheme`，明暗由 `ThemeManager / skin-manager` module 执行期写 class 决定（`index.html:64-76`）。骨架含 titlebar（`-webkit-app-region: drag` 以便拖窗）、sidebar（8 个体验按钮占位）、content（标题+标签+输入框占位）、statusbar。
- **入口脚本**：`<script type="module" crossorigin src="./assets/index-D3SrJ2Mw.js">`，并 `modulepreload` 约 50 个核心 chunk（`rolldown-runtime`、`ui-ardot`、`browser`、`renderer-logger`、`vendor-state`、`useTranslation`、`workspace-preparing`、`branch-switch-error`、`file-utils`、`shared`、`codebuddy-icon-provider`、`use-connector-actions`、`context`、`wb-status-chips`、`file-service`、`utils`、`link-handler`、`contract`、`entry-service`、`use-lexiang-add-to-task`、`cancel-barrier`、`upload-utils`、`wechat-chat-history-chip-store`、`acp-message-accumulator`、`loginRedirect`、`telemetry-client-info`、`store`、`app-shell`、`share-html-zip`、`publish-utils`、`api`、`lexiang-content-picker`、`network-check`、`use-tencent-docs-ai-edit-enterprise-feature`、`use-tencent-netdrive-knowledge-feature`、`teams-chat-span-holder`、`connector-device-code-modal`、`inspiration-feature-config`、`share-artifact-filter`、`share-platform-helpers`、`storage-capacity-toast`、`expert-install-intent-buffer`、`mcp-token-config-bus`、`token-connector-bus`、`host-xumqttWE`、`clipboard`、`runtime`、`desktop`、`renderer-trace-api`、`deeplink`）+ 业务 CSS（`lib-chat-ui`、`ui-docs-viewer`、`workspace-preparing`、`branch-switch-error`、`shared`、`wb-status-chips`、`main-content-core`、`lexiang-content-picker`、`network-check`、`connector-device-code-modal`、`safe-delete-events`、`index-65PlBXkd.css`）。

### 2.2 骨架引导 `renderer/skeleton/skeleton-bootstrap.js`
- 用 `window.workbuddyDesktop?.ipcRenderer` 监听骨架阶段：读 `splashState`（`?splashState=`）解出预置主题色/布局注入 `--sk-*`，并通过受限 ipcRenderer channel（`startup:message`、`startup:preload-timeout`、`splash-state:update`、`account-snapshot:persist`——见 preload `ipcRenderer.ALLOWED_CHANNELS`）驱动「Connecting…/Attempt #{{n}}」文案（locale 首字符为 e 用英文，否则中文）。
- 主 chunk 拆除骨架：`index-D3SrJ2Mw.js` 中 `App()` 在 `accountService.isInitialized()` 后调用 `window.__removeSkeleton`（失败则 `document.getElementById("skeleton-root").remove()`），并 `markStartupRenderer("E13")`；10s failsafe 兜底。

### 2.3 应用组装链（`index-D3SrJ2Mw.js` = `packages/workbuddy-app/src/main.tsx`）
```
createRoot(#root)
  └─ Root
     └─ AdapterContext / ImaApiContext / DocumentPreviewContext / EnhanceServiceContext / SkillRecommendServiceContext / AuthProvider / AccountContext
        └─ App  →  AgentWebAppHost
                    └─ App$1 (agent-ui/src/App.tsx)  ← 注入 adapter / desktopProviders / PROVIDER_CONFIG
                        └─ RouterProvider(内存 or Browser)  →  AgentAppRuntime (agent-ui/src/App.tsx 的 shell)
                            └─ TelemetryProvider → AppProviders → AuthProvider → SettingsProvider → AppRuntimeContextProviders
                                ├─ ModuleServicesHost / ShareSelectionProvider / ShareModeBridge / GoHomeRegistrar / AppShortcutsListener / RouterEffects / PurchaseModalHost / AppearanceRuntimeHost …
                                └─ RoutesView（shell 路由 + 独立路由）
```
- `AgentWebAppHost`（main.tsx）用 `desktopProviders` + `PROVIDER_CONFIG`，`enableDatongPageView:true`，并把路由变化经 `internalDaemonClient.reportSessionRouteState({pathname,taskId})` 上报 daemon。
- `App()`（main.tsx）同时负责「拆除骨架 + 骨架 failsafe」。
- 内置 `createWorkbuddySDK({platform,http,upload,...})`（`packages/workbuddy-core/src/wb/index.ts`）——这是注入 `window.__wbInvoke` 的 SDK，`wb.invoke(channel,...args)` 委托 `externalInvoke(channel,void 0,...args)`。

---

## 3. 页面 / 路由清单

路由表集中在 `packages/agent-ui/src/router/route-config.ts`（编译在 `ui-docs-viewer-CTU4bllw.js`）。每路由带 `handle.view`（shell 左侧会话列表按此为 tasks/automation/claw/colleagues/genie 分组，`deriveConversationListView`）。

### 3.1 主应用 shell 路由（SHELL_ROUTE_CONFIGS）

| 路由 path | 视图 view | 组件 | 页面用途 | 证据 asset chunk |
|---|---|---|---|---|
| `/`、`/home` | home | HomePage | 首页/工作台：欢迎 + 快捷启动（含 genie 应用卡片、频道品牌图） | `home-CfhZ9VO7.js`、`app-home-BwXhNU7Z.js` |
| `/task/:taskId` | chat | ChatPage | 单个任务/会话的聊天页 | `chat-BeFCeHHQ.js`、`conversation-DBVPVvoW.js`(redirect) |
| `/conversation/:conversationId` | conversation | ConversationPage | 指定会话详情 | `conversation-DBVPVvoW.js` |
| `/projects/*` | projects | ProjectsPage | 项目/工作台列表（collab 项目、项目详情、成员/申请入队） | `projects-BhaLqdkz.js`、`project-list-page-SQWvWvU6.js`、`project-detail-page-CD6myD5N.js`、`genie-project-lgLAqdik.js` |
| `/automation/*` | automation | AutomationPage | 自动化任务（编排/触发器/历史详情） | `automation-C05Up0nt.js`、`automation-panel-D0Z6gMqw.js` |
| `/colleagues/*` | colleagues | ColleaguesPage | 同事/团队协作（colleagues-panel、ACP 聊天、他人作品详情） | `colleagues-BnEtl3SC.js`、`colleagues-panel-lqkbF1Re.js`、`colleague-chat-page-28taxFJ-.js` |
| `/claw` | claw | ClawWorkspacePage | 「Enterprise Agents」自主智能体工作区（会话/技能 tab，微信/企微通知连接） | `claw-ChObIYBT.js`、`agent-chat-pane-B_Vq3oQg.js`、i18n `header.enterpriseAgents` |
| `/experts/*` | experts | MarketPage | 专家市场（专家列表/详情，expert-picker、install-intent-buffer） | `market-BDnsOKDz.js` |
| `/skills` | skills | MarketPage | 技能市场（skill-picker、skill-scan/install 协调器） | `market-BDnsOKDz.js`、`skills 模块` |
| `/discover` | discover | DiscoverPage | 发现页 | `discover-Dr4pnn85.js` |
| `/connectors` | connectors | MarketPage | 连接器市场（connector-capsule、OAuth、device-code 弹窗、oneid） | `market-BDnsOKDz.js`、`connector-device-code-modal-CknKFhbt.js`、`modules/connector/*` |
| `/plugins` | plugins | PluginsPage | 插件管理页 | `plugins-BwZ0gTem.js`、`plugins-panel/styles.less` |
| `/inspiration` | inspiration | InspirationPage | 灵感/创意（brandGate） | `inspiration-2R38SQv2.js`、`inspiration-panel/styles.less` |
| `/library/tencent-docs` | tencent-docs | TencentDocsPage | 腾讯文档知识库/文件库（brandGate） | `tencent-docs-DDa5R7Eu.js`、`knowledge-base-panel/tencent-docs/*`、`tencent-docs-panel-BxZmREXP.js` |
| `/library/ima` | ima | ImaPage | 腾讯 ima 知识库（brandGate, keepAlive） | `ima-BjiC2Z0B.js`、`modules/ima/services.tsx` |
| `/library/lexiang` | lexiang | LexiangPage | 腾讯乐享（brandGate, keepAlive） | `lexiang-D2LVHgSg.js`、`modules/lexiang/services.tsx`、`knowledge-base-panel/tencent-lexiang/*` |
| `/library/my-files` | my-files | MyFilesPage | 我的文件/网盘（cloud-files、上传队列、my-files store） | `my-files-BgF3mGHH.js`、`knowledge-base-panel/my-files/*`、`netdrive-service-BrhxPqNC.js` |
| `/library/agent-mail` | agent-mail | AgentMailPage | 智能邮箱（收发邮件、agentmail 卡片） | `agent-mail-Bob4J813.js`、`modules/agent-mail/message-cards/agentmail-card.tsx` |
| `/iframe-menu` | iframe-menu | IframeMenuPage | iframe 菜单容器（嵌入外部 webview/菜单） | `iframe-menu-BHm_u6FF.js` |
| `/space` | space | SpacePage | 空间/工作空间（keepAlive, warmup, brandGate；space-panel、space-iframe） | `space-CyO6kUn4.js`、`space-panel-*` 多份 |
| `/genie` | genie-home | GenieAppHomePage | Genie AI 应用平台首页（App 卡片/项目列表/创建） | `app-home-BwXhNU7Z.js`、`modules/genie-project/pages/app-home/genie-app-card.tsx` |
| `/genie/project/:projectId` | genie | GenieProjectPage | Genie 单个 AI 项目（keepAlive） | `project-detail-page-CD6myD5N.js`、`genie-project-lgLAqdik.js` |
| `/extension/:extensionId` | extension | ExtensionRouteView | 安装扩展的宿主路由（iframe 扩展 + 联邦 host） | `extension-route-view-C5DembzS.js`、`router/extension-mount.tsx`、`workbuddy-extensions/src/renderer/*` |

### 3.2 独立/无 shell 路由（STANDALONE_ROUTE_CONFIGS）

| path | 组件 | 用途 |
|---|---|---|
| `/callback` | OAuthCallback | 连接器 OAuth 回调落地页 |
| `/deeplink` | DeeplinkLanding | 深度链接落地（skill 预选、deeplink-parser） |
| `/share/:code` | SharePreview | 分享内容预览（markdown/html/task/artifact 等） |
| `/tasks/share/:code` | TaskSharePreview | 分享任务预览 |
| `/share/agent/:agentBusinessId` | AgentSharePage | 分享的 Agent 落地页 |

### 3.3 核心业务模块（按模块目录）
- `modules/collab/*`：项目协作（**project-detail** 布局/输入/成员 apply-join、task-chat、teams 消息卡片 teams-invite/join-request、members-store、quota）。
- `modules/smart-sheet/*`：智能表格（xtable、bidirectional-follow、cell-builders、smartsheet-context）。
- `modules/connector/*`：连接器（OAuth 回调、device-code 弹窗、oneid-refresh）。
- `modules/expert/*`、`modules/skills/*`：专家/技能（picker、import-errors、install-intent-coordinator、scan-result-dialog）。
- `modules/agent-mail/*`：智能邮箱。
- `modules/deeplink/*`：深度链接（skill-preselect）。
- `modules/poi/*`：POI（兴趣点，含 McpPoiConsentCard 授权卡片）。
- `modules/input-intents/*`、`modules/wechat-chat-history/*`、`modules/ima/*`、`modules/lexiang/*`、`modules/automation/*`、`modules/home/*`、`modules/idle-capability/*`。

---

## 4. 关键前端架构

### 4.1 聊天界面（三层管线）
位于 `packages/conversation-render`（编译到 `lib-chat-ui-Cj2-mAGC.js`、`safe-delete-events-BbPpiWkR.js`、`ui-docs-viewer-CTU4bllw.js`）：
1. **`block-render` / `blocks`**：把会话数据折叠成「块」(ContentBlock/Frame) 的抽象渲染器。`block-render/blocks/model/block.ts`、`operations/compose/block-structure.ts`、`renderer/containers/document-renderer.tsx`（虚拟化）、`renderer/registry.ts`。
2. **`list-like-render`**：会话长列表的虚拟滚动渲染（`list-like-render.tsx`、`hooks/use-smooth-scroll`、`streaming-text/use-streaming-text-buffer`、`extensions/registry.tsx` 基础 frame/text/collapse 扩展）。
3. **`scenarios/task-chat` 与 `scenarios/common`**：任务聊天场景（assistant-message、reasoning、system-notice、user-message、conversation-event 扩展）+ 通用消息渲染（`workbuddy-message/agent/agent-renderer.tsx`、`self-bubble`、`user-content`、`cancelled-indicator`、`toolbar`）。
- **工具调用卡片**：`scenarios/common/tool-call/views/*` 提供几十种工具 UI——`agent-mail`/`automation`/`plan`/`task`/`question`/`read-file`/`write-file`/`list-files`/`delete-files`/`web-search`/`web-fetch`/`fetch-mcp-resource`/`mcp-call-tool`/`mcp-display`/`mcp-match-tool`/`search-tool`/`search-reference`/`image-gen`/`video-gen`/`dispatch-specialist`/`specialist-tools`/`team`/`integration`/`connect-cloud-service`/`plugin-recommendation`/`poi`/`todo-write`/`execute-command`/`enter-plan-mode`/`exit-plan-mode`/`open-result-view`/`completion`/`send-message`/`skill`/`weixinpay`/`conversation-search`/`visualizer-read-me`/`defer-execute` 等；`tool-call-host.tsx` / `tool-view-runtime.tsx` 统一装载，`acp-permission.ts` 做权限，`icon-set.ts` 做图标。
- **沙箱 widget**：`scenarios/common/widget/*`（`widget-iframe`、`widget-sandbox`、`widget-download`、`widget-save-file`、`widget-theme-sync`）——AI 生成的交互内容在 iframe 沙箱中运行。
- **Markdown 渲染**：`shared/components/react-markdown/*`，含 `code-block`（Prism 高亮）、`math-block`（KaTeX）、`mermaid-block`（svg-pan-zoom）、`image-block`、`table-block`、`inline-code`；`path-detector`/`custom-url-scheme` 处理链接。

### 4.2 聊天输入（`chat-input`）
- **Slate 编辑器**（`editor/input.tsx`、`plugins/with-phrase/with-paste/with-max-length`、`dnd/plugins/with-node-id`）：支持 @提及、短语（phrase）触发、拖拽排序、粘贴多维数据、图片预览（`deferred-image-preview`）。
- **控件**：`model-selector`（模型选择、`model-icons.tsx` 含 KimiIcon）、`add-menu`（文件/专家/技能/模式/连接器/引用文件）、`voice-button`（语音+`voice-waveform`）、`enhance-button`、`quick-action-bar`、`input-footer`（`workspace-picker`、`permission-setting`）、`status-chips`（connector/expert/mode chip）、`context-usage-display`（按类目 Usage 弹层）、`drop-zone`、`send-button`、`resize-handle`、`trigger-search-panel`、`input-banner-rail`、`input-notification-banner`。
- **Providers 架构**：`providers/icon-provider`、`mode-provider`、`command-provider`、`connector-provider`、`attachment-provider`、`attachment-constraints`，配合 `store/*`（reducer/actions/draft/selector）。

### 4.3 主内容区 / 项目工作台（`components/main-content-core` = `main-content-core-BPPEee-O.js`）
- `main-content-core.tsx` 定义聊天主内容容器；`wb-input-footer`、`wb-input-attachments`（wechat-chat-history-chip / 附件）、`link-paste-providers`（tencent-docs/ima/tapd/connector/multi-provider）、`tool-renderer`、`poi-floating-panel`、`mcp-app-launcher-panel`、`miniprogram-phrase-renderer`、`team-member-bar`。
- 帮手件：`cancel-barrier`、`pending-interactive-tool`、`sandbox-intercept-visibility`、`assistant-display-snapshot`、`ardot-artifact-turn`、`queue-explicit-send`、`auto-clear-before-send`、`genie-project-create`。
- 项目/工作台另有 `components/claw-workspace/tabs/agent-chat-pane.tsx`（智能体聊天窗格）、`workspace-preparing`、`branch-switch-error`、`components/space-panel/*`、`components/knowledge-base-panel/*`（my-files / tencent-docs / tencent-lexiang）、`components/automation-panel/*`、`components/inspiration-panel/*`、`components/plugins-panel/*`。

### 4.4 文件预览 / 多模态（`packages/context-viewer-components`）
`media-preview/components/*` 提供统一预览：`pdf-preview`（PDF.js 5.4.296，含 `worker-impl`、`cmaps/standard_fonts`）、`image-preview`、`docx-preview`、`pptx-preview`、`sheet-preview`（xtable）、`video-preview`、`audio-preview`、`excalidraw-preview`、`drawio-preview`、`markdown-editor`、`smartcanvas`（`canvas-view-JxauDOY-.js`，SmartCanvas/SmartSheet 块）。`hooks/usePreviewMode`（Esc 关预览）、`hooks/useArtifactReader`、`hooks/useRotateControl`、`hooks/useScrollPageControl`、`use-zoom`（`zoom-in/out-icon`）。
- 代码编辑：`context-viewer-components/codeEditor` 配 `theme-manager.ts`（Monaco/共享主题），`document-upload-runner`、`file-type-icon`、`context/detail-panel-wrapper`（`detail-panel-wrapper-*` 负责右侧详情面板装载预览）。
- 多模态：输入侧支持**语音**（voice-button + waveform）、**图片**（image-preview、`resolve-image-preview-src`）、**图片/视频生成**（`image-gen`、`video-gen` 工具卡片）、`apear/ardot-canvas`（`utils/ardot-canvas.ts` 画布渲染）。模板 `workbuddy-prompt.tpl` 用 `{%- if not productFeatures.DisableMultimodalGeneration %}` 开启多模态生成能力。

### 4.5 主题与品牌（澄清 kimi/berry/crystal/aurora）
- **皮肤/主题系统**：`packages/agent-ui/src/utils/skin/skin-manager.ts`（在 `ui-docs-viewer` 内，注释同 index.html）统一写 `data-vscode-theme-name` / `--vscode-*` CSS 变量 + body class 决定明暗；默认主题 IDE Light（见 `index.html:64-76` 与 `theme/default-light.scss`）。`--cb-*`（如 `--cb-bg-color-container`）为另一套业务 CSS 变量前缀。
- **代码编辑器主题**：`context-viewer-components/codeEditor/theme-manager.ts`、`shared-theme-manager.ts`（Monaco 配色，配合 shiki/Prism）。
- **Shiki 高亮**：`berry`、`crystal`、`aurora-x` 均为 `@shikijs` 模块（`@shikijs/langs/dist/berry.mjs`、`crystal.mjs`；`@shikijs/themes/dist/aurora-x.mjs`），即**代码语法高亮语言/主题**，与 App 皮肤无关。
- **Kimi 品牌**：Kimi 是第三方 LLM Provider（Moonshot AI）。证据：i18n `settings.models.providers.kimi-coding`/`kimi-intl`/`kimi-cn`；`lib-chat-ui` `model-icons` 中的 `KimiIcon`、Provider 映射注释「本地自定义模型 → GLM/Kimi/腾讯云等 provider icon」；端点 `https://api.kimi.com/coding/v1`、`https://api.moonshot.ai/v1/chat/completions`、`https://api.moonshot.cn/v1/chat/completions`。模型选择器据此展示 Provider 图标与按 tier 分组的模型树（`model-tier-badge`、`model-sub-menu`、`model-group-menu-item`）。
- **产品品牌 `channel-branding`**：两种分发渠道官方 logo 图（`cmcc-mobile.png`=中国移动、`unicom-cloud-desktop.png`=联通云桌面），由主进程 `main/workbuddy-product-config.js` 读取，renderer 通过 `branch-switch-error-B-vAiXCI.js`、`home-CfhZ9VO7.js`、`index-D3SrJ2Mw.js` 等处的 `channel-branding` 工具以 `toLocalFileUrl` 加载（来源 `packages/workbuddy-app/src/...channel-branding.ts`）。

---

## 5. 对主进程 API 的调用（preload 桥 + IPC 面）

preload `preload/index.js`（311KB，`contextBridge.exposeInMainWorld` ×38）向 renderer 暴露如下对象。

### 5.1 `window.workbuddyDesktop`（主桥，`preload/index.js:6520` `createWorkbuddyDesktopHost`）
全部为 `ipcRenderer` 薄封装：

| 命名空间 | 方法 → IPC channel |
|---|---|
| 顶层 | `invoke(command,args)` → `workbuddy:invoke`；`events.on(event,handler)` → `workbuddy:event:<event>` 或 RAW_HOST 通道；`platform` / `appVersion` / `configDir` / `machineId()` → `workbuddy:machineId` |
| `app.*` | `getBootstrapInfo`、`getPendingDisplayLanguageMigration`、`completeDisplayLanguageMigration`、`consumePendingOpenUrls`→`app:consumePendingOpenUrls`、`consumePendingWechatChatHistoryChips`、`ackWechatChatHistoryChip` |
| `window.*` | minimize/maximize/close/isMaximized/isFullscreen/setFullscreen/toggleFullscreen/openStartupAnalysis/startDrag/stopDrag；事件 `onMaximizeChange/onFocusChange/onFullscreenChange` → `window:maximizeChanged`/`window:focusChanged`/`window-fullscreen-changed` |
| `opener.*` | `openUrl(url)` → `workbuddy:opener:openUrl` |
| `localFile.*` | `open(options)` → `workbuddy:localFile:open` |
| `dialog.*` | `open(options)` → `workbuddy:dialog:open`；`saveImage(dataUrl,name)` → `dialog:saveImage` |
| `clipboard.*` | `readText`/`writeText`/`writeImage` → `workbuddy:clipboard:*` |
| `notification.*` | `isSupported`/`requestRegistration`/`sendNotification` → `workbuddy:notification:*` |
| `globalShortcut.*` | `updateToggleWindow` → `workbuddy:globalShortcut:updateToggleWindow`；`onRegistrationStatus` → `globalShortcut:registrationStatus` |
| `ipcRenderer` | **受限白名单**（仅 `startup:message`、`startup:preload-timeout`、`splash-state:update`、`account-snapshot:persist`；sendSync 仅 `account-snapshot:persist`） |

### 5.2 其他 exposeInMainWorld
- `window.__wbInvoke(channel, ctx, ...args)`（→ 主进程，最终到 daemon RPC）；`window.__wbOn` / `__wbOff` / `__wbEventBridge`。业务层由 `packages/workbuddy-core/src/wb` 的 `createWorkbuddySDK` 统一包装成 `wb.invoke(channel,...args)` / `wb.on/off/onAny`。
- `window.vscode = { webUtils: { getPathForFile(file) } }`——拖拽本地文件取绝对路径。
- `window.mqq`（QQ 生态 mini-program 桥）+ `workbuddy:mqqBridge` / `workbuddy:mqqDirtyGuard` / `workbuddy.accessProbe`。
- `window.__hostPlatform` / `__hostPlatformProbe`（platform/arch/hostArch）。
- `window.__getClientMenuPreloadUrl`、`__getHostWebviewPreloadUrl`、`__getTdocImportPreloadUrl`、`__getTdocPreviewPreloadUrl`（webview 预载 URL）。
- `window.__workbuddyTelemetry`、`__workbuddyRenderLog`、`__workbuddyRendererLogWrite`、`__reportRendererJsError`、`__workbuddyStartupPerfD`（遥测/日志/性能）。
- `window.__workbuddyRegisterOnlineDocPreview` / `UnregisterOnlineDocPreview` / `RegisterSandboxDocPreview` / `UnregisterSandboxDocPreview` / `__workbuddyUpdateSandboxDocPreview` / `UpdateDocsFeatureList`——文档预览注册。
- `window.__openTencentDocsDebugPanel`、`__setTencentDocsLanguage/Theme`、`__consumeTencentDocsRendererEvents`。
- `window.__setShortcutRecordingState`、`__signalSkeletonReady`、`__signalStartupFirstPaint`、`__signalFirstLocalListRendered`、`__debugCrashTest`、`__openStartupAnalysis`、`__workbuddyStartDragLocalFile`、`__workbuddyDevtoolsTerminal`、`__getStartupTraceid`。

### 5.3 关键 IPC channel / 事件（preload 常量）
- 命令：`workbuddy:invoke`（统一入口）；窗口 `workbuddy:window:*`；剪贴板/对话框/通知/本地文件/opener/globalShortcut 见上。
- 事件（`RAW_HOST_EVENT_CHANNELS`，不经 `workbuddy:event:` 前缀）：`app:openUrl`、`app:wechatChatHistory:appendChip`、`app:inspirationShareCode:detected`、`binary:install-progress`、`menu:openNetworkCheck`、`menu:openSelfCheck`、`menu:openHelpFeedback`、`self-check:progress`、`tip-sound:play`、`globalShortcut:registrationStatus`。
- 其它：`workbuddy:document-status-changed`、`workbuddy:tencent-docs-save-shortcut`、`workbuddy:machineId`、`workbuddy:mqqBridge`、`workbuddy:syncNativeTheme`、`workbuddy:devtools-terminal:*`。

### 5.4 renderer 使用模式
- `host-xumqttWE.js`（`packages/workbuddy-app/src/desktop/host.ts`）导出 `getDesktopHost()`，返回 `window.workbuddyDesktop`（校验 `invoke`/`events.on` 存在）。
- 扩展 iframe：`extension-route-view-C5DembzS.js` 用 `window.__wbInvoke(channel, ctx, ...args)` 做 `MethodChannel`，供 `createExtensionIframeHost` 消费（iframe 扩展 → 主进程 IPC）。
- `setupDesktopSDK()`（main.tsx）：若 `window.__wbInvoke` 存在则初始化 SDK；`wb.invoke` 打点 `wb.invoke.<ch>` 性能计数。
- daemon 传输：preload `installDaemonTransportPortForwarder()` 监听 `window.postMessage({type:"workbuddy:open-local-daemon-transport-port",...})`，把 MessagePort 转给主进程，开启 renderer 主世界→ main→ daemon 的本地通道（`invokeDaemonFrame` / `sendDaemonFrameOnce`）。

---

## 6. 资源文件（`app_asar/resources/`）

| 目录 | 是什么 | 关键内容 |
|---|---|---|
| `templates/` | **Nunjucks 提示词模板**（拼装 system prompt） | `workbuddy-prompt.tpl`（基础系统提示，`This conversation is powered by {{ modelName }}`）、`workbuddy-expert-*-prompt.tpl`（专家模式）、`workbuddy-ask-*`、`workbuddy-craft-*-prompt.tpl`（craft/plan 模式）、`ask-mode-reminder.tpl`、`craft-mode-reminder.tpl`、`system-reminder.tpl`、`user-context-identity.tpl` / `user-context-expert-identity.tpl`（身份上下文，含 `WorkspaceIdentityMode=='onboarding'`、BOOTSTRAP.md/SOUL.md/IDENTITY.md 流程）；`style/` 下 7 份写作风格提示（creative/efficient/friendly/professional/sarcastic/socratic/straightforward） |
| `plugins/workbuddy-builtin/` | **内置插件市场**（`marketplace.json` 注册 33 个插件） | `welcomemode/{code,work,design}` 欢迎模式；`interactionmode/{plan,expert,ask,craft}` 交互模式（各自 `fragments/*.md` 注入对话，如 plan 的 task-management/tool-use/agent-loop/result-presentation/current-mode/interaction）；`skills/*`（skill-creator、ardot-design-core/router/to-code/ui-design/slides、recommend-experts、recommend-connectors、marketplace-skill-installer、sites、library、geo-map-compliance-guard、tencent-docs-routing、tencent-local-office-edit、wb-finance-skill、livestream-poster、buddy-multimodal-generation、expert-manager）；`mcps/{ardot-mcp-app,agently-cli}`；`prompt-common/fragments`；`builtin-plugins/{weixinpay,tencent-pptx,tencent-docx,tencent-docs-plugin,sheetagent}` |
| `extensions/edge-sync/` | 一个真实安装的**扩展**（含 `ui/index.html`、`server/index.cjs` 1.5MB、`extension.json`、`distribution.json`、`assets/icon.svg`） | `extension.json` 描述清单，renderer 经 `extends/extension-mount` + `workbuddy-extensions/src/renderer` 以 iframe/联邦方式加载，`server/index.cjs` 由主进程跑 |
| `builtin-expert-recommendations/curated-experts.json` | **内置专家推荐清单** | `{version:1, candidates:[{id,type:"expert",scenarios:[...],description,priority}]}`——如 `SeniorDeveloper`（高级开发/架构/代码质量, priority 300）、`WeChatMiniProgramDeveloper`（小程序/微信生态）、`EquityResearchExpert`（股票研究/估值建模）等，用于 onboarding/推荐专家 |
| `channel-branding/` | **渠道品牌图** | `cmcc-mobile.png`(867×250)、`unicom-cloud-desktop.png`(1197×324)——中国移动 / 联通云桌面分发渠道 logo，由主进程按渠道注入 |
| `devtools-terminal/` | 开发者工具终端 | `ghostty-web.js` + `ghostty-vt.wasm`（Ghostty 终端渲染）、`manifest.json`、`panel.html/js`（WebView 面板）、`devtools.html/js` |
| 顶层 | 预载/资产 | `client-menu-preload.js`、`tdoc-import-preload.js`、`tdoc-preview-preload.js`、`mcp-app-preload.js`；`trayTemplate.png`(菜单栏托盘) / `@2x`；`icon.ico`/`icon.png`(应用图标) |

---

## 附录：发现的网络端点（renderer 层，供主会话汇总）

**产品/官网**：`www.workbuddy.ai`、`www.workbuddy.cn`、`staging.workbuddy.ai`、`staging.workbuddy.cn`、`docs/`、`document/privacy-policy|term`。

**API/LLM（模型 provider）**：
- Kimi/Moonshot：`https://api.kimi.com/coding/v1`、`/coding/v1/chat/completions`、`https://api.moonshot.ai/v1/chat/completions`、`https://api.moonshot.cn/v1/chat/completions`
- 腾讯云大模型（lkeap / 混元）：`https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions`、`/plan/anthropic/v1/messages`、`/plan/v3/chat/completions`
- 模型配置：`https://codebuddy-1328495429.cos.ap-singapore.myqcloud.com/connectors-config-v2/custom-model/customModelSettings.json`、`https://static.workbuddy.cn/connectors-config-v2/custom-model/customModelSettings.json`

**腾讯账号/身份/遥测**：`account.tencent.com`、`api.account.tencent.com`、`api.pre-account.tencent.com`、`identity.tencent.com`、`galileotelemetry.tencent.com`（埋点）、`tokenhub.tencentmaas.com`、`ca.turing.captcha.qcloud.com/TJNCaptcha-global.js`（验证码）。

**文档/网盘（SPAPI）**：`docs.qq.com`、`docimg{2,3,4,8,9}.docs.qq.com`、`doc.weixin.qq.com`、`rescdn.qqmail.com`、`pub.idqqimg.com`、`iwiki.woa.com`（腾讯内网 wiki）；`/spapi/team/v1/teams`、`/spapi/kb/space/v1/spaces`、`/spapi/kb/import/v1/tasks`、`/spapi/kb/file/v1/files/hyperlink`、`/spapi/connector/iwiki/v1/nodes`、`/spapi/account/v1/staff|company`（host 由配置注入，[INFERENCE] 推断走 workbuddy 国内/国际网关）。

**COS / CDN 资产**：`acc-1258344699.cos.accelerate.myqcloud.com`（登录图、expert 默认头像、专家市场 `expert-marketplace/experts`）、`codebuddy-platform-1258344699.cos.accelerate.myqcloud.com`（专家头像）、`codebuddy-clawbot-1328944842.cos.ap-beijing.myqcloud.com`（附件）、`openplatform-cdn.codebuddy.cn`、`download.codebuddy.cn`、`ardot.tencent.com`（画布）、`buy.cloud.tencent.com`（乐享/选购）。

**代码/平台**：`www.codebuddy.cn`、`agentclientprotocol.com`（ACP 协议）、`developer.mozilla.org`/`reactrouter.com`/`floating-ui.com`/`github.com` 等（第三方文档/元数据，非业务端点）。

---

### 一句话总结
WorkBuddy AI 桌面端 = **React18 + Jotai/Immer + React Router + Vite(rolldown)** 的 Electron SPA；UI 复用腾讯 dui + 自研 lib-chat-ui / conversation-render / context-viewer-components 三件套；单张路由表驱动 20+ 内置页面（聊天、项目协作、智能体、文档/网盘知识库、智能邮箱、Genie 平台等）；渲染管线「块渲染 → 工具卡片 → 沙箱 widget」承载 AI 会话；与主进程统一经 preload 的 `workbuddyDesktop` / `__wbInvoke` 桥通信，业务通过 workbuddy-core 的 `wb` SDK 走 `wb:命名空间:方法` 到 daemon。
