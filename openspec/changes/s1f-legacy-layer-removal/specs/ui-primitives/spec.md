## MODIFIED Requirements

### Requirement: 设计 token 全集
`web/src/styles/tokens.css` SHALL 是 `--wb-*` 设计 token 的唯一定义处：调色板层（`--wb-palette-*`）与语义层（`--wb-brand-*`、`--wb-bg-*`、`--wb-text-*`、`--wb-border-*`、`--wb-status-*`、`--wb-shadow-*`、`--wb-icon-*`、`--wb-font*`、`--wb-mono` 等），浅色在 `:root`、深色在 `[data-theme="dark"]`。token 的值由本仓拥有，不再要求与 `resource/workbuddy-live-demo.html` 逐值相等，名集合也不再受 demo 约束；文件头 SHALL 保留 token 来源说明（WorkBuddy 5.3.11 token 文件，经 demo；ATTRIBUTION.md §4）。字体 token 只列本地/系统字体栈，不得 `@import`/`<link>` 任何公网字体。`web/src/**/*.css` 引用的每个 `var(--wb-*)` SHALL 在 `tokens.css` 有定义（`web/test` 断言引用集合 ⊆ 定义集合）。feature 与 routes 的样式 SHALL 只引用语义层 token 或 ui-foundation 的主题变量，不得直接引用 `--wb-palette-*` 或硬编码颜色（`web/test` 以 grep 断言 `web/src/features/**`、`web/src/routes/**` 的 `.css`/`.tsx` 以及去掉块注释与 `//` 行注释后的 `.ts` 无 `#[0-9a-fA-F]{3,8}`、`rgba?(`、`--wb-palette-`；Tailwind 任意值类名里的颜色字面量同样命中）。调色板到组件的映射边界只有 ui-foundation 的 `web/src/styles/theme.css`（旧的 `web/src/ui/**/*.css` 已随 s1f-legacy-layer-removal 删除）。

#### Scenario: token 分层且无未定义引用
- **WHEN** 读取 `tokens.css` 并扫描 `web/src`
- **THEN** `:root` 与 `[data-theme="dark"]` 两块都存在；`web/src/**/*.css` 无未定义的 `var(--wb-*)` 引用；`web/src/features/**`、`web/src/routes/**` 中无硬编码颜色（含 `rgba(`）与调色板引用；`tokens.css` 不含 `@import` 与公网字体地址；构建产物无公网字体请求

#### Scenario: 不再与 demo 逐值绑定
- **WHEN** 修改 `tokens.css` 中某个 token 的值，或新增一个 demo 没有的 `--wb-*` token，然后执行 `npm test --workspace web`
- **THEN** 没有测试因「与 demo 不相等」或「名集合多出变量」而失败

### Requirement: 动效与图标
`Icon` SHALL 是单一组件，位于 `web/src/components/icon.tsx`（自写共享组件，见 ui-foundation「组件分层」；自 s1f-legacy-layer-removal 起从 `web/src/ui/icon.tsx` 搬来，组件与名字不变）：`name` 为本仓用到的 lucide 图标名联合类型 `IconName`，内部维护 name→组件映射、不逐个再导出 lucide 图标；size `12|14|16|18|20`（类名 `ui-icon ui-icon-<size>`，规则在 ui-foundation 规定的 `theme.css` `base` 块里）；默认 `aria-hidden="true"`，传 `label` 时为 `role="img"` 且以 `label` 为可访问名。图标 SHALL 取自 `lucide-react`（ISC，打包进产物，运行时零网络请求）——经 `Icon`，或按 ui-foundation「组件分层」在拷入层与应用层直接导入。`web/src/ui/motion.css` 及其 `wb-*` 关键帧与 `ui-fadein`、`ui-pop`、`ui-pulse`、`ui-caret`、`ui-spin` 工具类 SHALL 不存在（它们的使用方只有已删除的旧基元）；应用里的动效由 Tailwind 的 `animate-*` 工具类、`tw-animate-css` 与 `tw-shimmer` 提供。运行中会话的状态标记 SHALL 在 `prefers-reduced-motion: reduce` 下停止动画、恢复 `no-preference` 后继续（全局块见「全局 reduced-motion 规则」）。`ATTRIBUTION.md` SHALL 保有 lucide（ISC）与 Radix UI Primitives（MIT）条目。

