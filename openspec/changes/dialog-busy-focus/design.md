# Design: dialog-busy-focus（#315）

Fixture level：expanded。

Risk packs：Public API（`Dialog.busy`）、Concurrency/ordering（busy 翻转 × focus fixup × layout effect）、Legacy compatibility（焦点归还/初始焦点/Tab 循环）、Error handling（logout 失败回滚）。

Governing invariant：模态打开期间，`busy` 由 false 变 true 的那次提交之后，活动元素 SHALL 在模态内容内且未被禁用。若本来已满足（活动元素是内容内未禁用的控件），不移动焦点；若活动元素在内容外的其他非 body 元素上，也不移动，因为那不是 fixup 造成的，本刀不抢焦点。只有 `busy` 的上升沿会触发。

Sibling surfaces：
- `ConfirmDialog` → `DialogFrame`，唯一的 pending 消费者是 `web/src/features/auth/footer.tsx:76-90`，它透传 `pending`，并在 pending 时把 `cancelText` 设为 `关闭`。
- `Dialog` → `DialogFrame`：目前 feature 中没有传 `busy` 的调用方。#302 迁移 files 对话框时会用上（`web/src/features/files/dialogs.tsx:214`，提交按钮 `disabled={pending}`）。
- `Drawer` 不走 `DialogFrame`，没有 pending 语义，不改。
- `useFocusHandoff` 负责打开和关闭时的焦点，不受影响：救回只在打开期间 `busy` 的上升沿发生。
- 以下 jsdom 用例在 jsdom 下都不会触发救回（原因见 Must preserve），应保持不变并通过：
  - `web/test/settings-footer.test.tsx`：`:358` 初始焦点 `取消`，`:363,385,410` 关闭后焦点归还；
  - `web/test/ui-dialog.test.tsx`；
  - `web/test/chat-page-lifecycle*.test.tsx`。
- 以下测试也会打开退出确认框：`web/test/sidebar.test.tsx:218,265`、`web/test/app-shell-responsive.test.tsx:120-146`、`web/test/settings-page.test.tsx:198`。它们都用 `fireEvent.click`，不移动焦点，焦点一直停在未禁用的 `取消` 上，救回逻辑不会改变任何焦点断言。其中 `app-shell-responsive` 在 pending 期间重开对话框会挂载一个新实例，此时 `useRef(true)` 初始即忙碌，不触发救回。`ui-dialog.test.tsx:407,430` 一开始就以 pending 渲染，没有上升沿。
- ui-walk 退出段 `web/e2e/ui-walk.spec.ts:102-116` 与 `oracle.phase = "post-logout-reload"`：挂起再放行，不改变 401 计数。

Change surface：
- 修改：`web/src/ui/dialog.tsx`、`web/src/ui/confirm-dialog.tsx`、`web/e2e/ui-walk.spec.ts`。
- 新增：`web/test/ui-dialog-busy.test.tsx`，承载 B1–B5。`web/test/ui-dialog.test.tsx` 已有 699 行，加上这些用例会超过 size-guard 的 800 行上限，所以不改它。
- 可能新增：`web/e2e/ui-walk-logout.ts`（仅当 spec 文件会超过 800 行）。
- 不改：`web/src/features/**`、`web/src/ui/{button,index}.tsx`、服务端、`web/playwright.config.ts`、`app-reference/**`。

Must preserve：
- `Button` `loading` 仍为原生 `disabled` + `aria-busy`，ui-primitives 模态 Scenario 中 `pending` 时确认按钮 `aria-busy="true"` 的断言不变。
- 打开时的初始焦点（默认首个可聚焦控件；`initialFocus`；ConfirmDialog 为 `取消`）、Tab 循环、关闭后的焦点归还（`returnFocus`、打开者、trigger），`ui-dialog.test.tsx` 现有全部断言不变。
- settings-footer 的退出语义与焦点断言不变。jsdom 中 `fireEvent.click(退出)` 不会移动焦点，焦点仍在 `取消`（未禁用），所以不触发救回，现有断言照旧成立。
- ui-walk：`/api/auth/me` 401 恰两次，零非预期 console/page error。
- `web/e2e/ui-walk.spec.ts` ≤ 800 行（当前 749）。

