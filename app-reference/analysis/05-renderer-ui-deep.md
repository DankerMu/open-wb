# WorkBuddy AI 5.4.2 渲染层 UI 深度报告（第二轮）

> 范围：renderer 静态产物（Vite/rolldown chunk、zh-cn 语言包、骨架 index.html）的证据化 UI 结构分析。
> 本轮目标：补齐第一轮报告（`02-renderer-ui.md`）缺失的**组件级结构、真实文案键值、token 规格**，并落地到 demo（`workbuddy-demo.html`）。
> 证据根：`app-reference/app_asar/renderer/`。全部行号基于解包产物原样。

---

## 1. 壳层 Shell（skeleton / index.html）

**VS Code 主题化是壳层的地基**，不是自绘主题：

| 证据 | 位置 |
|---|---|
| body 背景/字体走 vscode 变量 | `renderer/index.html` 内联 `<style>`：`var(--vscode-editor-background)`、`--vscode-editor-foreground, #3b3b3b`、字体 13px |
| 默认主题名 `IDE Light`，明暗与系统解耦 | `body[data-vscode-theme-name="IDE Light"]`（注释明写：默认 IDE Light，皮肤与系统明暗完全解耦，#93057） |
| 骨架布局常量 | `--sk-titlebar-h: 38px`、`--sk-sidebar-w: 220px`、`--sk-statusbar-h: 22px`；sidebar 背景 `#f7f7f8`、padding `12px 10px` |
| titlebar 可拖拽 | `.sk-titlebar { -webkit-app-region: drag }`（Windows/Linux frame:false 场景） |
| 骨架内容占位 | `.sk-content-tag { 80×32 圆角16 }`、`.sk-content-input { min(560px,80%) × 120 圆角12 }` |

**demo 对齐修正**：`--sidebar-w: 264px → 220px`（骨架代码常量，替换上轮按截图比例推算的 264）。

---

## 2. 首页 Welcome（`home-*.js/css`，118KB + 6.9KB）

### 2.1 组件树（源码证据）

```
wb-home-route                     // home-KqE7jadI.css:.wb-home-route
├── wb-home-cloud-header          // 云端版头部（登录态/云端渠道才渲染）
│   └── logo(img) + nav(8 项)     // cloudWelcome.nav.*：IDE/CLI/定价/文档/博客/插件/API文档/活动
├── wb-home-route__body(滚动区, scrollbar 6px/two-phase hover)
│   └── wb-home-page              // min-height: max(calc(432px + 220px), 100%)
└── wb-home-route__input-wrap     // position: relative
    ├── wb-home-route__growth-buddy  // 吉祥物：top:-78px right:0 z:0 pointer-events:none
    ├── wb-home-route__input-box
    └── wb-home-route__input      // 首页 composer（Slate 编辑器承载）
```

### 2.2 输入框 = Slate 富文本编辑器

- `.wb-home-route .cr-input-editor-host { min-height: 74px }` + `[data-slate-editor] { min-height: 74px !important }`（home-KqE7jadI.css:58-61）
- 首页 composer 内嵌于 `wb-home-composer__input-slot`（padding/border-radius 全清零，即输入框本身无边框，由外层卡片提供）
- demo 用 textarea 等价替代（Slate 富文本超出单文件 demo 承载），差异录入 §8

### 2.3 吉祥物 growth-buddy

- `.wb-home-route__growth-buddy { position:absolute; top:-78px; right:0; z-index:0; pointer-events:none }`（home-KqE7jadI.css:63-68）
- 素材：`assets/claw-welcome-light-DIM0nkzP.svg`（**1.63MB**，内嵌 1376×768 PNG base64 插画）+ `claw-welcome-unicorn-dark-*.png`（深色独角兽变体）
- demo：位置已改 `top:-78px; right:0`；SVG 素材体积过大不内联，保留手绘占位（路径可替换）
- 文案关联：`welcome.claw.*`（Claw 连接器：QQ邮箱/腾讯文档/腾讯会议/乐享/ima/企业微信五件套 + "通过 Claw，让 Agent 随时随地接手并推进你的工作…"）

