# demo 一致性验收清单（S1e）

> 目的：把 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 的差距行逐组件展开成可在 1 分钟内判定的验收项，签收结果作为 S1e（Epic #274）关闭证据。
> 本清单只做机械展开，不重新评审 demo；签收结论由签收人（仓库所有者）本人给出。

## 来源与运行方式

- **差距来源**：`docs/reviews/2026-09-24-demo-parity-audit.md` §3 分类规则、§4.1–4.7 映射表。`§4.x#n` 指该小节表格的第 n 个数据行（从 1 起）；§4.6、§4.7 是段落，分别记 `§4.6`、`§4.7:<控件名>`。同一组件出现在两行时只列一项，来源列两行都注。
- **行为基准**：`resource/workbuddy-live-demo.html`（只读，共 4154 行）；`demo:N` 即其第 N 行。
- **范围与决策**：`IMPLEMENTATION_PLAN.md:121-126`（F-UI-1..6）、`IMPLEMENTATION_PLAN.md:276`（S1e ↔ F-UI）；父 change `openspec/changes/s1e-frontend-parity/`，包括 proposal「偏差留痕」1–6 与 Non-goals、grill 结论（`openspec/changes/s1e-frontend-parity/design.md:7`）、tasks 各项 merge 注记；已晋升 spec `openspec/specs/{ui-primitives,spa-shell,chat-web,files-web,files-harness,verification-harness,demo-parity-acceptance}/spec.md`。
- **生成时 master**：`9a40ca8`。清单里的 `path:行` 缺省都指向这个提交；`9a40ca8` 之后更新过的条目带 `（@#NNN）` 后缀，表示该条目的 `path:行` 指向 issue/PR #NNN 合并后紧接着的 master，没有后缀的条目仍钉在 `9a40ca8`。
- **运行方式**：`make ui-shots` 只消费调用方已经在运行的服务，不负责 build/start/stop。对服务的要求：
  - 使用 dev-stub 认证；
  - `smoke/fixtures/sandbox/u1` 夹具已复制进沙箱根（`Makefile:60`）；
  - 模型上游为仓库假上游 `server/test/support/fake-upstream.mjs`（启动方式同 `.github/scripts/ci-fake-upstream.sh`）：`chat-done` 态的回复正文与 bash 步骤卡都来自它的固定输出，接真实模型端点时 CH-19、CH-25–CH-27 无法按本清单判定；
  - 会话回合能跑到 `已完成`（`chat-done` 态依赖它）。

  服务地址由 `UI_SHOTS_BASE_URL` 指定（缺省值见 `Makefile:73`）。产物缺省写到 `var/ui-shots/<UTC 时间戳>/`，内容为 60 张 PNG 和一个 `index.html`：
  - 每个格一张表：`1440`/`1024`/`390` × `light`/`dark`；
  - 每行一个态：`login-default`/`chat-welcome`/`chat-done`/`files-readme`/`settings-default`（常量见 `web/e2e/ui-shots.mjs:50-58`）；
  - 左列 demo，右列 app；
  - 脚本对每张 app 截图断言无横向溢出；非 chat 态（`login-default`/`files-readme`/`settings-default`）另断言无工作空间绝对路径，chat 态按 ADR-0011 不做该断言（`web/e2e/ui-shots.mjs:403-407`；豁免见 #386）。假上游的固定输出不含绝对路径，公开截图仍只用假上游。
- **验证方式记法**：
  - `ui-shots <态名> @<格>…`：在 `index.html` 对应格的该态行左右对照；响应式项列出所有要看的格。
  - `ui-walk <步骤>（web/e2e/…:行）`：`make ui-walk` 两个 project（`desktop-light` 1440×900、`mobile-dark` 390×844）里的真实浏览器断言。
  - `jsdom web/test/<文件>:行`：`make check` 中的 vitest 用例。
  - `手动：@<格> <操作>，对照 demo:<行>`：截图对不含覆盖层（对话框、菜单、弹层）打开态，外观部分在运行中的应用里按同一视口与主题手动打开后对照。

  键盘、焦点、Esc 栈、reduced-motion、Toast 时序、流式这类截图对看不到的交互，只用 ui-walk 与 jsdom 验证。

## 签收规则

1. 签收格只有三种取值：
   - `通过 YYYY-MM-DD`
   - `不通过 YYYY-MM-DD #<issue>`
   - `不适用（<来源>）`

   S1e 范围内项初始为 `待签`；范围外项生成时就写成 `不适用（…）`，不需要签收。
2. **判定口径**：期望以已晋升 spec 原文为准。结构、文案、状态、响应式、亮/暗与 demo 等价即判通过；像素级差异不计，如间距、阴影浓淡、字形渲染。
3. **有意偏差视为等价**，并在对应项逐条注明来源：
   - 父 proposal「偏差留痕」与 Non-goals；
   - grill 结论；
   - 父 tasks merge 注记；
   - #301 issue 评论：
     - 登录卡阴影用 `--wb-shadow-dialog`，比 demo:638 重；
     - 账号框挂载即聚焦，并画全局 `:focus-visible` 环，demo 不画；
   - 真实版本号：来自 `/api/info`，不沿用 demo 的 `5.3.11`；
   - 自有品牌 mark：不用上游 logo 资产。
4. **结论只能由签收人本人给出**，途径是 Epic #274 评论，或在与 agent 的对话中逐项/批量明确给出。
   - agent 不代签，自身判断只以「agent 预审」标注出现在 PR/Epic 评论中。
   - archive PR 只照抄签收人的结论写入签收格，每项或每批注明出处：评论链接，或「签收人对话确认 <日期>」。
5. 只能用 jsdom 判定的项（如页面中无消费者的基元 SH-04/SH-05/SH-06），以所引用例的断言存在、且在记录的 SHA 上 `make check` 为绿作为通过依据。
6. 不通过项一律开 issue，不在本清单所属 change 内修代码。
7. 实跑 `make ui-shots` 的提交 SHA 与上面的生成时 master 不同时，在文末签收记录里写明实跑 SHA。

## 范围判定

按行、按组件机械执行。一个组件有多个来源时，取优先级最高的那个。

**优先级**，从高到低：
1. 已晋升 spec（`openspec/specs/**`），以及父 change spec、proposal「偏差留痕」1–6、proposal Non-goals、grill 结论；
2. `IMPLEMENTATION_PLAN.md:121-126` 的 F-UI 原文；
3. 审计 §4 的「计划归属/分类」列。审计早于 F-UI，只作线索。

**范围内**（签收格 `待签`）：被 F-UI-1..6 或父 change spec 认领，且没有被更高优先级来源排除的组件，不论审计怎么分类。明确包含：
- 默认场景的静态 chip 行（偏差留痕 5）；
- dev-stub 下的快捷登录列表（grill：快捷登录仅 dev-stub）；
- 只含 `退出登录` 的用户菜单；
- 关于卡图标；
- 设置页外观分段控件；
- 文件页 `＋` 创建菜单的 Menu 形态，以及新建文件夹/新建工作空间的 Dialog 形态；
- 登录页账号框自动聚焦与错误行。

**范围外**：签收格写 `不适用（<来源>）`，实现列写 `—`。

| 类别 | 组件 | 签收格写法 |
|---|---|---|
| 偏差留痕 3 | 响应式 1100 档 | `不适用（S1d，偏差留痕 3）` |
| 偏差留痕 4 | 侧栏通知铃铛、底部设置快捷 | `不适用（grill 删除，偏差留痕 4）` |
| 偏差留痕 1 | ui-shots 进 CI | 不作清单项 |
| Non-goals → S1c | 场景胶囊与按场景切换、会话分组侧栏与条目更多菜单、停止生成（含已停止态）、重新生成、对话内搜索、审批条、composer footer「任务启动于 <空间> / 权限」、顶栏会话重命名 | `不适用（Non-goals：<组件> → S1c）` |
| Non-goals → S2c / S1d / S1b | 附件按钮（S2c）；模型切换 chip（S1d）；挂载目录、只读/在线标记、卸载（S1b） | `不适用（Non-goals：<组件> → <阶段>）` |
| 审计计划归属 | 知识库检索卡（S2c） | `不适用（S2c，审计计划归属）` |
| Non-goals 明确不做 | 麦克风、⌘K 命令面板、导出对话记录、赞/踩、上游品牌 logo 资产、`/tokens` 页、非 dev-stub 环境下的快捷登录卡 | `不适用（明确不做，Non-goals）` |
| 已实现且无 F-UI 认领 | 登录错误文案与 Enter 提交、登录中、Enter 发送、目录懒加载与名称校验/去重、md/csv/json/代码/图片预览主体、关于卡名称与版本、主题即时生效/持久化/跟随系统/跨 tab | `不适用（已实现，<交付阶段>）` |
| 计划遗漏、未归属 | 产物卡、文件变更卡、顶栏产物/更多入口（#403）；深度思考折叠、追问 chip（#404） | `不适用（计划遗漏，未归属 → #<issue>）` |
| 已晋升 spec 排除 | 越权访问提示；欢迎页 `查看更多` | `不适用（chat-web spec：<依据>）` |
| orchestrator 裁决（D3 未点名） | 侧栏窗口圆点、侧栏版本字样、侧栏「筛选任务」、宽屏顶栏折叠按钮、chip 行展开 `›`、composer 吉祥物 | 逐项写裁决来源（SH-40–SH-43、CH-35、CH-36） |
| §4.6 | `/center` 各 tab | `不适用（S1d/S2a-c/S3a-b）` |
| §4.7 | demo 中无后端契约的控件，逐控件列出 | `不适用（demo 无后端，<Non-goals 或后端阶段>）` |

