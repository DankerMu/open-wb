# Design: topbar-actions-slot（#529）

父设计：D8「顶栏 actions 插槽」、「模块拆分」web 图标清单。行号为 origin/master。

- **Change surface**：`web/src/ui/icon.tsx`（97 行：lucide import 列表 :1-39、`ICONS` :42-79）；`web/src/lib/topbar.tsx`（39 行）；`web/src/routes/shell/topbar.tsx`（50 行）；`web/src/routes/shell/topbar.css`（49 行）；新建 `web/test/topbar-actions.test.tsx`。装配点 `web/src/routes/shell/app-shell.tsx:26-44`（`TopbarProvider` 包住 `Topbar` 与页面）不改。
- **Governing invariant**：页面只经描述符通道向顶栏注入按钮，shell 是唯一渲染者；描述符的可比较字段（`key`/`label`/`icon`/`expanded`）不变时 shell 不更新，`onSelect` 永远是上报方最近一次渲染的回调；没有上报就没有 `.topbar-actions`，三态 DOM 与现状相同。
- **Must preserve**：
  - `useTopbar({breadcrumb})` 既有调用方（`features/chat/page.tsx`）不改且行为不变：layout effect 上报、变更即更新、卸载或 `undefined` 清空；Provider 外 no-op。
  - 顶栏三态：`/` 无面包屑宽屏不渲染 header、窄屏只含 `打开导航`；`打开导航` 恒为 header 首子节点且三态间不重挂；h1 的 accessible name 不变。
  - `topbar.tsx` 不直接依赖 `@radix-ui`、不 import `features/`；`lib/topbar.tsx` 不 import `routes/`、`features/`（`topbar.test.tsx:281-290` 的源文本断言）。
  - 既有 shell 测试（`topbar.test.tsx`、`app-shell-responsive.test.tsx`、`sidebar.test.tsx`、`sidebar-slot.test.tsx`、`ui-icon-brand.test.tsx`）零 diff 全绿；`web/src/features/chat/**` 零 diff。
- **Must add/change**：
  - `icon.tsx`：`star`→`Star`、`pencil`→`Pencil`、`trash`→`Trash`、`more-horizontal`→`Ellipsis`、`package`→`Package`、`download`→`Download`、`globe`→`Globe`、`palette`→`Palette`、`chevron-up`→`ChevronUp`、`filter`→`Funnel`（lucide-react 1.48.0 均有此导出；`MoreHorizontal`/`Filter` 只是 `Ellipsis`/`Funnel` 的别名，注册表既有项一律用规范名）；只追加，不重排既有项。
  - `lib/topbar.tsx`：
    - `export type TopbarAction = { key: string; label: string; icon: IconName; expanded?: boolean | undefined; onSelect(trigger: HTMLElement): void }`（`expanded` 带 `| undefined`：`exactOptionalPropertyTypes` 下后续会话页要能从一个有序常量统一 map 出 `expanded: cond ? open : undefined`；运行时缺省与 `undefined` 本就等价）（`import type { IconName } from "../ui/index.js"`；`ui` 不 import `lib`，无环）。
    - `useTopbar({ breadcrumb, actions }: { breadcrumb?: string | undefined; actions?: readonly TopbarAction[] | undefined })`（`exactOptionalPropertyTypes` 下调用方要能传 `cond ? list : undefined`）。面包屑的 effect **保持原样不合并**。`actions` 的上报形状写死为：
      - **上报 effect 无依赖数组、无 cleanup，每次渲染都跑**：先把各项 `onSelect` 写入 ref（不受浅比较门控；ref 在 effect 里写，不在 render 里写），再 `setActions(prev => same(prev, next) ? prev : next)`——比较基准就是当前 state，不另设镜像 ref；`same` 比较长度与各项 `key`/`label`/`icon`/`expanded`（`===`，缺省与 `undefined` 等价）。未提供 `actions`（`undefined`）与空数组都上报为空。
      - **卸载清空放在独立的 `[set]` 依赖 effect**（同 `lib/sidebar-slot.tsx:38-44`）：只在卸载时把 actions 置空。照抄面包屑的「同一 effect 里 cleanup」会因 `actions` 每次渲染都是新数组而每次先清空再上报、state 引用必变、上报方经 context 重渲染而成环。
      - Provider 的 actions 初始 state 为 `[]`，context value 的 `useMemo` 依赖含 `actions`；`same` 与更新函数必须纯（StrictMode 会双调用更新函数），ref 写入留在 effect 体内、不放进更新函数。
      - **派发前先用渲染期读到的 `context.actions` 比一次**（#713 review）：相同则只写 ref、不调 `setActions`。React 对「返回 `prev` 的更新」虽不调度渲染，但 update 对象仍挂在 Provider 的 hook 队列里直到它下次真正渲染；流式期间上报方每个 delta 渲染一次而 Provider 不渲染，这些 update 会一直持有各次渲染的 `actions` 及其 `onSelect` 闭包（7.2a 起闭包会带上页面 state）。先比后派发让未变化的上报不留下任何东西；`setActions(prev => same(prev, next) ? prev : next)` 仍是权威（渲染期快照可能陈旧：路由交接时新页读到的是旧页的列表，若恰与自己的相同会跳过派发，旧页的卸载清空生效后 context 变化让新页重渲染、effect 重跑而自愈，同一同步 layout 级联内完成）。该性质无法黑盒断言（队列不可观察），以代码检视为证。
      - `useTopbar` 的注释写明：同一时刻只允许一个已挂载调用方，面包屑与 actions 必须由同一次调用上报（只报面包屑的另一调用方每次渲染都会把 actions 压回空）。
      - `key` 唯一是调用方契约，不校验。
    - shell 读取用的 hook（如 `useTopbarActions(): readonly TopbarAction[]`）：返回的数组与各项 `onSelect` 包装函数随 actions state 派生（`useMemo`，依赖为 actions state 与经 context 取得的 ref 对象——后者引用恒定，写上只因 Biome `useExhaustiveDependencies` 不认 context 里的 ref 稳定），state 不变则引用不变；包装函数调用时读 ref 里的最新回调；Provider 外返回空数组。
  - `routes/shell/topbar.tsx`：第二态（`/` 且面包屑非空）与第三态（其它路由）在 h1 之后渲染 `<div className="topbar-actions">`，仅当 actions 非空；每项 `Tooltip label={label}` 包 `Button variant="ghost" size="icon" aria-label={label}`，内含装饰性 `Icon name={icon} size={16}`；`expanded !== undefined` 时带 `aria-expanded={expanded}`，否则不带该属性；`onClick` 以 `event.currentTarget` 调 `onSelect`；React `key` 用描述符 `key`。第一态不渲染。
  - `topbar.css`：`.topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }`（demo:321 `.tb-right`；只用既有 token，无新色值）。
