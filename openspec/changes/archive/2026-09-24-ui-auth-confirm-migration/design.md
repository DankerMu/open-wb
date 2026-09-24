# Design: ui-auth-confirm-migration（#280）

Change surface: `web/src/features/auth/footer.tsx`（重写对话框段与焦点归还）；`web/src/styles.css`（删 `.logout-dialog*` 五条规则）；`web/test/settings-footer.test.tsx`（shim 引入、`getFooter` 加 `hidden:true`、两处 Escape 驱动、一处 `waitFor`）；`web/test/render-app-router.tsx`（+`radix-platform` 引入）。`web/e2e/ui-walk.spec.ts` 与 `web/test/chat-page-lifecycle.test.tsx` 核实不改（后者须仍绿）。

Must preserve: footer 结构与文案（`.account-footer`/`.account-identity`/`.account-avatar`/`.account-copy`、`退出登录` trigger `className="ui-button" disabled={pending}`、pending 状态行 `正在退出登录，可继续浏览或刷新确认登录状态。` `role="status"`、`logoutError` 的 `.ui-alert role="alert"`）；对话框文案（标题 `退出登录？`、说明 `退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。`、pending 提示 `退出请求已发送，关闭窗口不会撤销请求。`、按钮 `取消`/`关闭`/`退出`）；`confirmLogout` 的 `pendingRef` 同 tick 去重、`mountedRef` 卸载守卫、失败回滚（`setConfirming(false); setPending(false)`）、成功后 principal 置空 footer 卸载；焦点：打开落在 `取消`，关闭回 trigger，trigger 禁用时回 `aside` 内 `a[aria-current=page]`；`web/src/lib/dialog.ts`、`web/test/dialog.test.tsx`、`web/test/dialog-platform.ts` 及 files 侧全部不动；`settings-footer.test.tsx` 其余 30+ 用例（AuthProvider 协调、About 卡、401/403 路径）逐字不动；`web/test/chat-page-lifecycle.test.tsx:389-392`（经 `render-app-router` 打开退出对话框并点 `退出`）逐字不动且仍绿——其查询是页面范围（能命中 portal）、按名精确匹配（`退出` 不误中 `退出登录`）、`findByRole("alert")` 轮询到对话框关闭、`aria-hidden` 撤掉之后；`ui-walk.spec.ts` 不动；`styles.css` 的 `.login-dialog` 规则保留。

Must add/change:
- `footer.tsx`：
  - import：删 `trapDialogFocus`；加 `import { ConfirmDialog } from "../../ui/index.js"`；`useEffect` 仍用于 `mountedRef`；删 `dialogRef`、`cancelRef` 与 `[confirming]` effect。
  - `returnFocus`：`const returnFocus = useMemo<RefObject<HTMLElement | null>>(() => ({ get current() { const trigger = triggerRef.current; if (!trigger) return null; return trigger.disabled ? (trigger.closest("aside")?.querySelector<HTMLAnchorElement>("a[aria-current=page]") ?? null) : trigger; } }), [])`（`@types/react` 19 的 `RefObject.current` 可写，getter-only 字面量推断为 `readonly current`，readonly → 可写的赋值 TS 允许；读取时机 = Radix `onCloseAutoFocus`，与旧 effect cleanup 在"关闭时刻按 disabled 二选一"一致；旧 `mountedRef` 守卫不再需要——footer 卸载时 ConfirmDialog 一并卸载，`onCloseAutoFocus` 归还到已脱离文档的 trigger 是空操作）。
  - 渲染：`{principal 守卫不变}` … trigger 与 pending 状态行不变；`<ConfirmDialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }} title="退出登录？" description="退出后本机不再保留登录状态，未完成的任务会保留在你的沙箱中。" cancelText={pending ? "关闭" : "取消"} confirmText="退出" danger pending={pending} onConfirm={() => { void confirmLogout(); }} returnFocus={returnFocus}>{pending ? <p className="ui-muted">退出请求已发送，关闭窗口不会撤销请求。</p> : null}</ConfirmDialog>`。`ConfirmDialog` 始终渲染（`open` 受控），不再 `confirming ? … : null` 条件挂载（Radix `Root open=false` 不产生 DOM）。
  - 行为对照：Escape → Radix `onEscapeKeyDown`（`closeOnEscape`）→ `onOpenChange(false)` → `setConfirming(false)`（= 旧 `onCancel`）；遮罩点击不关闭（`closeOnOverlay={false}`，旧 `<dialog>` 亦不关）；Tab 循环由 FocusScope（= 旧 `trapDialogFocus`）；`aria-labelledby`/`aria-describedby` 由 Radix Title/Description（= 旧手写 id）；`role="alertdialog"`、标题 `h2`（ui-walk:101 与测试 `:584` 的 `heading` 定位）由 `ConfirmDialog` 保证；pending 时确认按钮 `loading`（disabled + `aria-busy`，可访问名仍为 `退出`）= 旧 `disabled={pending}`；取消按钮文案随 pending 切换。