### 2.4 场景模式 Scene Mode（截图 2 胶囊的代码解释）

```js
// home-CfhZ9VO7.js（压缩产物）
const modeOptions = DEFAULT_MODE_OPTIONS.filter(
  (option) => option.id !== "design" || (ardotDesignEnabled && taskTarget !== "cloud"))
```

- **设计创意（design）默认隐藏**，仅在 `ardotDesignEnabled` 且 `taskTarget !== "cloud"` 时出现 → 解释用户截图只有「日常办公/代码开发」两个胶囊
- 模式文案三套齐备：`welcome.mode.working|coding|design`（label + subtitle + description，zh-cn-DmCZLMnB.js:4783 区域）
- demo：保持 2 胶囊，design 数据保留在报告（未删）

### 2.5 双套首页文案并存（版本灰度证据）

| key | 值 | 行号 |
|---|---|---|
| `home.header.title` | `WorkBuddy, 我帮你`（半角逗号，旧版） | zh-cn:4951 |
| `welcome.title` | `WorkBuddy，我帮你`（全角逗号，新版） | zh-cn:4783 |
| `home.header.subtitle.*` | 你的职场/开发/设计超能力（旧版） | — |
| `welcome.subtitle` | 一站式产品工作室，助你规划、开发和发布应用。 | — |
| `home.sceneTabs.ariaLabel` | 场景切换 | — |
| `home.relatedPlaybooks.*` | 不知道做什么，试试最佳实践案例/换一批/查看更多/今日不再展示（旧版首页卡片区） | — |
| `home.practiceCases.*` / `home.aiDisclaimer` | 最佳实践案例 / 内容由 AI 生成，请核实重要信息 | — |

用户截图标题为半角逗号 → 截图对应当前线上 home.header 文案；新版 welcome 全角文案已在语言包但截图未呈现。**demo 保持截图样（半角）**。

### 2.6 快捷动作 Quick Actions（真实词条）

语言包 `welcome.quickAction.*` 共 **12 项**（zh-cn:4939-4950）：

起草产品规格 / 分析代码缺陷 / 生成文档 / 代码审查 / 重构代码 / 编写单元测试 / 编写文档 / 分析数据 / 起草邮件 / 研究主题 / 总结内容 / 生成报告

- 分组（working/coding 各 6）为 **[INFERENCE]**（按词义语义划分，源码无分组表）
- **截图五 chips（文档处理/金融服务/数据分析及可视化/深度研究/视频生成）在本地无静态数据源**（语言包、curated-experts.json、assets 全量 grep 均无）→ 判定为**服务端专家推荐运行时数据**（对应 `expert-marketplace` COS 端点），无法静态取证
- demo：12 项真实词条已落地（含 `key` 字段注释来源）

### 2.7 TaskTargetPicker（本地/云端 chip，issue #76366 v2）

- 渲染：`home-CfhZ9VO7.js`（floating-ui `top-start`/offset(6)/flip/shift({padding:8})/role=menu；chip 带 `data-task-target` 属性）
- 规格（home-KqE7jadI.css `_chip_1ofo0_9`）：**高 32 / 字号 14 / 圆角 999 / transparent / 色 --cb-text-tertiary / hover 主色+字重 500**；面板 min-width 200 / padding 8 / border 0.5px / radius 16 / shadow --cb-shadow-popover / 动画 0.18s 淡入
- 文案：`home.taskTarget.local|cloud|tooltip`（本地任务/在你本机运行/云端任务/在云端沙箱运行/选择任务运行位置，zh-cn:228-232）
- demo：已重实现 `<TaskTargetChip/>`（本地/云端切换 + 面板 ✓ 选中态 + desc 行）

### 2.8 工作空间与权限（输入框下方条）