- **Sibling surfaces**：7.2a（`features/chat/topbar-actions.ts` 的 `CHAT_TOPBAR_ACTIONS` 与 `重命名`）、7.6（`产物面板`）、7.7（`对话内搜索`，`aria-expanded` 反映搜索框；断言三按钮全序）；7.1/7.2b/7.3/7.5b 消费新图标；组 8 ui-walk（窄屏下标题省略与按钮不换行的真实浏览器证据）；`sidebar-slot`（不变）。
- **残余**：两页可比较字段完全相同的路由交接里，新页因渲染期快照陈旧而跳过派发、Provider 先以空列表渲染一次再自愈，所以该按钮的 DOM 节点会重挂（同一同步 layout 级联内完成，不出帧；当前只有会话页一个调用方，走不到）；先比后派发使 `setActions(prev => …)` 返回 `prev` 的分支没有用例能走到（它只在快照陈旧且当前 state 恰与上报相同时省一次渲染），该分支与「未变化的上报不入队」同为代码检视性质；卸载只清 state 不清 ref，ref 会留着已卸载页面的闭包直到下次上报（此时没有按钮，调不到）；`Tooltip` 默认 `side="top"`，顶栏贴视口上沿，靠 Radix 碰撞翻转显示，jsdom 测不出，留给 ui-walk；**不支持**多个组件同时调用 `useTopbar`：只报面包屑的调用方每次渲染都把 actions 压回空，另一方的按钮要么永不出现、要么两者互相触发重渲染而成环（#713 review 按 effect 顺序推演，未执行验证）；当前只有会话页一个调用方，注释已写明该约束；`key` 重复不校验（React 会告警）；窄屏长标题 + 多按钮的视觉收口留给 ui-walk。
- **Required evidence**（新建 `web/test/topbar-actions.test.tsx`，jsdom；用测试页面组件 + `TopbarProvider` + `Topbar` + MemoryRouter，不挂真会话页；RED：1–6、8–10、12、13 在实现前红（`useTopbar` 忽略 `actions`、图标名未注册、无 CSS 规则），7、11 是 characterization；8、9 的「消失」断言必须排在「按钮先存在」之后才算红；以实际运行记录）：
  1. 第二态（`/?session=<id>`，上报 `breadcrumb:"T"` 与一项 `{label:"示例操作", icon, expanded:false}`）：banner 内 `示例操作` 按钮位于 level-1 heading 之后（DOM 次序）、在 `.topbar-actions` 内、`aria-expanded="false"`；heading 的 accessible name 恰为 `我的工作 / T`；聚焦按钮后出现 `role="tooltip"` 文本 `示例操作`（content 在 portal 里：`screen.findByRole("tooltip")`，需 `./radix-platform.js`，先例 `ui-popover-tooltip.test.tsx:126-137`）；图标 `aria-hidden`。
  2. 第三态（`/files`，同一描述符但**省略** `expanded` 键，不是传 `undefined`）：按钮没有 `aria-expanded` 属性；heading 恰为 `工作空间`。
  3. 点击按钮恰调用一次 `onSelect`，实参就是该按钮元素。
  4. 多项按数组顺序渲染；数组调换顺序后按钮次序随之改变。
  5. 上报方每次渲染都传新的 `onSelect` 闭包、其余字段不变，重渲染由**上报方自身的本地 state**（如 `useReducer` tick）驱动 N 次，探针是 Provider 下元素稳定的兄弟：探针读到的 actions 数组在 N 次 tick 前后 `Object.is` 相同；上报方渲染次数在挂载稳定后记为 `r0`（首次上报会经 context 让上报方多渲染一次，属预期），N 次 tick 后恰为 `r0+N`；`console.error` 未被调用（无 "Maximum update depth"）；随后点击调用的是最近一次渲染的闭包。
  6. `expanded` 由 `false` 变 `true`：按钮 `aria-expanded` 变为 `"true"`（浅比较识别变化）；`label` 或 `icon` 变化同样更新。
  7. 不提供 `actions`：第二、三态 DOM 中不存在 `.topbar-actions`，header 子节点恰为（窄屏）`打开导航` + heading。
  8. 清空与恢复（每步都先断言按钮存在）：上报方改为不提供 `actions` → 按钮消失、面包屑保留，再次提供**相同**描述符 → 按钮重新出现且点击生效；上报方卸载 → 按钮与面包屑一同消失，重新挂载同一上报方 → 重新出现；空数组等同未提供。
  9. 第二态 → 第一态的转移：先在第二态断言按钮存在，上报方随后停止上报标题（仍上报 `actions`）→ 宽屏不渲染 header、窄屏 header 只含 `打开导航`，文档中不存在 `示例操作` 按钮。
  10. 十个新图标名经 `Icon` 渲染出 svg（逐个）；`topbar.css` 的 `.topbar-actions` 规则含 `margin-left: auto` 与 `flex: none`（`ruleBody` 断言，`topbar.test.tsx` 的既有做法）。
  11. Provider 外：调用 `useTopbar({actions})` 不抛；Provider 外单挂 `Topbar`（第三态路由）渲染 heading 且无 `.topbar-actions`。
  12. `<StrictMode>` 下挂载（先例 `topbar.test.tsx:230`、`sidebar-slot.test.tsx:65-72`）：按钮恰一份、点击恰调用一次 `onSelect`。
  14. 节点身份：描述符的 `expanded`/`label` 更新、以及数组调换顺序后，同一 `key` 的按钮仍是**同一个 DOM 节点**（页面拿到的 `trigger` 不会因更新而脱离文档；React `key` 必须只用描述符 `key`）。
  15. 路由交接且两页描述符的可比较字段**完全相同**（只有 `onSelect` 不同）：`navigate` 后按钮在，点击调用的是新页的回调（渲染期快照陈旧时的自愈路径）。
  13. 路由交接：同一 MemoryRouter 内 `/?session=<id>` 与 `/files` 各有一张上报不同描述符的测试页，`navigate` 后新页按钮在、旧页按钮不在（旧页卸载清空不擦掉新页的上报），再导航回去同理。
  - 既有：上列五个 shell 测试文件 `git diff` 为空且全绿；`web/src/features/chat/**` `git diff` 为空。
  - 门禁：`npm test --workspace web`（含覆盖率阈值）、`make lint`、`make typecheck`（无 TS1117）、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate topbar-actions-slot --strict --no-interactive` 通过。
