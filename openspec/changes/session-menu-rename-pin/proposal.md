# Proposal: session-menu-rename-pin（#531）

## Why
父 change `s1c-session-metadata-presentation` tasks 7.2a（epic #509，design D7、D8）。服务端 `PATCH /api/sessions/:id`（4.2）与客户端 `patchSession`（5.1）已就位但没有调用方；7.1 的三分区侧栏里 `置顶任务` 分区没有入口；7.0 的顶栏 `actions` 通道没有注入方。本刀给每个侧栏条目加「更多」菜单（`重命名`、`置顶任务`|`取消置顶`），加重命名 Dialog，并在顶栏填入 `重命名` 槽——菜单两项、Dialog、handler 与顶栏入口共用同一份 handler 与同一个 PATCH 客户端，`CHAT_TOPBAR_ACTIONS` 须随首个顶栏按钮同刀创建。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: 所有视口的侧栏条目行（新增同级按钮）；会话页顶栏第二态（首次注入 `actions`）；`listState`/快照会话的元数据写入路径；`CHAT_TOPBAR_ACTIONS` 是 7.6/7.7 的共同前提；`page.tsx` 行数预算（666 → ≤676）。
Selected risk packs: Public API / CLI / script entry（`CHAT_TOPBAR_ACTIONS` 槽位次序与 builder 形状）；Concurrency / shared state / ordering（PATCH 在途时的列表刷新、乱序响应、账号切换与卸载、槽位节点卸载）；Error handling / rollback / partial outputs（失败保留 Dialog、置顶失败列表不变）；Schema / columns / units / field names（请求体恰为 `{title}`/`{pinned}`、只合并该请求修改的键）；Legacy compatibility / examples（既有条目钩子与既有测试零 diff）
Evidence floor: 新建 `web/test/chat-page-session-rename-pin.test.tsx`、`chat-page-session-pin.test.tsx`（及共用 support 模块）覆盖 design「Required evidence」；既有测试断言零 diff 全绿（两个夹具补 `ToastProvider`，偏差 6）；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；CI `ui-walk` 两个 project 全绿（既有走查，回归门）。真实浏览器 + 视口矩阵验收由 8.2b 承担；本刀另附一次 390×844 与 1440×900 的一次性真实浏览器观察（不入库）。

## What Changes
- 新建 `web/src/features/chat/session-menu.tsx`：行尾 `更多操作：<显示标题>` 按钮 + `Menu` 两项。
- 新建 `web/src/features/chat/rename-dialog.tsx`：`重命名任务` Dialog。
- 新建 `web/src/features/chat/session-actions.ts`：`useSessionActions`（重命名状态、rename/pin 请求、fence、响应合并、Toast）。
- 新建 `web/src/features/chat/topbar-actions.ts`：`CHAT_TOPBAR_ACTIONS` 与按序 builder。
- `session-sidebar.tsx`：条目行尾接入 `SessionMenu`。
- `session-path.ts`：加 `selectedSession()`，`selectedSessionTitle` 改为其薄封装（签名不变）。
- `page.tsx`：hook、`useTopbar` 的 `actions`、侧栏两个回调、`<RenameDialog>`（666 → ≤676）。
- `chat.css`：条目行布局与「更多」按钮、Dialog 表单样式。
- 新建 `web/test/chat-page-session-rename-pin.test.tsx`、`web/test/chat-page-session-pin.test.tsx`、`web/test/chat-page-session-meta-support.tsx`；`web/test/routes.test.tsx`、`web/test/settings-support.tsx` 的挂载补 `ToastProvider`。