仍无法按上述规则判定的组件，不编造来源、不列入清单，由 orchestrator 在 PR 中裁决。

## §4.1 外壳与组件体系

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| SH-01 | demo:19-188 | §4.1#1 | 亮、暗两格中，app 的页面底色、卡片与输入底色、主/次文字色、边框色、品牌强调色都与 demo 同格一致（token 名与值从 demo 逐字移植）。唯一允许的差异：标题字体栈不含 Poppins | `web/src/styles/tokens.css:10`、`web/src/styles/tokens.css:130`、`web/src/styles.css:42`（@#420） | ui-shots settings-default @1440-light @1440-dark；ui-shots files-readme @1440-light @1440-dark；jsdom `web/test/ui-tokens.test.ts:90`、`web/test/ui-tokens.test.ts:129`（@#420） | 待签 |
| SH-02 | demo:570-585 | §4.1#2 | 侧栏会话列表区的 `新建会话` 为 primary：亮色深底白字，暗色浅底深字。文件页 `＋`（可访问名 `新建`）为 secondary 浅底。按钮高 32、圆角 8。退出确认框里 `取消` 类名含 `ui-btn--ghost`、`退出` 含 `ui-btn--danger`（用例断言） | `web/src/ui/button.tsx:11` | ui-shots chat-welcome @1440-light @1440-dark；ui-shots files-readme @1440-light；jsdom `web/test/ui-form.test.tsx:74`、`web/test/ui-dialog.test.tsx:404` | 待签 |
| SH-03 | demo:606-612 | §4.1#2 | 登录页 `账号`、`密码` 两个输入框与 demo 同形：高度、圆角、底色、边框、占位符颜色一致，亮暗随主题变化 | `web/src/ui/input.tsx:12` | ui-shots login-default @1440-light @1440-dark；jsdom `web/test/ui-form.test.tsx:118` | 待签 |
| SH-04 | demo:614-619 | §4.1#2 | 开关为 `role="switch"` 的 32×18 轨道加圆点；点击回调新状态，禁用时不响应。S1e 页面没有开关消费者，只用 jsdom 判定 | `web/src/ui/switch.tsx:10` | jsdom `web/test/ui-form.test.tsx:152` | 待签 |
| SH-05 | demo:599-604 | §4.1#2 | 标签有 brand/success/warning/error/neutral 五种色调（高 20、圆角 6），暗色下 brand 文字色有覆盖。S1e 页面没有消费者，只用 jsdom 判定 | `web/src/ui/tag.tsx:8` | jsdom `web/test/ui-form.test.tsx:194`、`web/test/ui-form.test.tsx:271` | 待签 |
| SH-06 | demo:621-626 | §4.1#2 | 筛选 chip 为 `<button>` 胶囊；选中时深底白字，且 `aria-pressed="true"`。只对应 demo 的 `.filter-chip`，欢迎页 chip 行见 CH-02。S1e 页面没有消费者，只用 jsdom 判定 | `web/src/ui/chip.tsx:9` | jsdom `web/test/ui-form.test.tsx:201` | 待签 |
| SH-07 | demo:730-738 | §4.1#2 | 文件页 `＋` → `新建文件夹` 打开模态：遮罩上居中白底圆角卡片，标题为 h2，右上有 `关闭`。打开即聚焦首个表单控件，Tab 在框内循环；Escape、遮罩、`关闭`、`取消` 均关闭，并把焦点还给触发器 | `web/src/ui/dialog.tsx:180` | 手动：@1440-light 在 `/files` 点 `新建` → `新建文件夹`，对照 demo:731-736 的外观；ui-walk 新建文件夹挂起（`web/e2e/ui-walk.spec.ts:211-212`、`web/e2e/ui-walk.spec.ts:235-251`）；jsdom `web/test/ui-dialog.test.tsx:132` | 待签 |
| SH-08 | demo:1116-1128 | §4.1#2 | 侧栏 `用户菜单` → `退出登录` 弹出 `alertdialog`：宽 400，标题 `退出登录？` 前有警示图标；说明为「退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。」；按钮为 `取消`/`退出`（红底）；没有右上关闭，点遮罩不关闭，Escape 等同取消 | `web/src/ui/confirm-dialog.tsx:29`、`web/src/features/auth/footer.tsx:76` | ui-walk 退出确认（`web/e2e/ui-walk.spec.ts:107-117`）；jsdom `web/test/ui-dialog.test.tsx:388` | 待签 |
| SH-09 | demo:772-777 | §4.1#2 | 窄屏下点顶栏 `打开导航`，左侧滑出 288 宽抽屉（标题 `导航`、右上 `关闭`、带遮罩）；Escape、遮罩、`关闭` 均关闭，焦点回到 `打开导航`。右侧变体默认宽 420，最大 92vw | `web/src/ui/drawer.tsx:22`、`web/src/routes/shell/app-shell.tsx:27` | ui-walk 打开导航（`web/e2e/ui-walk-layout.ts:187-195`）；jsdom `web/test/ui-dialog.test.tsx:483`、`web/test/app-shell-responsive.test.tsx:295` | 待签 |
| SH-10 | demo:761-770 | §4.1#2 | 侧栏 `用户菜单` 与文件页 `新建` 打开下拉菜单：白底、圆角、带阴影，菜单项可带图标，悬停高亮。键盘打开时焦点落在首项，上下/Home/End 环绕移动，Enter 选中；Escape 关闭并回焦触发器 | `web/src/ui/menu.tsx:24`、`web/src/features/auth/footer.tsx:52`、`web/src/features/files/dialogs.tsx:40` | 手动：@1440-light 打开侧栏 `用户菜单`，对照 demo:761-765 的外观；ui-walk 用户菜单与新建菜单（`web/e2e/ui-walk.spec.ts:107-109`、`web/e2e/ui-walk.spec.ts:211-212`）；jsdom `web/test/ui-menu.test.tsx:63`、`web/test/ui-popover-tooltip.test.tsx:216` | 待签 |
| SH-11 | demo:779-780 | §4.1#2 | 文件页点 `选择工作空间` 卡，弹出锚定在卡片旁、宽 300 的弹层（圆角、阴影）。打开即聚焦弹层内首个输入；Escape 或点外部关闭，焦点回到卡片。弹层内容见 FI-02–FI-04 | `web/src/ui/popover.tsx:23`、`web/src/features/files/page.tsx:90` | 手动：@1440-light 在 `/files` 点 `选择工作空间`，对照 demo:779 的外观；ui-walk 工作空间切换器（`web/e2e/ui-walk.spec.ts:162-164`）；jsdom `web/test/ui-popover-tooltip.test.tsx:80` | 待签 |
| SH-12 | demo:753-758、demo:1044-1052 | §4.1#2 | `toast.css` 中通知区位于顶部 52px、z-index 2000，成功/失败/信息三类各有 circle-check/triangle-alert/info 图标与对应颜色；2.4s 到期移除，悬停或聚焦时暂停，同时最多 3 条（丢最旧）。示例：助手消息点 `复制` 后出现 `已复制到剪贴板` | `web/src/ui/toast.tsx:33`、`web/src/features/chat/message-actions.tsx:9` | jsdom `web/test/ui-toast.test.tsx:66`、`web/test/ui-toast.test.tsx:91`、`web/test/ui-toast.test.tsx:100`、`web/test/ui-toast.test.tsx:108`、`web/test/ui-toast.test.tsx:176`、`web/test/chat-copy.test.tsx:63` | 待签 |
| SH-13 | demo:724-728 | §4.1#2 | 空态居中三段式：可选的 64px 圆角图标框、标题、说明，以及可选的操作区。文件页各空态都用它（见 FI-26–FI-30） | `web/src/ui/empty-state.tsx:13` | jsdom `web/test/ui-empty-state.test.tsx:9`、`web/test/files-empty-layout.test.tsx:25` | 待签 |
| SH-14 | demo:934-1031 | §4.1#2 | 侧栏导航、chip、发送、文件类型、步骤卡等处的图标都是同一套线性图标，默认装饰性（不读屏）。图标随产物打包，离线可用，页面无跨源请求 | `web/src/ui/icon.tsx:84` | ui-shots chat-welcome @1440-light @1440-dark；ui-shots files-readme @1440-light；jsdom `web/test/ui-icon-brand.test.tsx:74` | 待签 |
| SH-15 | demo:1773-1778、demo:1791-1795 | §4.1#3 | 宽屏侧栏宽 288。主导航自上而下为 `会话`/`工作空间`/`中心`/`设置`，图标依次为 message-square/folder/layout-grid/settings；当前路由项高亮 | `web/src/routes/shell/sidebar.tsx:75-106`、`web/src/routes/manifest.ts:13` | ui-shots chat-welcome @1440-light @1440-dark @1024-light；ui-shots settings-default @1024-dark；jsdom `web/test/sidebar.test.tsx:84` | 待签 |
| SH-16 | demo:1775-1776 | §4.1#3 | 只有 `工作空间` 项右侧显示副标签 `文件·预览`；`中心` 不显示副标签。等价说明：demo 显示 `文件·预览·挂载` 与 `专家·技能·知识库·模型·权限`，spa-shell spec 规定不宣传未交付能力、没有真实内容前不显示 | `web/src/routes/manifest.ts:25`、`web/src/routes/shell/sidebar.tsx:88-90` | ui-shots chat-welcome @1440-light @1024-dark；jsdom `web/test/sidebar.test.tsx:84` | 待签 |
| SH-17 | demo:240-247、demo:1785 | §4.1#3 | 侧栏品牌区右侧有折叠按钮（可访问名 `折叠侧栏`/`展开侧栏`）。折叠后宽 48、只剩图标，悬停或聚焦时出现标签 Tooltip；reload 后保持折叠，再展开恢复 288 | `web/src/routes/shell/sidebar.tsx:30-40`、`web/src/routes/shell/sidebar.tsx:65-72`、`web/src/routes/shell/sidebar.tsx:95-98` | ui-walk 侧栏折叠往返（`web/e2e/ui-walk-layout.ts:30-40`）；jsdom `web/test/sidebar.test.tsx:103`、`web/test/sidebar.test.tsx:171` | 待签 |
| SH-18 | demo:1799-1806、demo:1816-1822 | §4.1#3 | 侧栏底部用户区：圆形头像 `Z`、`zhangsan`、角色 `成员`，逐字取当前账号，demo 的姓名/部门不伪造。点击后菜单只有一项 `退出登录`；demo 的沙箱信息、账号与隔离、切换账号不渲染（grill：用户菜单只含退出） | `web/src/features/auth/footer.tsx:13-16`、`web/src/features/auth/footer.tsx:51-65` | ui-shots chat-welcome @1440-light @1024-dark；ui-walk 用户菜单（`web/e2e/ui-walk.spec.ts:107-109`）；jsdom `web/test/sidebar.test.tsx:191` | 待签 |
| SH-19 | demo:1808 | §4.1#3 | app 侧栏底部不渲染通知铃铛 | — | ui-shots chat-welcome @1440-light | 不适用（grill 删除，偏差留痕 4） |
| SH-20 | demo:1809 | §4.1#3 | app 侧栏底部不渲染设置快捷按钮；设置入口在主导航里 | — | ui-shots chat-welcome @1440-light | 不适用（grill 删除，偏差留痕 4） |
| SH-21 | demo:1930-1932 | §4.1#4 | `/` 无会话时，1440、1024 两格没有顶栏，主区顶部直接是 hero；390 两格顶栏只剩最左侧的 `打开导航` 窄条，没有标题 | `web/src/routes/shell/topbar.tsx:24`、`web/src/routes/shell/topbar.tsx:43` | ui-shots chat-welcome @1440-light @1024-dark @390-light @390-dark；jsdom `web/test/topbar.test.tsx:119`、`web/test/app-shell-responsive.test.tsx:174` | 待签 |
| SH-22 | demo:1936-1944 | §4.1#4 | 打开一个已完成的会话，顶栏（在 `main` 之外、高 56）显示面包屑 `我的工作 / <会话标题>`，标题加粗，是页面唯一的 level-1 heading；无标题时显示 `新会话`。右侧的按钮见 SH-24–SH-27 | `web/src/routes/shell/topbar.tsx:36-42`、`web/src/features/chat/page.tsx:688` | ui-shots chat-done @1440-light @1440-dark @390-dark；jsdom `web/test/topbar.test.tsx:126` | 待签 |
| SH-23 | demo:1966-1971 | §4.1#4 | `/files` 顶栏标题为 `工作空间`，`/settings` 为 `设置`，均为 h1。右侧操作位为空（demo 同为空槽）。390 格标题左侧另有 `打开导航` | `web/src/routes/shell/topbar.tsx:43`、`web/src/routes/manifest.ts:26` | ui-shots files-readme @1440-light @390-dark；ui-shots settings-default @1440-dark @390-light；jsdom `web/test/topbar.test.tsx:186` | 待签 |
| SH-24 | demo:1942 | §4.1#4 | 面包屑旁不渲染重命名（铅笔）按钮 | — | ui-shots chat-done @1440-light | 不适用（Non-goals：顶栏会话重命名 → S1c） |
| SH-25 | demo:1945-1952 | §4.1#4、§4.3#11 | 顶栏不渲染对话内搜索按钮与搜索框 | — | ui-shots chat-done @1440-light | 不适用（Non-goals：对话内搜索 → S1c） |
| SH-26 | demo:1953 | §4.1#4 | 顶栏不渲染产物面板按钮 | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #403） |
| SH-27 | demo:1954 | §4.1#4 | 顶栏不渲染「更多」按钮 | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #403） |
| SH-28 | demo:892-896 | §4.1#5 | S1e 页面没有 1100 档元素：demo 的 1100 断点只作用于 `/center` 面板 | — | 核对 `openspec/specs/spa-shell/spec.md:18`（响应式段） | 不适用（S1d，偏差留痕 3） |
| SH-29 | demo:307-310 | §4.1#5 | 宽度 ≤760 时侧栏不在文档流里，主区占满宽度；顶栏最左是 `打开导航`（汉堡图标）。点它弹出左侧 288 覆盖层：展开态，没有品牌区与折叠按钮；选中路由即关闭。demo 的 390 截图为折叠后的浮层侧栏 | `web/src/routes/shell/app-shell.tsx:26-32`、`web/src/routes/shell/topbar.tsx:25-35`、`web/src/lib/viewport.ts:4` | ui-shots chat-welcome @390-light @390-dark；ui-shots files-readme @390-light；ui-shots settings-default @390-dark；ui-walk 打开导航（`web/e2e/ui-walk-layout.ts:187-195`）；jsdom `web/test/app-shell-responsive.test.tsx:265` | 待签 |
| SH-30 | demo:305-310 | §4.1#5 | 六个格、五个态的 app 截图都没有横向溢出。脚本逐张断言；`index.html` 中无失败标注即为通过 | `web/e2e/ui-shots.mjs:373` | ui-shots login-default @1440-light @1024-light @390-light；ui-shots chat-done @390-dark；ui-shots files-readme @1024-dark @390-light；ui-walk 逐路由 1024 无溢出（`web/e2e/ui-walk-layout.ts:98-105`） | 待签 |
| SH-31 | demo:4142 | §4.1#2、§4.1#6 | 覆盖层叠放时，每按一次 Escape 只关最上层：导航覆盖层 → 用户菜单 → 退出确认框逐层叠开，第一次 Escape 只关确认框（覆盖层仍在），第二次才关覆盖层 | `web/src/ui/dialog.tsx:133`、`web/src/ui/drawer.tsx:33` | jsdom `web/test/app-shell-responsive.test.tsx:377`（Escape 两次的辅助 `web/test/app-shell-responsive.test.tsx:129-133`）、`web/test/ui-dialog.test.tsx:243` | 待签 |
| SH-32 | demo:1786、demo:4141 | §4.1#6 | ⌘K 不打开命令面板，侧栏无 ⌘K 搜索按钮 | — | ui-shots chat-welcome @1440-light | 不适用（明确不做，Non-goals） |
| SH-33 | demo:2620-2621 | §4.1#6 | 输入框中无修饰 Enter 发送，Shift+Enter 换行，输入法组字中不发送 | — | jsdom `web/test/chat-page.test.tsx:175`、`web/test/chat-page.test.tsx:192` | 不适用（已实现，S0b · #270） |
| SH-34 | demo:222、demo:730 | §4.1#7 | 对话框与抽屉的遮罩淡入；`prefers-reduced-motion: reduce` 时无动画 | `web/src/ui/motion.css:23`、`web/src/ui/dialog.css:16` | jsdom `web/test/ui-guardrails.test.ts:113`、`web/test/ui-dialog.test.tsx:567` | 待签 |
| SH-35 | demo:223、demo:731 | §4.1#7 | 对话框、菜单、弹层、Tooltip、Toast 入场时弹入（微缩放加上移）；reduced-motion 时无动画 | `web/src/ui/motion.css:34`、`web/src/ui/dialog.css:28` | jsdom `web/test/ui-guardrails.test.ts:124`、`web/test/ui-popover-tooltip.test.tsx:206` | 待签 |
| SH-36 | demo:221、demo:455、demo:464 | §4.1#7、§4.3#7 | 运行中的会话状态点与步骤卡 `运行中` 徽章呼吸脉冲；reduced-motion 下 `animationName` 为 `none`，恢复后重新动起来 | `web/src/ui/motion.css:74-76`、`web/src/features/chat/conversation-view.tsx:53`、`web/src/features/chat/conversation-view.tsx:82` | ui-walk 受控回合运行中 reduced-motion 切换（`web/e2e/ui-walk.spec.ts:285`、`web/e2e/ui-walk-layout.ts:177-185`） | 待签 |
| SH-37 | demo:774 | §4.1#7 | 抽屉从所在一侧滑入：窄屏导航从左侧，右侧变体从右侧；reduced-motion 时无动画 | `web/src/ui/dialog.css:107-115`、`web/src/ui/dialog.css:147` | jsdom `web/test/ui-dialog.test.tsx:567`、`web/test/ui-dialog.test.tsx:590` | 待签 |
| SH-38 | demo:1195-1196、demo:1725 | §4.1#8 | app 任何位置都不出现上游 logo 图片 | — | ui-shots login-default @1440-light；ui-shots chat-welcome @1440-light | 不适用（明确不做，Non-goals） |
| SH-39 | demo:1783-1790 | §4.1#8 | 侧栏顶部品牌区为自有对勾 mark 加字标 `WorkBuddy`（折叠后只剩 mark；自有品牌 mark 等价，spa-shell 侧栏品牌区）。demo 的窗口圆点与版本字样见 SH-40、SH-41 | `web/src/routes/shell/sidebar.tsx:63-64`、`web/src/ui/brand-mark.tsx:11` | ui-shots chat-welcome @1440-light @1440-dark；jsdom `web/test/ui-icon-brand.test.tsx:90` | 待签 |
| SH-40 | demo:1784 | §4.1#3 | 侧栏顶部不渲染窗口三色圆点 | — | ui-shots chat-welcome @1440-light；核对 `openspec/specs/spa-shell/spec.md:18`（侧栏品牌区） | 不适用（demo 桌面壳窗口装饰；spa-shell spec 品牌区仅 mark + 字标） |
| SH-41 | demo:1790 | §4.1#3 | 侧栏不显示 `WorkBuddy V5.3.11` 版本字样；版本只在设置页关于卡出现（见 ST-03） | — | ui-shots chat-welcome @1440-light；核对 `openspec/specs/spa-shell/spec.md:18`、`openspec/specs/spa-shell/spec.md:84` | 不适用（spa-shell spec：侧栏无版本字样；版本取 /api/info 于关于卡） |
| SH-42 | demo:1787 | §4.1#3 | 侧栏不渲染「筛选任务」按钮 | — | ui-shots chat-welcome @1440-light | 不适用（S1c，会话分组侧栏，父 Non-goals） |
| SH-43 | demo:1939、demo:1967 | §4.1#4 | 宽屏顶栏不渲染折叠侧栏按钮；折叠入口在侧栏品牌区（SH-17），窄屏顶栏的 `打开导航` 见 SH-29 | — | ui-shots chat-done @1440-light；ui-shots settings-default @1440-light；核对 `openspec/specs/spa-shell/spec.md:18` | 不适用（spa-shell spec：折叠入口在侧栏，`openspec/specs/spa-shell/spec.md:18`） |

