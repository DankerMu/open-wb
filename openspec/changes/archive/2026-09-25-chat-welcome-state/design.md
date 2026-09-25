# Design: chat-welcome-state（#289）

Fixture level: expanded（父 tasks 组 4 声明）。

Risk packs:
- Public API / CLI / script entry：欢迎态新增按钮文本进入 jsdom 与 ui-walk 定位面。
- Legacy compatibility：hero `<h1>` 归属、composer 身份与既有键盘用例。

Change surface:
- 新增：`web/src/features/chat/welcome-content.ts`、`web/src/features/chat/welcome.tsx`。
- 修改：
  - `web/src/features/chat/conversation-view.tsx`、`web/src/features/chat/chat.css`；
  - `web/src/ui/icon.tsx`（只加映射）；
  - `web/test/chat-page.test.tsx`（若超 size-guard 则新建 `web/test/chat-welcome.test.tsx`）；
  - `web/test/ui-icon-brand.test.tsx`（`ICON_NAMES` 补五项）。
- 不改：`web/src/features/chat/{page.tsx,composer.tsx,stream.ts}`、`web/src/lib/**`、`web/src/routes/**`、`web/e2e/**`、服务端。

Must preserve:
- 欢迎态全页 level-1 heading 恰为 hero `WorkBuddy，我帮你`：
  - `chat-page-lifecycle.test.tsx:165-166`、`chat-page.test.tsx:84`、`app-shell-responsive.test.tsx:184`、`topbar.test.tsx:106`、`main.test.tsx:61`、`chat-page-ownership.test.tsx:84,223` 均保持绿。
  - ui-walk `web/e2e/ui-walk.spec.ts:30` 的 `/` heading 保持绿。
- `≥761px` 欢迎态无 `role=banner`，`≤760px` 顶栏只含 `打开导航`（#283 既有行为不变）。
- composer 结构与行为（`chat-composer.test.tsx` C1–C6）不变：
  - 欢迎态 placeholder 仍为 `今天帮你做些什么`；
  - form 内仍只有一个按钮 `发送`；
  - 无会话发送仍 create 一次再 prompt 一次。
- `Composer` 在欢迎态与会话态之间保持同一元素位置：`chat-main` 的子节点顺序为 alerts → `.chat-transcript` → `Composer` → 欢迎态最佳实践槽（会话态为 `null`）。hero 与 chip 行在 `.chat-transcript` 内。
- 有 `?session=` 时不渲染 hero、chip 行、最佳实践与免责声明。
- ui-guardrails：
  - feature css/tsx 无字面颜色或 palette；
  - 基元只经 `../../ui/index.js`；
  - 注释不含 `#NNN`；
  - 无 `style={`。
- size-guard：各文件 ≤ 800 行。

Must add/change:
- `welcome-content.ts`（头注释：`Static welcome content ported from resource/workbuddy-live-demo.html:1221-1239 (QUICK_PROMPTS, default 日常办公 scene), 2553-2561 (PLAYBOOKS), 2674 (card prompts).`）：
  ```ts
  import type { IconName } from "../../ui/index.js";
  export type WelcomePrompt = { label: string; icon: IconName; prompt: string };
  export type Playbook = { title: string; desc: string; icon: IconName; prompt: string };
  export const WELCOME_QUICK_PROMPTS: readonly WelcomePrompt[] = [
    { label: "文档处理", icon: "file-text", prompt: "把 Q3 经营数据做成 18 页分析 PPT" },
    { label: "内部汇报", icon: "zap", prompt: "汇总本季度部门进展并输出汇报材料" },
    { label: "数据分析及可视化", icon: "file-spreadsheet", prompt: "分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注" },
    { label: "资料归档", icon: "folder", prompt: "整理本地项目文档并建立分类索引" },
    { label: "幻灯片", icon: "file-chart-line", prompt: "帮我做一份项目评审 PPT 大纲" },
    { label: "产品需求", icon: "file-text", prompt: "帮我整理一份产品需求文档" },
  ];
  export const PLAYBOOKS: readonly Playbook[] = [
    { title: "数据分析", desc: "清洗销售数据，生成周报与区域拆解看板", icon: "file-spreadsheet", prompt: "分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注" },
    { title: "内容创作", desc: "把经营数据做成 18 页分析 PPT", icon: "file-chart-line", prompt: "把 Q3 经营数据做成 18 页分析 PPT" },
    { title: "工程研发", desc: "重构模块并补齐回归测试", icon: "code", prompt: "帮我重构一个模块并补齐回归测试" },
    { title: "AI 应用", desc: "设计一个 Agent 应用的交互流程", icon: "sparkles", prompt: "帮我设计一个 Agent 应用的交互流程" },
    { title: "资料归档", desc: "整理本地项目文档并建立分类索引", icon: "search", prompt: "整理本地项目文档并建立分类索引" },
    { title: "视觉设计", desc: "为发布活动设计一张科技感海报", icon: "image", prompt: "帮我设计一张内部活动海报" },
    { title: "内部汇报", desc: "汇总部门进展并输出汇报材料", icon: "zap", prompt: "汇总本季度部门进展并输出汇报材料" },
  ];
  export const PLAYBOOKS_SHOWN = 5;
  export function playbookWindow(start: number): readonly Playbook[] { /* 从 start % 7 起环形取 5 项，同 demo:2563-2564 */ }
  ```
  - 图标映射取 demo `QUICK_ICONS`（demo:1227）与 `PLAYBOOKS.icon`：`fileText`/`doc` → `file-text`，`fileSpreadsheet` → `file-spreadsheet`，`filePresentation` → `file-chart-line`（lucide 无同名图标；demo:979 为文件外框加折线，`file-chart-line` 形状最近，不用画板形的 `presentation`），其余同名。
  - 文本逐字照搬 demo；七项 `prompt` 逐字取 demo:2674 映射。
