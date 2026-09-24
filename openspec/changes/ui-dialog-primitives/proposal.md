# Proposal: ui-dialog-primitives（#277）

## Why
S1e 组 1 第三刀。既有两处手写 `<dialog>`（`web/src/features/auth/footer.tsx` 退出确认、`web/src/features/files/dialogs.tsx` 新建对话框）各自实现焦点循环（`web/src/lib/dialog.ts`）、Escape 与按钮布局，且 jsdom 侧靠 `web/test/dialog-platform.ts` 给 `HTMLDialogElement` 打 shim；侧栏覆盖层（#283）需要左侧 Drawer，files 切换器/创建菜单（#302）与退出确认（#280）等待可复用的模态基元。demo 的契约在 `resource/workbuddy-live-demo.html:730-738`（`.modal-backdrop`/`.modal`/`--sm`/head/close/body/foot）、1087-1128（`openModal`/`closeModal`/`confirmDialog`：`role="dialog" aria-modal`、打开即聚焦、遮罩 mousedown 关闭、Esc 关栈顶、confirm = sm 宽 + ghost 取消 + primary|danger 确认）与 772-777、1129-1140（`.drawer` 右侧 420/92vw、`wb-drawer-in`、遮罩点击关闭）。

## What Changes
- 新增 `web/src/ui/dialog.tsx`（`Dialog`）、`web/src/ui/confirm-dialog.tsx`（`ConfirmDialog`）、`web/src/ui/drawer.tsx`（`Drawer`）与 `web/src/ui/dialog.css`（三者共用一份 css：overlay/dialog/drawer 规则 + reduced-motion 块），基于 `@radix-ui/react-dialog`（行为层：Portal、FocusScope 焦点进入/循环、DismissableLayer Escape/外点、`hideOthers` 隔离、`aria-labelledby`/`aria-describedby`；`aria-modal="true"` 与无 trigger 时的焦点归还由本组件补齐）。
  - `Dialog`：受控 `open`/`onOpenChange`，`title`（必填，`Dialog.Title`）、`description?`、`size` `sm|md`（默认 md，`ui-dialog--sm|md`）、`initialFocus?: RefObject<HTMLElement | null>`（`onOpenAutoFocus` 改聚焦目标）、`dismissible`（默认 true；false 时 Escape/遮罩不关闭且不渲染右上 `关闭` 按钮）、`children`（body）、`footer?`（`ui-dialog-foot`）、`trigger?`（`Dialog.Trigger asChild`，可选）、`returnFocus?: RefObject<HTMLElement | null>`（关闭后焦点归还目标；未传且无 `trigger` 时归还打开瞬间的 `document.activeElement`，有 `trigger` 时交给 Radix 归还 trigger——Radix 模态 Content 的 `onCloseAutoFocus` 只会聚焦 `Dialog.Trigger`，无 trigger 时焦点会落到 `body`，故由本组件接管归还）。
  - `ConfirmDialog`：`Dialog` 的 `role="alertdialog"` 变体（`size="sm"`、无右上关闭按钮、遮罩点击不关闭、Escape = 取消）；props `open`/`onOpenChange`/`title`/`description`/`cancelText="取消"`/`confirmText`/`danger?`/`onConfirm`/`pending?`/`returnFocus?`（透传 Dialog 内核）；footer 固定为 `Button variant="ghost"`（取消 → `onOpenChange(false)`）+ `Button variant={danger ? "danger" : "primary"} loading={pending}`（→ `onConfirm()`）；标题前 `Icon name={danger ? "triangle-alert" : "info"}`（`Icon` 名集合新增这两个）。
  - `Drawer`：`side` `left|right`（默认 right）、`width` `288|420`（默认 420；映射类名 `ui-drawer--w288|w420`，不写内联 style）、`title`、`children`、`footer?`、`open`/`onOpenChange`；右侧默认 `420px`+`max-width: 92vw`，左侧 288 供 #283 侧栏覆盖层；可 Escape/遮罩关闭，右上 `关闭` 按钮。
