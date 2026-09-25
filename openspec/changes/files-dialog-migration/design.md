# Design: files-dialog-migration（#302）

Fixture level：expanded（父 tasks 组 1 声明；触碰 `make ui-walk` 文件页段）。Review priority：mechanical（行为等价迁移），但焦点归还与挂起期焦点是本刀唯一的行为风险面。

Risk packs：Legacy compatibility（files 既有断言语义、焦点闭环）、Concurrency/ordering（挂起期取消、代际守卫、Radix 关闭/打开焦点时序）、Error handling（409/其它错误后对话框保持可用）。

## Governing invariants

1. files-web「文件界面与键盘可用性」（`openspec/specs/files-web/spec.md:85-89`）：创建对话框为阻止背景交互的模态，打开时聚焦首个表单控件，Tab/Shift+Tab 留在框内，Escape/取消关闭并恢复触发器焦点；请求进行中保持忙碌反馈、不得重复提交、仍允许取消等待，经既有 AbortController 与代际守卫防止迟到响应影响新界面；界面明示可刷新确认结果。
2. ui-primitives「基元组件库」忙碌期焦点句（`openspec/specs/ui-primitives/spec.md` 末段）：`busy` 上升沿后活动元素在模态内且未禁用。
3. ui-primitives：`web/src/features/**` 不直接 import `@radix-ui/*`，只经 `web/src/ui/index.js`。

## Sibling surfaces

- 生产：`web/src/features/files/dialogs.tsx`（`DialogSurface`、`CreationMenu`、`DialogForm`、`WorkspaceDialog`、`DirectoryDialog`）、`web/src/features/files/page.tsx`（`WorkspaceSwitcher`、`openWorkspaceDialog`/`closeWorkspaceDialog`）、`web/src/features/files/tree.tsx:253,614`（`CreationMenu` 与 `DirectoryDialog` 的挂载点、`openFolderDialog`/`closeFolderDialog`）、`web/src/features/files/files.css:405-640`、`web/src/lib/dialog.ts`。
- 测试（jsdom）：
  - `web/test/files-fixture.tsx:83-104` 三个打开 helper 用 `fireEvent.click(新建)`；Radix DropdownMenu 在 pointerdown/键盘打开，click 不打开 → 改用 `web/test/ui-support.ts:89` `pressPointer`；`import "./dialog-platform.js"` 改 `./radix-platform.js`。
  - `web/test/files-page.test.tsx:153-163`（菜单开/Escape/再次点击 trigger 关闭）、`:183-184`（无空间时 `fireEvent.click` 开菜单）、`:198-206`（切换器）、`:244-300`（校验与 409）、`:302-335`（迟到创建不关新框）、`:337-392`（StrictMode：目录创建挂起时切换空间）。
  - `web/test/files-concurrency.test.tsx:39-95`（挂起时重开再提交）。
  - `web/test/files-errors.test.tsx:111,146`、`files-empty-layout.test.tsx`、`main.test.tsx:72`（只读页面，预期不改）。
  - `web/test/settings-footer.test.tsx:535-545` 静态契约只查 auth；本刀在新文件加 files/src 全局静态契约，不改它。
  - `dialog-platform.ts` 的 9 个 import 点：`routes`、`main`、`chat-page-lifecycle`、`chat-page-lifecycle-support`、`auth-router`、`settings-page`、`render-app-router`、`files-fixture`、`settings-footer`。
- e2e：`web/e2e/ui-walk.spec.ts:434-505` `walkFiles`（`files = page.locator("main")` 范围内取 `dialog`/`menuitem`）；`:119-148` `confirmLogoutByKeyboardWhileHeld`（挂起/放行模式的现有唯一实例）。
- 基元（只消费，不改）：`web/src/ui/{dialog,menu,popover}.tsx`、`web/src/ui/index.ts`。

## Decisions

