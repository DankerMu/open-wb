# Proposal: app-shell-responsive（#283）

## Why
S1e 组 2 第三刀（2.3）。现状外壳只有一个 `≤760px` 的过渡形态：侧栏变成横向导航条（`web/src/routes/shell/sidebar.css:229-299`，注释自称"Drawer 之前的过渡形态"），`styles.css:430-455` 把 `.app-shell` 竖向堆叠，欢迎态在任何宽度都没有顶栏（`topbar.tsx:17`）。demo `≤760` 把侧栏做成覆盖层（demo:307-310 `.sidebar{position:absolute;…}`，`.collapsed{margin-left:-288px}`），审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md:55` 归为**实现偏差 + 计划遗漏**。父 change design 决策 5 与 spa-shell 响应式段规定：`≤760px` 侧栏改为 `Drawer side="left" width=288` 覆盖层（默认关闭、选路由即关闭、隐藏态不可聚焦、开合不写 storage），顶栏左侧 `打开导航`（含欢迎态只含该按钮的窄条）；`≥761px` 不挂载 Drawer。2.2（#282）已把 `打开导航` 明确留给本刀（"按钮无接线即占位，违反不得先摆上"）。

## What Changes
- 新增 `web/src/lib/viewport.ts`：`SHELL_NARROW_QUERY = "(max-width: 760px)"` 与 `useMediaQuery(query)`（`useSyncExternalStore` 订阅 `window.matchMedia(query)` 的 `change`；**`matchMedia` 缺失或抛错一律按不匹配（宽屏）**——jsdom 没有 `matchMedia`，这一条让全部既有 jsdom 测试不动即绿）。放 `lib/`：与 `lib/topbar.tsx`/`lib/theme.ts` 同层，`routes/shell` 消费，不进 `ui/`（基元层不放外壳断点逻辑）。
- `web/src/routes/shell/app-shell.tsx`：`AppShell` 持有 `navOpen` 瞬时状态；`narrow = useMediaQuery(SHELL_NARROW_QUERY)`。`narrow` 时**不渲染**文档流侧栏，改渲染 `<Drawer open={navOpen} onOpenChange={setNavOpen} side="left" width={288} title="导航">` 内的 `Sidebar` 覆盖层变体；`Topbar` 收到 `onOpenNav`。`narrow` 变为 false 时 Drawer 整体不再渲染且 `navOpen` 复位（切回宽屏再切窄屏不得"复活"覆盖层）。
- `web/src/routes/shell/sidebar.tsx`：`Sidebar` 增覆盖层变体（`variant: "overlay"` + `onNavigate`）：始终展开态（标签/副标签可见）、**不渲染**品牌区与折叠按钮（Drawer 头部已有标题 `导航` 与 `关闭`）、每个 NavLink `onClick` 调 `onNavigate`（选路由即关闭）、`data-variant="overlay"`；文档流变体（`collapsed`/`onToggle`）行为不变。`useSidebarCollapsed` 仍只由文档流变体驱动写入，覆盖层任何开合都不触发 `writeCollapsed`。
- `web/src/features/auth/{provider.tsx,footer.tsx}`：退出 pending 从 `AuthFooter` 本地 state 上提为 `AuthContextValue.logoutPending`（footer 只读）。原因：Drawer 关闭即卸载内容，窄屏下“确认退出 → 关闭确认框 → 关闭覆盖层 → 重开”会得到全新 footer 实例，丢失状态 note 与“重复退出被锁定”的忙碌禁用态，违反 spa-shell 既有 SHALL。issue 的 PR 边界未列 `features/auth`，这是覆盖层承载用户区的必然后果而非新功能；桌面可观测行为不变（`settings-footer.test.tsx` 零改动）。
- `web/src/routes/shell/topbar.tsx`：`Topbar({ onOpenNav? })`。有 `onOpenNav`（即 `≤760`）时三态都在 `<header className="topbar">` 最左渲染 `Button size="icon" variant="ghost" aria-label="打开导航"`（`Icon name="menu"`）；欢迎态渲染**只含该按钮**的窄条（无 heading，hero 仍是唯一 h1）；无 `onOpenNav` 时行为与 2.2 完全一致（欢迎态 `null`）。按钮在三态中位于同一树位置（header 首子节点），路由切换不重挂——Drawer 关闭后焦点归还的正是它。
- CSS：删除 `sidebar.css:229-299` 整个 `≤760` 横条块；新增 `.sidebar[data-variant="overlay"]`（填满 `ui-drawer-body`：`width:100%;min-height:100%;overflow:visible;background:transparent;border-right:0;transition:none`，`nav{padding:0}`）；`styles.css` `≤760` 块删去已无对象的 `.app-shell{flex-direction:column}`（页面级滚动模型 `body{overflow:auto}`/`min-height:100dvh` 与 `.theme-options`/内边距规则保留——chat/files 的 `≤760` 块按此模型写成，归 4.x/5.x）；`topbar.css` 按需加 `.topbar-nav` 对齐规则。不改 `web/src/ui/**`（`Drawer` 属性面由 ui-primitives spec 枚举，扩它需二次 delta，本刀不做）。
- 测试：新 `web/test/app-shell-responsive.test.tsx`（R1–R10，matchMedia mock 按 query 分派）；新 `web/test/media-query-support.ts`（从 `theme-provider.test.tsx` 抽出 `createMediaQuery`/安装函数，theme 测试改为 import，行为不变——避免 jscpd）；`web/test/sidebar.test.tsx` 删去依赖被删 CSS 块的两处断言与 `narrowCss` helper。**不改 e2e**：`playwright.config.ts` 单 project 1280 仍为桌面态，`ui-walk` 保持绿；`mobile-dark` project 与 `openNav()` 归 6.1（#295），本刀固定其定位器：按钮 `打开导航`、对话框 `导航`。

## Non-goals
1100 档与 `≤900` files 树栏 210（5.3）；Playwright 双 project / `openNav()`（6.1 #295）；#318 折叠态浮出 note 常驻（桌面态问题，本刀删除的 `≤760` note 复位规则与其无交互）；chat/files 各自 `≤760` 内部布局；覆盖层状态持久化、手势滑动、顶栏 `≤760` 吸顶；Drawer API 扩展（去内边距/隐藏标题）；覆盖层内品牌区。

## Capabilities
- MODIFIED `spa-shell`：Requirement「路由 IA 与侧栏」加响应式段（外壳断点 `760` 唯一、覆盖层契约、`打开导航` 三态、`≥761` 不挂载）；Scenario「视觉与键盘可用性」/「顶栏三态」措辞收口（去掉"随响应式切片落地"的前瞻句）；新增 Scenario「窄屏导航覆盖层」与「覆盖层不触碰折叠偏好」（jsdom matchMedia）。

## Impact
`web/src/lib/viewport.ts`（新）、`web/src/routes/shell/{app-shell,sidebar,topbar}.tsx`、`web/src/routes/shell/{sidebar,topbar}.css`、`web/src/styles.css`、`web/src/features/auth/{provider.tsx,footer.tsx}`（pending 上提）；`web/test/{app-shell-responsive.test.tsx,media-query-support.ts}`（新）、`web/test/{sidebar,theme-provider}.test.tsx`。不加依赖；`Drawer` 首个真实消费者。

## 与 oracle 偏差留痕
- 父 spa-shell delta 响应式段同一句里含 `≤900px` files 树栏 `210px`；issue #283 与父 tasks 2.3 明确把 900 档划给 5.3（files feature css）。本 delta 只落 760 档，900 档留在父 delta 由 5.3 晋升。
- demo `≤760` 覆盖层**默认可见**（`.sidebar.collapsed` 才是隐藏态）；父 design 决策 5 拍板默认关闭 + `打开导航`，本刀照此实施，不照搬 demo 默认态。demo 无 `打开导航` 等价控件（`toggle-sidebar` 是桌面折叠钮），该按钮是本仓自有补充。

## Risk triage
- 覆盖层写回 `workbuddy-sidebar` 或读到 `collapsed` 后以折叠态渲染 → 破坏"瞬时、不持久化"契约（R3/R8 钉住，含预置 `collapsed` 的反向用例）。
- 视口切换：宽屏时覆盖层仍打开 / 切回窄屏复活 / 应用根容器的 `aria-hidden` 未复位 → 整个应用不可交互（R7 钉住）。
- 覆盖层关闭即卸载 `AuthFooter`：退出 pending 若仍是本地 state，重开后锁定态丢失（R9b 钉住；pending 上提到 Provider）。
- `AuthFooter` 首次运行在模态 Dialog 内：`Menu`（非模态 DropdownMenu）与 `ConfirmDialog` 的 portal/DismissableLayer 叠层可能把 Drawer 一起关掉（R9 钉住）。
- `matchMedia` 缺失未兜底 → 全部 jsdom 测试炸（R2b 与既有套件钉住）。
