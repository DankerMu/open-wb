# 前端改用 assistant-ui + shadcn/Tailwind 重建，不再以 demo 为验收基线

S1c 交付后的实测（2026-10-04，真实模型端点）暴露出：会话页按「与 demo 一致」逐组件对齐，得到的界面并不好用——输入框只有发送键，
工作空间只能在欢迎态选、选中空会话后选不了，权限与附件入口因「后端未到不渲染」而缺席。demo 是行为清单的来源，不是一个经过使用验证的设计。

决定（owner，2026-10-04）：

1. **整个前端改用 [assistant-ui](https://www.assistant-ui.com/) + shadcn/ui + Tailwind 重建。**
   会话面（消息线程、输入框、会话列表）用 assistant-ui 的组件；外壳、文件页、设置页、登录页与之后的中心页用 shadcn/ui 组件重写。
   `web/src/ui/*` 自有基元层与逐组件 CSS 随迁移退役。
2. **全站放弃「与 demo 一致」的验收基线。** `resource/workbuddy-live-demo.html` 只保留为功能清单来源（`IMPLEMENTATION_PLAN.md` 的 F-ID），
   不再约束布局、组件形态与文案。demo-vs-app 截图对（`make ui-shots`）与 `docs/acceptance/demo-parity-checklist.md` 的逐组件签收退役，
   改为按功能的验收清单；S1c 的 25 项待签不再签收。
3. **输入框能力栏是一等需求。** 工作空间选择、权限设置、「+」菜单（技能/命令、上传文件、专家）在任何会话状态下都可达。
   空间选择与技能/命令选择的后端已有，随重建交付；权限设置与工作空间附件上传的后端从 S3b / S2c 提前，紧跟重建之后交付；专家留在 S1d。
   「无后端不渲染、不摆禁用占位」的规则保留——控件与其后端同批上线。
4. **挂起的审批固定显示在输入框上方**（owner，2026-10-04，看过试验后）：不放进消息里默认折叠的工具调用组——折叠后用户看不出回合停在哪。
   消息内的工具调用只显示已结算的结果（已允许 / 已拒绝 / 超时自动允许）。

## 接入方式

- 运行时用 `useExternalStoreRuntime`：应用继续持有状态与后端（REST + SSE + `Last-Event-ID` 回放），向 assistant-ui 提供消息数组、
  运行态与回调。`web/src/lib`（API 客户端、契约解析）与流式 reducer 的逻辑保留，重写的是呈现层。
- 消息映射：`thinking` → `reasoning` part；每个步骤 → `tool-call` part（`argsText` = 步骤 detail，`result` = 步骤 output）；
  挂起审批 → 输入框上方的审批条（自做组件，读应用自己的审批状态，直接调作答 REST；不经 `tool-call` 的 `approval` 字段）；
  停止 → `onCancel`；重新生成 → `onReload`；
  会话的新建/切换/重命名/删除 → `adapters.threadList`。
- 组件以源码形式拷入仓库（shadcn registry），由本仓拥有与修改；选 Radix 版式（仓库已依赖 Radix，不引入第二套无样式基元库）。
- 现有 token（`web/src/styles`）的品牌色与亮/暗语义映射进 Tailwind 主题变量，不保留第二套样式体系。

## 试验结论（2026-10-04，仓库外一次性工程，对接运行中的服务与真实端点）

已验证：

- React 19.2 + Vite 8 + Tailwind 4 + `@assistant-ui/react` 0.15 安装、类型检查、构建通过；Radix 版式（`radix-nova`）的组件可安装
  （端到端流程是在 Base UI 版式上跑的，Radix 版式只验证到安装）。
- 真实会话快照（含思考、多步骤、已结算审批）经上述映射正确渲染。
- 在界面里选工作空间 → 发送 → 新建带空间的会话 → 挂起审批出现 Allow/Deny → 点 Allow → 工具执行 → 回合完成，全程走现有 REST。
- 输入框动作行可加自有控件：「+」菜单列出 `GET /api/commands` 的条目并写入输入框，工作空间选择器驱动会话创建。

试验未覆盖，留给设计阶段：

- 试验用轮询快照；SSE 增量与断线回放接入 `ExternalStoreRuntime` 未跑。重命名、删除、重新生成、停止的回调已接线但未操作验证。
- 试验把审批放在 `tool-call` 的 `approval` 字段里（按工具名与步骤配对，现有契约没有关联键），结果挂起审批被默认折叠的工具组藏住——
  这正是决定第 4 条的来由。输入框上方的审批条、多条并发审批的排列、60s 倒计时与「超时自动允许」的呈现都需自做；
  已结算审批要不要在消息内的工具调用上标注（需要关联键）留给设计阶段。
- 文件变更卡、产物卡与产物面板、对话内搜索、fork、置顶/分组/场景、项目配置入口 assistant-ui 不提供，仍需自做。
- 试验包（含其全部示例组件）构建产物约 1.09 MB（gzip 335 kB），现前端整包约 0.55 MB；需按用到的组件裁剪并做代码分割。
- 界面文案默认英文，需全部中文化。

## Consequences

- `ui-primitives`、`spa-shell`、`chat-web`、`files-web`、`session-sidebar`、`conversation-search`、`demo-parity-acceptance` 等规格中
  按 demo 写死 DOM/类名/像素的条款要在重建的 change 里改写为行为条款；服务端规格不受影响。
- UI guardrails（features 不得直接引 Radix、只经 `web/src/ui` 取样式）改为新分层：`components/ui`（shadcn）与
  `components/assistant-ui` 可引 Radix；features 只引这两层。
- `web/` 现有测试中断言 DOM 结构的部分与 `make ui-walk` 的选择器随页面重写；`make ui-walk` 的视口矩阵与 error oracle 保留。
- `AGENTS.md` 验证矩阵的「demo 一致性截图对」一行随重建 change 更新。
- #824（场景切换 Toast）、#825（空会话主区空白）、#826（重复新建空会话）在重建的设计里一并处理，不再按旧界面单独修。
- 依赖面增加：`tailwindcss`、`@assistant-ui/react`（间接带入 `zustand`、`zod`、`assistant-stream`）、`@assistant-ui/react-markdown`、
  `class-variance-authority`、`tw-animate-css`。assistant-ui 仍在 0.x，升级可能有破坏性变更；拷入的组件源码由本仓维护。
- 内网部署不受影响：全部为构建期依赖，产物不访问公网（assistant-ui 的云服务适配不启用）。

## 增补（2026-10-04，change B `s1f-chat-surface` 设计阶段）

- **Markdown**：助手正文改用 `@assistant-ui/react-markdown`。链接保持惰性（只显示文字，不生成可点击的链接），图片不加载（显示替代文本），
  源 HTML 不生成元素。`web/src/lib/md-render.ts` 留给文件页。
- **轻提示退场**：重建后的会话页不再弹提示。成功/信息类删除；失败在触发处就地显示；复制成功只换图标。会话列表动作的提示留到 change C 处理。
- **输入框上方停靠区**：待决审批做成提问卡（参照 Claude Code 桌面版），答完收起，消息内按消息留一条已结算记录（已允许 / 已拒绝 / 超时自动允许）；
  助手的任务清单面板同样停靠在这里，位于提问卡之上。不用 assistant-ui 挂在 `tool-call` 上的 `approval` 字段。
- **threadList**：change B 不用运行时的 `adapters.threadList`——会话列表经外壳侧栏插槽渲染，属 change C；上文「接入方式」里的对应一行留给 C 决定。
- **任务清单后端**：change B 不再是纯前端。服务端从 omp `todo` 工具结果取全量清单，落库到会话行，经 `todo.updated` 事件与快照字段下发。
- **启用 `tw-shimmer`**（owner 2026-10-05，#854 实现期间）：拷入的 `reasoning`、`tool-group` 用它给「进行中」的标题加流光。样式入口因此多一条 `@import "tw-shimmer";`，ui-foundation「入口结构」条文与守卫同步放宽为允许这一条。
- **拷入层第六类修改放宽**（owner 2026-10-04，#848 实现期间）：从「渲染被 registry 原文丢弃的调用方 `children`」放宽为「把被原文丢弃的调用方 `children` 或属性原样透传给底层基元」。
  拷入文件只转发、不写默认值；起因是 `markdown-text` 不透传基元的 `smooth`，正文的逐字显现由应用层传 `smooth={false}` 关闭。

## Considered Options

- **只换会话页，其余页面保留自有基元**：改动小，但留下两套样式体系与两种观感。owner 否决。
- **保留现有实现，按 demo 继续补控件**：成本最低，但基线本身就是不满意的来源。owner 否决。
- **只用 assistant-ui 的无样式基元、沿用自有 CSS**：不引 Tailwind，但拿不到它现成的界面，等于自己重画一遍。否决。

## 增补（2026-10-06，#874 跟进，change `s1f-chat-followups`）

- **代码块复制去掉末尾恰一个换行**（owner 2026-10-06）：粘贴到终端时末行不会直接执行。改在应用层覆盖的代码块头里，拷入文件不动，拷入层的六类修改不变。
- **可访问性四项**（owner 2026-10-06）：`list-none` 的列表显式 `role="list"`；待决提问卡以 `aria-describedby` 关联本卡的工具徽章与请求说明；用键盘作答后卡消失时（或焦点停在卡上而卡超时消失时），焦点移到下一张卡的 `允许`，没有卡时等输入框解锁后落到输入框（期间焦点去过别处则不动；鼠标或触屏作答不移动焦点，卡内按钮忽略按住不放的重复按键——#901 审核后收窄）；任务清单与项目配置的限高列表在内容被裁剪时可键盘聚焦滚动。
- **不处理**（owner 2026-10-06）：回答结束时正文比状态晚一帧（拷入的 `markdown-text` 沿用上游的延迟渲染，不放行对它的透传）；输入框随内容增高依赖 `field-sizing`（不支持的浏览器里停在最小高度、内部滚动）。
- **包体暂不设上限**（owner 2026-10-06）：`web/dist` 的 JS 为 1,086,670 字节（gzip 326,274），较重建前的 598,483 字节增加 488,187 字节。S1f 的全部 change 完成后再定上限与是否做代码分割。
- **删除 `docs/acceptance/demo-parity-checklist.md`**（owner 2026-10-06）：它已被功能验收清单取代，其中多行引用了重建后已删除的代码；历史从 git 查看。本文正文里提到它的地方是当时的记录，不改。

## 增补（2026-10-06，S1g，change `s1g-composer-capabilities` 设计阶段）

- **能力行五项与次序**（owner 2026-10-06）：文本框下方一行，分左右两组——左组依次为「+」菜单、工作空间、权限档位；右组依次为模型、推理强度，其后是既有的 `生成中` 与 `停止` / `发送`。
  权限档位、模型、推理强度三项不随输入框锁定而禁用；它们的选项取不到时三项都不渲染、不摆占位。窄屏（≤760px）允许换行：左组留在第一行，右组放不下时整体落到下一行并靠右。专家与麦克风不渲染，「+」菜单里也没有。
- **「+」按钮改名**：可访问名从 `技能与命令` 改为 `添加文件或命令`——菜单第一项是 `上传文件`，其后才是命令目录。原先草稿非空时整个按钮禁用，现在按钮只在输入框锁定时禁用；
  草稿非空时只是命令条目不可选，并显示一行 `清空输入后可选择命令`（与斜杠候选不打开是同一条件）。打了字仍可加附件。
- **附件是应用层状态**：输入框是应用层组件（不用 `ComposerPrimitive`，草稿是应用自有状态，提交走页面既有的发送路径），附件标签与它放在一处——位于文本框上方、输入框容器之内，不进停靠区；
  状态只在页面内存里，不持久化，切换会话或回到欢迎态时清空。不使用 runtime 的 attachments 适配器；用户气泡里的附件列表同样由应用层渲染。chat-web「消息线程」里「不提供编辑/分支/附件」一句的「附件」相应改述为「不使用 runtime 的附件适配器」。
- **拷入层零改动**：`web/src/components/ui` 与 `web/src/components/assistant-ui` 不改，六类修改不变。三个控件由已拷入的 dropdown-menu（含单选组）、alert-dialog、button 在应用层组合而成；实现中若发现非改不可，停下来报告，不自行放宽。
- **模型与推理强度**（owner 2026-10-06，并入 #906）：可用模型来自服务端白名单；按会话保存，新会话沿用最近的选择；生成中可改，从下一条消息起生效；强度按 omp 支持的全部档位，当前模型不支持推理时不显示强度控件；不按消息记录模型。

## 增补（2026-10-06，change `s1f-session-list-temp-space`）

- **不用 `adapters.threadList`（终稿）**：上文「接入方式」里「会话的新建/切换/重命名/删除 → `adapters.threadList`」一行作废。会话列表经外壳侧栏插槽（`web/src/lib/sidebar-slot.tsx`）由应用渲染，数据与动作留在应用自己的状态里。
  理由：该适配器假定「线程」只有标题与归档两个属性，没有分组、置顶、状态标记、临时空间与按用户的事件连接；接入它要把这些都做成适配器之外的旁路状态，得到两套列表状态。change B 已在不用它的前提下交付。
  放弃的方案：只用 `ThreadListPrimitive` 取样式——它的条目动作绑定运行时的线程切换，与应用自己的 `?session=` 选择冲突。
- **会话列表动作不弹提示**：成功不提示，条目自身的移动 / 改名 / 消失就是反馈。有对话框的动作（重命名、删除）失败时在对话框内以 `role="alert"` 显示；没有对话框的动作（置顶、归档、恢复、导出）失败时，
  在列表区顶部以一条可关闭的 `role="alert"` 显示信封文案，下一次列表动作发起时清除。已迁移文件的导入白名单不含 `useToast`，由守卫机械保证；与 change B「失败就地显示」一致。
- **会话视图由八键扩为十一键**：新增 `archivedAt`、`pendingApproval`、`temporaryWorkspace`。会话 DTO 是严格键集，服务端加键与 web 解析在同一个 PR 合入，其后的功能才各自使用这些键。

## 增补（2026-10-12，change `s1f-files-page` 收尾，#1120）

- **预览器按需加载是唯一放开的代码分割**（design D9）：上文 2026-10-06 增补留下的「是否做代码分割」只在这一处有了答案。`web/src` 里动态 `import()` 只出现在
  `web/src/features/files/previewers/index.ts`——十类预览器九个模块（`web` 与 `document` 同在 `frame.tsx`），另有高亮器一个模块；`web/vite.config.ts` 不配 `manualChunks`；其余页面仍不做代码分割。
  规格是 ui-foundation「预览器按需加载是唯一的代码分割」，静态守卫是 `web/test/previewers-code-split.test.ts`（随 `make check` 跑）；
  「构建产物确有按需块」只在 `make ui-walk` 的 `/files` 步骤里断言，`make check` 不构建。
- **包体仍不设上限**：下面只是记录。上限定多少、要不要进一步分割，仍按 2026-10-06 增补「S1f 的全部 change 完成后再定」。
- **测量**：提交 `08b236502f86c0202300618c34018008a17f3481`，`npm run build --workspace web`（CI 的构建步骤；Makefile 没有构建 web 的目标），Node 24.13.1、Vite 8.2.2，macOS arm64。
  连续构建两次，`web/dist/assets` 下 16 个文件的 SHA-256 逐个相同。原始字节为 `wc -c`，gzip 为逐文件 `gzip -9 -c <文件> | wc -c`（Apple gzip 479）。
  各块装了什么，取自同一提交另做的一次带 `--sourcemap` 的构建（输出到仓库外，文件名与哈希相同）的 sources 列表；何时加载取自 `index.html` 与各块的 `import` 语句。

  | 文件 | 何时加载 | 原始字节 | gzip 字节 | 内容 |
  |---|---|---:|---:|---|
  | `index-xzvsoMgb.js` | 入口（`index.html` 的 `<script>`） | 1,009,178 | 301,432 | 应用其余全部代码与依赖，含 `react-resizable-panels` |
  | `columns-vWNgaiQd.js` | 启动（入口静态导入，`modulepreload`） | 139,323 | 45,828 | 126 个模块：`lucide-react` 图标、dropdown-menu、toast、`web/src/lib` 的 API 客户端等；块名与其中的 `features/files/columns.tsx` 同名 |
  | `button-C3sGx_X3.js` | 启动（同上） | 33,882 | 10,852 | `components/ui/button.tsx`、`lib/utils.ts` 及其依赖 |
  | `react-BasombWv.js` | 启动（同上） | 7,527 | 2,915 | `react` |
  | `jsx-runtime-FW1pBIp1.js` | 启动（同上） | 1,145 | 655 | `react` 的 jsx-runtime |
  | `highlight-BjSOg_M9.js` | 按需（`loadHighlighter`） | 98,044 | 33,319 | 高亮器：`highlight.ts`、`lowlight`、`highlight.js` 核心与 19 种语言 |
  | `markdown-CbAHc4M1.js` | 按需（`markdown`） | 11,983 | 4,010 | `markdown.tsx`、`lib/md-render.ts`、`lib/markdown-view.tsx` |
  | `notebook-B_4qzwO4.js` | 按需（`notebook`） | 4,270 | 1,933 | `notebook.tsx` |
  | `code-ZeSoSnoD.js` | 按需（`code`） | 2,680 | 1,298 | `code.tsx` |
  | `frame-DVnoBF-l.js` | 按需（`web` 与 `document` 共用） | 2,436 | 1,250 | `frame.tsx` |
  | `archive-lu8bfdcl.js` | 按需（`archive`） | 2,184 | 1,144 | `archive.tsx` |
  | `table-DBVd_FVi.js` | 按需（`table`） | 1,364 | 771 | `table.tsx`、`features/files/csv.ts` |
  | `svg-DKpCpNj2.js` | 按需（`svg`） | 1,130 | 676 | `svg.tsx` |
  | `media-DWkHbrSe.js` | 按需（`media`） | 703 | 472 | `media.tsx` |
  | `image-BOivpOW9.js` | 按需（`image`） | 556 | 437 | `image.tsx` |

  JS 共 15 个文件、1,316,405 字节（逐文件 gzip 之和 406,992）：入口加四个启动块 1,191,055（361,682），十个按需块 125,350（45,310）。CSS 一个文件 `index-BKGOV40a.css`，128,226（22,736）。
- **JS 文件分三类，不是「入口 + 按需块」两类**：放开按需加载后，打包器自己另拆出四个块（没有 `manualChunks`；为什么是这四个没有查）。它们由入口静态导入、
  在 `index.html` 里 `modulepreload`，属于首屏，不是按需块。按需块之间也有静态导入：`markdown`、`svg`、`table`、`notebook` 的块导入 `code` 的块，`notebook` 的块还导入 `markdown` 的块，
  所以选中一个文件时取回的可能不止一个块。
- **与此前的数字**：2026-10-06 增补记的是单个 JS 文件 1,086,670 字节（gzip 326,274），当时入口即全部。现在 JS 合计多 229,735 字节，首屏（入口加四个启动块）多 104,385 字节。
  这个差值是其后合入的全部 change（`s1f-session-list-temp-space`、`s1g-composer-capabilities`、`s1f-files-page` 等）之和，没有按 change 拆开量。
  那次的 gzip 没有记录压缩方法与级别，且是单个文件的 gzip；这里是逐文件之和，两者不能直接相减。Vite 构建输出自带的 gzip 数字（入口 305.39 kB）与 `gzip -9` 的也不相同。
  CSS 的上一个数字在已归档的 `s1f-chat-surface` design 里：125,897（gzip 22,196），现在多 2,329 字节。
- **没有量的**：brotli；各路由实际加载了哪些块、传输了多少字节（取决于部署时的压缩配置）；解析与执行耗时；运行时内存。
- **新拷入 `resizable`**（design D26，任务 23.1）：`web/src/components/ui/resizable.tsx`，来自 shadcn/ui registry 的 `radix-nova` 版式（`web/components.json`），按拷入层六类修改的规则拷入（这次没有与 registry 原文逐行比对）；
  新增依赖 `react-resizable-panels`（MIT，锁定 4.14.3），两者都登记在 `ATTRIBUTION.md`。用途是会话页工作空间侧边栏与对话区之间那条可拖动、键盘可达的分隔线，
  调用方只有 `web/src/features/chat/workspace-sidebar.tsx`；文件页自己的树 / 预览分栏不用它。

## 增补（change `s1f-legacy-layer-removal`）

逐刀追加：本节由该 change 的各个 PR 依次写入，每条写明是哪一刀。

- **Toast 删除，不提供替代的通知机制**（任务组 2，#1398；owner 2026-10-12）：`web/src/ui/toast.tsx`、`toast.css` 与应用入口的 `ToastProvider` 包裹删除，直接依赖 `@radix-ui/react-toast` 卸载
  （`web/package.json` 不再直接安装任何 `@radix-ui/*` 单包）。删除前产品代码里没有任何 `useToast` 调用方（`grep` 实测：`web/src` 里只有 `main.tsx` 导入 `ToastProvider`），所以没有哪一条用户可见的提示随之消失；
  各功能规格里「不显示 Toast / 轻提示」的条文仍然为真，没有改。以后要通知机制另开 change。
- **测试侧查 Toast 元素的断言整体删除**（同一刀）：三个 `toasts()` 助手及其调用、按类名 `.ui-toast` 的查询、对 `通知` 区域的查询。理由只有一个：被查的元素在 Toast 删除后不可能再存在，
  这些断言要么恒真（按类名查不到任何东西）、要么抛错（按角色查通知区），留着是摆设。这是该 change 里「既有断言不删除、不削弱」的唯一例外。条件是每个受影响的用例里都有一条整页范围的断言继续证明「没有提示」：
  旧提示文案在整页找不到，或整页的提示面清单（全部 `alert` 与 `status` 角色元素的文案，`web/test/page-notices.ts`）恰为该用例应有的那几条；逐文件的对照表在 #1398 的 PR 描述里。
- **`useEscapeFallback` 本刀不动**：它与十处调用原样保留，六处「Toast 占住 Radix 层栈」的注释改为过渡说法；去留由 #1393 的 Escape 实测决定，结论由后一刀写在这里。
- **Escape 实测：`useEscapeFallback` 保留，十处调用原样不动**（任务组 3，#1399；取 tasks 3.3）。
  - 方法：在 Toast 已删除的 `master` 上把十处调用接到内容元素上的 `onEscapeKeyDown` / `onKeyDown` 两个属性去掉（`ref` 保留；这份改动只用于实测，没有提交），然后
    (1) 跑全部单测；(2) 跑 `make ui-walk` 两个 project；(3) 一次性的 Playwright 脚本（不入库）在 Chromium 里对走查没有 Escape 步骤的七处各打开三次、焦点在其内时用真实按键按一次 Escape，
    断言它关闭、外层仍在、其间没有发出任何写请求（撤回冲突确认框用 `page.route` 造 409）；(4) 同一脚本的时序探针在「接着兜底」与「去掉兜底」两份构建上各跑一遍，逐项比对。
  - 十个调用点的结论（去掉兜底时）：`导航` 覆盖层、退出确认框、会话删除确认框、撤回冲突确认框、`全部自动` 确认框、文件的创建 / 重命名 / 移动对话框、文件删除确认框——七处通过，
    (1)(2)(3) 全绿（(3) 含嵌套：`导航` 覆盖层里的确认框与对话框、窄屏工作空间侧边栏模态层里的文件对话框都只关最内一层，外层再按一次才关）。
    (4) 只覆盖了其中一部分——打开后不等焦点落定就按 Escape（退出确认框、`导航` 覆盖层），以及嵌套层上间隔 0–600ms 的两次 Escape（六种组合）——两份构建结果相同；其余四处（会话删除确认框、撤回冲突确认框、`全部自动` 确认框、文件删除确认框）没有做两份构建的时序比对（出处：#1399 的 PR #1421 十行结果表的「两份构建的时序比对」一列；文件的创建 / 重命名 / 移动对话框只经嵌套双击一项比对过——侧边栏模态层内的文件重命名）。
    重命名 / 另存为工作空间对话框、项目配置弹层、窄屏的工作空间侧边栏模态层——三处**不通过**：(1)(2)(3) 同样全绿，但 (4) 里由顶栏按钮经键盘打开时，紧跟着 Enter 的那次 Escape 关不掉它们。
  - 现象（实测，Chromium，真实按键）：键盘聚焦顶栏按钮，它的 tooltip 出现；按 Enter 打开覆盖层、焦点进入其内，随即按 Escape——按键被标为已处理，覆盖层仍开着，再按一次才关闭。
    项目配置弹层上聚焦、Enter、Escape 紧挨着发出时，去掉兜底 12 次里 12 次没关，接着兜底 12 次里 0 次；Enter 与 Escape 之间隔 20ms 或 50ms 时两边都是 12 次里 0 次。
    按键之间各隔一次页面往返时（间隔不受控），去掉兜底 30 次里 8 次没关（三处都出现过），接着兜底 30 次里 0 次。这个间隔自动化按得出；人手按不出是推断，没有测。
  - 原因：Radix DismissableLayer 只由层栈里的「最高层」监听 Escape，一层是不是最高层在它渲染时才算（读代码推出，`@radix-ui/react-dismissable-layer` 1.1.19）；覆盖层挂载时 tooltip 还在退出动画里、仍在栈中，
    覆盖层要等下一次重渲染才接过监听，这之前的 Escape 分派给了 tooltip 那一层（实测：那次按键 `defaultPrevented` 为真而覆盖层未关）。兜底不经 Radix 的分派，由内容元素自己的 `onKeyDown` 关闭，所以不受这个窗口影响。
    十处覆盖层里触发按钮本身是 tooltip 触发器的只有这三处（读代码推出：`web/src/routes/shell/topbar.tsx` 的顶栏动作按钮带 tooltip，其中 `重命名`、`项目配置`、`工作空间侧边栏` 各打开一处；`打开导航` 是不带 tooltip 的普通按钮，
    其余六处由菜单项或消息上的按钮打开），所以实测到的三处是 **tooltip 这一个来源**能波及的全部（读代码推出，依据是上面的触发器清点），不是「覆盖层挂载时栈里还有别的层」这个原因能波及的全部。
    同一类的来源可能还有一种：由菜单项同步打开的覆盖层。下拉菜单层在退出动画期间同样留在层栈里（读代码推出：`@radix-ui/react-menu` 2.1.24 的内容经 `Presence` 挂载、内含 `DismissableLayer`，
    拷入层 `dropdown-menu` 给了它退出动画），例如 `web/src/features/auth/footer.tsx` 里由菜单项 `退出登录` 打开的退出确认框。这一种**没有实测**，是读代码推出的可能性，不是结论：
    上面 (4) 对退出确认框做过「打开后不等焦点落定就按 Escape」（两份构建结果相同），那次按键是否落在菜单的退出动画之内，记录里没有写明。
  - 常驻证据：jsdom 能复现（钩子辅助：按 `data-state` 给 tooltip 一个动画名让它留在页面上，并在焦点进入覆盖层的同一个任务里派发 Escape，搭台在 `web/test/escape-race-support.ts`），所以是三条单测，
    各在该覆盖层既有的测试文件里，去掉对应调用点的两个属性即判红：`chat-page-project-config-dialog.test.tsx` 的 H5、`chat-page-rename-focus.test.tsx` 的「opened from the banner's 重命名 while its tooltip is still closing…」、
    `chat-workspace-sidebar-narrow.test.tsx` 的 N5。兜底自身的三条性质（不重复、输入法组合中不关、不响应子树之外）仍在 `web/test/escape-fallback.test.tsx`。
  - 取保留分支的依据是 tasks 3.1 的判据（任一处不通过或不稳定即保留），不做「只留在这三处」的局部删除（design D4、D19 第 5 项）：十处调用全部保留，六处注释改写为上面的原因。
    守卫（`web/test/ui-layering.test.ts`「兜底去留」）对真实仓库断言「定义恰一处、在 `web/src/ui/escape-fallback.ts`」；这个路径是过渡值，文件随旧基元层退役搬到 `web/src/components/` 时一并改。
    （任务组 4，#1400 已改：文件现在在 `web/src/components/escape-fallback.ts`，内容未变；同一条守卫的指定路径改为这个位置，并断言 `web/src/ui/escape-fallback.ts` 不再存在——这是终态。上面各条里的 `web/src/ui/…` 是实测当时的位置。）
  - 输入法：组合中的 Escape 在两份构建上表现相同（实测，Chromium，用 CDP `Input.imeSetComposition` 合成组合：页面收到 `key: "Escape"`、`isComposing: true`，重命名对话框在两份构建上都是 6 次里 6 次关闭）——
    关闭它的是 Radix，兜底的组合判断只管兜底自己那条路径。真实输入法在各平台上发出的按键没有测。
- **终态达成：旧基元层与 `legacy` 层删除**（任务组 6，#1402）。
  - 删了什么：`web/src/styles/legacy.css`、`web/src/ui/ui.css`、`web/src/ui/motion.css`，`web/src/ui/` 目录随之不存在；入口 `web/src/styles.css` 的层声明改为
    `@layer theme, base, components, utilities;`，不再有 `legacy` 层与对 `legacy.css` 的导入。`web/src` 下的样式文件恰为三个：`styles.css`、`styles/tokens.css`、`styles/theme.css`。
    随文件消失的规则只有三组，删除前都没有使用方（`grep` 实测：`web/src`、`web/test`、`web/e2e`）：`.ui-sr-only`，`motion.css` 的六组 `@keyframes wb-*`，五个动效工具类及其 reduce 块。
  - 全局基础规则与 `ui-*` 类在哪：`theme.css` 的 `@layer base` 块（任务组 5，#1401 搬入；本刀不改它）——边框色基线、`Icon` / `BrandMark` 的 `ui-icon*` / `ui-brand*`、全局 reset 与
    `:focus-visible`、选区、滚动条、`.ui-alert` / `.ui-muted` / `.ui-empty`。理由（design D7）：这些规则必须排在 preflight 之后、utilities 之下。未分层会压过 utilities（全局 `:focus-visible` 的圆角盖掉所有 `rounded-*`，
    `button { padding: 0 }` 盖掉所有 `px-*`）；放进 `base` 层则与 preflight 同层，靠靠后的源码顺序与不低于它的特异性取胜，使用处的 Tailwind 类照旧压过它们。原样搬、不去重、不改写成 Tailwind 类。
    块内的选择器由 `web/test/ui-foundation-entry.test.ts` 按清单钉住，只减不增。
  - 删层不改变计算样式：这是读代码推出的，本刀没有再做计算样式比对——#1401 之后 `legacy` 层里已没有被使用的规则（上一条的 `grep`），而逐探针的 A/A 与 A/B 比对是 #1401 做的（记录在它的 PR 里）。
    本刀的实测只有 `make ui-walk` 两个 project 通过。
  - 守卫改为终态断言：三份清单（冻结区文件、已迁移区域、导入白名单）退役。`web/test/ui-layering.test.ts` 断言 `web/src/ui` 下没有文件、`web/src` 的任何 `.ts`/`.tsx` 都不从它导入（不再只查清单内的文件）、
    源码里不出现 `useToast` 与 `ToastProvider`、三个样式文件之外没有 `.css`；`ui-layering-chat.test.ts` 的显式列表语义改为扫描除两个拷入目录之外的全部 `.tsx`；`ui-foundation-entry.test.ts` 断言层声明、七条导入与
    「样式文件恰为三个」；`ui-guardrails.test.ts` 的 Radix 允许目录只剩两个拷入目录，`web/src/ui` 不再是例外。
  - 走查的层序探针（`expectLegacyOverPreflight`）删除，没有新增走查步骤：「全局基础规则压过 preflight」改由上述静态断言与入口的导入次序保证，真实浏览器里不再有专门读这一点的探针。
  - 依赖：七个 `@radix-ui/react-*` 单包（`dialog`、`dropdown-menu`、`popover`、`radio-group`、`switch`、`tooltip` 在 #1397，`toast` 在 #1398）已卸载，本刀不增删依赖。被卸的是直接依赖声明：
    它们仍作为合包 `radix-ui` 的传递依赖留在 lockfile 与产物里（design D13）。
  - 没有做的：包体上限仍不设（见 2026-10-12 增补）；两份主规格的 `## Purpose` 在归档时由编排方改（design D21）。

## 增补（2026-10-15，change `chat-thinking-status-stream` 切片 7a，#1449）

- **正文逐字显现重新启用，在应用层做**（owner 2026-10-06 / 2026-10-14，#910 O2/O6）：取代关闭逐字显现时的理由「正文不能落后于已到达的数据」（2026-10-04 增补所记的 `smooth={false}`；该理由原写在 `markdown-body.tsx` 的注释里，本切片已改写）。
  运行中的助手正文经 `web/src/features/chat/smooth-text.tsx` 调用 `@assistant-ui/react` 的 `useSmooth`，把要显示的前缀交给 `MarkdownBody`；终态立即全文，`prefers-reduced-motion: reduce` 下不展开。
  `复制` 与对话内搜索仍读已收到的全文。
- **基元的 `smooth` 仍关**：`markdown-body.tsx` 照旧传 `smooth={false}`。基元追赶期间把容器 `data-status` 置为 `running`，拷入的 `dot.css` 会在末块之后加一个脉动点，与消息自己的小圆点叠成两个运行指示（design D8）。
  应用层交给基元的 part 状态恒为「已完成」，所以不出这个点。拷入层零改动，第六类修改（`markdown-text` 透传 `smooth`）保留。
- **依赖 0.x 内部分支**：挂载显示全文、从空串开始的第一段直接提交、传 `false` 立即全文、reduce 停用、文本增长时 `aui.part` 引用不变——在已装的 0.15.23 上实测，由 `web/test/chat-smooth-text.test.tsx` 的两条
  「依赖 @assistant-ui/react useSmooth 分支」用例与同文件的页面用例钉住，升级改了分支时先在那里判红。展开时长随积压增长（200 字约 0.6s，design D8），不是 250ms 上限。

## 增补（2026-10-22，change `s1d-model-registry`）

- **新拷入 `tabs`**（change `s1d-model-registry` 任务 9.3）：`web/src/components/ui/tabs.tsx`，来自 shadcn/ui registry 的 `radix-nova` 版式（`web/components.json`），按拷入层六类修改的规则拷入（与 registry 原文相比只改了 `cn` 导入与格式化），用合包 `radix-ui` 的 `Tabs`，未新增依赖，登记在 `ATTRIBUTION.md`。用途是中心页 `/center` 的 tab 条，调用方只有 `web/src/features/center/page.tsx`。
- **拷入层的裸 `data-*` 变体在 `theme.css` 一次绑定**（#1706，owner 2026-10-22 裁定；change `s1d-model-registry` 任务 10.0）：radix-nova 的组件按 shadcn 自带样式表（`shadcn/tailwind.css`）的语义写 `data-active:`、`data-checked:`、`data-horizontal:` 这类变体，
  本入口不导入那份样式表；未绑定时 Tailwind 把它们编成属性存在选择器（`[data-active]`），而 Radix 输出的是 `data-state` / `data-orientation`，样式永远匹配不上。规则：
  - 按上游语义在 `web/src/styles/theme.css` 绑定，每个变体一行无花括号的 `@custom-variant`（不新增顶层规则块，`ui-foundation-entry.test.ts` 的块清单不变）；扩展不替换：Radix 的 `data-state` / `data-orientation` 一支之外，
    保留组件自设同名属性的一支（`[data-active]:not([data-active="false"])` 这种）。已绑七个：`data-open`、`data-closed`（#834 起）与 `data-active`、`data-checked`、`data-unchecked`、`data-horizontal`、`data-vertical`。
    `data-unchecked` 目前没有使用者，因 #1706 的验收标准列了它而绑。逐字文本由 `ui-foundation-entry.test.ts` 钉住，编译结果由 `web/test/ui-variant-bindings.test.ts` 用 Tailwind 的 `compile` 证明。
  - 不绑：`data-selected`（没有调用方；`table` 用的是方括号写法 `data-[state=selected]:`）；`data-disabled`、`data-inset`、`data-placeholder`（Radix 或组件自己输出裸属性，按存在匹配本来就对）。
  - 调用方不得再按 `data-[state=…]:` / `data-[orientation=…]:` 补写这些状态（守卫：`web/src/features` 的 `.tsx` 不含 `data-[state=active]:`、`data-[state=checked]:`、`data-[state=unchecked]:`、`data-[orientation=`）。
    此前的两处绕过已删除：设置页主题单选（#836 起）与中心页 tab 条（任务 9.3）。
  - 以后拷入新组件出现新的裸变体，先在 `theme.css` 补绑定（连同钉住表），再用。
- **新拷入 `table`、`checkbox`**（change `s1d-model-registry` 任务 10.3）：`web/src/components/ui/table.tsx`、`checkbox.tsx`，来自 shadcn/ui registry 的 `radix-nova` 版式，按拷入层六类修改的规则拷入（与 registry 原文相比改了 `cn` 导入与格式化；
  `checkbox` 原文的图标占位 `IconPlaceholder` 按 `dropdown-menu.tsx` 的先例换成 `lucide-react` 的 `CheckIcon`），`checkbox` 用合包 `radix-ui` 的 `Checkbox`，未新增依赖，登记在 `ATTRIBUTION.md`。
  用途是中心页「模型」tab 的模型表与表单复选框，调用方只在 `web/src/features/center/models/`。表单没有下拉字段，`select` 不拷。

## 增补（2026-10-23，change `s1d-experts-skills`）

- **新拷入 `select`**（change `s1d-experts-skills` 任务 7.3）：`web/src/components/ui/select.tsx`，来自 shadcn/ui registry 的 `radix-nova` 版式（`web/components.json`），按拷入层六类修改的规则拷入（与 registry 原文相比改了 `cn` 导入与格式化；
  原文的图标占位 `IconPlaceholder` 按 `checkbox.tsx` 的先例换成 `lucide-react` 的 `ChevronDownIcon`、`ChevronUpIcon`、`CheckIcon`），用合包 `radix-ui` 的 `Select`，未新增依赖，登记在 `ATTRIBUTION.md`。
  用途是中心页「专家」tab 新建 / 编辑对话框的分类字段，调用方只在 `web/src/features/center/experts/`。
  - 原文 `SelectContent` 带的 `cn-menu-target`、`cn-menu-translucent` 两个类名照原文保留：它们是 shadcn 自带样式表的钩子，本入口不导入那份样式表，在这里不匹配任何规则，删掉不在六类修改之内。
  - 用到的裸 `data-*` 变体是 `data-open`、`data-closed`（已绑定）与 `data-placeholder`、`data-disabled`（按 2026-10-22 增补不绑：Radix 自己输出裸属性），其余是方括号写法；所以 `theme.css`、`ui-foundation-entry.test.ts` 与 `ui-variant-bindings.test.ts` 的钉住表都不动。
