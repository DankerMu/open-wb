# Proposal: ui-auth-confirm-migration（#280）

## Why
S1e 组 1 第六刀（1.6a）：首个基元消费切片。`web/src/features/auth/footer.tsx:105-137` 的退出确认仍是手写 `<dialog role="alertdialog">` + `trapDialogFocus`（`lib/dialog.ts`）+ `onCancel` + 自管焦点归还（`:22-47`），与 #277 交付的 `ConfirmDialog`（demo:1116-1128 `confirmDialog` 形态：sm 宽、ghost 取消 + danger 确认、Escape=取消、遮罩不关）并存；jsdom 侧 `settings-footer.test.tsx` 仍靠 `HTMLDialogElement.open`/`cancel` 事件驱动。本刀把 auth 侧切到基元，files 侧（#302）沿用 `lib/dialog.ts` 直到 1.6b。

## What Changes
- `web/src/features/auth/footer.tsx`：删除手写 `<dialog>`、`trapDialogFocus` import、`dialogRef`/`cancelRef` 与 `[confirming]` effect（showModal/close/焦点归还）；改渲染 `<ConfirmDialog open={confirming} onOpenChange={open => { if (!open) setConfirming(false); }} title="退出登录？" description="退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。" cancelText={pending ? "关闭" : "取消"} confirmText="退出" danger pending={pending} onConfirm={() => { void confirmLogout(); }} returnFocus={returnFocus}>{pending && <p className="ui-muted">退出请求已发送，关闭窗口不会撤销请求。</p>}</ConfirmDialog>`（经 `../../ui/index.js` 导入）。`returnFocus` 是一个带 getter 的 ref 对象：trigger 未禁用 → trigger；trigger 已禁用（pending）→ `aside` 内 `a[aria-current=page]`（与 `:36-44` 现行归还逻辑逐字等价，只是由 Radix `onCloseAutoFocus` 时机读取）。`mountedRef`/`pendingRef`/同 tick 双击去重、`logout` 失败回滚（`setConfirming(false)`+`setPending(false)`）、成功后 footer 随 principal 置空整体卸载——全部不变。trigger `<button className="ui-button">` 与 footer 其余结构不变（`.ui-button` 迁移归后续切片）。
- `web/src/styles.css:446-478`：`.logout-dialog`/`.logout-dialog h2`/`.logout-dialog p`/`.logout-dialog-actions`/`.logout-dialog::backdrop` 规则删除（`.login-dialog` 保留：`web/src` 已无使用者，属既有死 CSS，超出本刀范围，另行上报）。
- `web/test/settings-footer.test.tsx`（同 PR）：顶部加 `import "./radix-platform.js"`（保留 `dialog-platform.js`——`/files` 路由的原生 `<dialog>` 直到 #302）；`getFooter()` 改为 `screen.getByRole("complementary", { name: "侧栏", hidden: true })`（Radix `hideOthers` 在对话框打开期间给 portal 外元素加 `aria-hidden`，`:294`/`:654-655` 在打开期间取 footer）；`:606-614` 由 `dialog.open`/`new Event("cancel")` 改为 `aria-modal="true"` 断言 + `fireEvent.keyDown(document.activeElement, { key: "Escape" })`，焦点回 trigger 改 `await waitFor(...)`（FocusScope 归还在 `setTimeout(0)`）；`:626-628` 同样改 Escape；`:609` 初始焦点在 `取消` 保持（Radix 聚焦首个可聚焦控件 = ghost 取消按钮，无需 `initialFocus`）；其余用例（恰一次 POST logout、失败回滚显示 `alert`、pending 期间 trigger 禁用、unmount 无 React 告警、204 后回登录页）语义不变。
- `web/test/render-app-router.tsx`：加 `import "./radix-platform.js"`——**必须**：`web/test/chat-page-lifecycle.test.tsx:389-392` 经它挂载后点击 `退出登录` → `退出`，完整走 Radix 对话框路径；该文件不改定位也须仍绿（页面范围 `getByRole`、名称精确匹配、`findByRole("alert")` 轮询到关闭后）。
- `web/e2e/ui-walk.spec.ts:99-108`：退出段定位已是页面范围（`page.getByRole("alertdialog")`），**核实后不改**；`sidebarFooter(page)…click()` 发生在打开前，不受 `aria-hidden` 影响。
- 产物：页面首次导入 `Dialog` 内核 → `@radix-ui/react-dialog` 及其传递依赖（`react-remove-scroll`、`aria-hidden`、`react-focus-scope` 等 MIT，`tslib` 0BSD）进入 `web/dist`；ATTRIBUTION 政策沿用"只登记直接依赖"（传递依赖登记与否待用户拍板，见 Impact）。

