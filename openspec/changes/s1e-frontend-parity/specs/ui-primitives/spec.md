# Spec: ui-primitives

## ADDED Requirements

### Requirement: 设计 token 全集
`web/src/styles/tokens.css` SHALL 定义 demo（`resource/workbuddy-live-demo.html:19-188`）的调色板层（`--wb-palette-*`）与语义层（`--wb-brand-*`、`--wb-bg-*`、`--wb-text-*`、`--wb-border-*`、`--wb-status-*`、`--wb-shadow-*`、`--wb-icon-*`、`--wb-font*`、`--wb-mono`）全部 token，浅色在 `:root`、深色在 `[data-theme="dark"]`，值逐字取自 demo；demo 引用但未定义的 `--wb-home-composer-chip-bg-hover`、`--wb-palette-black-60`、`--wb-palette-white-10`、`--wb-palette-white-60`、`--wb-palette-white-20`、`--wb-text-white` SHALL 在此补齐并注明"demo 缺失、本仓补定"。文件头 SHALL 保留 token 来源说明（WorkBuddy 5.3.11 token 文件，经 demo；ATTRIBUTION.md §4）。`--wb-font-heading` 是唯一允许与 demo 值不同的变量：SHALL 去掉 `Poppins`、只列本地/系统字体栈，不得 `@import`/`<link>` 任何公网字体。仓内既有但 demo 无的 `--wb-home-bg`/`--wb-control-bg` SHALL 迁入 `tokens.css` 并注明"本仓既有、demo 无"（或改为等价 demo 语义 token 后删除）。feature 样式 SHALL 只引用语义层 token，不得直接引用 `--wb-palette-*` 或硬编码颜色（`web/test` 以 grep 断言 `web/src/features/**/*.css` 与 `web/src/routes/**` 无 `#[0-9a-fA-F]{3,8}`、`rgb(`、`--wb-palette-`）。

#### Scenario: token 完整且分层
- WHEN 读取 `tokens.css` 并对照 demo `:root` 与 `[data-theme="dark"]` 两块
- THEN demo 定义的每个 `--wb-*` 变量名在对应主题块中存在且值逐字相等（`--wb-font-heading` 期望为去掉 `Poppins,` 后的串）；六个补定变量在两块中都存在；`web/src/features/**/*.css`、`web/src/routes/**` 中无硬编码颜色与调色板引用；构建产物无公网字体请求

### Requirement: 基元组件库
`web/src/ui/` SHALL 以 Radix UI Primitives（`@radix-ui/react-dialog`、`react-dropdown-menu`、`react-popover`、`react-toast`、`react-switch`、`react-radio-group`、`react-tooltip`）为行为层、以 token 为样式层，导出且仅导出：`Button`（variant `primary|secondary|ghost|danger`，size `sm|md|lg|icon`，`loading` 态禁用并保留宽度）、`Input`（含 `search` 变体）、`Switch`、`Tag`（`brand|success|warning|error|neutral`）、`Chip`（可选中）、`Dialog`（模态；`size sm|md`；打开聚焦首个可聚焦控件或 `initialFocus`；Escape/遮罩关闭可被 `dismissible=false` 禁止；关闭恢复触发器焦点）、`ConfirmDialog`（`role="alertdialog"`，标题/说明/`取消`/确认按钮文案与 `danger` 开关）、`Drawer`（`side: "left"|"right"`，默认 right 宽 `420px` 且 `max-width:92vw`；`width` 可覆盖，左侧用于侧栏覆盖层 `288px`）、`Menu`（`role="menu"`/`menuitem`，键盘上下/Home/End/Escape）、`Popover`（锚定、视口内自动翻转，content 可声明 `role`/`aria-label`）、`Tooltip`（hover/focus 显示，`aria-describedby` 关联）、`Toast`（`success|error|info`，2.4s 自动消失，同时最多 3 条，`aria-live="polite"`；`ToastProvider`/Viewport 挂在应用根，feature 经 `useToast()` 触发）、`EmptyState`（icon/title/desc 三段）、`Icon`（单一组件，`name` 为本仓用到的 lucide 图标名联合类型，内部维护 name→组件映射、不逐个再导出；size `12|14|16|18|20`，`aria-hidden` 默认 true，需语义时传 `label`）、`BrandMark`（自有 mark SVG + 可选字标 `WorkBuddy`，`size` 可配，不含任何上游品牌资产）、`SegmentedControl`（基于 RadioGroup，每项 `role="radio"`）。组件自身代码 SHALL 不写内联 `style`（Radix 注入的定位样式 `--radix-*`/`transform` 除外）、类名前缀 `ui-`，`prefers-reduced-motion: reduce` 时禁用过渡与动画；Dialog/Drawer/Menu/Popover/Tooltip/Toast 内容 portal 到 `document.body`（Radix 默认），依赖它们的测试定位器 SHALL 以页面为范围而非 `main`。除 `Icon`/`Chip`/`Tag`/`Input`/`Button`/`BrandMark` 外的组件 SHALL 是既有两处手写 `<dialog>`（`web/src/features/auth/footer.tsx`、`web/src/features/files/dialogs.tsx`）、手写 `role="menu"` 创建菜单（`web/src/features/files/dialogs.tsx`）与手写切换器弹层（`web/src/features/files/page.tsx`）的唯一替代；迁移后 `web/src/lib/dialog.ts` 删除。jsdom 侧 SHALL 以 `web/test/radix-platform.ts` 提供 Radix 所需的 `ResizeObserver`/pointer capture/`scrollIntoView` shim，由页面级 fixture 引入。

