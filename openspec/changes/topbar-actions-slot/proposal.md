# Proposal: topbar-actions-slot（#529）

## Why
父 change `s1c-session-metadata-presentation` tasks 7.0（epic #509，design D8）。顶栏归 shell，会话页的 `重命名`、`对话内搜索`、`产物面板` 三个顶栏按钮（7.2a/7.6/7.7）只能经上报通道注入；它们用到的图标也还不在共享注册表里。本刀先落通道与图标：`useTopbar` 接受 `actions` 描述符数组、shell 在 heading 之后渲染图标按钮、`Icon` 注册表补十个名——只加通道不注入，三态 DOM 不变，可单独合入并解锁组 7 的全部 web 刀。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: shell 顶栏公共通道（所有路由共享）；`useTopbar` 的公共签名（既有只传 `breadcrumb` 的调用方不改）；共享 `Icon` 注册表与 `IconName` 联合；后续 7.2a/7.6/7.7 依赖的描述符契约。
Selected risk packs: Public API / CLI / script entry（`useTopbar`/`TopbarAction`/`.topbar-actions` 的契约）；Concurrency / shared state / ordering（layout effect 上报不成环、ref 读最新闭包、清空时机、数组顺序）；Legacy compatibility / examples（无 actions 时三态 DOM 与既有 shell 测试零 diff）；Release / packaging / dependency compatibility（十个 lucide 名在已装版本存在、不重复登记）
Evidence floor: 新建 `web/test/topbar-actions.test.tsx` 覆盖 design「Required evidence」；既有 shell 测试零 diff 全绿；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。真实浏览器 + 视口矩阵收口由组 8 ui-walk 承担（本刀无页面注入，无可走查的按钮）。

## What Changes
- `web/src/ui/icon.tsx`：注册 `star`、`pencil`、`trash`、`more-horizontal`、`package`、`download`、`globe`、`palette`、`chevron-up`、`filter`。
- `web/src/lib/topbar.tsx`：`TopbarAction` 类型；`useTopbar({breadcrumb?, actions?})`；Provider 持有 actions（浅比较、`onSelect` 经 ref）；shell 读取用的 hook。
- `web/src/routes/shell/topbar.tsx`：第二、三态在 heading 之后渲染 `.topbar-actions`。
- `web/src/routes/shell/topbar.css`：`.topbar-actions` 一条规则（靠右、不收缩）。
- 新建 `web/test/topbar-actions.test.tsx`。

## Capabilities
- MODIFIED `spa-shell`「路由 IA 与侧栏」：main 原文 + 「顶栏 actions 插槽」段 + Scenario「顶栏 actions 插槽」。父 delta 该 Requirement 的其余改动（侧栏三分区措辞、删去「无重命名/搜索/更多按钮直到对应阶段」、`useTopbar({ breadcrumb, actions })` 由会话页上报）属 7.1/7.2a 等后续刀，不并入；插槽段末句如实写「当前没有任何页面向插槽注入按钮」。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **多改一个文件 `web/src/routes/shell/topbar.css`**：issue 的 PR Boundary 只列三个源文件，但 `.topbar-actions` 没有布局规则时按钮会紧贴标题而不是靠右（demo `.tb-right{margin-left:auto;display:flex;gap:6px;flex-shrink:0}`，`resource/workbuddy-live-demo.html:321`）。只加这一条规则。
2. 父「路由 IA 与侧栏」届时在 main 基础上只需再补：侧栏三分区措辞（7.1）、会话页上报 `actions` 与删去「无重命名/搜索/更多按钮」句（7.2a 起），以及把插槽段末句换回「会话页注入的 `重命名`、`对话内搜索`、`产物面板` 分别归 …」。子 delta 的插槽段另比父文多三处措辞，父文应同步采纳：「shell 只在各项 `key`/`label`/`icon`/`expanded` 有变化时更新，`onSelect` 取上报方最近一次渲染提供的回调」「`.topbar-actions` 容器（靠右）」「（或数组为空）…不渲染该容器」。
3. 父 Scenario 的「随后移除 `?session=`」在用测试页面（不是真会话页）的 jsdom 证据里表述为「不再上报标题（第一态）」；另补一组 WHEN/THEN 覆盖不成环、最新闭包、顺序与卸载清空（D8 的性质，父场景未写）。
4. turn-artifacts「产物卡」末句（`globe`、`download`、`package` 进入共享注册表）所在 Requirement 尚不在 main，本刀不动该 spec；图标先行注册。
5. `more-horizontal`、`filter` 两个键注册到 lucide 的规范导出 `Ellipsis`、`Funnel`（`MoreHorizontal`/`Filter` 是其别名）。

## Impact
- web：三个源文件 + 一条 CSS 规则 + 一个新测试文件。server 无改动。`web/src/features/chat/**` 零 diff。
- 依赖：A #477 已合并。

## Non-goals
- 会话页注入任何按钮、`CHAT_TOPBAR_ACTIONS`（7.2a/7.6/7.7）；十个图标的消费方；侧栏槽位；ui-walk 证据（组 8）；多个上报方并存时的合并语义（沿用面包屑的「后上报者生效」）。