## Capabilities
- ADDED `session-sidebar`「会话条目菜单与重命名」（菜单两项、重命名、置顶、顶栏重命名入口）。
- MODIFIED `session-sidebar`「分区侧栏」：条目行尾「更多」按钮一句 + Scenario「置顶与取消置顶后的移动」。
- MODIFIED `spa-shell`「路由 IA 与侧栏」：会话页上报 `actions`、删去「无重命名/搜索/更多按钮直到对应阶段」、插槽段末句。
- MODIFIED `chat-web`「会话页」：`useTopbar` 上报 `actions`（由 `CHAT_TOPBAR_ACTIONS` 构造，当前只有 `重命名`）、List 句加 `entry menus`、欢迎态场景加「无顶栏 `actions` 按钮」。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **`chat.css` 与 `session-path.ts` 有改动**：issue 的 PR Boundary 只列四个新文件、`session-sidebar.tsx` 与 `page.tsx`。行内并排两个按钮需要布局规则；顶栏入口需要当前会话对象而不只是标题（`selectedSession()`），放进 `page.tsx` 会超预算。
2. **「更多」按钮始终可聚焦**：demo:296-297 用 `display:none` + 悬停显现，触屏与键盘不可达；本刀在 DOM 中始终存在，仅在支持悬停的宽屏上以透明度弱化。已写进子 delta。
3. **请求中可关闭、请求不取消**：父文只写「请求中 Dialog 忙碌、`保存` 禁用」，没说能否关闭。既有先例是可关闭（spa-shell 退出确认「提交中允许关闭窗口以避免网络停滞锁死应用」、`features/files/dialogs.tsx` 的 `取消` 在 pending 时可用），`lib/api.ts` 没有请求超时。子 delta 写明：请求中仍可关闭；请求不取消，迟到的 200 照常合并并提示，失败改用 Toast；重开是全新状态。这与两个先例都不完全相同（退出确认重开后仍忙碌锁定；files 的 `取消` 是停止等待、结果丢弃），取的是「可关闭」这一点，结果处理是本刀自己的规则。父文应同步采纳。
4. **「以响应视图更新」写明为只合并该请求修改的键**：整体替换条目会让迟到的 PATCH 响应把已刷新的 `status` 改回旧值（PATCH 在 `running` 时可用，回合结束会 `refreshList`），也会让先发后到的重命名响应把刚成功的置顶改回去。子 delta 加一段规则与 Scenario「迟到的元数据响应」；并写明同一会话的同类多请求只采用最后发出者、账号切换/离开页面后丢弃。父文应同步采纳。
5. **裁掉 7.2b 及之后的部分**：`删除` 菜单项、ConfirmDialog 段、Scenario「删除当前会话」不并入（「三项对任何状态可用」写成两项）；顶栏段的「DOM 顺序为 `重命名`、`对话内搜索`、`产物面板`」写成「次序由 `CHAT_TOPBAR_ACTIONS` 固定，当前只有 `重命名` 产出按钮」；Scenario「顶栏重命名入口」的 THEN 只断言 `重命名` 存在、无 `更多`（三按钮全序归 7.7）。chat-web 的 `exactly three icon buttons` 同样改写；其 Scenario「顶栏入口」「助手块次序」「斜杠命令候选」、场景胶囊与 footer 句均不并入。
6. **两个既有测试夹具补 `ToastProvider`**：issue 写「既有测试零 diff」。`useSessionActions` 是页面级 hook，`ChatPage` 一挂载就调用 `useToast()`；`web/test/routes.test.tsx`（三处）与 `web/test/settings-support.tsx` 裸挂 `RouterProvider`、没有 Provider（此前只有叶子组件用 Toast，欢迎态不挂载，一直没暴露）。夹具改成与 `main.tsx` 相同的根结构；断言不变。不为迁就夹具把 `useToast()` 下沉到叶子或让它容忍缺 Provider。
7. 子 delta 另加父文未写的可观察行为：打开时焦点在输入框、成功后焦点回到打开它的按钮、再次提交清除失败提示、置顶失败的非信封文案、「更多」按钮与菜单项不关闭导航覆盖层、欢迎态不上报 `actions`；新增 Scenario「重命名请求中」「迟到的元数据响应」。
8. spa-shell 插槽段保留 #529 留下的三处 main 独有措辞（#714 的 rebase 备注）；末句改为「`重命名` 归 session-sidebar（另两个槽位由后续能力规定，当前不产出按钮）」，7.6/7.7 落地后换回父文原句。

## Impact
- web：四个新产品文件、`session-sidebar.tsx`/`session-path.ts`/`page.tsx`/`chat.css` 改动、一个新测试文件。server、shell（`web/src/lib/topbar.tsx`、`web/src/routes/**`）、`web/src/ui/**`、`web/e2e/**` 无改动。
- 运行时：无新增常驻请求；用户操作各发一个 `PATCH /api/sessions/:id`。
- 依赖：#530（7.1）、#529（7.0）、#524（4.2）、A #489 已合并。

## Non-goals
- `删除` 与 ConfirmDialog（7.2b）；`对话内搜索`（7.7）、`产物面板`（7.6）槽位；顶栏三按钮全序断言（7.7）；`导出记录`、顶栏 `更多`（不做）；ui-walk 置顶/重命名步骤（8.2b）；置顶后把焦点移到迁移后的条目；`Popover` 层级（#715，本刀不用 Popover）。