#### Scenario: 组件可访问且样式只来自 token
- WHEN 在 jsdom 渲染每个组件并按键盘操作
- THEN `Dialog` 打开时焦点进入、Tab 循环留在框内、Escape 关闭并把焦点还给触发器；`Menu` 用箭头键移动、Enter 触发、Escape 关闭；`Toast` 在 `aria-live` 区域出现并在计时后移除；`SegmentedControl` 三项 `role="radio"` 且箭头键切换；`Tooltip` 聚焦触发器时出现且 `aria-describedby` 指向它；`Icon` 默认 `aria-hidden="true"`、传 `label` 时有可访问名；每个组件根元素类名以 `ui-` 开头，且源码（`web/src/ui/**/*.tsx`）grep 无 `style={`

#### Scenario: 既有对话框迁移不回归
- WHEN 退出确认、新建工作空间、新建文件夹、`＋` 创建菜单、工作空间切换器改用基元后运行既有 `web/test` 与 `make ui-walk`
- THEN 既有断言语义（`alertdialog` 标题 `退出登录？`、`取消`/`退出`、创建校验文案、切换器 `dialog` 名称 `工作空间切换器`、`＋ 新建工作空间`、`menuitem` `新建文件夹`）全部保持通过——定位器由 `main` 范围改为页面范围、原生 `HTMLDialogElement.open`/`cancel` 事件断言改为 Escape keydown；`web/src/lib/dialog.ts` 与 `dialog.test.tsx` 不再存在

### Requirement: 动效与图标
`web/src/ui/motion.css` SHALL 提供 demo 的 `wb-fadein`、`wb-pop`、`wb-pulse`、`wb-caret`、`wb-spin`、`wb-drawer-in` 关键帧与对应工具类（`ui-fadein`、`ui-pop`、`ui-pulse`、`ui-caret`、`ui-spin`），并在 `prefers-reduced-motion: reduce` 下全部禁用；demo 未使用的 `wb-float`/`wb-shimmer` 不移植。图标 SHALL 全部经 `Icon` 取自 `lucide-react`（ISC，打包进产物，运行时零网络请求），`ATTRIBUTION.md` SHALL 新增 lucide（ISC）与 Radix UI Primitives（MIT）条目。

#### Scenario: 图标离线、动效可禁用且归属登记
- WHEN `make ui-walk` 的 `desktop-light` project 在 journey 内统计 resourceType 为 `image|font|stylesheet|script` 的 `requestfailed`（导航/SSE 取消的 `net::ERR_ABORTED` 不计）与非 `baseURL` 源的请求，并在受控回合运行中对 `.ui-pulse` 元素先 `emulateMedia({reducedMotion:"reduce"})` 再恢复 `no-preference`；`web/test` 静态读取 `motion.css`
- THEN 全 journey 零静态资源 `requestfailed`、零跨源请求（图标离线可用）；reduce 下 `animationName` 为 `none`、恢复后非 `none`；`motion.css` 的 reduced-motion 块把每个 `ui-*` 动效类置为 `animation: none` 且 `transition: none`；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目