- **D1 对话框**：`WorkspaceDialog`/`DirectoryDialog` 渲染受控 `<Dialog open onOpenChange={(open) => { if (!open) onCancel(); }} title=… busy={pending} initialFocus=… returnFocus=…>`，表单（含 `取消`/`创建` 行）整体作为 children 放在 body，不用 `footer`（提交按钮须在 `<form>` 内）。保持默认 `dismissible`：右上 `关闭`、Escape、遮罩点击都等同 `取消`（与 demo `openModal` 的 `.modal-close` 与遮罩 mousedown 关闭一致，demo:1087-1101）。原生 `<dialog>` 的遮罩点击不关闭，这是本刀唯一的交互增量，语义与 `取消` 相同。`aria-busy` 留在 `<form>` 上（对话框根不再有），pending 提示行与 `alert` 不变。`DialogSurface`、`titleId` prop 删除。
- **D2 初始焦点**：沿用原生 `showModal` 的"首个表单控件"：`WorkspaceDialog` → `工作空间名称` input，`DirectoryDialog` → `位置` select，经 `initialFocus` ref（不得用 `autoFocus`，见 `dialog.tsx` `useFocusHandoff` 注释）。不传时 Radix 会聚焦 `关闭`，违反 invariant 1。
- **D3 焦点归还**：显式 `returnFocus` 指向发起流程的触发器：切换器路径 → `选择工作空间`；`＋` 菜单路径 → `新建`（两个对话框皆可经此路径打开）。不依赖 `useFocusHandoff` 的"打开者"记录：从 Radix Menu/Popover 选项打开时，打开瞬间的活动元素是正在卸载的 menuitem/弹层内按钮，归还会落到 body。归还只在取消类关闭（`取消`/`关闭`/Escape/遮罩）上断言；创建成功后工作空间切换会重挂树与切换器，原触发器已脱离文档，迁移前后都不归还（`isConnected` 检查 / 脱离元素 `focus()` 无效），不作要求。ref 如何从 tree/page 传到对话框由实现决定，保持最小接线。
- **D4 菜单**：`CreationMenu` → `<Menu trigger={<button aria-label="新建" className="ui-button" type="button">＋</button>} items={[{ label: "新建文件夹", onSelect }, { label: "新建工作空间", onSelect }]} />`，无图标；trigger 外观（`ui-button`/`＋`）不变（换 `Button` 属 5.x）。Radix 提供 `aria-haspopup`/`aria-expanded`、方向键/Home/End、Escape 与关闭后焦点回 trigger；删除手写 `moveMenuFocus`/`closeMenu`/`open` 状态。
- **D5 切换器**：`WorkspaceSwitcher` → 受控 `<Popover open onOpenChange contentLabel="工作空间切换器" trigger={<button aria-label="选择工作空间" className="files-switcher-trigger" type="button">…</button>}>`（`contentRole` 不传，保持默认 `dialog`）。Popover 打开聚焦首个可聚焦元素 = 搜索框（与现 `searchRef` 手动聚焦等价），Escape/外点关闭并归还 trigger；删除 `searchRef`/`triggerRef`/`dismissSwitcher` 手动焦点。选中空间与 `＋ 新建工作空间` 先 `setOpen(false)` 再回调。`query` 状态仍在 `WorkspaceSwitcher` 上（关闭不清空，与现状同）。弹层内部布局由 content 内一层 `div.files-switcher-panel` 承载（保留 flex/gap/max-height/overflow），外壳（边框/圆角/阴影/背景/margin/padding/z-index/定位）归 `.ui-popover`，`.files-switcher-panel` 中这些外壳属性删除。
- **D6 删除**：`web/src/lib/dialog.ts`、`web/test/dialog.test.tsx`；`web/src` 迁移后无 `HTMLDialogElement` 使用者，`web/test/dialog-platform.ts` 与 9 处 import 一并删除（保留它就是死 shim）。`files.css` 删 `.files-dialog`、`.files-dialog::backdrop`、`.files-dialog h2`、`.files-menu`、`.files-menu-panel*`；`.files-switcher-panel` 按 D5 只删外壳属性；保留 `.files-dialog-form*`、`.files-dialog-actions`、`.files-field` 与其余 `.files-switcher-*`（内容类）。
- **D7 jsdom 定位与不可达路径**：Radix 模态打开期间 `hideOthers` 给背景加 `aria-hidden`，portal 内容在 `document.body` 直接子树。改法沿用 1.6a：打开期间取背景元素用 `{ hidden: true }` **仅限断言**；**不得**用 `{ hidden: true }` 点击模态背后的控件去伪造真实界面不可达的路径。现有三处依赖该漏洞的用例改走真实路径并保留断言意图：
  - `files-concurrency.test.tsx:39-95`（挂起时"重开"再提交）→ 先 `取消`（中止等待）再重开提交；两次 POST body 断言不变，用例标题按真实路径改写。
  - `files-page.test.tsx:337-392`（目录创建挂起时经切换器换空间）→ 用 `renderFiles` 返回的 `router.navigate` 切到 `?ws=workspace-2`（地址栏/前进后退的真实路径；`WorkspaceBrowser` 按 `key`（`page.tsx:420`）重挂，卸载中止目录请求（`tree.tsx:411-412`），对话框随之消失），其后迟到结果被丢弃的断言不变。
  - 实现中若发现其它同类用例，按同一规则处理并在 PR 列出。
