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
