# Proposal: ui-popup-primitives（#278）

## Why
S1e 组 1 第四刀。既有 `web/src/features/files/dialogs.tsx:84-190` 手写 `role="menu"` 创建菜单（自己实现上下/Home/End/Escape 与焦点归还）、`web/src/features/files/page.tsx:94-165` 手写切换器弹层、`web/src/features/settings/page.tsx:6-38` 三张 radio 卡；侧栏折叠态（#281）需要 Tooltip 与只含 `退出登录` 的用户菜单，设置页（#300/2.5）需要分段控件，files 迁移（#302）需要 `Menu` 与 `Popover`。demo 契约：`resource/workbuddy-live-demo.html:761-770`（`.menu-pop`/`.menu-item`/`--danger`：z 1600、radius 10、padding 4、min-width 180、`wb-pop`）、1055-1084（`openMenu`：`role="menu"`/`menuitem`、锚点下方 +6、视口 8px 内钳位、溢出翻到上方、document click 外点关闭且不吞点击）、779-792（`.pop`：width 300、radius 12、padding 8、z 1300、`max-height:min(70vh,520px)`）、558-562（`.seg`/`.seg button.on`：99px 胶囊、选中 `black-90` 底白字、深色反转）。demo 无 tooltip 规则（用原生 `title`），本仓 Tooltip 样式以 token 类比定义。

## What Changes
- 新增 `web/src/ui/menu.tsx`（`Menu`，`@radix-ui/react-dropdown-menu`）、`popover.tsx`（`Popover`，`@radix-ui/react-popover`）、`tooltip.tsx`（`Tooltip`，`@radix-ui/react-tooltip`）、`segmented-control.tsx`（`SegmentedControl`，`@radix-ui/react-radio-group`）与各自同名 css（`ui.css` +4 `@import`）。
  - `Menu({ trigger, items })`：`trigger: ReactElement`（`DropdownMenu.Trigger asChild`，须能接 ref，如 `Button`）；`items: MenuItem[]`，`MenuItem = { label: string; onSelect: () => void; danger?: boolean; icon?: IconName }`。`Root modal={false}`（demo:1056 外点关闭且点击到达目标；Radix 默认 `modal=true` 会给 body 加 `pointer-events:none` 与 `hideOthers`）；`Content loop sideOffset={6} collisionPadding={8}`（demo:1078-1081）；键盘上下/Home/End/typeahead/Enter/Space/Escape 与关闭后焦点归还 trigger 全部由 Radix 提供，不手写。
  - `Popover({ trigger, children, open?, onOpenChange?, contentRole?, contentLabel? })`：受控与非受控皆可（`open` 未传时 Radix 自管）；content 默认 Radix `role="dialog"`，`contentRole`/`contentLabel` 只在传入时展开为 `role`/`aria-label`（不得以 `role={undefined}` 覆盖掉 Radix 默认值）；未传 `contentLabel` 时 content 无可访问名（调用方自负）。只提供面板壳 `.ui-popover`，列表项/搜索框样式归消费者（#302 用语义 token 或 `Input variant="search"`）。
  - `Tooltip({ label, children, side? })`：每个实例自带 `Tooltip.Provider delayDuration={300} disableHoverableContent`（纯文字 label 无需悬停到内容上；不禁用时 Radix 离开 trigger 后只建宽限区、要等下一次 document pointermove 才关闭。无需应用根挂载，本切片零页面改动；代价是相邻触发器之间无 `skipDelayDuration` 共享，#281 继承）；`children` 为 `Trigger asChild` 的单一元素；`side` 默认 `top`（`right` 供折叠侧栏 2.1）；聚焦即显、hover 300ms 后显、blur/Escape/离开隐藏；可见 content 本身即 `role="tooltip"`（Radix 仅在 Content 传 `aria-label` 时才另渲染隐藏副本，本组件不传），`aria-describedby` 由 Radix 在打开期间指向它。
  - `SegmentedControl<T extends string>({ value, onValueChange, options: readonly { value: T; label: string }[], label })`：`RadioGroup.Root` 类名 `ui-seg`、`aria-label={label}`（既有 `settings-footer.test.tsx:154` 按 `radiogroup` 名 `主题` 定位，2.5 沿用）；每项 `RadioGroup.Item` 类名 `ui-seg-item`（`<button role="radio" aria-checked data-state>`）；箭头键切换由 Radix roving focus 提供（默认 `loop`），选中态样式挂 `[data-state="checked"]`。