- `web/src/ui/index.ts` 增量导出三组件；`web/src/ui/icon.tsx` 名集合 + `triangle-alert`、`info`。
- 新增 `web/test/radix-platform.ts`：jsdom 缺失的 `ResizeObserver`（no-op 类）、`Element.prototype.{hasPointerCapture,setPointerCapture,releasePointerCapture}`、`Element.prototype.scrollIntoView` 四项 shim（仓内 jsdom 29 已有 `PointerEvent`，不补）；由 `web/test/ui-dialog.test.tsx` 引入（后续 1.4 Menu/Popover 与 1.6a/1.6b 页面级 fixture 复用）。
- 新依赖 `@radix-ui/react-dialog`（MIT）；`ATTRIBUTION.md` §3 Radix 条目登记（守卫已要求每个 `@radix-ui/*` 依赖出现在 ATTRIBUTION）。
- 单测 `web/test/ui-dialog.test.tsx`：焦点进入/`initialFocus`/Tab 循环/Escape/遮罩/`dismissible=false`/焦点恢复/portal 到 body/`alertdialog` 角色与按钮文案与回调/Drawer 两向与宽度类名/css 静态契约。

## Non-goals
迁移既有对话框（#280 auth、#302 files）与删除 `lib/dialog.ts`/`dialog-platform.ts`；Menu/Popover/Tooltip（#278）、Toast（#279）；模态栈（demo `modalStack` 多层叠加——S1e 无嵌套模态场景，Radix 天然支持嵌套，不额外建模）；任意数值 `width`（只提供 288/420 两档，避免内联 style；新消费者需要时扩枚举）；`Drawer` 的 `initialFocus`/`dismissible`（无消费者）。

## Capabilities
### Modified
- `ui-primitives`：「基元组件库」整体重述，加入 Dialog/ConfirmDialog/Drawer 契约与 `radix-platform.ts`。

## Impact
- `web/package.json`（+`@radix-ui/react-dialog`）、`package-lock.json`；`web/src/ui/{dialog,confirm-dialog,drawer}.tsx`、`web/src/ui/dialog.css`、`web/src/ui/ui.css`（+1 `@import`）、`web/src/ui/index.ts`、`web/src/ui/icon.tsx`；`web/test/radix-platform.ts`、`web/test/ui-dialog.test.tsx`、`web/test/ui-icon-brand.test.tsx`（图标名清单 +2）；`ATTRIBUTION.md`。
- 不改任何页面/feature；`make ui-walk` 不变。knip：三导出由测试消费。
- 已知延后：Radix Dialog 的 bundle 体积与 portal 定位器改动在首个迁移切片（#280）里验证。

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：呈现类 + 焦点/键盘可访问性契约一次定调，被 #280/#283/#302 继承)
Blast radius: 焦点策略/关闭策略错一处即三个迁移切片与侧栏覆盖层继承；`role="alertdialog"` 若被 Radix 覆盖回 `dialog` 会破坏既有 ui-walk 退出定位语义（#280 迁移时暴露）；jsdom shim 写错会掩盖真实浏览器行为差异。
Selected risk packs: Public API / CLI / script entry（三组件 props 契约与出口）；Config / project setup（Radix 依赖、ATTRIBUTION、测试 shim 文件）；Legacy compatibility / examples（既有 `<dialog>` 实现与 `.logout-dialog`/`.files-dialog` 类名不动）；Release / packaging / dependency compatibility（react-dialog 及其传递依赖、jsdom 兼容性）；Documentation / migration notes（shim 用法与迁移切片的定位器改动预告）。
Evidence floor: `make check` exit 0；`ui-dialog.test.tsx` 先红后绿，且焦点循环/恢复/Escape/遮罩/dismissible 每条各有可判别断言；`npm run build --workspace web` 通过；`make ui-walk`（CI 环境变量方式）exit 0。