- `styles.css`：删除 `.logout-dialog`（从 `.login-dialog,\n.logout-dialog {` 选择器列表中移除该项，规则体保留给 `.login-dialog`）、`.logout-dialog h2`、`.logout-dialog p`、`.logout-dialog-actions`、`.logout-dialog::backdrop`。
- `settings-footer.test.tsx`：
  - 顶部 `import "./radix-platform.js";`（保留 `import "./dialog-platform.js";`）。
  - `getFooter()` → `screen.getByRole("complementary", { name: "侧栏", hidden: true })`；`:655` 的 `within(getFooter()).getByRole("button", { name: "退出登录" })` 加 `hidden: true`（对话框打开期间 footer 及其后代 `aria-hidden`）；`:299/:320` 的 `within(footer).getByRole("alert")` 发生在对话框已关闭后（失败回滚），无需 hidden，但 `footer` 引用取自 `:294`（打开期间）——`getFooter()` 已带 hidden，元素引用不变。
  - `:606-614`（Escape 用例）：`const dialog = screen.getByRole("alertdialog"); expect(dialog.getAttribute("aria-modal")).toBe("true"); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消" })); fireEvent.keyDown(document.activeElement as Element, { key: "Escape" }); expect(screen.queryByRole("alertdialog")).toBeNull(); expect(logout 请求数).toBe(0); await waitFor(() => expect(document.activeElement).toBe(trigger));`。
  - `:626-628`（pending 中关闭）：点击 `退出` 后 `fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })`（Radix Escape 在 document 层监听，目标取当前活动元素即可）；其余断言不变（对话框消失、`heading` 工作空间仍在、logout 恰一次、204 后回登录页）。
  - 去掉两处 `as HTMLDialogElement` 断言。
- `render-app-router.tsx`：`import "./radix-platform.js";` 与既有 `dialog-platform` 并列。
- ui-walk：`:99` 点击发生在打开前；`:100-107` 全部经 `page.getByRole("alertdialog")` 与 `dialog.getByRole(...)`；`:108` `expectLoggedOutOnSettings` 在对话框随 footer 卸载后。不改。

Governing invariant: 退出确认的全部模态行为（焦点进入/循环/归还、Escape、遮罩、aria 关联、portal、`hideOthers`）只来自 `ConfirmDialog`（即 Radix Dialog）；auth feature 不再持有任何 `<dialog>`/焦点管理/键盘处理代码，只持有 `confirming`/`pending` 状态、`returnFocus` 目标选择与 logout 编排；退出语义（文案、恰一次请求、失败回滚、pending 呈现、焦点去向）与迁移前逐字等价；jsdom 与 e2e 两条定位路径同 PR 绿；feature 只经 `ui/index.ts` 取基元（#279 守卫）。

Sibling surfaces: `web/src/features/files/dialogs.tsx`（仍用 `trapDialogFocus` 与 `<dialog>`，#302 迁移；本刀的 `hidden:true`/Escape/`waitFor` 三条改法是 #302 的模板）；`web/src/features/auth/index.ts`（`AuthFooter` 导出不变）；`web/src/routes/router.tsx:80`（`AuthFooter` 挂在 aside 内，#281 重构 footer 时沿用本刀的 `ConfirmDialog` 用法与 `returnFocus`）；`web/test/{routes,auth-router,main,auth-session-client}.test.tsx` 与 `chat-page-lifecycle-support.tsx:92`（直接挂载、不打开对话框：Radix `Root open=false` 无 DOM、无 shim 需求，不改）；`web/test/chat-page-lifecycle.test.tsx:389-392`（经 `render-app-router` 打开并确认退出——shim 由 `render-app-router.tsx` 间接引入，定位不改，必须仍绿）；`web/test/ui-dialog.test.tsx`（`ConfirmDialog` 契约测试，不动）；`web/src/styles.css:302-345` `.account-*` 规则（不动）；`ATTRIBUTION.md`（不改，政策问题上报）。