- `web/src/ui/index.ts` 增量导出 `Menu`、`type MenuItem`、`Popover`、`Tooltip`、`SegmentedControl`。
- 测试 helper 上收：`ui-dialog.test.tsx` 的 `yieldMacrotask`、`pressOverlay`（改名 `pressPointer`）、`ruleBody` 移入 `web/test/ui-support.ts`，`ui-dialog.test.tsx` 改为导入（避免 jscpd 复制）。
- 单测三文件：`web/test/ui-menu.test.tsx`、`web/test/ui-popover-tooltip.test.tsx`（含 css 静态契约与出口）、`web/test/ui-segmented-control.test.tsx`。
- 新依赖四个 Radix 包（MIT）；`ATTRIBUTION.md:37` 列出全部四个包全名（守卫逐个 `toContain`），"后续切片安装"改为只剩 toast（#279）。

## Non-goals
迁移既有菜单/切换器/radio 卡（#302、#281、2.5）；Toast（#279）；Menu 的分隔线/分组标签/选中勾（demo:767-770，S1e 无消费者）、`align`/`side` 属性（Radix 碰撞处理已覆盖底部用户菜单上翻与右缘钳位）；Popover 的 `initialFocus`/`modal`；Tooltip 的 `TooltipProvider` 应用根共享与 arrow；SegmentedControl 的 `name`/`disabled`/表单提交；视口翻转的 jsdom 断言（零尺寸下不可观察，归 ui-walk/ui-shots）。

## Capabilities
### Modified
- `ui-primitives`：「基元组件库」整体重述，加入 Menu/Popover/Tooltip/SegmentedControl 契约。

## Impact
- `web/package.json`（+4 Radix 包）、`package-lock.json`；`web/src/ui/{menu,popover,tooltip,segmented-control}.{tsx,css}`、`web/src/ui/ui.css`、`web/src/ui/index.ts`；`web/test/ui-support.ts`、`web/test/ui-dialog.test.tsx`（helper 改导入）、三份新测试；`ATTRIBUTION.md`。
- 不改任何页面/feature；`make ui-walk` 不变。knip：四组件与 `MenuItem` 类型由测试消费。`radix-platform.ts` 不改：Radix Popper 依赖的 `ResizeObserver` 已在 shim 内；floating-ui `autoUpdate` 的 `layoutShift` 以 `typeof IntersectionObserver === 'function'` 守卫（`@floating-ui/dom` 1.x `autoUpdate`），jsdom 缺失时自动跳过。

### 与 oracle / demo 的偏差留痕
1. `MenuItem.icon?` 是 issue 键接口 `{label, onSelect, danger?}` 的超集：demo:764/1068 菜单项带图标，#302 创建菜单需要。
2. Tooltip 无 demo 锚点：样式取 `.seg button.on` 反转色对（`--wb-palette-black-90` 底 / `--wb-text-white` 字，深色 `--wb-palette-white-90` / `--wb-palette-black-90`）与 `--wb-shadow-popover`，z-index 1700（高于菜单 1600）。
3. demo:561-562 的 `#fff`/`#111` 按 #276 先例替换为 `--wb-text-white`/`--wb-palette-black-90`（ui css 禁 hex）。
4. `Menu` 用 `modal={false}`：Radix 默认 modal，与 demo:1056 语义不符（外点被吞、页面其它元素被 `aria-hidden`）。
5. `Tooltip.side` 为 2.1 折叠侧栏预置（默认 `top` 与 Radix 一致）。
6. Popover z 1300 < Dialog 1400 照搬 demo，Dialog（1400）/Drawer（1350/1360）之上不能开 Popover——S1e 无此消费者。

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：键盘/角色契约被 #281/#302/2.5 三个迁移切片继承)
Blast radius: Menu 若沿用 Radix modal 默认，#302/#281 迁移后 ui-walk 中打开菜单期间的其它定位与点击会被吞；Popover `role` 若被 `undefined` 覆盖会让切换器失去 `dialog` 角色（ui-walk:387 定位）；SegmentedControl 名称/`aria-checked` 映射错则 2.5 无法沿用既有 `radiogroup`/`radio` 断言；Tooltip 缺 Provider 会在运行时抛错。
Selected risk packs: Public API / CLI / script entry（四组件 props 契约与出口）；Config / project setup（四个 Radix 依赖、ATTRIBUTION、测试 helper 上收）；Legacy compatibility / examples（既有手写菜单/切换器/radio 卡及其测试不动）；Release / packaging / dependency compatibility（四包及传递依赖、floating-ui 在 jsdom 的守卫）；Documentation / migration notes（#281/#302/2.5 的定位器与断言改动预告）。
Evidence floor: `make check` exit 0；三份测试先红后绿，键盘导航/角色/关闭策略每条各有可判别断言；`npm run build --workspace web` 通过；`make ui-walk`（CI 环境变量方式）exit 0。
