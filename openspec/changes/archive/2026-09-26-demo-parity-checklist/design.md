# Design: demo-parity-checklist（#301）

Fixture level：expanded（Epic 关闭证据；父组 6 声明）。Review priority：mechanical（文档），但清单范围判定决定 Epic 能否关闭。

Risk packs：Documentation / migration notes（清单与架构文档）、Legacy compatibility（清单引用的 `file:line` 必须指向合并时的真实代码）、Auth / permissions / secrets（公开仓库：签收材料不得含本机绝对路径、供应商名）。

## Governing invariants

1. 目标文本 = 本 change spec「逐页验收清单与签收」（父 delta 原文）。
2. 清单是审查报告 §4 的机械展开，不重新评审 demo：每项都能回溯到 §4 的一行；§4 中 S1e 范围内"实现偏差/计划遗漏"行无一遗漏；范围外行无一留空。
3. 签收是人工行为：S1e 范围内项的签收结论只能由签收人（仓库所有者）本人给出；agent 只能照抄结论并注明出处，自身判断只能作为"预审"出现在 PR/Epic 评论中。
4. 不改代码：不通过项开 issue。

## Sibling surfaces

- 来源：`docs/reviews/2026-09-24-demo-parity-audit.md` §3 分类规则（`:34-43`）、§4.1–4.7 映射表（`:45-111`）、§5 统计（`:113-122`）、§6.4 待拍板（`:166-173`）。
- 范围定义：`IMPLEMENTATION_PLAN.md:121-126`（F-UI-1..6）、`:276`（S1e ↔ F-UI）；父 change `openspec/changes/s1e-frontend-parity/`（proposal「偏差留痕」六条、design 决策 1-15 与 grill 结论 `design.md:7`：无铃铛/设置快捷、快捷登录仅 dev-stub、重新生成/审批/对话内搜索 → S1c、麦克风/⌘K 明确不做）、父 tasks 各项的 merge 注记（每项实现的 PR/文件）。
- 已晋升 spec（实现契约与测试锚点）：`openspec/specs/{ui-primitives,spa-shell,chat-web,files-web,files-harness,verification-harness,demo-parity-acceptance}/spec.md`。
- 实现：`web/src/ui/**`（基元，`index.ts` 出口）、`web/src/routes/**`（外壳/顶栏/侧栏）、`web/src/features/{auth,chat,files,settings,theme}/**`、`web/src/styles.css` 与 `web/src/styles/tokens.css`；走查 `web/e2e/ui-walk*.ts`；截图对 `web/e2e/ui-shots.mjs`（态名 `login-default|chat-welcome|chat-done|files-readme|settings-default`，格 `1440|1024|390 × light|dark`）。
- `docs/architecture/system.md:54-58`（§3.3 web SPA 现文）。
- 文档门禁：`make check`（naming-guard 覆盖 `docs/**` 命名；无链接检查器）。

## Decisions

- **D1 清单结构**（`docs/acceptance/demo-parity-checklist.md`）：
  1. 头部：目的一句；来源（审查报告路径、demo 文件、父 change、生成时 master 提交短 SHA）；运行方式（`make ui-shots`，调用方拥有服务；产物 `index.html` 每行左 demo 右 app）。
  2. 签收规则：签收值 `通过 YYYY-MM-DD` / `不通过 YYYY-MM-DD #issue` / `不适用（来源）`；S1e 范围内项初始为 `待签`；判定口径 = 期望以已晋升 spec 原文为准，结构、文案、状态、响应式、亮暗与 demo 等价；以下有意偏差视为等价并在对应项逐条注明来源：父 proposal 偏差留痕与 Non-goals、grill 结论、父 tasks merge 注记、#301 issue 评论（登录卡阴影用 `--wb-shadow-dialog`、比 demo:638 重；账号框挂载即聚焦并画全局 `:focus-visible` 环、demo 不画）、真实版本号、自有品牌 mark；像素级差异不计。
  3. 分节：外壳与组件体系（§4.1）、登录（§4.2）、会话 `/`（§4.3）、文件 `/files`（§4.4）、设置 `/settings`（§4.5）、`/center`（§4.6，整节一行 `不适用`）、demo 无后端控件（§4.7，逐控件 `不适用`）。
  4. 每节一张表，列固定为 `编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收`。编号前缀 `SH-`/`LG-`/`CH-`/`FI-`/`ST-`/`CT-`/`NB-` + 两位序号。
  5. 文末：Epic 签收记录模板（表头 `编号 | 签收 | 备注`，加"不通过项 → issue"与"签收人/日期"两行）。