- `ui/icon.tsx`：从 `lucide-react` 增导入 `Code`、`FileChartLine`、`FileSpreadsheet`、`Sparkles`、`Zap`，`ICONS` 增 `code`、`"file-chart-line"`、`"file-spreadsheet"`、`sparkles`、`zap`。其余不动。
- `welcome.tsx`（头注释：`Welcome state adapted from resource/workbuddy-live-demo.html:2537-2567; scene pills, chip expand toggle and 查看更多 are not rendered (S1c / undelivered /center).`）：
  - 两个组件都收 `disabled: boolean`，由 `conversation-view` 传入既有的 `composerDisabled`，作用到每个 chip、卡片与 `换一批`：composer 锁定期间（发送后到终态），chip 与卡片不得改草稿（否则 create 失败时 `restoreOwnedDraft` 只在草稿为空时恢复，用户原 prompt 被覆盖）。
  - `WelcomeIntro({ disabled, onPick }: { disabled: boolean; onPick(prompt: string): void })`：
    ```tsx
    <div className="chat-welcome-intro">
      <h1 className="chat-hero">WorkBuddy，我帮你</h1>
      <div aria-label="快捷任务" className="chat-quick-row" role="group">
        {WELCOME_QUICK_PROMPTS.map((item) => (
          <button className="chat-quick-chip" key={item.label} onClick={() => onPick(item.prompt)} type="button">
            <Icon name={item.icon} size={14} />{item.label}
          </button>
        ))}
      </div>
    </div>
    ```
  - `WelcomePlaybooks({ disabled, onPick })`：`const [start, setStart] = useState(0)`。结构如下：
    ```tsx
    <div className="chat-welcome-foot">
      <section aria-label="最佳实践案例" className="chat-playbooks">
        <div className="chat-playbooks-head">
          <Icon name="sparkles" size={12} />
          <p>不知道做什么，试试最佳实践案例</p>
          <button className="chat-playbooks-refresh" onClick={() => setStart((s) => s + 1)} type="button">换一批</button>
        </div>
        <ul className="chat-playbooks-row">
          {playbookWindow(start).map((item) => (
            <li key={item.title}>
              <button className="chat-playbook-card" onClick={() => onPick(item.prompt)} type="button">
                <span className="chat-playbook-title"><Icon name={item.icon} size={12} />{item.title}</span>
                <span className="chat-playbook-desc">{item.desc}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <p className="chat-disclaimer">内容由 AI 生成，请核实重要信息</p>
    </div>
    ```
    - 卡片按钮的可访问名由标题与描述两个 span 拼成；jsdom 不加载 CSS，span 视为 inline，拼接时无空格，而真实浏览器中标题为 flex、会插入空格。测试不断言拼接后的名称：以 `region` 内的 `.chat-playbook-card` 列表加 `within(card).getByText(title, { exact: true })` 定位与取标题。
    - `资料归档`、`内部汇报` 同时是 chip 与卡片标题：W1/W2 的查找一律限定在 `group`（快捷任务）或 `region`（最佳实践案例）内。
    - 最佳实践头用 `p`，不用 heading 元素。
- `conversation-view.tsx`：
  - 删除 `<h1 className="chat-hero">`。
  - `.chat-transcript` 内容：会话态为 `historyView ? <MessageThread/> : null`（不变），欢迎态为 `<WelcomeIntro disabled={composerDisabled} onPick={onChangeDraft} />`。
  - `Composer` 之后加 `{requestedSessionId ? null : <WelcomePlaybooks disabled={composerDisabled} onPick={onChangeDraft} />}`。
  - 欢迎态给 `chat-main` 追加类 `chat-main--welcome`。