- `taskStarter.selectWorkspace|selectFolder` = 选择工作空间（zh-cn:4872）；`inputFooter.permission.default` = 默认权限（zh-cn:5625）
- 真实 TaskStarter 另有：`welcome.taskStarter.github|gongfeng|cnb`（仓库源：GitHub/工蜂/CNB）、`welcome.taskStarter.startIn|selectRepo|selectBranch|hint`
- `workspace.keep.*`（保存到工作空间 dialog：可同时运行多个任务，互不干扰/对话和文件自动保存，不怕丢失/随时回来继续上次的工作）
- demo：perm-bar 文案与真实 key 一致；「选择工作空间」打开任务启动器（真实是 workspace picker chip，[INFERENCE] 简化路径在报告）

---

## 3. 聊天页 Agent Chat Pane（13KB）

### 3.1 内容宽度规则（agent-chat-pane-B_Vq3oQg.js:289 区）

```js
computeAgentChatMaxContentWidth(containerWidth):
  ≤1200 → DEFAULT_AGENT_CHAT_MAX_CONTENT_WIDTH (= 832, :289)
  ≤1600 → 65%    ≤2000 → 60%    >2000 → min(55%, 1400)
```

**demo 对齐修正**：`.chat-msgs max-width 780 → 832px`（DEFAULT 常数证据）。

### 3.2 组件结构与复用

- `AgentChatPane({ agent, kind, isActive, specialists, avatar, avatarVariant, openTarget, onChatTargetReady, onSessionDeleted, showModelSelector })`
- 复用 `ColleagueChatPage`（colleague-chat-page-chunk）+ `ClawAgentChatTopbar`（enterprise-annotations chunk）+ enterprise 追问/欢迎语（`getEnterpriseFollowUpQuestions`/`getEnterpriseWelcomeMessage`）
- 聊天输入框协议：`chat.input.placeholder.workbuddy` = "今天帮你做些什么？ @ 引用对话文件，/ 调用技能与指令"（zh-cn:5154，demo 已用）
- **聊天输入模式切换（demo 缺失）**：`DEFAULT_MODE_OPTIONS`（lib-chat-ui chunk）= Craft（默认）/ Plan / Ask，描述 = 可以执行文件操作、命令等 / 擅长制定多步骤计划 / 仅能读取文件

### 3.3 审批与工具状态（真实词汇对应）

| 场景 | key | 值 |
|---|---|---|
| 命令审批标题 | `tool.executeCommand.runCommand` | 确认执行命令？ |
| 命令审批按钮 | `tool.executeCommand.allow/alwaysAllow/reject` | 允许 / 始终允许 / 拒绝（**demo 三按钮已正确**） |
| 图片/视频生成审批 | `tool.approval.confirm/alwaysAllow/reject` | 确认 / 本次会话始终允许 / 拒绝 |
| 生成积分风险 | `tool.approval.riskTag.*` | 积分消耗较高 / 产生积分消耗 |
| 决策落章 | `tool.approval.decisionApproved/Rejected` | 已确认 / 已拒绝 |
| 工具状态 | `tool.status.success/failed` | 执行成功 / 执行失败（**demo 已修「完成→执行成功」**） |

---

## 4. 侧边栏（conversation.* 域，语言包 zh-cn:255 区）

### 4.1 导航键值

| key | 值 |
|---|---|
| `conversation.experts` (+`expertSub`=技能/连接器) | 专家·技能·连接器 |
| `conversation.automation` (+`automationSub`=定时任务) | 自动化 |
| `conversation.more` (+`moreSub`=灵感) | 更多 |

「更多」面板完整子项（真实全集）：灵感 / 项目(项目·团队协作) / 资料库(知识管理) / 应用·网站(可在线访问) / 我的邮箱 / 我的文件 / 腾讯文档 / ima知识库 / 乐享知识库 / 插件 / 技能 / 连接器 / 助理。

### 4.2 任务区

