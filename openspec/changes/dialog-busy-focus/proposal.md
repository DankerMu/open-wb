# Proposal: dialog-busy-focus（#315）

## Why
#315 是 #280 / PR #314 交叉评审发现的 a11y 回退：

- `ConfirmDialog` 的 `pending` 直接复用 `Button loading`，也就是原生 `disabled`（`web/src/ui/confirm-dialog.tsx:49` → `web/src/ui/button.tsx:33`）。
- 键盘用户在确认按钮上按 Enter 后按钮被禁用，浏览器 focus fixup 把焦点移到 `body`。Radix FocusScope 的三个处理器都救不回来：`handleFocusIn` 要回拉的目标正是这个已禁用按钮；`handleFocusOut` 在 `relatedTarget` 为 null 时直接返回；`handleMutations` 只处理节点被移除的情况。
- 焦点落到 body 后，Tab 会进入被 `aria-hidden` 的背景应用，按 Enter 能在仍打开的模态框背后切换路由。
- 迁移前的原生 `<dialog>.showModal()` 会让背景 inert，所以这是一次行为回退。
- 兄弟路径：#302 把 files 表单对话框迁到 `Dialog` 后，`disabled={pending}` 的提交按钮会遇到同样问题。

issue 标注 needs-triage，要求在 (a') 与 (b) 之间选一个。本 fixture 选 (a')：在共用骨架 `DialogFrame` 做"忙碌期焦点救回"。理由：

- 不改 `Button` 的 `loading`=原生禁用语义，ui-primitives spec「禁用」措辞不动；
- 不需要为 `type="submit"` 单独拦截；
- `Button` 现有断言（`toBeDisabled` 等）无需修改；
- 放在 `DialogFrame`，`Dialog` 与 `ConfirmDialog` 两条路径一次覆盖，#302 只需把 `pending` 传给 `Dialog` 的 `busy`。

## What Changes
- **`web/src/ui/dialog.tsx`**：
  - `DialogFrame` 新增可选 `busy`，并给 Radix `Content` 挂 ref；
  - 用 `useLayoutEffect` 监听 `busy` 由 false 变 true：若活动元素是内容内已禁用的控件，或为 `document.body`/空，就聚焦内容内首个未禁用的可聚焦控件；
  - 公开 `Dialog` 透传 `busy`。
- **`web/src/ui/confirm-dialog.tsx`**：把 `pending` 作为 `busy` 传给 `DialogFrame`。
- **`web/e2e/ui-walk.spec.ts`**：改写退出段，在真实浏览器里验证。
  - 先用 `page.route` 挂起 `POST /api/auth/logout`，再键盘 Tab 到 `退出` 并按 Enter；
  - 断言焦点在 `关闭`，Tab/Shift+Tab/Tab 后焦点仍在 `alertdialog` 内，URL 不变；
  - 放行请求后沿用原有断言。
- **新 `web/test/ui-dialog-busy.test.tsx`**：jsdom 用例 B1–B5。

## Non-goals
- 方案 (b)（`aria-disabled`）。
- auth footer 消费逻辑：`footer.tsx` 只透传，不改。
- #302 的 files 表单迁移：由 archive PR 把约束写进父 tasks 1.6b（#302 的执行任务）：`Dialog` 传 `busy={pending}`，并加一条真实浏览器断言，证明 files 表单提交按钮被禁用后焦点仍在模态内（与 #315 验收第 1 条同类）。
- Radix 上游修复与其他 a11y 问题。

## Capabilities
- MODIFIED `ui-primitives`：Requirement「基元组件库」新增忙碌期焦点句，并新增 Scenario「忙碌期焦点留在模态内」。
- MODIFIED `verification-harness`：Requirement「UI 走查（Playwright）」中 Scenario「登录、四路由、主题持久与退出全绿」的退出行改为键盘确认 + 挂起期焦点断言。

## Impact
- 修改：`web/src/ui/{dialog.tsx,confirm-dialog.tsx}`、`web/e2e/ui-walk.spec.ts`。
- 新增：`web/test/ui-dialog-busy.test.tsx`（`ui-dialog.test.tsx` 已 699 行）。
- 可能新增：`web/e2e/` 下的 helper 文件。仅在 `ui-walk.spec.ts` 超过 800 行时拆出，先例是 `ui-walk-gate.ts`。
- 不改：`web/src/features/**`、`button.tsx`、`web/src/ui/index.ts`（`Dialog` 已导出）、服务端、`web/playwright.config.ts`。

## Risk triage
Issue type: bugfix（a11y 回退）
Fixture level: expanded
Upstream suggested level: 未声明（follow-up issue）；定为 expanded：基元层被全部模态消费者共享，且证据必须在真实浏览器里拿到。
Blast radius:
- 所有 `ConfirmDialog`/`Dialog` 消费者都受影响：auth 退出、`chat-page-lifecycle` 经 `render-app-router` 打开的退出框、未来 #302 的 files 表单。
- ui-walk 退出段的完成 oracle（`/api/auth/me` 401 计数、`post-logout-reload` 阶段）。
- jsdom 里没有 focus fixup，只有真实浏览器能证明。
Selected risk packs:
- Public API / CLI / script entry：`Dialog` 新增可选 `busy`。
- Concurrency / shared state / ordering：`busy` 翻转、Chromium focus fixup 与 layout effect 三者的先后。
- Legacy compatibility / examples：现有焦点归还、初始焦点、Tab 循环，以及 settings-footer、chat-page-lifecycle 用例。
- Error handling / rollback / partial outputs：logout 失败回滚后焦点仍在模态内，归还行为不回归。
Evidence floor:
- `make check` exit 0（含 web 全量）；
- jsdom B1–B5；
- 反向注入各红，其中去掉救回逻辑必须让真实浏览器 ui-walk 变红；
- `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。