## §4.2 登录

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| LG-01 | demo:637-638、demo:1723-1724 | §4.2#1 | 登录卡在页面居中，宽 360（390 格两侧留边），圆角 16，有细边框。阴影用 `--wb-shadow-dialog`，比 demo:638 重，属有意偏差（#301 评论），视为等价 | `web/src/features/auth/login-form.tsx:70-71`、`web/src/features/auth/auth.css:20` | ui-shots login-default @1440-light @1440-dark @390-light | 待签 |
| LG-02 | demo:639-640、demo:1725 | §4.2#1 | 卡片顶部居中为自有 mark 加字标 `WorkBuddy`，高 26；不用上游 logo 图（自有品牌 mark，等价） | `web/src/features/auth/login-form.tsx:72-74` | ui-shots login-default @1440-light @1440-dark；jsdom `web/test/login-form.test.tsx:104` | 待签 |
| LG-03 | demo:641、demo:1726 | §4.2#1 | 品牌位下方为标题 `登录 WorkBuddy`（level-1 heading），居中 | `web/src/features/auth/login-form.tsx:75` | ui-shots login-default @1440-light @390-dark；jsdom `web/test/login-form.test.tsx:104` | 待签 |
| LG-04 | demo:642、demo:1727 | §4.2#1 | 标题下方为居中的小号灰字副标题 `内网统一身份 · 本实例不出网` | `web/src/features/auth/login-form.tsx:76` | ui-shots login-default @1440-light @390-dark | 待签 |
| LG-05 | demo:1728-1729 | §4.2#1 | 字段标签 `账号`，占位符 `域账号，如 zhangsan` | `web/src/features/auth/login-form.tsx:78-92` | ui-shots login-default @1440-light；jsdom `web/test/login-form.test.tsx:141` | 待签 |
| LG-06 | demo:1730-1731 | §4.2#1 | 字段标签 `密码`，占位符 `密码`，输入被掩码 | `web/src/features/auth/login-form.tsx:93-106` | ui-shots login-default @1440-light；jsdom `web/test/login-form.test.tsx:141` | 待签 |
| LG-07 | demo:643、demo:1733 | §4.2#1 | 密码框下方是满宽主按钮 `登录`：亮色深底白字，暗色反相 | `web/src/features/auth/login-form.tsx:113-115` | ui-shots login-default @1440-light @1440-dark | 待签 |
| LG-08 | demo:1751 | §4.2#2 | 页面加载后账号框即获焦。app 画出 2px 品牌色全局焦点环，demo 不画，属有意偏差（#301 评论），视为等价 | `web/src/features/auth/login-form.tsx:26-28` | ui-shots login-default @1440-light @1440-dark；jsdom `web/test/login-form.test.tsx:131` | 待签 |
| LG-09 | demo:644、demo:1732 | §4.2#2 | 登录失败后，`登录` 按钮上方出现带警示图标的错误行（`role="alert"`），文本恰为错误信封的 message | `web/src/features/auth/login-form.tsx:107-112` | jsdom `web/test/login-form.test.tsx:168` | 待签 |
| LG-10 | demo:1732 | §4.2#2 | 错误文案逐字来自服务端信封，如 `账号或密码不正确`、`该账号已停用，请联系管理员` | — | jsdom `web/test/login-form.test.tsx:168` | 不适用（已实现，S0a） |
| LG-11 | demo:1747 | §4.2#2 | 在输入框中按 Enter 提交表单 | — | jsdom `web/test/login-form.test.tsx:302` | 不适用（已实现，S0a） |
| LG-12 | demo:645、demo:1734 | §4.2#3 | dev-stub 环境下，按钮下方居中显示小号灰字 `演示账号：zhangsan / zhaoliu / lisi（管理员），密码均为 demo`，账号与密码加粗 | `web/src/features/auth/quick-login.tsx:38-48` | ui-shots login-default @1440-light @390-light；jsdom `web/test/login-form.test.tsx:446` | 待签 |
| LG-13 | demo:646-650、demo:1735-1739 | §4.2#3 | 提示下方有分隔线，下面是三行快捷登录：首字母头像、account、seed 角色（`成员`/`成员`/`管理员`）。等价说明：demo 显示姓名与部门，spa-shell spec 规定只显示 account 与 seed role。点击即以该账号和密码 `demo` 登录，恰一次；非 dev-stub 时整块不渲染 | `web/src/features/auth/quick-login.tsx:49-68`、`web/src/features/auth/dev-accounts.ts:2` | ui-shots login-default @1440-light @1440-dark @390-dark；jsdom `web/test/login-form.test.tsx:504`、`web/test/login-form.test.tsx:465` | 待签 |
| LG-14 | demo:1735 | §4.2#3 | provider 不是 dev-stub（如生产 OIDC）时，不渲染演示账号与快捷登录卡 | — | jsdom `web/test/login-form.test.tsx:465` | 不适用（明确不做，Non-goals） |
| LG-15 | demo:1741-1744 | §4.2#4 | 提交中按钮显示 `正在登录` 并禁用 | — | jsdom `web/test/login-form.test.tsx:168` | 不适用（已实现，S0a） |