#### Scenario: 图标可访问、动效可禁用、归属登记
- **WHEN** 在 jsdom 渲染从 `web/src/components/icon.tsx` 导入的 `<Icon name="folder" />` 与 `<Icon name="folder" label="目录" size={12} />`，并静态读取 `ATTRIBUTION.md`、列出 `web/src` 下的 `.css` 文件
- **THEN** 第一个 svg `aria-hidden="true"`、类名含 `ui-icon` 与 `ui-icon-16`；第二个 `role="img"`、可访问名 `目录`、类名含 `ui-icon-12`；`web/src/ui/motion.css` 不存在；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目

#### Scenario: 图标离线、动效可禁用且归属登记
- **WHEN** `make ui-walk` 的 `desktop-light` project 在 journey 内统计 resourceType 为 `image|font|stylesheet|script` 的 `requestfailed`（导航/SSE 取消的 `net::ERR_ABORTED` 不计）与非 `baseURL` 源的请求（verification-harness 规定的隔离预览来源例外除外），并在受控回合运行中对运行中会话的状态标记（`[data-status-mark="running"]`）先 `emulateMedia({reducedMotion:"reduce"})` 再恢复 `no-preference`
- **THEN** 全 journey 零静态资源 `requestfailed`、零计入的跨源请求（图标离线可用）；reduce 下该标记的 `animationName` 为 `none`、恢复后非 `none`；`ATTRIBUTION.md` 含 `lucide`/ISC 与 `Radix`/MIT 条目

### Requirement: 按钮单一实现与旧类退役
旧基元 `Button`（类名 `ui-btn ui-btn--<variant> ui-btn--<size>`）已随 `web/src/ui/` 删除（s1f-legacy-layer-removal）；应用里的按钮经 ui-foundation 拷入层的 `@/components/ui/button` 或带 Tailwind 类的原生 `button` 渲染，不带 `ui-btn` 类。旧 `.ui-button`、`.ui-button-primary`、`.ui-button-danger` 类及其规则 SHALL 不存在于 `web/src`，`web/src` 下 `.ts`/`.tsx`/`.css` 不得再出现 `ui-button`。`.ui-alert`/`.ui-muted`/`.ui-empty` 不在本条范围（它们的规则见 ui-foundation「Tailwind 入口与层叠顺序」）。此前的迁移 SHALL 保持各按钮的可访问名、`type`、禁用态、点击行为与作为菜单触发器时的回焦不变。`web/test/ui-guardrails.test.ts` SHALL 有扫描 `web/src` 的 grep 守卫，并以注入样本自证其匹配式命中 `ui-button` 且不命中 `ui-btn`。

#### Scenario: 旧类清零且守卫自证
- **WHEN** 扫描 `web/src` 下全部 `.ts`/`.tsx`/`.css`，并对注入样本 `<button className="ui-button">` 与 `<button className="ui-btn ui-btn--md">` 运行同一匹配式
- **THEN** 仓库扫描零命中，注入样本恰命中 1 条（`ui-button` 行），`ui-btn` 行不命中

#### Scenario: 迁移后行为不回归
- **WHEN** 渲染侧栏的 `新建会话`、文件预览的 `查看源码`/`渲染视图`、切换器里的 `＋ 新建工作空间`、`新建`（`＋` 菜单的触发器）、创建对话框的 `取消`/`创建`
- **THEN** 它们的类名都不含 `ui-btn`（文件页的五个按钮经 `@/components/ui/button`；`新建会话` 建在拷入层上——session-sidebar「分组侧栏」规定其名称与行为不变；旧 `Button` 基元已不存在）；可访问名不变，`创建`仍为 submit 且挂起期禁用，`新建`菜单开合与关闭回焦不变

