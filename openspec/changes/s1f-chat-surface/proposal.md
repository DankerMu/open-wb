# Proposal: s1f-chat-surface

## Why

ADR-0013 决定把前端重建在 assistant-ui + shadcn/ui + Tailwind 上。change A（`s1f-ui-foundation`，已归档）交付了地基与外壳、登录页、设置页；
会话页（`/`）仍是旧的自有基元 + 逐组件 CSS 实现，`@assistant-ui/react` 尚未进入依赖。本 change 是 S1f 的 B：把会话页重建到新栈上，
并在新页面上解决三个仍可复现的缺陷：

- #824：切换欢迎页场景弹出多余的提示。
- #825：选中零消息会话时主区一片空白。
- #826：点「新建会话」立刻 `POST /api/sessions`，留下空会话。

owner 在本次 grill 里另外定了三件事，改变了 `IMPLEMENTATION_PLAN.md` 对 B 的原始描述（「纯前端」不再成立）：

- 待决审批做成输入框上方的提问卡（参照 Claude Code 桌面版），不用 assistant-ui 挂在工具卡上的审批字段。
- 助手的任务清单（omp `todo` 工具的状态）显示在输入框上方；后端目前不向 web 暴露这份状态，本 change 补上。
- 会话页不再弹轻提示：成功/信息类提示删除，失败改为就地显示。

## What Changes

- **运行时接入**：会话页经 `useExternalStoreRuntime` 接现有 REST + SSE。`web/src/lib` 的 API 客户端、流式 reducer、连接器、所有权 fence 的行为不变；
  重写的是呈现层。页面状态先抽成无渲染的 `useChatSession`，会话列表（change C 的面）继续经现有 props 契约消费它。
  运行时只负责线程呈现：`isRunning` 只看末条助手消息是否在跑（不产生乐观的助手占位）；输入框是应用层组件，应用的草稿状态是唯一事实来源，`onNew` 只是委托给现有发送路径。
- **拷入组件**：线程、消息、步骤卡、停靠区、输入框是 `features/chat/` 内的应用层组件，直接用 `@assistant-ui/react` 的基元组合；不拷 registry 的 `thread` 与 `tool-fallback`。
  拷入 `web/src/components/assistant-ui/` 的只有 `markdown-text`、`reasoning`、`tool-group`（各随首个消费者拷入，只做 A 定下的六类修改），行为定制全部在应用层。
- **消息线程**：用户气泡、助手块、思考折叠、工具调用默认折叠成一行摘要（失败步骤自动展开）、停止徽章、操作行（复制 / 重新生成 / 从此处分叉）、贴底跟随与「回到最新」。
- **Markdown**：助手正文改用 `@assistant-ui/react-markdown`；源 HTML 不生成元素、链接与现状一样惰性（只显示可见文本，不生成链接元素）、图片不加载（显示 alt 文本）。`lib/md-render.ts` 留给文件页。
- **输入框与能力栏**：工作空间选择（欢迎态可选，会话开始后只读）、「+」菜单列出技能/命令、斜杠候选保留；权限设置、上传、专家不渲染（无后端不渲染）。
- **输入框上方停靠区**：自上而下为任务清单面板、待决审批提问卡。审批答完即收起，消息内按消息留一条已结算记录；作答失败在卡内就地提示并可重试。
  停靠区有最大高度并在内部滚动，不把输入框挤出视口（极端状态由整页挂载测试断言结构，真实栈能产生的状态由 ui-walk 断言布局）。
- **任务清单（含后端）**：服务端从 omp `todo` 工具结果取全量清单，落库到会话行，经新 SSE 事件 `todo.updated` 与快照字段 `todo` 下发；web 归约并显示面板。
- **欢迎页与会话创建**：三场景只作欢迎页的建议分组，切换不弹提示（#824）；点「新建会话」只回欢迎态、零 `POST /api/sessions`，首次发送才创建（#826）；
  选中的零消息会话显示轻量空态（#825）。