- **D2 §4 来源行记法**：`§4.x#n`，n 为该小节表格数据行的 1 起序号（§4.6/§4.7 为段落，记 `§4.6`、`§4.7:<控件名>`）。一行含多个组件时逐组件拆项，各注同一来源。
- **D3 范围判定**（逐行、逐组件机械执行；判据与下表写进清单头部）：
  - **优先级**：已晋升 spec（`openspec/specs/**`）与父 change spec / proposal「偏差留痕」1-6 / proposal Non-goals / grill 结论（父 `design.md:7`）> `IMPLEMENTATION_PLAN.md:121-126` F-UI 原文 > 审计 §4 的"计划归属/分类"列。审计分类列早于 F-UI，只作线索。
  - **范围内**（非 `不适用`，初始 `待签`）：被 F-UI-1..6 或父 change spec 认领、且未被上述更高优先级来源排除的组件，不论审计分类为何。明确包含：默认场景静态 chip 行（偏差留痕 5；`openspec/specs/chat-web/spec.md` 欢迎态）；dev-stub 下的快捷登录列表（父 grill "快捷登录仅 dev-stub"；`openspec/specs/spa-shell/spec.md` 登录页）；用户菜单只含 `退出登录`（spa-shell）；关于卡图标（§4.5#2，F-UI-5）；设置外观分段控件（§4.5#1，F-UI-5）；文件页 `＋` 创建菜单的 Menu 形态与新建文件夹/新建工作空间的 Dialog 形态（父 proposal、父 tasks 1.6b、`openspec/specs/files-web/spec.md` 创建流程焦点闭环）；登录页账号框自动聚焦与错误行（`role="alert"`、位于主按钮之上，`openspec/specs/spa-shell/spec.md` 登录页）。
  - **范围外**（写 `不适用（<来源>）`；同一组件多个来源时取优先级最高者，铃铛与底部设置快捷统一写 `不适用（grill 删除，偏差留痕 4）`）：
    - 偏差留痕 3：响应式 1100 档 → `不适用（S1d，偏差留痕 3）`；偏差留痕 4：侧栏铃铛、底部设置快捷 → `不适用（grill 删除，偏差留痕 4）`；偏差留痕 1：ui-shots 进 CI → 不作清单项。
    - Non-goals → S1c：场景胶囊与按场景切换、会话分组侧栏与条目更多菜单、停止生成、重新生成、对话内搜索、审批条、composer footer"任务启动于 <空间> / 权限"（空间绑定，`chat-web` spec 规定未到阶段不渲染）、顶栏会话重命名；→ S2c：附件按钮；审计计划归属 → S2c：知识库检索卡；→ S1d：模型切换 chip、`/center`；→ S1b：挂载目录、只读/在线标记、卸载。
    - Non-goals 明确不做：麦克风、⌘K 命令面板、导出对话记录、赞/踩、通知铃铛、侧栏底部设置快捷、上游品牌 logo 资产（自有 mark + 字标替代）、`/tokens` 页、demo 快捷登录卡（生产形态；dev-stub 列表见上）。
    - 审计分类"已实现"且无 F-UI 认领的组件（如 §4.2#2 错误文案逐字与 Enter 提交、§4.2#4 登录中、§4.4#3 目录懒加载与名称校验/去重、§4.5#3 主题即时生效）→ `不适用（已实现，<交付阶段>）`；同一行中被 S1e 认领的组件按上面"范围内"处理。
    - 审计分类"计划遗漏"但无任何 F-UI/spec/阶段认领的组件（§4.3#10 产物卡/文件变更卡与顶栏产物/更多入口、§4.3#6 深度思考折叠与追问 chip）→ `不适用（计划遗漏，未归属 → #<issue>）`；§4.3#12 越权访问：`chat-web` spec 已定 404 → 回到欢迎态，写 `不适用（chat-web spec：越权 404 回欢迎态，无 toast）`；orchestrator 在 docs PR 前经 issue-scribe 为每个此类组件开 issue（或引用已存在者），清单写入编号。
    - §4.6 `/center` 整节 → `不适用（S1d/S2a-c/S3a-b）`；§4.7 逐控件 → `不适用（demo 无后端，Non-goals/后端阶段）`。
  - 仍有无法按上面规则判定的组件：停止并在 PR 中列出，由 orchestrator 裁决，不自行编来源。