Seams under test（全部落在既有 `web/test/settings-footer.test.tsx`，不新增测试文件；先红 = 改完测试、未改 footer 时 Escape 用例与 `aria-modal` 断言红）:
- (F1) `:576-595` 打开/取消：`alertdialog` 存在、`heading` `退出登录？`、说明文案、点击 `取消` → 关闭、0 次 logout、URL 不变（不改）。
- (F2) `:598-615` Escape：`aria-modal="true"`、初始焦点 `取消`、Escape keydown → 关闭、0 次 logout、`waitFor` 焦点回 trigger。
- (F3) `:617-635` pending 中关闭：点击 `退出`（1 次 logout）→ 打开期间 `getByRole("button",{name:"关闭"})` 存在 → Escape → 关闭、页面 heading 仍在、请求未取消；**焦点归还的禁用分支**：此时 trigger `disabled`，`await waitFor(() => expect(document.activeElement).toBe(within(getFooter().closest("aside") ?? getFooter()).getByRole("link", { current: "page" })))`（`/files` 下 NavLink 带 `aria-current="page"`）；204 后登录页。
- (F4) `:637-661` 同 tick 双击：logout 恰一次、确认按钮 disabled、trigger disabled（`hidden:true` 取 footer）、204 后登录页且无 `alertdialog`。
- (F5) `:663-681` unmount 中止：打开并确认后 `view.unmount()` → 请求 signal aborted、无 `console.error`（Radix 卸载不得产生告警）。
- (F6) `:254-330` 失败回滚：403 → 对话框关闭、footer `alert` 文案、About 卡状态；`:700-735` 失败后重试仍可打开并成功。
- (F7) 静态：`footer.tsx` 文本不含 `lib/dialog`、`<dialog`、`showModal`、`trapDialogFocus`，含 `ConfirmDialog` 与 `returnFocus`；`styles.css` 不含 `.logout-dialog`；`settings-footer.test.tsx` 与 `render-app-router.tsx` 含 `radix-platform.js`（以现有 `ui-guardrails`/`ui-support` 的 `readRepoFile` 在 `web/test/ui-dialog.test.tsx` 或 `settings-footer.test.tsx` 末尾加一个 `describe("迁移静态契约")`——放在 `settings-footer.test.tsx`，注意 size-guard 800：当前 733 行，改完约 770 行）。
- ui-walk 退出段（CI）：`:99-110` 不改，`ci-compiled-server.sh ui-walk` 1 passed。

Required evidence:
- 先红后绿：先改 `settings-footer.test.tsx`（F2/F3 Escape 驱动 + `aria-modal` + F7 静态），未改 footer 时 F2（`aria-modal` 为 null）与 F7 红；改 footer 后全绿。反向注入五项各红并回退：去掉 `returnFocus` → F2 焦点归还红（jsdom `fireEvent.click` 不移动焦点，`useFocusHandoff` 记下的打开者是 body，归还落到 body）；`returnFocus` getter 忽略 `disabled`、总返回 trigger → F3 禁用分支红（禁用按钮 `.focus()` 无效，焦点留在 body）；`onOpenChange` 忽略 `open=false` → F2/F3 关闭红；去掉 `pending` 透传 → F4 `confirm.disabled` 红；去掉 `cancelText` 切换 → F3 `关闭` 断言红。
- `make check` exit 0（size-guard：`settings-footer.test.tsx` < 800；knip：`trapDialogFocus` 仍有消费者）；`npm run build --workspace web` exit 0（产物首次含 Radix Dialog）；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
- `grep -n "lib/dialog" web/src/features/auth/footer.tsx` 为空。

Non-goals: files 侧迁移与 `lib/dialog.ts` 删除；footer 结构/用户菜单重构（#281）；`.ui-button` 迁移；Toast 化错误提示；ATTRIBUTION 政策变更。

Review focus: (1) `returnFocus` getter 在 disabled/非 disabled 两种关闭时刻的返回值与旧 `:36-44` 等价（F2/F3 各覆盖一支），且通过 typecheck（`@types/react` 19 的 `RefObject.current` 可写，getter-only 字面量推断为 `readonly current`，readonly → 可写的赋值 TS 允许）；(2) `ConfirmDialog` 常驻渲染（受控 `open`）后 footer 卸载路径无 React 告警（F5）；(3) `hidden:true` 只加在打开期间会取的定位（`getFooter`、`:655`），没有把整份文件的定位都放宽；(4) Escape 用例的 keydown 目标与 `waitFor` 只用于焦点归还，关闭本身仍是同步断言；(5) `styles.css` 只删 `.logout-dialog*`，`.login-dialog` 规则体完整；(6) footer 无任何 `@radix-ui` 直接 import、无 `style={`；(7) ui-walk 未改的核实过程（`:99-110` 逐行）；(8) size-guard。