- **文件变更卡、产物卡与产物面板、对话内搜索框、项目配置入口**：换到拷入层组件（`sheet`、`dialog` 等），行为不变，提示改就地。
- **轻提示退场**：重建后的会话页文件不再导入 `useToast`。会话列表的重命名/置顶/删除提示属 change C，本 change 不动。
- **旧样式退役**：`messages.css`、`project-config.css` 删除；`chat.css` 只剩会话列表规则（留给 C）；`legacy.css` 里 `.chat-md` 的 `revert` 规则删除。
- **验收**：`docs/acceptance/functional-checklist.md` 的「会话（CH）」节补行（结论 `待签`）；ui-walk 的会话相关步骤改按角色/可访问名选择，建会话的辅助函数改走首次发送。
- **BREAKING（规格层）**：`tool-approval`「web 审批条」与 `chat-web`「会话页」里「审批条在助手消息内」的条文改为输入框上方；
  `session-sidebar` / `spa-shell` 里「点新建会话即 POST」的条文反转；规格里要求 Toast 的条文（`已停止生成`、`已复制到剪贴板`、`正在重新生成…`、场景切换等）删除或改为就地呈现；
  会话快照从三键变四键（新增 `todo`）。

## Capabilities

### New Capabilities

- `session-todo`：任务清单的来源、归一化与上限、持久化、`todo.updated` 事件、快照字段、web 契约解析与归约、输入框上方的面板。

### Modified Capabilities

- `chat-web`：会话页（运行时接入、消息线程、输入框与能力栏、停靠区、空态、创建时机、轻提示退场、Markdown 渲染器）、会话页源码模块划分、步骤卡条文的呈现部分。
- `session-sidebar`：欢迎页场景（建议分组、不弹提示）、「新建会话」只回欢迎态、输入框的工作空间选择。
- `spa-shell`：外壳里与「新建会话即创建」相关的条文（只改条文；外壳的焦点规则与实现不变）。
- `tool-approval`：web 审批条 → 输入框上方提问卡 + 消息内已结算记录。
- `turn-control`：回合控制 web 呈现（停止 / 重新生成不再弹提示）。
- `turn-artifacts`：文件变更卡、产物卡、产物面板的呈现与失败就地显示。
- `conversation-search`：跳转与命中标记在新线程上的落点（消息根 `article`、`aria-current`）。
- `thinking-fold`：思考折叠在新线程上的呈现。
- `chat-stream`：事件联合新增 `todo.updated`。
- `chat-sessions`：会话 schema 新增 `todo` 列（迁移 036）、快照新增 `todo` 键。
- `omp-test-harness`：fake omp 的 `todo` 场景与 fake 上游的 `todo` 工具调用标记。
- `chat-harness`：ui-walk 对任务清单、首次发送建会话、审批位置的断言，以及停靠区布局的断言（一张待决提问卡时、任务清单面板展开时）。
- `ui-foundation`：已迁移区域清单增长（会话页逐文件登记）及其终态；拷入层新增 assistant-ui 组件。
- `ui-primitives`：一个场景（`焦点归还不滚动`）改以会话重命名对话框为对象，其余不变。

## Impact

- **代码**：`web/src/features/chat/**`（会话列表相关的八个文件除外）、`web/src/components/assistant-ui/**`（新增拷入组件）、`web/src/components/ui/**`（按需新增拷入组件）、
  `web/src/lib/session-contract.ts` 与 `web/src/features/chat/stream*.ts`（`todo`）、`web/src/styles/legacy.css`；
  `server/src/sessions/**`（事件归约、`turn-control.ts` 的持久化路径、一个新的 store 模块、快照；`supervisor.ts` 与 `store.ts` 不增长）、`server/src/core/db/migrations/036_*.sql`、`server/test/support/fake-omp.mjs`、`fake-upstream.mjs`。
- **依赖**：新增 `@assistant-ui/react`、`@assistant-ui/react-markdown`、`remark-gfm`，以及拷入组件自身需要的包（如 `tw-shimmer`，随该组件加入）；都在 `ATTRIBUTION.md` 登记。
- **测试**：`web/test/chat-*.test.tsx` 中读 `.css`、按旧类名选择的断言随所在分片退役或改写；行为断言（按角色/可访问名）原样保留，除非对应规格条文在本 change 里被改。
  `web/e2e/ui-walk*.ts` 的会话步骤改写。每个分片自带它打破的断言改写与旧文件/旧 CSS 的删除。
- **不动**：会话列表 UI 与其动作（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、
  `rename-dialog.tsx`、`delete-dialog.tsx`）、外壳文件（窄屏下点「新建会话」后的焦点沿用外壳现有规则）、文件页、`web/src/ui/**` 冻结区、`main.tsx` 的旧 `ToastProvider`（D 退役）。
- **包体**：试装约 1.09 MB（重建前基线 598,483 字节，约 0.6 MB）。本 change 不做代码分割，收尾分片量出数字写进 PR；是否分割另行立项。