- 分区标签：`conversation.section.tasks|groups|workspaces|colleagueConversations|pinned`（任务/空间/工作空间/助理任务/置顶任务）
- 分类入口：`conversation.recently|all|cloudTasks|genieTasks`（最近/所有任务/云端任务/Genie 任务）
- **空态：`conversation.empty.title` = 暂无任务 / `conversation.empty.description` = 点击上方按钮开始新任务**（zh-cn:1179-1180，demo 文案命中）
- 顶部工具：`conversation.search`(搜索任务)/`conversation.filter`(筛选)
- 小程序 banner：`conversation.banner.wechatmp.*`（扫码领取 WorkBuddy 云上虾 / iOA 绑定提示）
- 双侧栏：`sidebar.mode.toggleToNext/toggleToLegacy`（试用新侧栏/回到经典侧栏）——线上存在新旧两套侧栏，用户截图为新侧栏

---

## 5. Token 体系（三层）

1. **vscode 层**：`--vscode-*`（editor-background/foreground/font-family/font-size=13px）
2. **wb 层**（产品设计 token，home CSS 直接消费）：`--wb-home-bg-secondary`、`--wb-border-subtle`、`--wb-spacing-2/4/6`、`--wb-radius-md`、`--wb-font-body-size/line-height`、`--wb-scrollbar-thumb[-hover]`、`--wb-home-slot-reserve`(220px)
3. **cb 层**（lib-chat-ui 1.47MB CSS，聊天 UI 库）：`--cb-text-primary/tertiary`、`--cb-dropdown-bg-color/item-hover-bg-color`、`--cb-popover-border`、`--cb-shadow-popover`、`--cb-green-color`、`--cb-focus-border(#007fd4)`；cb→wb 桥接注释见 home CSS TaskTargetPicker 段
4. 字体栈：`"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`（chat chip 与面板统一）

---

## 6. 本轮 demo 对齐状态

| 项 | 证据 | demo 状态 |
|---|---|---|
| sidebar 宽度 220px | 骨架常量 | ✅ 已修 |
| 场景 12 项真实 quickAction | 语言包 key | ✅ 已换 |
| 截图 5 chips 词条 | 本地无静态源 | ⚠️ [INFERENCE] 服务端数据，demo 用真实 quickAction 替代 |
| TaskTargetPicker（本地/云端） | home JS+CSS | ✅ 已重实现 |
| 工具状态词「执行成功」 | tool.status.success | ✅ 已修 |
| 消息宽 832px | agent-chat-pane:289 | ✅ 已修 |
| mascot 位置 top -78 / right 0 | home css:63 | ✅ 已修 |
| 空态文案 | conversation.empty.* | ✅ 一致（注释补 key） |
| 审批按钮 | executeCommand.* | ✅ 一致 |
| 输入占位符 | chat.input.placeholder.workbuddy | ✅ 一致 |

## 7. 未落地差距（需运行时/服务端证据）

1. **Slate 富文本编辑器**（cr-input-editor-host）——demo 以 textarea 代替
2. **聊天输入模式 Craft/Plan/Ask 切换**——demo 未实现（可后续加）
3. **截图五 chips 真实来源**——服务端 expert 推荐配置，需抓包运行时证据（nexus: `welcome` 页首屏 XHR）
4. **cloud header（云端版登录态）**——demo 未做（本地版无此 header）
5. **Claw 吉祥物真实素材**——claw-welcome-light.svg 1.63MB，如需还原可裁剪为 PNG 引入
6. **双范围 780 底部"输入框架"**（inputFooter.permission 存在但 demo perm-bar 简化为 2 项）——完整权限模式：默认权限/只读/完全访问等（`permission` 域，home JS `permissionMode`/`bypassPermissions` 出现）

## 9. 图标与排版取证（第三轮）

### 9.1 真实图标（16×16 fill 系，提取自源码组件）

| 用途 | 组件 | 来源 chunk |
|---|---|---|
| 场景·日常办公 | `DocumentIcon`（文档，非闪电） | branch-switch-error-B-vAiXCI.js（DEFAULT_MODE_OPTIONS：work→DocumentIcon / code→CodeIcon / design→PaletteIcon） |
| 场景·代码开发 | `CodeIcon`（`</>` 形状 + 斜杠） | 同上 |
| 场景·设计创意 | `PaletteIcon`（调色板） | 同上 |
| 侧栏·专家 | `ExpertIconV2`（16×16 evenodd，机器人接口脸） | ui-docs-viewer-CTU4bllw.js |
| 侧栏·自动化 | `ClockIconV2`（时钟，conversation.automation 的 defaultIcon=ClockIconV2） | 同上 |
| 任务·本地/云端 | `LocalTaskIcon` / `CloudTaskIcon`（16×16，Q 贝塞尔语法 path，TaskTargetPicker 选项 icon） | 同上 |