## §4.3 会话 `/`

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| CH-01 | demo:341、demo:2539 | §4.3#1 | 欢迎态主区中上部为居中大标题 `WorkBuddy，我帮你`，是页面唯一的 level-1 heading | `web/src/features/chat/welcome.tsx:16` | ui-shots chat-welcome @1440-light @1024-dark @390-light；jsdom `web/test/chat-page.test.tsx:313` | 待签 |
| CH-02 | demo:352-357、demo:2543-2546 | §4.3#2 | hero 下方一行胶囊 chip（图标 + 文案），取 demo 默认「日常办公」组，首项为 `文档处理`；点击只把 prompt 填进输入框，不发送。无场景胶囊（偏差留痕 5） | `web/src/features/chat/welcome.tsx:17-30`、`web/src/features/chat/welcome-content.ts:7` | ui-shots chat-welcome @1440-light @1440-dark @390-dark；jsdom `web/test/chat-page.test.tsx:354` | 待签 |
| CH-03 | demo:2540-2542 | §4.3#2 | 不渲染 `日常办公`/`代码开发`/`创意设计` 场景胶囊，也不能按场景切换 chip | — | ui-shots chat-welcome @1440-light | 不适用（Non-goals：场景胶囊与按场景切换 → S1c） |
| CH-04 | demo:403-413、demo:2562-2575 | §4.3#3 | composer 下方先是标题行 `不知道做什么，试试最佳实践案例`（前有 sparkles 图标），再是五张卡片：图标、标题、描述，描述最多两行。点卡片只填草稿，不发送。`≥761px` 五张卡同一行、不换行（demo:408-409），`≤760px` 可换行 | `web/src/features/chat/welcome.tsx:36-71`、`web/src/features/chat/welcome-content.ts:20`、`web/src/features/chat/chat.css:288-301`（@#424） | ui-shots chat-welcome @1440-light @1024-light @390-light；ui-walk `session list in sidebar and welcome first screen (#424)`（`web/e2e/ui-walk.spec.ts:106`、`web/e2e/ui-walk-layout.ts:129`，@#424，1440×900 与 1024×768 五卡 offsetTop 相同）；jsdom `web/test/chat-page.test.tsx:313`、`web/test/chat-composer.test.tsx:210`（@#424） | 待签 |
| CH-05 | demo:2567 | §4.3#3 | 标题行右侧有 `换一批`；点击后五张卡换成静态七项中的另一组（循环轮换） | `web/src/features/chat/welcome.tsx:44-51` | ui-shots chat-welcome @1440-light；jsdom `web/test/chat-page.test.tsx:396` | 待签 |
| CH-06 | demo:2567 | §4.3#3 | 不渲染 `查看更多` | — | ui-shots chat-welcome @1440-light；核对 `openspec/specs/chat-web/spec.md:72` | 不适用（chat-web spec：目标 `/center` 未交付，属 S1d） |
| CH-07 | demo:414、demo:2551 | §4.3#3 | 欢迎区底部居中显示小号灰字 `内容由 AI 生成，请核实重要信息` | `web/src/features/chat/welcome.tsx:72` | ui-shots chat-welcome @1440-light @390-light；ui-walk `session list in sidebar and welcome first screen (#424)`（`web/e2e/ui-walk.spec.ts:106`、`web/e2e/ui-walk-layout.ts:147`，@#424，1440×900、1024×768、390×844 免责声明底边在首屏内） | 待签 |
| CH-08 | demo:364-368、demo:2585-2589 | §4.3#4 | 输入区为圆角 16 的卡片，内含多行输入框。placeholder 在欢迎态为 `今天帮你做些什么`，会话态为 `继续追问，或派一个新任务…`；卡片下方有提示 `Enter 发送 · Shift+Enter 换行` | `web/src/features/chat/composer.tsx:27-58`、`web/src/features/chat/composer.tsx:77-79` | ui-shots chat-welcome @1440-light @1440-dark @390-light；ui-shots chat-done @1440-light；jsdom `web/test/chat-composer.test.tsx:57`、`web/test/chat-composer.test.tsx:72` | 待签 |
| CH-09 | demo:374-381、demo:2597 | §4.3#4 | 卡片底部工具栏只有一个控件：右侧 32px 圆形发送按钮（send 图标），草稿为空时禁用。回合运行中按钮禁用、可访问名为 `生成中`，工具栏出现 `生成中` 状态字 | `web/src/features/chat/composer.tsx:59-75` | ui-shots chat-welcome @1440-light @1440-dark；ui-walk 运行中前缀（`web/e2e/ui-walk.spec.ts:475`）；jsdom `web/test/chat-composer.test.tsx:116` | 待签 |
| CH-10 | demo:2590 | §4.3#4 | composer 不渲染附件（回形针）按钮 | — | ui-shots chat-welcome @1440-light | 不适用（Non-goals：附件按钮 → S2c） |
| CH-11 | demo:2593 | §4.3#4 | composer 不渲染模型切换 chip | — | ui-shots chat-welcome @1440-light | 不适用（Non-goals：模型切换 chip → S1d） |
| CH-12 | demo:2596 | §4.3#4 | 运行中不出现停止按钮（发送按钮只变成禁用的 `生成中`） | — | jsdom `web/test/chat-composer.test.tsx:116` | 不适用（Non-goals：停止生成 → S1c） |
| CH-13 | demo:2579-2582 | §4.3#4 | composer 下方不渲染「任务启动于 <空间>」与「权限」两个按钮 | — | ui-shots chat-welcome @1440-light；核对 `openspec/specs/chat-web/spec.md:75` | 不适用（Non-goals：composer footer 空间绑定 → S1c） |
| CH-14 | demo:1862 | §4.3#5 | 会话列表每项左侧有状态圆点：运行中带脉冲，已完成、失败、未开始各用不同颜色。读屏名为 `<标题> 运行中/已完成/失败/未开始`，可见文字只有标题 | `web/src/features/chat/conversation-view.tsx:63-69`、`web/src/features/chat/status-label.ts:4` | ui-shots chat-done @1440-light @1440-dark；ui-walk 会话状态（`web/e2e/ui-walk.spec.ts:474`、`web/e2e/ui-walk.spec.ts:528`）；jsdom `web/test/chat-composer.test.tsx:152` | 待签 |
| CH-15 | demo:274、demo:1797、demo:1852-1907 | §4.3#5 | 会话列表区（`新建会话` + 按更新时间倒序的平铺列表）在主侧栏 `主导航` 之后、用户区之前，`main` 内没有；折叠态不渲染列表区；`≤760px` 在 `导航` 覆盖层里位于主导航之后，选会话或 `新建会话` 后覆盖层关闭。置顶/任务/空间/助理任务分组不在本项：仍属 S1c，不适用（Non-goals：会话分组侧栏 → S1c） | `web/src/routes/shell/sidebar.tsx:52`、`web/src/routes/shell/sidebar.tsx:121`、`web/src/features/chat/session-nav.tsx:74`、`web/src/features/chat/page.tsx:703`（@#424） | ui-shots chat-done @1440-light @1024-light；ui-walk `session list in sidebar and welcome first screen (#424)`（`web/e2e/ui-walk-layout.ts:274`，@#424）；jsdom `web/test/sidebar.test.tsx:149`、`web/test/sidebar.test.tsx:168`、`web/test/app-shell-responsive.test.tsx:341`、`web/test/app-shell-responsive.test.tsx:373`（@#424） | 待签 |
| CH-16 | demo:1864、demo:1909-1920 | §4.3#5 | 会话条目没有「更多」按钮，也没有重命名/置顶/删除菜单 | — | ui-shots chat-done @1440-light | 不适用（Non-goals：条目更多菜单 → S1c） |
| CH-17 | demo:421、demo:2380 | §4.3#6 | 用户消息为右对齐气泡，右下角是小圆角，保留原文的换行与空白 | `web/src/features/chat/conversation-view.tsx:117-124`、`web/src/features/chat/messages.css:28`、`web/src/styles.css:42`（@#420） | ui-shots chat-done @1440-light @1440-dark @390-dark；jsdom `web/test/chat-messages.test.tsx:83` | 待签 |
| CH-18 | demo:424-427、demo:2400-2405 | §4.3#6 | 助手消息为左侧 28px 自有 mark 头像（装饰性）加无底色正文块，步骤卡在正文之后。等价说明：demo 头像是上游 app 图标，这里以自有品牌 mark 替代 | `web/src/features/chat/conversation-view.tsx:126-145` | ui-shots chat-done @1440-light @1440-dark @390-dark；jsdom `web/test/chat-messages.test.tsx:152` | 待签 |
| CH-19 | demo:428-445、demo:2390 | §4.3#6 | 助手正文按 Markdown 渲染：标题、列表、代码块、表格。源 HTML 作为文本显示，链接不跳转。`chat-done` 态正文为假上游的固定回复 `你好，这是 WorkBuddy 的第一条流式回复。` | `web/src/lib/markdown-view.tsx:139`、`web/src/features/chat/conversation-view.tsx:132-133` | ui-shots chat-done @1440-light；jsdom `web/test/chat-messages.test.tsx:65` | 待签 |
| CH-20 | demo:446、demo:2390 | §4.1#7、§4.3#6 | 助手运行中，正文末尾有品牌色闪烁竖条光标；完成或失败后消失 | `web/src/features/chat/conversation-view.tsx:134-136`、`web/src/ui/motion.css:78-80` | jsdom `web/test/chat-messages.test.tsx:101`、`web/test/chat-messages.test.tsx:132` | 待签 |
| CH-21 | demo:2383-2386 | §4.3#6 | 助手消息不渲染「深度思考过程」折叠块 | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #404） |
| CH-22 | demo:528-530、demo:2395 | §4.3#6 | 已完成且正文非空的助手消息末尾有操作条，只有一个复制图标按钮（名称与 tooltip 都是 `复制`）。点击后复制 Markdown 原文，弹出 Toast `已复制到剪贴板`；剪贴板不可用时弹出 `复制失败`。运行中的消息、正文为空的消息、用户消息都没有操作条 | `web/src/features/chat/message-actions.tsx:4-27`、`web/src/features/chat/conversation-view.tsx:140-142` | ui-shots chat-done @1440-light @1440-dark；jsdom `web/test/chat-copy.test.tsx:63`、`web/test/chat-copy.test.tsx:76`、`web/test/chat-copy.test.tsx:132` | 待签 |
| CH-23 | demo:2396 | §4.3#6 | 操作条不渲染「重新生成」 | — | ui-shots chat-done @1440-light | 不适用（Non-goals：重新生成 → S1c） |
| CH-24 | demo:2393 | §4.3#6 | 助手消息下方不渲染追问 chip | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #404） |
| CH-25 | demo:448-458、demo:2218-2231 | §4.3#7 | 每个步骤是一张卡片，卡头为图标（`bash` 用 terminal，其它用 wrench）、步骤名，以及状态徽章 `运行中`/`已完成`/`失败`。徽章可访问名为 `<步骤名> <状态>`；卡片中不出现伪造的耗时或 todo。`chat-done` 中的 bash 步骤卡来自假上游固定发出的一次 bash 调用（`echo workbuddy-smoke`） | `web/src/features/chat/conversation-view.tsx:79-97` | ui-shots chat-done @1440-light @1440-dark；ui-walk 步骤徽章（`web/e2e/ui-walk.spec.ts:481-487`）；jsdom `web/test/chat-steps.test.tsx:45` | 待签 |
| CH-26 | demo:461-471、demo:2215-2217、demo:2232-2238 | §4.3#7 | 卡头下方一行摘要：JSON detail 依次取 `text`、`content`、首个 `key: value`，否则取首个非空行，截断到 120 码点；不整段倒出 JSON。`chat-done` 中这一步来自假上游固定发出的 bash 调用（`echo workbuddy-smoke`） | `web/src/features/chat/conversation-view.tsx:98`、`web/src/features/chat/step-summary.ts:33` | ui-shots chat-done @1440-light；jsdom `web/test/step-summary.test.ts:35`、`web/test/chat-steps.test.tsx:45` | 待签 |
| CH-27 | demo:2224-2232 | §4.3#7 | 摘要下方是默认折叠的 `原始输出`，展开后显示工具参数（detail）与工具输出（output）两块，参数在前、各自为空时不渲染。`chat-done` 中这一步来自假上游固定发出的 bash 调用（`echo workbuddy-smoke`） | `web/src/features/chat/conversation-view.tsx:99-104` | ui-shots chat-done @1440-light；jsdom `web/test/chat-steps.test.tsx:45` | 待签 |
| CH-28 | demo:2223 | §4.3#7 | 步骤卡没有「已停止」态 | — | jsdom `web/test/chat-steps.test.tsx:45` | 不适用（Non-goals：停止生成 → S1c） |
| CH-29 | demo:2875-2902 | §4.3#8 | 助手消息不渲染知识库检索卡 | — | ui-shots chat-done @1440-light | 不适用（S2c，审计计划归属） |
| CH-30 | demo:2407-2418 | §4.3#9 | 不渲染审批条（允许/拒绝） | — | ui-shots chat-done @1440-light | 不适用（Non-goals：审批条 → S1c） |
| CH-31 | demo:2419-2466 | §4.3#10 | 助手消息不渲染产物卡（code/html/img） | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #403） |
| CH-32 | demo:2468-2476 | §4.3#10 | 助手消息不渲染文件变更卡 | — | ui-shots chat-done @1440-light | 不适用（计划遗漏，未归属 → #403） |
| CH-33 | demo:2504 | §4.3#11 | 会话中上滚超过一屏时，底部居中浮出 `回到最新`（带 chevron-down 图标）；点击后滚回底部并隐藏。贴底时新内容自动跟随；欢迎态没有该按钮 | `web/src/features/chat/scroll-follow.tsx:58-73` | jsdom `web/test/chat-scroll-follow.test.tsx:146`、`web/test/chat-scroll-follow.test.tsx:157`、`web/test/chat-scroll-follow.test.tsx:238` | 待签 |
| CH-34 | demo:2054-2058 | §4.3#12 | 打开他人或不存在的会话 ID（GET 返回 404）时，移除 `?session=` 回到欢迎态，不弹 toast，也不建立事件流 | — | jsdom `web/test/chat-page-ownership.test.tsx:212` | 不适用（chat-web spec：越权 404 回欢迎态，无 toast） |
| CH-35 | demo:2545 | §4.3#2 | chip 行末尾不渲染展开 `›` 按钮 | — | ui-shots chat-welcome @1440-light；核对 `openspec/specs/chat-web/spec.md:72` | 不适用（chat-web spec：默认场景静态单行 chip，`openspec/specs/chat-web/spec.md:72`） |
| CH-36 | demo:2584 | §4.3#4 | composer 旁不渲染吉祥物图形 | — | ui-shots chat-welcome @1440-light | 不适用（上游品牌图形，父 Non-goals 明确不做；审计 §4.1#8） |