Must add/change：
- `dialog.tsx`：
  ```tsx
  const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** 忙碌上升沿的焦点救回：活动元素是内容内已禁用控件，或已被 focus fixup 到 body 时，移到内容内首个可用控件。 */
  function useBusyFocusRescue(content: RefObject<HTMLElement | null>, busy: boolean) {
    const wasBusy = useRef(busy);
    useLayoutEffect(() => {
      const rising = busy && !wasBusy.current;
      wasBusy.current = busy;
      const root = content.current;
      if (!rising || !root) return;
      const active = document.activeElement;
      const lost =
        active === null ||
        active === document.body ||
        (root.contains(active) && (active as HTMLButtonElement).disabled === true);
      if (lost) root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, [busy, content]);
  }
  ```
  - `DialogFrameProps` 与公开 `DialogProps` 各加 `busy?: boolean | undefined`，并给 `busy` 写 JSDoc：忙碌期（如提交中）由调用方传入，上升沿时若焦点所在控件被禁用，就把焦点救回内容内。
  - `DialogFrame` 创建 `const contentRef = useRef<HTMLDivElement>(null)`，传给 `DialogPrimitive.Content ref={contentRef}`，并调用 `useBusyFocusRescue(contentRef, busy ?? false)`。
  - 在注释中说明用 layout effect 的原因：
    - Blink 设置 `disabled` 时不会同步 fixup，而是经 `SetNeedsFocusedElementCheck` → `ClearFocusedElementSoon`（0 延迟定时器任务）处理；
    - React 离散事件的 commit 与 layout effect 都在该任务之前跑完，`auth/provider.tsx:375` 的 setState 也在 `await` 之前；
    - 所以 Chromium 实际走「内容内已禁用」分支，`body` 分支是给其他时序（非 React 离散事件、其他引擎）兜底的。
  - 注明 `wasBusy` 实际只在 mount 时起作用：依赖是 `[busy, content]`，而 `content` 是稳定的 ref，effect 只在 `busy` 变化时重跑。以 `pending=true` 首次挂载时不会救回；Radix Portal 首次 commit 时内容尚未挂上，`root` 为 null。
- `confirm-dialog.tsx`：给 `DialogFrame` 传 `busy={pending}`；`pending` 的 JSDoc 补一句"忙碌期焦点救回到取消按钮"。
- `ui-walk.spec.ts` 退出段（`:102-116`）改为：
  1. 点击 `用户菜单` → `退出登录`，断言标题与说明（不变）；
  2. 断言 `取消` 可见后，注册挂起（第 3–6 步放在 `try` 中，`finally` 里执行 `release()`，保证断言失败时请求不会一直挂着）：`let release!: () => void; const held = new Promise<void>((r) => { release = r; });`，再 `await page.route("**/api/auth/logout", async (route) => { await held; await route.continue(); });`；
  3. 先断言 `取消` `toBeFocused()`（初始焦点）；`await page.keyboard.press("Tab")`，断言 `dialog.getByRole("button", { name: "退出" })` `toBeFocused()`（初始焦点在 `取消`）；
  4. `await page.keyboard.press("Enter")`，断言 `dialog.getByRole("button", { name: "关闭" })` `toBeFocused()`；
  5. 对 `["Tab", "Shift+Tab", "Tab"]` 逐个按键，每次后断言 `await dialog.evaluate((el) => el.contains(document.activeElement))` 为 true；
  6. 断言 `page` URL pathname 仍为 `/settings`；
  7. `release(); await page.unroute("**/api/auth/logout");`，然后执行原有的 `expectLoggedOutOnSettings` 与 reload 流程。
  - 若文件会超过 800 行，就把第 2–7 步抽成 `web/e2e/ui-walk-logout.ts` 中的导出函数，并在偏差段写明。