- demo 已内置 `ic16` 对象（真实 path 原样内联，含 transform 矩阵 / fill-rule）与 `I16` 渲染器（16 viewBox / fill=currentColor），场景胶囊、侧栏导航、本地任务 chip 均已切换。
- **发现修正**：demo 此前场景图标用 bolt/@（闪电/At）是**错误推断**；源码权威为文档/代码图标。

### 9.2 排版与 token（wb 设计 token 全集）

来源：safe-delete-events CSS（主题定义载体，浅/深双套）：

```
--wb-palette-gray-1 #FAFAFA / gray-2 #F7F7F7 / gray-3 #F2F2F2 / gray-4 #EBEBEB / gray-5 #E6E6E6
--wb-color-text-primary black-100 / secondary black-70 / tertiary black-50 / placeholder #727882
--wb-font-size-* 8/10/12/13/14/16/18/20/24/28/32；line-height 18…40；weight 400/500/600/700
--wb-radius-md 6 / lg 8 / 2xl 16 / 3xl 20 / 4xl 24 / full 9999
--wb-home-bg-secondary #ffffff（浅）/ #141414（深）
--wb-font-body-size = font-size-5 (14px)，line-height 22px，weight 400；strong=600
```

demo 已对齐：sidebar 220px、标题 34px/700、场景胶囊 padding 9×22 圆角 999 字 15、chips 高 32 圆角 full、composer 圆角 18/阴影、内容宽 832、本地任务 chip 32 高/999/hover 500 字重。

### 9.4 市场页（unifiedMarket）取证（第四轮）

**结构**（ui-docs-viewer chunk `UnifiedMarket*` 组件 + `TAB_CONFIG`）：

- 顶 tab：`TAB_CONFIG = [{experts, ExpertTabIcon}, {skills, SkillTabIcon}, {connectors, ConnectorTabIcon}]`，14px 图标；`MarketTabIcon` 支持服务端 iconUrl 覆盖（RemoteMenuIcon fallback 本地图标）
- 操作行：搜索框（`unifiedMarket.search.skills` = "搜索技能"/experts 为"搜索专家职称或描述"）+ "我安装的"（InstalledSkillIcon，进 skills-installed-subpage）+ "添加技能"（AddCircleIcon + Dropdown：寻找/上传/创建，trackId skill_upload/skill_create_new）
- 精选技能：`skills.recommend.featured`，`featuredSkills` state 带 `readCache("skills-cache-featured")` 缓存 → **服务端接口 + 本地缓存**
- 二级 tab：推荐 / 套件（`skills.tab.recommend` / `skills.tab.plugins`）
- 分类 chips：**服务端下发**（zh-cn locale 无分类文案）
- 侧栏"更多"图标 = `MoreIconV2`（conversation.more 使用处确认，右下带圈勾的两圆图标）
- 侧栏顶栏：SidebarCollapseIcon（面板）/ 搜索（lucide Search re-export）/ FilterIcon

**demo 落地**：icm 对象新增 7 个真实图标（mSkill/mConnector/mMore/mInstalled/mAddCircle/mFilter/mSidebar），MarketPage 重写为截图结构（tab 黑胶囊选中、精选 2 大卡、推荐/套件、10 分类 chips、3×4 卡片网格），默认 tab=技能。卡片名称/描述取自真实截图字面；logo 为彩色字母近似（真实 iconUrl 服务端下发，[INFERENCE] 配色目测）。

### 9.5 吸收对方 Live Demo 的改进（第五轮）

`resource/workbuddy-live-demo.html`（第三方原型，5.3.11 token 基线）对比吸收，**保留 5.4.2 基线**：