## §4.4 文件 `/files`

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| FI-01 | demo:660-665、demo:3845-3849 | §4.4#1 | 树栏顶部是切换器卡：layout-grid 图标、空间名 `smoke-fixture`，下方等宽小字为逻辑路径 `zhangsan/smoke-fixture`。页面任何文本、`title`、`aria-*`、placeholder 都不含服务器绝对路径。等价说明：demo 在这里显示服务器目录，files-web spec 规定改为逻辑路径 | `web/src/features/files/page.tsx:95-106`、`web/src/features/files/file-meta.ts:43` | ui-shots files-readme @1440-light @1440-dark @390-light；jsdom `web/test/files-logical-path.test.tsx:116`、`web/test/files-logical-path.test.tsx:161` | 待签 |
| FI-02 | demo:3592 | §4.4#1 | 点切换器卡弹出切换器，首行是搜索框 `搜索工作空间` 并获焦。按空间名或逻辑路径做大小写无关过滤；无匹配时显示 `无匹配的工作空间`。Escape 关闭，焦点回到卡片 | `web/src/features/files/page.tsx:90-117` | ui-walk 工作空间切换器（`web/e2e/ui-walk.spec.ts:162-164`）；jsdom `web/test/files-logical-path.test.tsx:193`、`web/test/files-overlays.test.tsx:52` | 待签 |
| FI-03 | demo:3593-3597 | §4.4#1 | 弹层列表每项为空间名加逻辑路径，当前空间右侧有 `✓`；选中其它项即切换空间，并更新 `?ws=` | `web/src/features/files/page.tsx:118-145` | ui-walk 选择 smoke-fixture（`web/e2e/ui-walk.spec.ts:165-176`）；jsdom `web/test/files-logical-path.test.tsx:193` | 待签 |
| FI-04 | demo:3599 | §4.4#1 | 弹层底部有按钮 `＋ 新建工作空间`，点击打开新建工作空间对话框（见 FI-15） | `web/src/features/files/page.tsx:149-156` | jsdom `web/test/files-overlays.test.tsx:52`；ui-walk 新建工作空间入口（`web/e2e/ui-walk.spec.ts:164-171`，条件分支：仅 smoke-fixture 不存在时执行） | 待签 |
| FI-05 | demo:3600 | §4.4#1 | 弹层不渲染「挂载目录到当前空间」 | — | jsdom `web/test/files-overlays.test.tsx:52` | 不适用（Non-goals：挂载目录 → S1b） |
| FI-06 | demo:680-684、demo:3865-3873 | §4.4#2 | 树根行为 shield 图标加空间名 `smoke-fixture`（不再显示字面 `root`），可访问名为 `折叠 smoke-fixture`；下一行等宽小字 `zhangsan/smoke-fixture` | `web/src/features/files/tree.tsx:238`、`web/src/features/files/tree.tsx:144-161` | ui-shots files-readme @1440-light @1024-dark；jsdom `web/test/files-logical-path.test.tsx:169` | 待签 |
| FI-07 | demo:3870 | §4.4#2 | 根行不渲染在线/离线圆点 | — | ui-shots files-readme @1440-light | 不适用（Non-goals：只读/在线标记 → S1b） |
| FI-08 | demo:3869 | §4.4#2 | 根行不渲染 `只读` 标签 | — | ui-shots files-readme @1440-light | 不适用（Non-goals：只读/在线标记 → S1b） |
| FI-09 | demo:3871 | §4.4#2 | 根行不渲染卸载（×）按钮 | — | ui-shots files-readme @1440-light | 不适用（Non-goals：卸载 → S1b） |
| FI-10 | demo:697、demo:3885-3893 | §4.4#2 | 目录行是 folder 图标；文件按扩展名选图标：`readme.md` 为 file-text，`notes.csv` 为 table，`logo.png` 为 image。文件按钮的可访问名恰为文件名 | `web/src/features/files/tree.tsx:216-218`、`web/src/features/files/file-meta.ts:22` | ui-shots files-readme @1440-light @1440-dark；jsdom `web/test/files-page.test.tsx:469`、`web/test/file-meta.test.ts:5` | 待签 |
| FI-11 | demo:699、demo:3890 | §4.4#2 | 文件行行尾是右对齐的灰色小字大小：小于 1024 显示 `N B`，否则按 KB/MB/GB 保留一位小数 | `web/src/features/files/tree.tsx:220-222`、`web/src/features/files/file-meta.ts:31` | ui-shots files-readme @1440-light @390-dark；jsdom `web/test/files-page.test.tsx:469`、`web/test/file-meta.test.ts:40` | 待签 |
| FI-12 | demo:3882-3884 | §4.4#3 | 目录首次展开时请求该层，折叠后再展开复用缓存 | — | jsdom `web/test/files-page.test.tsx:80` | 不适用（已实现，S1a） |
| FI-13 | demo:3852、demo:3952-3957 | §4.4#3 | `工作空间目录` 标题右侧有 `＋` 按钮（可访问名 `新建`），打开的下拉菜单恰两项 `新建文件夹`、`新建工作空间`。Escape 关闭后焦点回到 `新建`；demo 的「挂载目录」项见 FI-16 | `web/src/features/files/dialogs.tsx:37-53`、`web/src/features/files/tree.tsx:264-267` | ui-walk 新建菜单（`web/e2e/ui-walk.spec.ts:211-212`）；jsdom `web/test/files-overlays.test.tsx:77`、`web/test/files-overlays.test.tsx:159` | 待签 |
| FI-14 | demo:3987-3995 | §4.4#3 | `新建文件夹` 以模态对话框呈现：字段为 `位置`（下拉，根项为 `根目录　<空间名>`）与 `文件夹名称`，打开时聚焦 `位置`。Escape、遮罩、`关闭`、`取消` 均取消，焦点回到 `新建`。提交中 `创建` 禁用，焦点留在框内；此时取消会中止请求 | `web/src/features/files/dialogs.tsx:186-218` | ui-walk 新建文件夹挂起（`web/e2e/ui-walk.spec.ts:235-251`）；jsdom `web/test/files-overlays.test.tsx:96`、`web/test/files-overlays.test.tsx:116`、`web/test/files-logical-path.test.tsx:212` | 待签 |
| FI-15 | demo:3609-3612 | §4.4#3 | `新建工作空间` 以模态对话框呈现：说明 `将在你的沙箱内创建同名目录`，字段为 `工作空间名称`、`目录名`，打开时聚焦 `工作空间名称`。取消类关闭后，焦点回到发起入口（`选择工作空间` 或 `新建`）。提交中 `创建` 禁用；409 时显示 `同名工作空间已存在`，对话框保持打开 | `web/src/features/files/dialogs.tsx:122-150` | jsdom `web/test/files-overlays.test.tsx:52`、`web/test/files-overlays.test.tsx:137`；ui-walk 新建工作空间（`web/e2e/ui-walk.spec.ts:164-171`，条件分支：仅 smoke-fixture 不存在时执行）；jsdom `web/test/files-overlays.test.tsx:76`（O1，@#422）、`web/test/files-overlays.test.tsx:108`（O2，@#422） | 待签 |
| FI-16 | demo:3954 | §4.4#3 | `＋` 菜单不含「挂载目录」 | — | jsdom `web/test/files-overlays.test.tsx:77` | 不适用（Non-goals：挂载目录 → S1b） |
| FI-17 | demo:3960-3975、demo:3989-3990 | §4.4#3 | 位置下拉只列根和已加载的目录，不额外递归请求 | — | jsdom `web/test/files-page.test.tsx:80` | 不适用（已实现，S1a） |
| FI-18 | demo:3999-4000 | §4.4#3 | 名称为空时提示 `请填写文件夹名称`；含 `/` 或 `\` 时提示 `名称不能包含路径分隔符` | — | jsdom `web/test/files-page.test.tsx:230` | 不适用（已实现，S1a） |
| FI-19 | demo:4003 | §4.4#3 | 同名条目返回 409 时显示 `该目录下已存在同名条目` | — | jsdom `web/test/files-page.test.tsx:230` | 不适用（已实现，S1a） |
| FI-20 | demo:703-706、demo:3913-3917 | §4.4#4 | 预览区顶部依次为：文件类型图标、等宽路径 `readme.md`，之后是灰字 `<大小> · <修改时间>`（宽屏时靠右） | `web/src/features/files/preview.tsx:118-124` | ui-shots files-readme @1440-light @1024-light @390-light；jsdom `web/test/preview.test.tsx:153` | 待签 |
| FI-21 | demo:3917、demo:3922 | §4.4#4 | Markdown 默认渲染，可切换 `查看源码`/`渲染视图`；换文件后重置为渲染 | — | ui-walk readme 预览（`web/e2e/ui-walk.spec.ts:184-193`）；jsdom `web/test/preview.test.tsx:174` | 不适用（已实现，S1a） |
| FI-22 | demo:3923、demo:3938 | §4.4#4 | CSV 首行为表头，下方注 `共 N 行 · 大文件仅预览前若干行` | — | ui-walk notes.csv（`web/e2e/ui-walk.spec.ts:195-202`）；jsdom `web/test/preview.test.tsx:83` | 不适用（已实现，S1a） |
| FI-23 | demo:3924-3926 | §4.4#4 | JSON 格式化后显示；解析失败时保留原文 | — | jsdom `web/test/preview.test.tsx:543` | 不适用（已实现，S1a） |
| FI-24 | demo:3927-3931 | §4.4#4 | 文本与代码以带行号的表格显示 | — | jsdom `web/test/preview.test.tsx:113` | 不适用（已实现，S1a） |
| FI-25 | demo:3920 | §4.4#4 | 图片按原始尺寸预览（夹具 `logo.png` 为 256×256） | — | ui-walk logo.png（`web/e2e/ui-walk.spec.ts:204-208`） | 不适用（已实现，S1a） |
| FI-26 | demo:3919 | §4.4#4 | 不支持的类型：预览区为空态，标题 `该类型不支持预览`，说明 `<文件名> · <大小>　二进制或未识别格式`，不发起文件请求。demo 的后半句「，可下载到沙箱后处理」按 files-web spec 不渲染 | `web/src/features/files/preview.tsx:141-151` | jsdom `web/test/files-empty-layout.test.tsx:48`、`web/test/preview.test.tsx:480` | 待签 |
| FI-27 | demo:3910 | §4.4#5 | 空间根一层为空时，树区空态显示 `该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹`。demo 的「或挂载…」半句按 files-web spec 不渲染 | `web/src/features/files/tree.tsx:175-177` | jsdom `web/test/files-empty-layout.test.tsx:25` | 待签 |
| FI-28 | demo:3877 | §4.4#5 | 展开一个空目录后，其下显示灰字 `空目录` | `web/src/features/files/tree.tsx:179` | jsdom `web/test/files-empty-layout.test.tsx:48` | 待签 |
| FI-29 | demo:3912 | §4.4#5 | 未选文件时，预览区空态显示 `未选择文件` / `在左侧目录树中选择一个文件进行预览` | `web/src/features/files/tree.tsx:244-249` | jsdom `web/test/files-empty-layout.test.tsx:25` | 待签 |
| FI-30 | demo:3847 | §4.4#5 | 账号没有任何空间时，切换器卡显示 `未选择工作空间`，树区空态显示 `先选择或创建工作空间` / `使用左上角 ＋ 新建工作空间`；此时 `＋` 菜单仍可新建工作空间 | `web/src/features/files/page.tsx:103`、`web/src/features/files/page.tsx:163-186` | jsdom `web/test/files-empty-layout.test.tsx:74`、`web/test/files-empty-layout.test.tsx:87`（E3b，@#422） | 待签 |
| FI-31 | demo:667 | §4.4#6 | 宽屏时树栏宽 280，预览区在右侧占满剩余宽度，两栏各自滚动 | `web/src/features/files/files.css:27-29` | ui-shots files-readme @1440-light @1440-dark @1024-light；ui-walk 树栏 280（`web/e2e/ui-walk-layout.ts:118`） | 待签 |
| FI-32 | demo:723 | §4.1#5、§4.4#6 | 视口 ≤900（且 >760）时树栏收窄为 210，页面无横向溢出。ui-shots 没有这一档，由 ui-walk 在 880 宽下断言 | `web/src/features/files/files.css:586-590` | ui-walk 树栏 210（`web/e2e/ui-walk-layout.ts:119-122`）；jsdom `web/test/files-empty-layout.test.tsx:108` | 待签 |
| FI-33 | demo:307-310 | §4.4#6 | ≤760 时文件页改为纵向布局，树在上、预览在下，页面无横向溢出。长文件名单行省略，`title` 为全名 | `web/src/features/files/files.css:592-596` | ui-shots files-readme @390-light @390-dark；ui-walk 纵向堆叠（`web/e2e/ui-walk-layout.ts:111-116`）；ui-walk 长名截断（`web/e2e/ui-walk-layout.ts:147-157`） | 待签 |
| FI-34 | demo:3916、demo:1532-1540 | §4.4#4 | 预览头的修改时间显示为查看者本地时区 `YYYY-MM-DD HH:mm`（24 小时制、各段补零），不含 ISO 的 `T`/`Z` 与毫秒。等价说明：demo 样例是相对时间（`今天 09:12`），按用户决定（2026-09-25）app 显示绝对本地时间 | `web/src/features/files/file-meta.ts:45`、`web/src/features/files/preview.tsx:123`（@#421） | jsdom `web/test/file-meta.test.ts:68`、`web/test/preview.test.tsx:154`；ui-shots files-readme @1440-light（@#421） | 待签 |