### Requirement: 全局 reduced-motion 规则
`web/src/styles.css` 的全局 `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }` 块 SHALL 保持未分层（不放进任何层，从而压过 Tailwind utilities 设定的动画时长），且只声明 `animation-duration`、`animation-iteration-count` 与 `scroll-behavior`，SHALL NOT 声明任何 `transition` 或 `transition-*` 属性。原因：`transition-property` 初值为 `all`，只设时长会给所有元素隐式新建过渡；首帧（亮色）之后切换主题时，继承色文字会在若干帧内保持旧主题颜色（#423）。组件自己声明的过渡 SHALL 由各自 CSS 文件内的 reduce 块置为 `transition: none`：`web/src/**/*.css` 中每条在普通规则里声明非 `none` 的 `transition` 或 `transition-*` 的规则，其每个选择器都 SHALL 在同一文件中、源码顺序位于该规则之后的顶层 reduce 块内有同选择器（分组选择器按逗号拆分）的 `transition: none` 覆盖；只有覆盖、没有声明的 reduce 规则允许存在。自 s1f-legacy-layer-removal 起 `web/src` 的三个样式文件里没有声明非 `none` 过渡的规则（声明过渡的旧基元样式已删除），本句作为对日后新增规则的约束保留，由守卫以注入样本自证。以 Tailwind `transition*` 工具类声明的过渡（拷入层与已迁移区域）SHALL 由 `web/src/styles/theme.css` 中一条未分层的 reduce 规则统一置为 `transition: none`（选择器匹配类名含 `transition` 的元素），不逐组件改写拷入代码。`animation-*` 与各组件既有的 reduced-motion 行为保持不变。

#### Scenario: reduce 下切换主题，继承色立即生效
- **WHEN** `make ui-walk` 两个 project 在 `/settings` 的主题步骤中先 `emulateMedia({reducedMotion:"reduce"})`，再在同一次 `page.evaluate` 内确认 `matchMedia("(prefers-reduced-motion: reduce)").matches` 为 true、`data-theme` 不等于目标主题，然后点击目标主题 radio，并立即读取设置页两张卡的标题、三个行标题（按角色/文本定位）以及 `desktop-light` 的主导航链接（至少 1 个）的计算 `color` 与 `getAnimations()`
- **THEN** 点击后 `data-theme` 等于目标主题；继承色元素的 `color` 等于目标主题的 `--wb-text-primary`（`desktop-light` 切到深色为 `rgb(255, 255, 255)`，`mobile-dark` 切到浅色为 `rgb(0, 0, 0)`）；所读元素的 `getAnimations().length` 均为 0；随后恢复 `no-preference`，既有持久化断言仍成立

#### Scenario: reduce 下拷入组件无动画与过渡
- **WHEN** `make ui-walk` 在 `emulateMedia({reducedMotion:"reduce"})` 下打开用户菜单与（窄屏 project）导航覆盖层，并读取打开后的菜单/覆盖层内容元素与一个带 Tailwind `transition*` 类的按钮
- **THEN** 内容元素的计算 `animation-duration` 不大于 `0.01ms`；该按钮的计算 `transition-property` 为 `none`

#### Scenario: 全局块不新建过渡、组件过渡各有在后的覆盖
- **WHEN** 静态读取 `web/src/styles.css` 与 `web/src/**/*.css`（去注释后按顶层块遍历），并对注入样本执行同一判定
- **THEN** 全局 `*` reduce 块不含 `transition` 前缀的声明，但仍含 `animation-duration`、`animation-iteration-count`、`scroll-behavior`；仓库内每条声明非 `none` 过渡的规则（现状为零条，守卫不再要求该集合非空），其每个选择器都在其文件中源码顺序靠后的顶层 reduce 块内有 `transition: none`；除 reduce 块外的 `@` 块内出现 `transition` 声明即判失败；注入样本"缺覆盖"与"覆盖位于声明之前"判失败，"分组选择器覆盖位于声明之后"判通过

## ADDED Requirements

### Requirement: 覆盖层的 Escape 关闭
应用里允许 Escape 关闭的覆盖层——外壳的 `导航` 覆盖层、退出确认框、会话的重命名与另存为工作空间对话框、会话删除确认框、撤回冲突确认框、权限档位 `全部自动` 的确认框、项目配置弹层、窄屏下的工作空间侧边栏模态层、文件的创建 / 重命名 / 移动对话框与文件删除确认框——SHALL 保证：焦点位于该覆盖层内容的 DOM 子树内时，一次 Escape 使该覆盖层关闭，确认动作不被触发；Escape 的事件目标位于 portal 在外的嵌套层（覆盖层内打开的菜单、弹层或另一个对话框）时 SHALL 只关闭最内的那一层，外层保持打开，再按一次才关闭外层。这是用户可见的行为保证，不规定实现方式。Toast 删除（s1f-legacy-layer-removal）之后 SHALL 逐个覆盖层实测 Radix 自身的 Escape 分派是否已满足上述保证：全部满足则 `useEscapeFallback` 及其全部调用删除；任一不满足则保留该 hook，放在 `web/src/components/escape-fallback.ts`（自写共享模块，见 ui-foundation「组件分层」），由应用层经组件 props 接到覆盖层的内容元素上，不改拷入代码。保留时该兜底 SHALL NOT 让同一次 Escape 把关闭回调调用两次（Radix 已分派到本层的那次事件，兜底不再处理），SHALL NOT 在输入法组合中触发关闭，SHALL NOT 响应事件目标在本层内容子树之外的 Escape；这三条是兜底自身的性质，以组件级测试断言（Radix 自己不判输入法组合，整层行为断言不了后两条）。保留时，实测中不通过的那个现象 SHALL 有常驻证据：jsdom 能复现的是一条单测，只在真实浏览器复现的是 `make ui-walk` 的一个步骤。两种结果都是合法终态；实测结论与（保留时）需要它的覆盖层 SHALL 记入 ADR-0013 的增补。