- **D8 ui-walk 挂起断言**：`walk-out` 创建改为：填好位置与名称后先 `holdRoute` 挂起 `POST **/api/workspaces/*/dirs`，`创建` 上 `locator.press("Enter")`（聚焦后键盘提交）；紧接着先 `expect.poll` 确认请求确实被挂起（放在焦点断言之前，使挂起断言可独立变红），再断言对话框内 `关闭` 获焦（Chromium 同步 fixup 到 body → body 分支救回到内容内首个可用控件，即头部 `关闭`），依次 Tab、Shift+Tab、Tab 后 `dialog.contains(document.activeElement)` 均为 true；`finally` 放行；随后 `展开 walk-out` 行可见（原断言）。挂起/放行抽成新模块 `web/e2e/route-hold.ts`（放行时先 await 处理器转发的 `route.continue()` 再 `unroute`，见 `ui-walk.spec.ts:126-128` 注释），退出段 `confirmLogoutByKeyboardWhileHeld` 改用它，行为不变。`ui-walk.spec.ts` 须 ≤ 800 行（现 782）。

## FOCUSABLE 复核（父 1.6b 交接项）

- files 两个表单对话框内容：头部 `关闭`、body 内 `<form>`（`p`、`label>input|select`、status/alert `p`、`取消`/`创建`）。无 `input[type=hidden]`、无 `[href]`、无 `fieldset`。首个 `FOCUSABLE` 命中恒为 `关闭`（`dismissible` 默认 true 时总渲染）。
- 无匹配回退：现有全部 `busy` 消费者（`ConfirmDialog` 恒有取消按钮；files 两个 `Dialog` 恒有 `关闭`）都不可能无匹配，回退路径不可达 → 本刀不改 `dialog.tsx`（YAGNI）。将来出现 `dismissible=false` 且内容无可用控件的 `busy` 消费者时须同刀处理。
- 救回目标是关闭类控件：挂起期在 `关闭` 上再按 Enter（含按键自动重复）会关闭对话框，即"取消等待"——invariant 1 明确允许挂起期取消，行为与点 `取消` 相同，接受；不作为本刀缺陷。

## Must preserve

- 文案与语义：两对话框标题、字段标签/placeholder、`将在你的沙箱内创建同名目录`、pending 提示行、`请输入名称`/`请填写文件夹名称`/`名称不能包含路径分隔符`/`同名工作空间已存在`/`该目录下已存在同名条目`、位置下拉只列已加载目录（含 `根目录　root`，5.x 才改）；菜单项恰为 `新建文件夹`、`新建工作空间`（此序）；切换器 `dialog` 名 `工作空间切换器`、`搜索工作空间`、当前项 `当前工作空间`、`没有匹配的工作空间`、`＋ 新建工作空间`。
- 并发：挂起时 `创建` 禁用、不重复提交；取消即 abort；迟到响应不关闭/不覆盖更新的对话框；空间切换丢弃迟到结果（files-page、files-concurrency 断言意图不变）。
- 无空间时 `新建文件夹` → `当前工作空间没有可写目录`（`files-page.test.tsx:178-186`）。
- ui-walk：`/api/auth/me` 401 恰两次、零非预期 console/page error；walk-out 创建与 reload 恢复断言不变。
- 不改 `web/src/ui/**`、服务端、`web/playwright.config.ts`、`app-reference/**`。

## Must add/change