## §4.5 设置 `/settings`

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| ST-01 | demo:558-562、demo:3537-3546 | §4.5#1 | 分节标题 `外观` 下是一张卡。第一行左侧为 `主题` 和说明 `浅色 / 深色 / 跟随系统 · 即时生效并持久保存`，右侧是胶囊分段控件 `浅色`/`深色`/`跟随系统`，当前项深底白字（暗色反相）。demo 说明末尾多「（localStorage）」，按 spa-shell spec 不带 | `web/src/features/settings/page.tsx:22-45`、`web/src/ui/segmented-control.tsx:16` | ui-shots settings-default @1440-light @1440-dark @390-light；ui-walk 主题切换（`web/e2e/ui-walk-layout.ts:261-277`）；jsdom `web/test/settings-page.test.tsx:242` | 待签 |
| ST-02 | demo:3547-3549 | §4.5#1 | 同一张卡的第二行左侧为 `当前生效`，说明为 `浅色 · 持久保存于 localStorage` 或 `深色 · 持久保存于 localStorage`，跟随实际生效的主题 | `web/src/features/settings/page.tsx:46-54` | ui-shots settings-default @1440-light @1440-dark；jsdom `web/test/settings-page.test.tsx:284` | 待签 |
| ST-03 | demo:3551-3556 | §4.5#2 | 分节标题 `关于` 下是一张卡，一行中左侧为 32px 自有 mark，右侧为名称与 `版本 <version>`。等价说明：名称与版本来自 `/api/info`，不沿用 demo 的 `WorkBuddy`/`5.3.11`，图标用自有品牌 mark | `web/src/features/settings/page.tsx:97-122` | ui-shots settings-default @1440-light @1440-dark @390-dark；ui-shots settings-default 截图前断言标题与名称文字色为本格 `--wb-text-primary`、无残留过渡 `web/e2e/ui-shots.mjs:415`（@#423）；ui-walk `expectReducedMotionThemeSwitch`：reduce 下点选主题后同一任务内读取继承色与过渡数 `web/e2e/ui-walk-layout.ts:400`（@#423）；jsdom `web/test/settings-page.test.tsx:352` | 待签 |
| ST-04 | demo:3555 | §4.5#2 | 关于卡的名称与版本逐字取自 `/api/info`；读取失败时显示稳定的回退文案 | — | jsdom `web/test/settings-page.test.tsx:48` | 不适用（已实现，S0a） |
| ST-05 | demo:3559-3566 | §4.5#3 | 选中某一档后，根元素的 `data-theme` 立即变化 | — | jsdom `web/test/theme-provider.test.tsx:125` | 不适用（已实现，S0a） |
| ST-06 | demo:1035-1039 | §4.5#3 | 所选档位写入 `workbuddy-theme`，刷新后仍然保持 | — | jsdom `web/test/theme-provider.test.tsx:125`、`web/test/theme-provider.test.tsx:147` | 不适用（已实现，S0a） |
| ST-07 | demo:1036、demo:1041 | §4.5#3 | 选 `跟随系统` 时随系统深浅变化，持久值仍为 `system` | — | jsdom `web/test/theme-provider.test.tsx:160` | 不适用（已实现，S0a） |
| ST-08 | demo:1035 | §4.5#3 | 其它标签页改了主题（`storage` 事件）时，本页同步切换 | — | jsdom `web/test/theme-provider.test.tsx:183` | 不适用（已实现，S0a） |

