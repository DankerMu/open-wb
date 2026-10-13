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