- **D4 实现 `file:line`**：指向合并时 master 的真实行（组件定义或渲染点），每项至少一处；`不适用` 项写 `—`。PR 附一段一次性脚本输出（不入库）：解析清单中所有 `path:line`，断言文件存在且行号 ≤ 文件行数。
- **D5 验证方式**：优先 `ui-shots <态名> @<格>`（格写 `1440-light` 等；响应式项列出需要看的格）；截图对无法观察的交互（键盘、焦点、Esc 栈、reduced-motion、toast 时序、流式）写 `ui-walk <步骤>`（引用 `web/e2e/ui-walk*.ts:line`）或 jsdom 测试 `web/test/<file>:line`。每项必须能在 1 分钟内判定：期望写成可观察语句（出现什么、在哪、什么文案/状态），不写"与 demo 一致"这类空话。
- **D6 system.md §3.3**：在现文之后补一段：`web/src/ui` 为基元层（按钮/输入/开关/标签/chip/Dialog/confirm/Drawer/Menu/Popover/Toast/Tooltip/空态/分段控件/图标/品牌 mark），交互基元依赖 Radix Primitives（Dialog/DropdownMenu/Popover/RadioGroup/Switch/Toast/Tooltip）、图标 lucide-react；token（`web/src/styles/tokens.css` 调色板 + 语义层，亮/暗）与动效（`ui/motion.css`，`prefers-reduced-motion`）归此层；feature 只经 `ui/index.ts` 使用基元、不直接依赖 Radix；demo 无后端契约的控件不渲染。措辞与现文风格一致，≤ 8 行。
- **D7 签收流程**：docs PR（`Refs #301`）合并时，S1e 范围内项签收格为 `待签`，头部记录生成时 master 短 SHA。随后 orchestrator 在同一 SHA（或记录实际 SHA）按 `make ui-shots` 运行面实跑一次，把 `index.html` 与截图以私有页面交给签收人，并在 PR 评论中给出逐项"agent 预审"意见（明确标注非签收）。签收人须**以本人发言**给出结论（Epic #274 评论，或在与 agent 的对话中逐项/批量明确给出）；agent 不以签收人身份代写结论（agent 使用的 gh 账号即仓库所有者，评论无法区分作者，故以对话中的明确授权为出处）。archive PR（`Closes #301`）只照抄签收人结论写入签收格，每项或每批注明出处（评论链接或"签收人对话确认 <日期>"），并同步父 delta（见 tasks 3.3）。

## Must preserve

- 审查报告、demo、`app-reference/` 只读；不改任何代码与控制面文件。

## Must add/change

- `docs/acceptance/demo-parity-checklist.md`（新）与 `docs/architecture/system.md` §3.3 一段。

## Required evidence

1. **§4 逐行范围表**（贴 PR，reviewer 全表审）：§4.1–4.5 每一数据行（`§4.x#n`）→ 组件拆分 → 各组件判定（范围内/外）、依据的 D3 条款、来源、对应清单编号；§4.6、§4.7 各控件同样列出。此表是范围判定的审查对象，抽查不能替代。
2. 一次性脚本（不入库）输出：清单每项的 `demo:N`、§4 来源、期望、实现 `file:line`（`不适用` 项为 `—`）、验证方式均非空；`demo:N ≤ 4154`（`resource/workbuddy-live-demo.html` 行数）；仓库 `path:line` 文件存在且行号在界内；`ui-shots` 引用的态名 ∈ {`login-default`,`chat-welcome`,`chat-done`,`files-readme`,`settings-default`}、格 ∈ `{1440,1024,390}-{light,dark}`（`web/e2e/ui-shots.mjs:51-58`）。
3. 抽查：reviewer 从清单随机取 ≥8 项（覆盖每节），对照源码确认期望可观察、`file:line` 指向正确组件、验证方式能看到该组件。
4. `make check` exit 0；naming-guard 对新文件通过。
5. 公开纪律：新文档不含本机绝对路径、IP、供应商名（`grep` 证据）。

## Not yet specified

- 签收人的判定结果（D7 由人工给出）。