- `chat.css`（来源注释 `adapted from resource/workbuddy-live-demo.html:341-359 (.hero, .quick-row), 402-414 (.playbooks-*, .ai-disclaimer)`；只用语义 token）：
  - `.chat-main--welcome`：内容纵向居中（`chat-main` 已是 flex 列，`chat.css:150-157`），`overflow-y: auto`（窄屏矮视口下最佳实践区与免责声明可滚到，不被 `overflow: hidden` 裁掉）；居中用自动外边距而非 `justify-content: center`（后者在内容溢出时顶部不可滚到）：欢迎态 `.chat-transcript` 为 `flex: 0 0 auto; overflow: visible; margin-top: auto`，`.chat-welcome-foot` 为 `margin-bottom: auto`。
  - `.chat-welcome-intro`：纵向，居中对齐。
  - `.chat-quick-row`：flex 换行，`gap: 8px`，居中。
  - `.chat-quick-chip`：
    - 形态：高 32px、左右内边距 12px、`border-radius: 100px`。
    - 颜色：`1px solid var(--wb-color-border-secondary)`、`var(--wb-bg-primary)`、`var(--wb-text-secondary)`，14px。
    - hover：`var(--wb-home-composer-chip-bg-hover)`，文字 `var(--wb-text-primary)`。
  - `.chat-playbooks-head`：flex、`gap: 8px`、12.5px、`var(--wb-text-secondary)`；`换一批` 按钮 12px、无边框透明底，hover 为 `var(--wb-bg-hover)`，推到右侧（`margin-left: auto`）。
  - `.chat-playbooks-row`：`list-style: none`、flex、`flex-wrap: wrap`、`gap: 10px`、零 padding；`li` 为 `flex: 1 1 140px; max-width: 220px; min-width: 0`。
  - `.chat-playbook-card`：
    - 形态：宽 100%、左对齐、`padding: 12px 14px`。
    - 边框与底色：`1px solid var(--wb-border-default)`、`border-radius: 12px`、`var(--wb-bg-secondary)`。
    - hover：边框 `var(--wb-text-tertiary)`，阴影 `var(--wb-activity-card-shadow)`。
    - 标题：12.5px/600，单行省略，图标 `var(--wb-brand-primary)`。
    - 描述：11.5px、`var(--wb-text-secondary)`、两行截断（`-webkit-line-clamp: 2`）。
  - `.chat-disclaimer`：居中，11px，`var(--wb-text-secondary)`，`margin: 12px 0 0`。
  - 全局 `:focus-visible { border-radius: 4px }`（`web/src/styles.css:83-87`）排在 `chat.css` 之后且特异度相同，会覆盖圆角：按 `chat.css:396-399` `.chat-send:focus-visible` 先例，补 `.chat-quick-chip:focus-visible { border-radius: 100px }` 与 `.chat-playbook-card:focus-visible { border-radius: 12px }`。
  - `prefers-reduced-motion` 下取消卡片 transition（若加了 transition）。

Sketch seams under test（`chat-page.test.tsx` 新 `describe("welcome state")`，`renderChatPage("/", { "/api/sessions": () => jsonResponse({ sessions: [] }) })`；POST 路由按需加）：
- (W1) 结构：
  - `findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" })`；`queryByRole("banner")` 为 null。
  - `getByRole("group", { name: "快捷任务" })` 内按钮文本依次为六个 chip label，每个含 svg。
  - `getByRole("region", { name: "最佳实践案例" })` 内有文本 `不知道做什么，试试最佳实践案例`、按钮 `换一批`；卡片按钮（`.chat-playbook-card`）恰 5 个，标题依次为 `数据分析、内容创作、工程研发、AI 应用、资料归档`。
  - `getByText("内容由 AI 生成，请核实重要信息", { exact: true })` 命中。
  - `getByRole("textbox", { name: "给助手发消息" })` 在，placeholder 为 `今天帮你做些什么`。
  - 以下均为 null：`queryByRole("button", { name: /查看更多|附件|模型|麦克风/ })`；`queryByText("日常办公")`、`queryByText("代码开发")`、`queryByText("创意设计")`（场景胶囊）。
  - DOM 顺序：hero 在 chip 行之前，chip 行在 textarea 之前，textarea 在最佳实践区之前，最佳实践区在免责声明之前（`compareDocumentPosition`）。