## §4.6 `/center`

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| CT-01 | demo:3144-3161、demo:1756 | §4.6 | `/center` 只显示占位 `中心暂不可用`，没有 专家/技能/连接器/知识库/模型/权限/审计/账号 八个 tab，也没有任何功能按钮；路由只有四个，没有 `/tokens` 开发者页 | — | jsdom `web/test/topbar.test.tsx:199`（`中心暂不可用`）、`web/test/routes.test.tsx:214`（只有四条路由） | 不适用（S1d/S2a-c/S3a-b；`/tokens` 明确不做，Non-goals） |

## §4.7 demo 无后端控件

| 编号 | demo:行号 | §4 来源 | 期望（可观察） | 实现 file:line | 验证方式 | 签收 |
|---|---|---|---|---|---|---|
| NB-01 | demo:2594、demo:2720-2731 | §4.7:麦克风语音、§4.3#4 | composer 不渲染麦克风按钮与录音提示 | — | ui-shots chat-welcome @1440-light | 不适用（demo 无后端，Non-goals 明确不做） |
| NB-02 | demo:3667、demo:3689 | §4.7:上传本地文件 | 不渲染「上传本地文件」入口 | — | ui-shots chat-welcome @1440-light | 不适用（demo 无后端，S2c 附件） |
| NB-03 | demo:3184、demo:3426 | §4.7:召唤专家 | 不渲染「召唤」按钮（`/center` 为占位） | — | `/center` 为占位页（见 CT-01）：jsdom `web/test/topbar.test.tsx:199` | 不适用（demo 无后端，S1d） |
| NB-04 | demo:3203、demo:3431 | §4.7:安装技能 | 不渲染「安装」按钮 | — | `/center` 为占位页（见 CT-01）：jsdom `web/test/topbar.test.tsx:199` | 不适用（demo 无后端，S1d） |
| NB-05 | demo:3216、demo:3438-3440 | §4.7:连接器 | 不渲染连接器「连接」按钮 | — | `/center` 为占位页（见 CT-01）：jsdom `web/test/topbar.test.tsx:199` | 不适用（demo 无后端，S1d） |
| NB-06 | demo:3462 | §4.7:测试连通并保存 | 不渲染「接入内网模型 / 测试连通并保存」 | — | `/center` 为占位页（见 CT-01）：jsdom `web/test/topbar.test.tsx:199` | 不适用（demo 无后端，S1d） |
| NB-07 | demo:4026 | §4.7:测试连通并挂载 | 不渲染「挂载目录 / 测试连通并挂载」 | — | jsdom `web/test/files-overlays.test.tsx:77` | 不适用（demo 无后端，S1b） |
| NB-08 | demo:2254、demo:2415 | §4.7:审批 15s 自动通过 | 没有审批倒计时与自动允许 | — | ui-shots chat-done @1440-light | 不适用（demo 无后端，Non-goals：审批条 → S1c） |
| NB-09 | demo:2340、demo:2821、demo:3096 | §4.7:知识库入库与相似度 | 没有知识库入库、切片与相似度展示 | — | `/center` 为占位页（见 CT-01）：jsdom `web/test/topbar.test.tsx:199` | 不适用（demo 无后端，S2a-c） |
| NB-10 | demo:1917 | §4.7:导出记录、§4.3#5 | 没有「导出记录」入口 | — | ui-shots chat-done @1440-light | 不适用（demo 无后端，Non-goals 明确不做） |
| NB-11 | demo:2458 | §4.7:在编辑器中打开 | 没有产物卡「在编辑器中打开」按钮 | — | ui-shots chat-done @1440-light | 不适用（demo 无后端，计划遗漏，未归属 → #403） |
| NB-12 | demo:2474 | §4.7:查看详情 | 没有文件变更卡「查看详情」按钮 | — | ui-shots chat-done @1440-light | 不适用（demo 无后端，计划遗漏，未归属 → #403） |
| NB-13 | demo:2371-2372、demo:2397-2398 | §4.7:赞/踩、§4.3#6 | 助手操作条没有赞/踩按钮 | — | ui-shots chat-done @1440-light | 不适用（demo 无后端，Non-goals 明确不做） |

## Epic 签收记录模板

签收人给出结论后，由 archive PR 照抄到上面各表的签收格，并按下列格式贴入 Epic #274。只列范围内项；范围外项维持 `不适用（…）`。

```markdown
### S1e demo 一致性签收（清单 docs/acceptance/demo-parity-checklist.md）

- 清单生成 SHA：9a40ca8；ui-shots 实跑 SHA：<sha>；产物：<私有页面链接或"已交签收人">

| 编号 | 签收 | 备注 |
|---|---|---|
| <编号> | 通过 YYYY-MM-DD / 不通过 YYYY-MM-DD #<issue> | <出处：评论链接或"签收人对话确认 YYYY-MM-DD"> |

- 不通过项 → issue：<编号 → #issue，逐条；无则写"无">
- 签收人 / 日期：<签收人> / <YYYY-MM-DD>
```