#### Scenario: 一次 Escape 关闭所在覆盖层恰一次
- **WHEN** 在 jsdom（引入 `radix-platform.ts`）中分别打开上列每个覆盖层，焦点在其内容内，按一次 Escape
- **THEN** 该覆盖层关闭（按角色与名称再也查不到它），它外层的页面与覆盖层仍在；确认框的确认动作未被触发（退出确认发出 0 次 `POST /api/auth/logout`，会话与文件的删除确认发出 0 次删除请求，`全部自动` 确认框不提交档位）；焦点按各自规格归还

#### Scenario: 嵌套层只关最内一层
- **WHEN** 窄屏已登录应用中打开 `导航` 覆盖层，在其中打开用户菜单，层栈交接完成后按 Escape；另一例在 `导航` 覆盖层内打开退出确认框后按 Escape
- **THEN** 前者只有菜单关闭、`dialog 导航` 仍在，再按一次 Escape 才关闭覆盖层；后者只有确认框关闭、覆盖层仍在、未发起退出

#### Scenario: 真实浏览器里的 Escape
- **WHEN** `make ui-walk` 的两个 project 运行其既有的 Escape 步骤（`mobile-dark` 的 `导航` 覆盖层、项目配置弹层、窄屏的工作空间侧边栏模态层）
- **THEN** 每一步一次 Escape 之后对应的覆盖层关闭、焦点按各自规格归还，走查全绿；`useEscapeFallback` 保留且实测中不通过的现象只在真实浏览器复现时，走查另含复现该现象的那一步（去掉该覆盖层的兜底则这一步失败）

#### Scenario: 保留兜底时不重复、不抢输入法
- **WHEN** `useEscapeFallback` 存在（见「兜底只有两种合法终态」），在 jsdom 中：(1) 把它接在一个不经 Radix 的普通元素上，分别派发子树内的一次 Escape、`isComposing: true` 的 Escape、目标在该元素之外的 Escape，以及一次已先经它的 `onEscapeKeyDown` 标记过的 Escape；(2) 把它按应用层的写法接在拷入层 `dialog` 的内容元素上（引入 `radix-platform.ts`），焦点在内容内按一次 Escape
- **THEN** (1) 第一种情形关闭回调以 `false` 恰被调用一次，其余三种情形兜底都不调用关闭回调；(2) Radix 的分派与兜底都经过，关闭回调以 `false` 恰被调用一次；`useEscapeFallback` 不存在时本场景不适用

#### Scenario: 兜底只有两种合法终态
- **WHEN** 扫描 `web/src` 下全部 `.ts`/`.tsx`
- **THEN** 要么 `useEscapeFallback` 不出现在任何文件里（定义与调用都没有），要么它的定义恰一处、在 `web/src/components/escape-fallback.ts`；任何情况下 `web/src/ui/escape-fallback.ts` 都不存在；对注入样本（`web/src/features` 下一个文件定义同名函数、`web/src/ui/escape-fallback.ts` 重新出现）守卫各判失败