- 新 `web/test/ui-dialog-busy.test.tsx` 用例（引入既有 `radix-platform.ts`；用受控 `rerender` 翻转 prop）：

| # | 场景 | 断言 |
|---|---|---|
| B1 | `ConfirmDialog` 调用 `退出.focus()`，先断言活动元素为 `退出`，再把 `pending` 由 false 改为 true | 活动元素为 `取消` |
| B2 | `ConfirmDialog` 先 `退出.focus()` 再 `退出.blur()`（jsdom 的 `blur()` 只对当前焦点元素生效），断言活动元素为 `document.body` 后翻转 `pending` | 活动元素为 `取消` |
| B3 | `Dialog` 聚焦 body 内 input（未禁用）后 `busy` false→true | 活动元素仍为 input |
| B4 | `Dialog` 聚焦 footer 的 `创建` 提交按钮，再以 `busy` 为 true 且 `创建` 被 `disabled` 的形态重渲染 | 活动元素为内容内首个未禁用的可聚焦控件，即 `querySelector(FOCUSABLE 等价)` 的首个元素，测试中显式算出并比较 |
| B5 | B1 之后执行 `取消.blur()` 并断言活动元素为 `document.body`（jsdom 不允许已禁用的按钮获焦，因此不能把焦点放到 `退出` 上），再以 `pending` 仍为 true 重渲染（B1 不带 children，B5 重渲染时新增一个 `<p>` children 以确保真实 commit；只能新增节点，不能删除或替换元素，否则 FocusScope 的 `handleMutations` 在活动元素为 body 且有 `removedNodes` 时会 `focus(container)`，导致误红） | 活动元素仍为 `document.body`，证明只在上升沿触发 |

## Required evidence
每项单独注入并跑对应命令，确认变红后回退：
1. 去掉 `useBusyFocusRescue` 调用 → B1、B2、B4 红；且 CI 环境变量下的 `ci-compiled-server.sh ui-walk` 在第 4 步（`关闭` 未获焦）或第 5 步（焦点逃出）变红。**这一项证明 e2e 能在真实浏览器里观测到原缺陷**，必须实跑。
2. 只保留 `active === document.body` 分支，去掉"内容内已禁用控件"分支 → B1、B4 红；预期 ui-walk 也红，因为 Chromium 走的是"已禁用"分支，见时序注释。**实测相反：ui-walk 保持绿，见偏差 1。**
3. 只保留"已禁用"分支，去掉 body 分支 → B2 红；ui-walk 大概率保持绿，这是预期，如实记录。**实测相反：ui-walk 红，见偏差 1。**
4. 同时去掉上升沿判断和依赖数组，让 effect 每次 commit 都跑，只要 busy 为 true 就救回 → B5 红。只去掉 `rising` 而保留 `[busy, content]` 不会变红，因为 effect 本就只在 busy 变化时运行。
5. 救回条件放宽为"总是聚焦首个可用控件" → B3 红。
6. `ConfirmDialog` 不传 `busy` → B1、B2 红，ui-walk 红。
7. （fix pass 1 补）`useFocusHandoff` 的 `onCloseAutoFocus` 不再归还焦点（去掉 `returnFocus`/opener 的 `.focus()`）→ 新增 settings-footer「救回后 403」用例在焦点回到 trigger 的断言处红。

## Test plan / verification
- `(cd web && npx vitest run test/ui-dialog-busy.test.tsx test/ui-dialog.test.tsx test/settings-footer.test.tsx)` 全绿。
- `make check` exit 0。已知与本刀无关的 flake：#369、#375，出现时重跑并同时报告两次结果。
- `npm run build --workspace web` 后跑 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

Seams under test：`DialogFrame` 的 busy 上升沿 × 活动元素状态；真实浏览器的 fixup。

Review focus：救回条件（不在非 fixup 场景抢焦点）；layout effect 的时序说明；ui-walk 挂起与放行、401 oracle 不受影响；jsdom 与真实浏览器的差异是否如实记录。

## Not yet specified
- 忙碌期间用户用鼠标点击背景：Radix `onPointerDownOutside` 与 `aria-hidden` 已兜底，本刀不涉及。