- `dialogs.tsx`/`page.tsx`/`tree.tsx` 按 D1–D5；`files.css` 按 D6。
- 新 `web/test/files-overlays.test.tsx`（`files-page.test.tsx` 已 536 行，新用例不进它）：
  - O1 切换器路径：点击 `选择工作空间` → `dialog` 名 `工作空间切换器`，活动元素为 `搜索工作空间` 输入框；点击 `＋ 新建工作空间` → `dialog` 名 `新建工作空间`、`aria-modal="true"`，活动元素为 `工作空间名称` 输入框；Escape → 对话框消失，`waitFor` 活动元素为 `选择工作空间`；0 次 `POST /api/workspaces`。另一轮：打开切换器后直接 Escape → 弹层消失，`waitFor` 活动元素为 `选择工作空间`。
  - O2 菜单路径：`pressPointer(新建)` → `menu` 内 `menuitem` 恰为 `["新建文件夹","新建工作空间"]`；选 `新建工作空间` → 对话框；点击 `取消` → `waitFor` 活动元素为 `新建`；0 次 POST。
  - O3 目录对话框：菜单 `新建文件夹` → 活动元素为 `位置` select；点击 `关闭` → 对话框消失、`waitFor` 活动元素为 `新建`；再次打开后 `yieldMacrotask` 再对遮罩（`.ui-dialog-overlay`）`pressPointer` → 对话框消失、`waitFor` 活动元素为 `新建`；全程 0 次 `POST …/dirs`。
  - O4 挂起期焦点：目录对话框填名后 `创建.focus()` 再点击，`POST …/dirs` 挂起（deferred）→ `创建` 禁用、活动元素为对话框内 `关闭`（jsdom 无 fixup，走"内容内已禁用"分支）；点击 `取消` → 对话框消失、该请求 `signal.aborted === true`、活动元素为 `新建`。
  - O5 工作空间挂起与失败：工作空间对话框填名、`创建.focus()` 后点击，`POST /api/workspaces` 先挂起（deferred）→ 挂起期间 `创建` 禁用、活动元素为对话框内 `关闭`；再以 409 解决 → `alert` 为 `同名工作空间已存在`、对话框仍在、`创建` 未禁用、活动元素在对话框内。
  - O6 菜单 Escape：打开菜单后 Escape → `menu` 消失、活动元素为 `新建`。
  - O7 静态契约：`web/src/**/*.{ts,tsx}` 不含 `<dialog`、`role="menu"`、`showModal`、`trapDialogFocus`、`lib/dialog`；`web/src/lib/dialog.ts`、`web/test/dialog.test.tsx`、`web/test/dialog-platform.ts` 不存在；`files/dialogs.tsx` 与 `files/page.tsx` 从 `../../ui/index.js` 导入 `Dialog`/`Menu`/`Popover`（按实际归属）。
- 既有测试按 Sibling surfaces 与 D7 调整；`files-page.test.tsx:153-163` 菜单开合改 pointer（再次 pointerdown trigger 关闭）与 Escape。
- `web/e2e/route-hold.ts` + `ui-walk.spec.ts` 按 D8；walkFiles 中切换器/`新建工作空间` 对话框/`新建文件夹` menuitem 与对话框改 `page` 范围（`新建`、`选择工作空间` trigger 与树/预览仍在 `main` 内）。

## Required evidence

- 先红：O1–O7 在迁移前运行，预期红为 O1、O3、O4、O5（挂起期 `关闭` 不存在）、O7；O2、O6 迁移前已绿（旧菜单 `closeMenu()` 同步归还焦点），作为回归守卫；ui-walk 挂起段在未传 `busy` 时红（即注入 1）。
- `make check` exit 0；`npm run build --workspace web` exit 0；CI 环境变量本地 ui-walk exit 0。
- 反向注入（各自单独施加、观察红、回退）：
  1. 删 `DirectoryDialog` 的 `busy={pending}` → O4 红；本地 CI-env ui-walk 在 `关闭` 获焦断言红。
  1b. 删 `WorkspaceDialog` 的 `busy={pending}` → O5 挂起期断言红。
  2. 删 `WorkspaceDialog` 的 `returnFocus` → O1 或 O2 红（若二者皆绿，说明 D3 前提不成立，停止并在 PR 报告）。
  3. 删 `WorkspaceDialog` 的 `initialFocus` → O1 红（焦点落在 `关闭`）。
  4. 恢复 `web/src/lib/dialog.ts`（任意内容）→ O7 红。
  5. 删切换器 `contentLabel` → O1 与 `files-page.test.tsx:198` 红。
  6. 把 `holdRoute` 的挂起模式改成不匹配的 glob → ui-walk 在"请求确被挂起"的 `expect.poll` 红（它位于焦点断言之前；证明挂起断言不空转），PR 记录失败行。
- 行数：`ui-walk.spec.ts` ≤ 800；新 test 文件 ≤ 800；`wc -l` 记入 PR。

## Not yet specified

- 切换器与菜单的视觉细节（卡片图标、逻辑路径、`Button` 外观、菜单项图标）归 5.x，本刀不预切。