### Requirement: 品牌标记与取色边界
`BrandMark` SHALL 位于 `web/src/components/brand-mark.tsx`（自写共享组件，见 ui-foundation「组件分层」；自 s1f-legacy-layer-removal 起从 `web/src/ui/brand-mark.tsx` 搬来，组件与名字不变），只含自有 mark SVG（沿用现有对勾图形）与可选字标 `WorkBuddy`，`size` 可配，不含任何上游品牌资产；无字标时 svg 为 `role="img"` 且可访问名为 `WorkBuddy`，有字标时 svg 为装饰、可访问名由字标文本提供。`BrandMark` 与 `Icon`（见「动效与图标」）用类名取样式（`ui-brand*`、`ui-icon*`，规则在 ui-foundation 规定的 `theme.css` `base` 块里），这两个文件 SHALL NOT 出现颜色字面量、`--wb-palette-` 引用与 `style={` 内联样式。搬家只改位置与导入路径，组件的属性、类名与渲染结果不变。旧基元层的出口 `web/src/ui/index.ts` SHALL 不存在，也不另建新的统一出口：使用方直接从这两个文件导入。调色板到组件的取色边界见「设计 token 全集」：`web/src/features/**`、`web/src/routes/**` 与直接放在 `web/src/components/` 下的自写文件只引用语义 token 或主题变量。

#### Scenario: 出口与品牌
- **WHEN** 在 jsdom 渲染从 `web/src/components/brand-mark.tsx` 导入的 `<BrandMark />` 与 `<BrandMark wordmark />`，并静态读取 `web/src/components/brand-mark.tsx`、`web/src/components/icon.tsx` 与 `web/src/ui`
- **THEN** `BrandMark` 渲染 svg，仅 `wordmark` 时出现文本 `WorkBuddy`；无字标时 svg 为 `role="img"`、可访问名 `WorkBuddy`；两个文件都没有 `style={`；`web/src/ui/index.ts` 不存在，`web/src/components/index.ts` 与 `web/src/components/index.tsx` 也不存在（对注入样本「`web/src/components/index.ts` 出现」守卫判失败），`Icon`、`IconName` 与 `BrandMark` 分别从这两个文件导入

#### Scenario: 取色边界
- **WHEN** 静态扫描 `web/src/features/**/*.{css,tsx}`、`web/src/routes/**` 与 `web/src/components/` 下直接放置的 `.tsx`
- **THEN** 所有路径无 `#[0-9a-fA-F]{3,8}` 与 `rgba?(` 字面量，也无 `--wb-palette-`；`web/src/styles/theme.css` 引用的 `--wb-palette-*` 与 `--wb-*` 均在 `tokens.css` 有定义；扫描到的三组路径都非空（守卫没有放空）

### Requirement: 手写对话框迁移不回归
既有手写 `<dialog>` 的迁移 SHALL 分两刀且行为等价：auth 侧（`web/src/features/auth/footer.tsx`）的退出确认 SHALL 为 `role="alertdialog"` 的确认框（确认按钮 `退出`、危险样式；取消按钮在 pending 时文案为 `关闭` 否则 `取消`；pending 时确认按钮忙碌禁用并显示提示行；由 ui-foundation 拷入层的 `alert-dialog` 渲染；它的忙碌期焦点行为是——`pending` 由 false 变 true 时若焦点所在控件在确认框内且被禁用，或焦点已落到 `document.body`，焦点 SHALL 移到取消按钮（焦点在确认框外其它元素上时不移动）（此时文案为 `关闭`），Tab/Shift+Tab 仍停在确认框内——由 `footer.tsx` 在应用层实现，不改拷入代码），feature 不再持有 `<dialog>`/焦点循环/键盘处理代码，`returnFocus` SHALL 在关闭时刻按 trigger 是否禁用归还到 trigger 或 `aside` 内 `a[aria-current=page]`（两支各有断言）；退出语义（标题 `退出登录？`、说明文案、恰一次 `POST /api/auth/logout`、同 tick 双击去重、pending 中关闭不取消请求、失败回滚并显示 `alert`、卸载中止请求）SHALL 与迁移前一致；`styles.css` 的 `.logout-dialog*` 规则 SHALL 随之删除。jsdom 侧因 Radix portal 与 `hideOthers` 的定位改法 SHALL 为：打开期间取页面元素用 `{ hidden: true }`、原生 `HTMLDialogElement.open`/`cancel` 事件改为 `aria-modal` 断言与 Escape keydown、焦点归还断言经 `waitFor`；渲染该 footer 并打开对话框的测试 SHALL 引入 `web/test/radix-platform.ts`。files 侧（`web/src/features/files/`）SHALL 同样不持有手写对话框：`新建工作空间`/`新建文件夹` 两个表单对话框由拷入层的 `dialog` 渲染（请求进行中提交按钮禁用；遮罩点击关闭与 `取消` 同义，其余行为等价），`＋` 创建菜单由拷入层的 `dropdown-menu` 渲染，工作空间切换器由拷入层的受控 `popover` 渲染（弹层保留 `role="dialog"` 与可及名 `工作空间切换器`）；它们的界面行为由 files-web 规定；`web/src/lib/dialog.ts`、`web/test/dialog.test.tsx` 与已无使用者的 `web/test/dialog-platform.ts` SHALL 删除，`web/src` SHALL 不再含 `<dialog`、`showModal`、手写 `role="menu"`。
`web/test/radix-platform.ts` SHALL 只在 jsdom 缺失时补 `ResizeObserver`、`Element.prototype.{hasPointerCapture,setPointerCapture,releasePointerCapture,scrollIntoView}` 四项，不覆盖已有实现、不补 `PointerEvent`（jsdom 29 已有）；渲染拷入层覆盖层组件（对话框、确认框、菜单、弹层、提示）的测试 SHALL 引入它。`web/test/ui-support.ts` SHALL 提供 `yieldMacrotask`/`pressPointer`/`ruleBody` 三个 helper 供这些测试共用。会话重命名对话框关闭时的焦点归还 SHALL 以 `focus({ preventScroll: true })` 进行：归还不滚动任何容器。