## Non-goals
files 对话框/菜单/切换器迁移与 `lib/dialog.ts`/`dialog.test.tsx`/`dialog-platform.ts` 删除（#302）；侧栏用户菜单与 footer 重构（#281）；trigger `.ui-button` → `Button`（`.ui-button*` 由最后迁移切片移除）；`logoutError` 呈现改 Toast（无此要求）；ui-shots 视觉证据（#297/#298）。

## Capabilities
### Modified
- `ui-primitives`：「基元组件库」加入「既有对话框迁移（auth 部分）」契约与场景。

## Impact
- `web/src/features/auth/footer.tsx`、`web/src/styles.css`、`web/test/settings-footer.test.tsx`、`web/test/render-app-router.tsx`。不改 `web/src/ui/**`、不改 `web/e2e/**`（核实无需）、不加依赖。
- knip：`trapDialogFocus` 仍由 `files/dialogs.tsx` 与 `dialog.test.tsx` 消费；`ConfirmDialog` 首次有 feature 消费者。
- 依赖方向守卫（#279）：footer 经 `../../ui/index.js` 导入，无直接 `@radix-ui`。
- **待用户拍板（不阻塞本刀）**：ATTRIBUTION §3 只登记直接 Radix 依赖；本刀后 `web/dist` 首次含 Radix Dialog 的非 Radix 传递包（`react-remove-scroll`、`react-remove-scroll-bar`、`react-style-singleton`、`aria-hidden`、`use-callback-ref`、`use-sidecar`、`get-nonce`、`detect-node-es`，均 MIT；`tslib` 0BSD）。是否逐个登记属政策决定；本刀沿用现行政策。

### 与 oracle / demo 的偏差留痕
1. 父 tasks 1.6a 写"ui-walk 退出 `alertdialog` 定位改页面范围"：`ui-walk.spec.ts:100` 自 #133 起已是 `page.getByRole("alertdialog")`，核实后不改（#277 integration review 已记录）。
2. 焦点归还用带 getter 的 ref 对象而非固定元素：现行逻辑在关闭时刻按 trigger 是否禁用二选一，`ConfirmDialog.returnFocus` 只接受 `RefObject`，getter 让读取时机落在 Radix `onCloseAutoFocus`，语义与 `:36-44` 相同。
3. `cancelText` 在 pending 时为 `关闭`（沿用现行 `:125`），demo `confirmDialog` 无 pending 态，属本仓既有语义。
4. `.logout-dialog*` css 随迁移删除（父 design 说"既有类在迁移切片前不动"——本刀即其迁移切片）。

## Risk triage
Issue type: refactor（行为等价迁移）
Fixture level: expanded
Upstream suggested level: expanded (agree：触碰登录态退出主路径与 `make ui-walk` 退出段，jsdom/e2e 两条路径须同 PR 绿)
Blast radius: 退出确认是每个页面都有的出口；焦点归还/去重/失败回滚任一退化会破坏 `settings-footer.test.tsx` 的 14 个退出用例与 ui-walk 退出段；`hideOthers` 使打开期间页面元素 `aria-hidden`，既有 `getByRole` 定位若未加 `hidden:true` 会整体抛错。
Selected risk packs: Public API / CLI / script entry（`ConfirmDialog` 首个消费者，props 用法定型）；Legacy compatibility / examples（退出语义、文案、恰一次 logout、失败回滚、pending 呈现逐字保留；`lib/dialog.ts` 与 files 侧不动）；Concurrency / shared state / ordering（同 tick 双击去重、pending 中关闭不取消请求、unmount 中止请求）；Error handling / rollback / partial outputs（logout 失败 → 关闭对话框 + 显示 `alert` + 可重试）；Release / packaging / dependency compatibility（Radix Dialog 首次进产物、传递依赖许可）；Documentation / migration notes（`hidden:true`/Escape/`waitFor` 三条定位改法供 #302 复用）。
Evidence floor: `make check` exit 0；`settings-footer.test.tsx` 改 Escape 驱动后全绿且 `footer.tsx` 不 import `lib/dialog`；`npm run build --workspace web` 通过；`make ui-walk`（CI 环境变量方式）exit 0（退出段不改）。