- (W2) 只填不发：
  - 点击标题为 `内容创作` 的卡片后，textarea 值为 `把 Q3 经营数据做成 18 页分析 PPT`。
  - 再点 chip `数据分析及可视化`，textarea 值为 `分析 2026 年 7 月销售数据，生成周报：同比环比、区域拆解、异常标注`。
  - 全程 fetchMock 无 `method: "POST"` 调用；URL 仍为 `/`（无 `?session=`）。
  - 填入后发送按钮可用（非空草稿）。
  - 锁定期间不可改草稿：草稿 `hello` 发送，create 路由返回 deferred（挂起）；此时 chip 与卡片按钮均 `disabled`，对一张卡片 `fireEvent.click` 后 textarea 值仍为 `hello`。随后让 create 以 500 失败，草稿仍为 `hello`，chip 与卡片恢复可用。
- (W3) 轮换：
  - 点 `换一批` 后，卡片标题集合不等于初始集合，且恰为 start=1 的窗口 `内容创作、工程研发、AI 应用、资料归档、视觉设计`。
  - 每个标题 ∈ 七项；卡片数仍为 5。
  - 再点 6 次（共 7 次）回到初始顺序。
- (W4) 数据与会话态：
  - `WELCOME_QUICK_PROMPTS`、`PLAYBOOKS` 与 design 列表逐字相等（表驱动，直接 import）。
  - `playbookWindow(6)` 为 `内部汇报、数据分析、内容创作、工程研发、AI 应用`，`playbookWindow(7)` 深等于 `playbookWindow(0)`，`playbookWindow(8)` 深等于 start=1 的窗口 `内容创作、工程研发、AI 应用、资料归档、视觉设计`（钉住取模：缺 `% 7` 时 start ≥ 7 恒退化为初始窗口）。
  - 有 `?session=<id>` 的已完成会话页中，`queryByRole("group", { name: "快捷任务" })`、`queryByRole("region", { name: "最佳实践案例" })` 与免责声明均为 null。
- (W5) composer 身份：
  - 欢迎态取 `textbox` 元素引用，输入 `hello` 并提交。沿用既有 create+prompt 路由：create 返回 `SESSION_ID`，messages 返回快照，prompt 返回 deferred。
  - URL 变为 `?session=` 后，`getByRole("textbox", { name: "给助手发消息" })` 与之前是同一元素（`toBe`）。
- `ui-icon-brand.test.tsx`：`ICON_NAMES` 追加 `code`、`file-chart-line`、`file-spreadsheet`、`sparkles`、`zap`。

Required evidence：
- W1–W5 在现实现上先红，记录原因（W5 若因 composer 已在固定位置而现即绿，如实记录，并以反向注入 6 证明其有效）。实现后转绿。
- 反向注入（九项），各自变红后回退（记录失败的测试名）：
  1. 卡片点击改为调用提交 → W2 红（出现 POST）。
  2. `换一批` 不轮换 → W3 红。
  3. `playbookWindow` 去掉取模 → W4 `playbookWindow(8)` 行红。
  9. chip 与卡片不接 `disabled` → W2 锁定期间行红。
  4. chip prompt 改用 label → W2 红。
  5. 渲染 `查看更多` → W1 红。
  6. 把 `Composer` 移入欢迎组件（欢迎态与会话态父节点不同）→ W5 红。
  7. 会话态仍渲染最佳实践 → W4 红。
  8. 最佳实践头改为 `h1` → W1 或既有 heading 断言红。
- `make check`、`npm run build --workspace web`、`(cd web && npx vitest run)`、CI 形态 ui-walk 全部 exit 0。

Not yet specified:
- chip 选中态与 `›` 展开、`换一批` toast、点击后聚焦输入框：留待 S1c 场景切换一并决定。
- 欢迎态纵向排布与 demo 贴底定位的视觉差异：由 6.3a 截图对比签收。

Implementation deviations（Phase 1 记录）：
- `web/test/topbar.test.tsx:269`（T8 静态契约）断言 hero 字面量在 `conversation-view.tsx`。hero 移入 `welcome.tsx` 后，路径随之改为 `welcome.tsx`，"hero 由 chat feature 渲染"的原意不变。Must preserve 原先漏列此处。
- 快捷任务行用 `<fieldset aria-label="快捷任务">`（隐式 role group），不用 `<div role="group">`：biome `lint/a11y/useSemanticElements` 拒绝后者。CSS 重置 fieldset 的 margin、padding、border 与 min-width。`disabled` 仍逐个挂在按钮上。
- W2 锁定期间行：提交时 `page.tsx:635-636` 先清空草稿，锁定期间 textarea 值为 `""`，不是 `hello`。测试断言三点：
  - 锁定期间点卡片后仍为 `""`；
  - create 500 后由 `restoreOwnedDraft` 恢复为 `hello`；
  - 卡片未禁用时会写入卡片 prompt，从而跳过恢复（注入 9 的判别点）。
- 注入 1 用延迟 `requestSubmit`：同一次点击里同步提交会读到旧的空草稿并提前返回。W2 每次点击后先 settle，再断言无 POST。