#### Scenario: 退出确认迁移不回归
- **WHEN** 在 jsdom（引入 `radix-platform.ts`）渲染已登录应用并点击侧栏 `退出登录`，分别执行：点击 `取消`；按 Escape；点击 `退出` 后按 Escape（logout 挂起）；同 tick 双击 `退出`；确认后卸载；logout 返回 403 后再次打开并成功；并静态读取 `footer.tsx`、`styles.css`
- **THEN** `alertdialog` 标题 `heading` `退出登录？`、说明文案存在、`aria-modal="true"`、初始焦点在 `取消`；`取消`/Escape 关闭且 0 次 logout，Escape 后焦点回 trigger；pending 中 `关闭` 按钮存在、Escape 关闭后请求仍在（恰 1 次）且页面 heading 仍在、焦点回到 trigger（`用户菜单` 在退出请求进行中保持可用，见 spa-shell「路由 IA 与侧栏」），204 后回登录页；双击恰 1 次 logout、确认按钮 disabled、trigger 保持可用；卸载后请求 signal aborted 且无 `console.error`；403 后对话框关闭、footer `alert` 显示错误、重试可成功；`footer.tsx` 不含 `lib/dialog`/`<dialog`/`trapDialogFocus`，`web/src` 的样式文件不含 `.logout-dialog`；CI `make ui-walk` 退出段（定位已为页面范围，不改）通过，经 `render-app-router` 打开退出对话框的既有 `chat-page-lifecycle` 用例不改仍绿

#### Scenario: 退出确认框忙碌期焦点
- **WHEN** 在 jsdom 渲染已登录应用，打开退出确认框并点击 `退出` 使 logout 挂起（确认按钮随即忙碌禁用）
- **THEN** 活动元素为取消按钮（文案 `关闭`），Tab 与 Shift+Tab 后焦点仍在确认框内；真实浏览器由 `make ui-walk` 退出段的既有断言证明

#### Scenario: 既有对话框迁移不回归
- **WHEN** 退出确认、新建工作空间、新建文件夹、`＋` 创建菜单、工作空间切换器由拷入层组件渲染后运行既有 `web/test` 与 `make ui-walk`
- **THEN** 既有断言语义（`alertdialog` 标题 `退出登录？`、`取消`/`退出`、创建校验文案、切换器 `dialog` 名称 `工作空间切换器`、`＋ 新建工作空间`、`menuitem` `新建文件夹`）全部保持通过——定位器由 `main` 范围改为页面范围、原生 `HTMLDialogElement.open`/`cancel` 事件断言改为 Escape keydown；`web/src/lib/dialog.ts` 与 `dialog.test.tsx` 不再存在

#### Scenario: 焦点归还不滚动
- **WHEN** 转录贴底、回合仍在输出，用户从顶栏 `重命名` 按钮打开会话重命名对话框（标题 `重命名任务`，由拷入层的 `dialog` 渲染），期间正文继续增长，随后以 Escape 或 `取消` 关闭
- **THEN** 焦点回到该 `重命名` 按钮，转录不因焦点归还而滚动、仍贴底跟随，不出现 `回到最新`；归还调用的入参为 `{ preventScroll: true }`

