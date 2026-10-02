# Proposal: session-menu-delete（#532）

## Why
父 change `s1c-session-metadata-presentation` tasks 7.2b（epic #509，design D3「客户端行为」）。服务端 `DELETE /api/sessions/:id`（4.3b、4.3c：任何状态可删，running 时内含停止）与客户端 `deleteSession`（5.1）已就位但没有调用方；7.2a 的条目菜单只有 `重命名` 与 `置顶任务`|`取消置顶`。本刀给菜单加第三项 `删除`、加确认框，并在删除的是当前会话时让页面关闭事件流、以 replace 回到欢迎态——菜单项、确认框与当前会话的收尾是同一个删除交互闭环。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: 所有视口的条目菜单（两项 → 三项）；`listState` 的条目移除路径；当前会话的事件流连接与 URL（破坏性操作后的页面收尾）；`page.tsx` 行数预算（672 → ≤682）；`useSessionActions` 的签名（唯一调用方是 `page.tsx`）。
Selected risk packs: Concurrency / shared state / ordering（请求在途时切换会话、关闭并重开确认框、账号切换与卸载、响应到达时才判定「当前会话」）；Error handling / rollback / partial outputs（失败关闭确认框 + Toast + 重读列表；200 非 204 按失败；401）；Schema / columns / units / field names（恰一次无 body 的 `DELETE`）；Legacy compatibility / examples（7.2a 的重命名/置顶与条目钩子不变；三处钉「恰两项」的既有断言随规格更新）
Evidence floor: 新建 `web/test/chat-page-session-delete.test.tsx` 覆盖 design「Required evidence」R1–R13；既有测试除三处「恰两项」断言外零 diff 全绿；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；CI `ui-walk` 两个 project 全绿（既有走查，回归门）。真实浏览器 + 视口矩阵验收由 8.2b 承担；本刀另附一次 390×844 与 1440×900 的一次性真实浏览器观察（不入库）。

## What Changes
- `web/src/features/chat/session-menu.tsx`：菜单加第三项 `删除`（`Icon trash`，danger）。
- `web/src/features/chat/session-actions.ts`：`useSessionActions` 加删除状态、在途标记与 handler；签名多一个 `page` 参数（`closeSource`、`refreshList`、`requestedSessionRef`）。
- 新建 `web/src/features/chat/delete-dialog.tsx`：`删除任务` 确认框（`ConfirmDialog` 的薄封装）。
- `web/src/features/chat/session-sidebar.tsx`：新 prop `onDeleteSession`，传给 `SessionMenu`。
- `web/src/features/chat/page.tsx`：hook 调用移到 `refreshList` 之后并传入 `page` 参数、侧栏回调、`<DeleteDialog>`（672 → ≤682）。评审后补充：`page` 参数另含 `abortHistory`（design D2）。
- 新建 `web/test/chat-page-session-delete.test.tsx`（超过 800 行时另拆 support 模块）；`web/test/chat-page-session-rename-pin.test.tsx:138-148`、`web/test/chat-page-session-pin.test.tsx:97`、`:119-122` 的菜单项断言改为三项。

## Capabilities
- MODIFIED `session-sidebar`「会话条目菜单与重命名」：菜单三项、`删除` 段、响应丢弃规则覆盖删除；新增 Scenario「删除当前会话」「删除请求中」。

## Non-goals
- `重命名`/`置顶`、`CHAT_TOPBAR_ACTIONS` 与顶栏（7.2a 已落）；`deleteSession` 客户端方法（5.1）；`DELETE` 路由（4.3b、4.3c）。
- 其它标签页的 EventSource 在服务端 `end` 后重连得 404 的既有 `fail(CONNECTION_FAILURE)` 路径（父 design D3：不为此新增 UI）。
- ui-walk 删除步骤（8.2b）；`stream.ts`、`api-sessions.ts`、`web/src/ui/**`、server 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **新建 `delete-dialog.tsx`，`session-sidebar.tsx` 有改动**：issue 的 PR Boundary 只列 `session-menu.tsx`、`session-actions.ts`、`page.tsx` 与新测试文件。确认框必须挂在页面主树（侧栏槽位节点随折叠与 `≤760px` 覆盖层关闭而卸载，同 7.2a 的 `RenameDialog`）；「无打开的删除则不渲染」的判断放进 `ChatPage` 会让它的认知复杂度超过 Biome 上限（7.2a 已遇到），故落独立组件。`session-sidebar.tsx` 只是把回调透传给 `SessionMenu`。
2. **三处既有断言改动**：issue 写「既有测试零 diff」。`chat-page-session-rename-pin.test.tsx:138-148`（M1，连同 `:99` 的用例标题）与 `chat-page-session-pin.test.tsx:97`、`:119-122` 钉的是 7.2a 的「菜单恰两项、无 `删除`」，正是本刀改写的那句规格；改为三项，其余断言不动，两个文件不增行。
3. **请求中可关闭、请求不取消、重开仍忙碌**：父文只写「请求中确认按钮忙碌禁用」。`ConfirmDialog` 的 `取消` 与 Escape 在 pending 时可用（`web/src/ui/confirm-dialog.tsx:50`），`lib/api.ts` 没有请求超时，running 会话的删除最长约 16 s（父 design D3）。子 delta 照 spa-shell 退出确认的先例（`web/src/features/auth/footer.tsx:88-105`）：请求中取消按钮文案为 `关闭`、框内显示 `删除请求已发送，关闭窗口不会撤销请求。`、再次对同一会话打开仍忙碌（不发第二个 DELETE）。父文应同步采纳。
4. **「当前选中会话」在响应到达时判定**：父文没说以哪一刻为准。删除请求在途时用户可以切换会话；按发出时判定会把用户从刚切过去的会话踢回欢迎态，或让被删会话的页面留在原地。子 delta 写明以响应到达时为准，并加 Scenario「删除请求中」。
5. **删除成功同时关闭为该会话打开的重命名 Dialog**：父文未写。请求中关闭确认框后可以对同一会话打开重命名；会话删掉后这个 Dialog 没有对象。
6. **失败文案补全**：父文只举 409。子 delta 写明非信封失败为 `请求失败，请稍后重试`（同重命名/置顶）；响应 200（非 204）由 `deleteSession` 判为无效响应，走同一失败路径。
7. **响应丢弃规则覆盖删除**：账号切换或离开会话页之后到达的删除响应不移除条目、不提示、不导航、不重读列表（7.2a 规则的延伸）。
8. 子 delta 另加父文未写的可观察行为：`取消`/Escape 后焦点回到打开它的「更多」按钮；`DELETE` 无 body；删除当前会话后不再读取该会话的消息。

## Impact
- web：一个新产品文件、`session-menu.tsx`/`session-actions.ts`/`session-sidebar.tsx`/`page.tsx` 改动、一个新测试文件、两个既有测试文件的三处断言。server、shell、`web/src/ui/**`、`web/src/lib/**`、`web/e2e/**`、`chat.css` 无改动。
- 运行时：一次删除发一个 `DELETE /api/sessions/:id`；失败时多一次列表读取（及其附带的 `/api/workspaces` 读取）。
- 依赖：#531（7.2a）、#526（4.3c）、#525（4.3b）、5.1 已合并。