## Implementation deviations
1. **时序注释与 Chromium 实际分支相反（已按实测改写注释）。**
   - 设计称 Blink 经 `ClearFocusedElementSoon` 延后 fixup，所以 Chromium 走「内容内已禁用」分支。
   - 实测（Playwright 1.62 自带 Chromium 151.0.7922.34）：对已聚焦按钮设置 `disabled` 后，同步读取 `document.activeElement` 已是 `body`；强制 style/layout、微任务、0 延迟定时器后也都是 `body`。所以 layout effect 看到的是 `body`，Chromium 走 body 分支。
   - 反向注入佐证：注入 2（只留 body 分支）ui-walk 绿；注入 3（只留已禁用分支）ui-walk 在第 4 步红。与 Required evidence 第 2、3 条对 ui-walk 的预期正好相反，jsdom 侧（注入 2 → B1、B4 红；注入 3 → B2 红）与设计一致。
   - 处理：救回逻辑不变（两个分支都保留）；`dialog.tsx` 的注释改为如实描述：Chromium 走 body 分支；「内容内已禁用」分支给 fixup 延后（如 `ClearFocusedElementSoon` 路径）或不做 fixup（jsdom）的环境兜底。
2. **ui-walk 放行后先等处理器的 `route.continue()` 完成再 `unroute`。**
   - 按设计第 7 步 `release()` 后立即 `page.unroute(...)`，实跑报 `route.continue: Route is already handled!`：Playwright 1.62 的 `unroute` 默认行为会清空拦截模式，挂起的请求被自动放行，与处理器随后的 `continue` 竞争。
   - 最小修复：处理器把 `held.then(() => route.continue())` 存为 `forwarded` 并返回；`try` 末尾加 `expect.poll(() => forwarded !== undefined)`，证明请求确被 route 挂住；`finally` 里 `release()` 后，先 `await forwarded` 再 `unroute`。挂起期断言与 401 oracle 不变。
   - 第 2–7 步抽成同文件内的 `confirmLogoutByKeyboardWhileHeld`（文件 782 行 ≤ 800，未拆出 `ui-walk-logout.ts`）。
3. **B5 的前置步骤复用 B1。** 所以在无救回（实现前、注入 1、注入 6）时，B5 在其前置断言（`:109`，活动元素为 `关闭`）处红，而不是在"仍为 body"的断言处红。注入 4 下 B5 在末条断言（`:115`，活动元素仍为 `body`）处红，符合设计。
   - 行号更正（fix pass 1 按 `web/test/ui-dialog-busy.test.tsx` 现文件复跑注入 1 核对）：先红记录中的"B4 :105、B5 :111"应为 B4 `:103`（活动元素为算出的首个可用控件）、B5 `:109`（前置断言）；B1 `:72`、B2 `:82` 不变。行为结论不变。
4. **fix pass 1（评审 F1）：补"救回触发后 logout 403"用例。**
   - 新增 `web/test/settings-footer.test.tsx`「returns focus to the trigger when logout 403 follows the busy focus rescue」（`:503`，文件 552 行 ≤ 800，未移到 `ui-dialog-busy.test.tsx`）：聚焦 `退出` 后点击并挂起 logout，断言焦点救回到 `关闭`（`:520`）；放行 403 后断言 `alertdialog` 消失、焦点回到 `用户菜单` trigger（`:527`）、footer alert 为 `无法退出当前会话`。
   - 注入 7（`onCloseAutoFocus` 去掉 `.focus()` 归还）→ 新用例在 `:527` 红；注入 6（`ConfirmDialog` 不传 `busy`）→ 新用例在 `:520` 红（B1 `:72`、B2 `:82`、B5 `:109` 同红）。两者回退后与原文件逐字节一致。
   - `confirm-dialog.tsx` 的 `pending` JSDoc 改为：救回到内容内首个未禁用的可聚焦控件，`children` 不含可聚焦元素时即取消按钮（不再断言总是取消按钮）。