## REMOVED Requirements

### Requirement: Escape 分派不受 Toast 层栈影响
**Reason**: 这条规定的是 Toast 与旧基元 `Dialog` / `ConfirmDialog` / `Drawer` 共用 Radix DismissableLayer 层栈时的 Escape 交接。owner 2026-10-12 裁定 Toast 直接删除、不提供替代；旧的三个覆盖层基元在产品代码里已没有调用方，随 s1f-legacy-layer-removal 一起删除。四个场景里三个以 Toast 在场为前提（「Toast 在场时打开导航覆盖层后立即 Escape」「覆盖层打开期间出现 Toast」「焦点不在通知区时 Escape 不关 Toast」），前提消失后无从成立；条文标题本身也以 Toast 为名。
**Migration**: 仍然有效的用户可见保证——一次 Escape 恰好关闭所在覆盖层一次、嵌套菜单只关自己——改由新增的「覆盖层的 Escape 关闭」规定，覆盖对象换成现在实际存在的覆盖层（都由拷入层组件渲染）。原场景「无 Toast 时不重复关闭，嵌套菜单只关自己」的两个断言分别进入新条文的场景「一次 Escape 关闭所在覆盖层恰一次」与「嵌套层只关最内一层」；「不重复关闭」的计数断言与输入法组合的断言进入场景「保留兜底时不重复、不抢输入法」（只在兜底保留时适用）。`useEscapeFallback` 的去留由新条文规定的实测决定（design D4）。通知区对 Escape 的响应不再有对应物：应用里没有 Toast。

### Requirement: 基元组件库
**Reason**: 这条是 `web/src/ui/` 基元层的规格：出口 `ui/index.ts` 的导出清单，以及 `Button`、`Input`、`Switch`、`Tag`、`Chip`、`Dialog`、`ConfirmDialog`、`Drawer`、`Menu`、`Popover`、`Tooltip`、`SegmentedControl`、`ToastProvider` / `useToast`、`EmptyState` 各自的属性、类名与样式映射。所有页面迁到拷入层之后，这十三个基元在产品代码里已没有导入方（#1393 清点一），Toast 由 owner 2026-10-12 裁定直接删除；s1f-legacy-layer-removal 把它们连同整个目录删除。十一个场景里五个只描述已删除的基元，无从改写：「表单级基元可访问且状态可断言」「模态基元可访问且关闭策略可断言」「弹出与分段基元可访问且键盘可断言」「通知与空态可断言」「忙碌期焦点留在模态内」。OpenSpec 的 MODIFIED 不能去掉既有场景，所以整条移除，仍然有效的内容另立新条。
**Migration**: 仍然有效的内容原样迁入两条新条文——`BrandMark`、不设统一出口与取色边界进「品牌标记与取色边界」（场景「出口与品牌」「基元层取色边界」改写后保留，后者更名为「取色边界」）；退出确认与文件页对话框的迁移条款、`radix-platform.ts` 与 `ui-support.ts` 的约定、重命名对话框的焦点归还进「手写对话框迁移不回归」（场景「退出确认迁移不回归」「退出确认框忙碌期焦点」「既有对话框迁移不回归」「焦点归还不滚动」保留）。`Icon` 的条款本来就在「动效与图标」。「features 与 routes 不直接导入 Radix」由 ui-foundation「组件分层」的场景「应用层不直接引 Radix」规定；`ATTRIBUTION.md` 列出每个 `@radix-ui/*` 依赖由 ui-foundation「拷入层的门槛豁免」的场景「归属登记完整」规定，这里不再重复。界面上需要按钮、输入框、开关、对话框、确认框、抽屉、菜单、弹层、提示、分段选择与空态的地方，使用 ui-foundation 拷入层的 shadcn/ui 组件加 Tailwind 类；应用层各对话框自己的忙碌期焦点行为：退出确认见新条文「手写对话框迁移不回归」，文件对话框见 files-web「创建对话框」；会话的重命名与删除确认框已在应用层实现（`web/src/features/chat/rename-dialog.tsx`、`delete-dialog.tsx`），但 session-sidebar 尚无对应条文——这是 s1f-session-list-temp-space 留下的既有缺口，不由本 change 引入或修补。没有通知组件可迁：应用不再有 Toast。