1. **审批 15s 倒计时 + 超时自动允许**（真实行为：countdown 15s 默认通过）——ApprovalCard 进度条+剩余秒数，超时 badge"超时自动允许"并继续流程
2. **执行步骤状态机**：plan 卡逐项推进（700-1200ms 随机）+ 每步耗时（0.4-1.8s 记录）
3. **文件变更卡**（`+128/-3` 行统计，git 图标）——对齐真实 Agent 交付的变更摘要
4. **跟进 chips**：流式完成后展示"把这份文档转成 PPT 大纲"等，点击回填 composer 并聚焦
5. **消息操作条**：复制 / 重新生成（截断重跑）/ 有帮助 / 没帮助
6. **MiniMarkdown 块级升级**：`###` 标题、有序/无序列表、表格（流式半成型不渲染，等完整表头+分隔行）、引用
7. **⌘K 命令面板**：任务/页面/主题搜索，↑↓+Enter 导航，Esc 关闭；侧栏搜索按钮接入
8. **hash 路由**：`#/view/param`，浏览器前进/后退/刷新保持
9. **主题三态 + 持久化**：浅色/深色/跟随系统（localStorage wb-theme），system 监听 prefers-color-scheme
10. **侧栏颗粒度**：任务分组计数"任务 (N)"、状态筛选菜单（全部/进行中/已完成）、相对时间（刚刚/N 分钟前）

**验证**：超时自动允许→继续流程→文件变更卡→表格渲染（3th/9td）→跟进回填 composer→重新生成（9→8 条重跑）→赞高亮→palette（12 项：页面8+主题3）→hash 路由 #/settings→后退→主题三态 localStorage 持久化，全链路通过。

### 9.6 会话（session）功能补齐（第六轮）

**原差距**：会话消息不持久化（切换即丢）、侧栏任务平铺无分区、无任务操作。

**落地**（对齐 conversation-list 真实结构 + 用户真实截图的分区）：

1. **会话持久化**：`msgsByTask`（taskId→msgs[]）上移 App 层，ChatPage 经 `getMsgs/setMsgsFor` 读写——切换会话消息保留
2. **侧栏四分区 + 归档**：置顶任务 / 任务 / 空间（项目·工作空间·专家团三小组，组头带类型图标）/ 助理任务 / 归档（条件显示）；分组可折叠（`groups` state）；组头计数
3. **任务操作菜单**（hover ⋯ + 右键 contextmenu）：置顶/取消置顶、重命名（内联编辑态 Enter/Esc/Blur）、从空间移除、归档/恢复、删除（ConfirmDialog 二次确认 + toast）
4. **状态可视化**：running 任务点 pulse 动画 + 「进行中」badge；failed → 红色「失败」badge
5. **相对时间**：刚刚 / N 分钟前 / N 小时前 / N 天前（任务 ts → fmtRel）
6. 新任务（createTask）进入「任务」组；空间挂载任务（`t.ws`）在对应空间组

**验证**：四分区渲染（置顶0/任务2/空间5/助理2）；Q3 发消息→切走→切回消息保留；置顶→置顶任务(1)；归档→归档(1) 出现；重命名「Outing 投票页 v2」；删除 Q3（确认框→移除→toast）；空间组折叠 3→0。

### 9.7 已知近似项（[INFERENCE]）

- chips 彩色方块图标：真实为服务端专家推荐的**卡通插画图标**（iconUrl 指向 openplatform CDN），本地无源；demo 用彩色圆角方块 + 白色线性符号近似（tint 取自截图目测）。
- 场景胶囊与 chips 的字号/间距按截图比例校准（截图无配套 CSS 常量可采）。

## 10. 下一步建议

- 若允许**动态取证**（当前约束：禁止启动应用）：启动应用后对 welcome 页拍 XHR 捕获 → 定位 5 chips 的接口与响应，可 100% 还原
- 补充 `project-list-page`（31KB css + 101KB js）与 `colleagues-panel` 的深度分析，对齐项目页/助理页（本轮未展开）
