# Design: slash-command-menu（#556）

## Context
- `web/src/features/chat/composer.tsx`（128 行）：`Composer` 的 textarea `onKeyDown`（`:48-63`）在非组合态、无修饰键的 Enter 上 `preventDefault` 并 `requestSubmit()`；组合态判据是 `isComposing || keyCode === 229`。没有插槽、没有拦截点。
- `Composer` 只有一处挂载：`web/src/features/chat/conversation-view.tsx:288`（316 行），欢迎态与已选会话共用。`page.tsx`（697 行）经 `ConversationView` 的 prop 传 `draft`、`onChangeDraft={setDraft}`、`composerDisabled`、`onSubmit={submitComposer}`；`composerDisabled` 在 `page.tsx:648` 算出。`submitComposer`（`:563-594`）原样发送 `draft`（不 trim），服务端 `rest.ts` 自己 trim。
- `web/src/lib/api.ts`（722 行）：`ApiClient` 类型（`:127-176`）与 `createApiClient`（`:547`）；会话方法在 `api-sessions.ts`，以 `...createSessionMethods(onUnauthorized, transport)` 展开——`api-commands.ts` 照此写。严格解析辅助：`api-json.ts` 的 `hasExactlyKeys`。
- 服务端（已在 master）：`GET /api/commands` 返回 `{commands:[…]}`，先两条内建（`compact`/`整理上下文`/hint `可选：想保留的重点`，`todo`/`任务清单`/hint `可选：append <任务>`），后平台 skills（`name` 为 `skill:<名>`、`label` 为 `<名>`、hint `可选参数`）；带查询串或 body 的请求是 400（`server/src/sessions/rest-commands.ts`）。
- 先例：#538 的 `useConversationSearch`（hook 放在自己的模块里，`page.tsx` 只加调用与一个 prop；渲染期重置；滚动只在事件处理器里做；IME 守卫）。
- CSS：`web/src/features/chat/chat.css` 现为 798 行（`split("\n").length`），`web/test/chat-steps.test.tsx:138-139` 断言它 ≤ 800——新样式进 `messages.css`（745 行，无行数断言；#538 的先例）。裸色值有全局守卫（`web/test/ui-guardrails.test.ts`），CSS 规则读取辅助 `ruleBody` 在 `web/test/ui-support.ts`。
- lint：`biome.json` 开 `recommended`；带 `aria-activedescendant` 的元素须可聚焦（`useAriaActivedescendantWithTabindex`）、可交互 role 须可聚焦（`useFocusableInteractive`）、有 `onClick` 须有键盘处理（`useKeyWithClickEvents`）。`web/test/chat-composer.test.tsx:189-199` 要求 `composer.tsx` 源码里出现的 `role=` 全是 `role="status"`。
- `client`：`page.tsx:59` 的 `useMemo`，只随登录会话版本变化，渲染间稳定；它变化时 draft 不清空。
- 测试装配：页面用例用真实的 `createApiClient` 加 fetch 替身（`web/test/chat-page-support.tsx` 等），没有手写的 `ApiClient` 替身，所以给 `ApiClient` 加成员不会让既有测试编译失败；既有用例没有以 `/` 开头的 draft，不会触发新的请求。

## Decisions

### D1 `web/src/lib/api-commands.ts`（新）
```ts
export type Command = {
  name: string;
  label: string;
  description: string;
  hint: string | null;
  source: "builtin" | "skill";
};
export function createCommandMethods(onUnauthorized, transport): Pick<ApiClient, "listCommands">
```
- `listCommands(options?)`：GET `/api/commands`（无查询串、无 body），走与 `listSessions` 相同的传输辅助（same-origin、no-store、401 通知、`signal` 透传）。transport 参数的类型只声明用到的成员（`request`、`getRequestOptions`、`requestFailed`），不整段复制 `api-sessions.ts` 的 `SessionTransport`（jscpd 克隆数不得增加）。
- 解析：响应体恰为 `{commands}`（`hasExactlyKeys`），`commands` 是数组；每个元素恰五键，`name`/`label`/`description` 为字符串、`hint` 为字符串或 null、`source` 为两个枚举之一。任何不符 → 与其它方法相同的失败（`requestFailed`），整体拒绝，不返回部分结果。返回数组保持次序。
- `api.ts`：`ApiClient` 加 `listCommands(options?: ApiRequestOptions): Promise<Command[]>;`、`createApiClient` 加 `...createCommandMethods(onUnauthorized, {…})`、加 import。722 → 约 726，其它不动。

### D2 `web/src/features/chat/slash-menu-state.ts`（新，纯函数，不依赖 React）
```ts
export type SlashMenuState = { draft: string; index: number; dismissed: boolean };
type SlashMenuAction =
  | { type: "draft"; draft: string }
  | { type: "move"; delta: 1 | -1; count: number }
  | { type: "dismiss" };
export function initialState(draft: string): SlashMenuState   // { draft, index: 0, dismissed: false }
export function isOpen(draft: string): boolean                // /^\/[^\s]*$/
export function filter(commands: readonly Command[], draft: string): Command[]
export function pickText(name: string): string                // "/" + name + " "
export function reduce(state: SlashMenuState, action: SlashMenuAction): SlashMenuState
```
- `filter`：前缀 = `draft.slice(1)`；保留 `name.startsWith(前缀) || label.startsWith(前缀)` 的条目，大小写敏感，保持目录次序；draft 不满足 `isOpen` 时返回 `[]`。
- `reduce`：
  - `draft`：`action.draft === state.draft` → 原样返回同一个对象；否则 `initialState(action.draft)`——draft 的任何变化都把高亮重置到 0 并撤销 `dismissed`（所以 `Esc` 之后改动文本、再改回原文本，面板重新出现）。
  - `move`：`count === 0` → 原样；否则 `index = (index + delta + count) % count`（循环）。
  - `dismiss`：`dismissed = true`。
- 只导出被其它模块或测试用到的符号（knip）。

### D3 `web/src/features/chat/slash-menu.tsx`（新）
```ts
export function useSlashMenu(
  client: ApiClient,
  draft: string,
  enabled: boolean,
  setDraft: (text: string) => void,
): { menu: ReactNode; interceptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean };
```
- **条件**：`wanted = enabled && isOpen(draft)`。
- **目录**：按 `client` 身份保存（`client` 变了就当作没有目录，旧请求的结果丢弃）。拉取是**边沿触发**，放在一个依赖为 `[client, wanted]` 的 effect 里，这个 effect 不带 abort 清理（它的清理函数在 `wanted` 每次翻转时都会跑）；abort 由另一个只依赖 `[client]` 的 effect 的清理函数负责（先例 `artifact-card.tsx`）（`wanted` 还会被 `enabled` 翻转、fork 回填 draft 等不经按键处理器的路径改变，所以不能放在处理器里）：effect 在 `wanted` 为真、当前 `client` 没有目录且没有在途请求时发一次 `listCommands({ signal })`。于是「边沿」= `wanted` 由假变真，或 `wanted` 为真时 `client` 变化。成功 → 存下；失败 → 不存、不报错（不 toast、不 inline、不 `console.error`），等下一次边沿——`wanted` 保持为真期间的继续输入不重跑 effect。在途期间 `wanted` 的反复变化不追加调用，也**不** abort（`wanted` 变假时请求继续，结果照常存下）；只在卸载或 `client` 变化时 abort，其结果不落状态。
- **菜单状态**：`SlashMenuState` 跟随 `draft`（渲染期用 `reduce(state, {type:"draft", draft})` 同步，写法同 #538 的渲染期重置；不用 effect）。
- **可见**：`wanted && 目录已有 && !dismissed && matches.length > 0`，其中 `matches = filter(目录, draft)`。不可见时 `menu` 为 `null`、`interceptKeyDown` 恒返回 `false`。高亮下标按 `index < matches.length ? index : 0` 取用（`client` 变化后新目录可能更短而 draft 没变）。
- **`interceptKeyDown(event)`**（返回 `true` 表示已处理，`Composer` 不再走自己的 Enter 逻辑）：
  - 不可见，或组合态（`event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229`）→ `false`，不 `preventDefault`。
  - 带 `Ctrl`/`Alt`/`Meta` → `false`。
  - `ArrowDown` / `ArrowUp`（无 Shift）→ `move`，`preventDefault`，把新的高亮项滚入面板可视范围（`scrollIntoView({ block: "nearest" })`，在处理器里做，不放 effect），`true`。
  - `Enter`（无 Shift）或 `Tab`（无 Shift）→ `setDraft(pickText(<高亮项>.name))`（高亮项按上面兜底后的下标取），`preventDefault`，`true`。
  - `Escape` → `dismiss`，`preventDefault`，`true`。
  - 其它 → `false`。
- **`SlashMenu`**（模块私有）：
  ```html
  <div class="chat-slash" role="listbox" aria-label="命令候选" aria-activedescendant="<高亮项 id>" tabindex="-1">
    <div class="chat-slash-option [chat-slash-option--active]" role="option" id="…" aria-selected="true|false" tabindex="-1">
      <span class="chat-slash-label">{label}</span>
      <span class="chat-slash-desc">{description}</span>
      <span class="chat-slash-hint">{hint}</span>   <!-- hint 为 null 时不渲染 -->
    </div>
  </div>
  ```
  - listbox 与每个 option 都是 `tabIndex={-1}`：满足 Biome 的 a11y 规则而不新增 Tab 停靠点（`tabIndex={0}` 会违反不变量 5）。
  - `onMouseDown` 的 `preventDefault()` 挂在 **listbox 容器**上：`tabindex="-1"` 的元素可被点击聚焦，所以按在面板任何位置（选项、间隙、滚动区）都不能让输入框失焦。
  - option 的 `onClick` 选中该项（同 Enter，但取被点的那一项）；该行加一条 `biome-ignore lint/a11y/useKeyWithClickEvents`，理由写明「按键由保持焦点的输入框处理」（先例 `conversation-search.tsx`）。
  - id 用 `useId` 派生。鼠标悬停不移动高亮。
- 选中后 draft 变为 `/<name> `，含空白 → `isOpen` 为假 → 面板自然关闭；此时 Enter 照常提交（服务端 trim）。

### D4 `composer.tsx`
`ComposerProps` 增：
```ts
/** 卡片内、输入框上方的候选面板（斜杠命令）；不传时不渲染。 */
slashMenu?: ReactNode;
/** 先于既有 Enter 规则调用；返回 true 表示按键已被处理，不再提交。 */
interceptKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
```
- `{slashMenu}` 渲染在 `.chat-composer-card` 内最前（label 与 textarea 之前），是裸的 `{slashMenu}`：不包任何容器元素，`composer.tsx` 源码里不得出现新的 `role=`（含注释；`chat-composer.test.tsx:189-199` 的源码守卫）。
- `onKeyDown` 第一句：`if (interceptKeyDown?.(event)) return;`。其后的既有判断块逐字不动。
- 两个 prop 都不传时，输出的 DOM 与行为与现状逐字相同。

### D5 接线
- `conversation-view.tsx`：props 增 `slash: { menu: ReactNode; interceptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean }`（类型可用 `ReturnType<typeof useSlashMenu>`），在 `<Composer>` 上传 `slashMenu={slash.menu}` 与 `interceptKeyDown={slash.interceptKeyDown}`。316 → 约 321。
- `page.tsx`：import、`const slash = useSlashMenu(client, draft, !composerDisabled, setDraft);`（放在 `:648` 算出 `composerDisabled` 之后）、`slash={slash}`。697 → ≤ 707（预算 +10；实际约 +4）。其它不动。

### D6 `messages.css`（`chat.css` 零 diff）
面板在卡片内、输入框上方，随卡片宽度；与输入框之间一条分隔线。`.chat-slash` 有高度上限与纵向滚动（`max-height` + `overflow-y: auto`）；`.chat-slash-option--active` 的背景与普通项不同；`.chat-slash-hint` 用弱化文字色；颜色、间距、圆角只用既有 design token（`var(--wb-…)`），不写裸色值。窄屏（≤760px）下不产生页面级横向溢出：描述与提示可换行或截断，由实现者按卡片既有写法定。

## Governing invariant
1. 不传两个 prop 的 `Composer` 与现状逐字相同；既有 Enter / Shift+Enter / IME 规则不变。
2. 面板打开时 Enter 不提交；组合态的任何按键既不移动高亮也不选中，也不被拦截。
3. 未命中任何候选的 `/xxx` 原样发送，用户气泡显示原文；本刀不改写、不拦截发送内容。
4. 目录拉取失败对用户不可见（无面板、无错误 UI、无控制台错误），且不在每次按键上重试。
5. 焦点始终在输入框；面板不抢焦点。

## Sibling surfaces
- `conversation-view.tsx` 的其它 prop 与渲染（搜索框、转录、alert、footer）：不动。
- `composer-footer.tsx`（欢迎态空间选择）与停止键：不动；生成中 composer 禁用 → `enabled` 为假 → 无面板。
- fork 锁定（`forkLocked`）同样使 `composerDisabled` 为真 → 无面板。
- 对话内搜索（#538）的输入框不是 composer，不受影响。
- 登录态变化：`client` 身份变化时目录作废。

## Must-preserve
- `web/test/chat-composer.test.tsx` 与全部既有 `chat-page*.test.tsx`、`api*.test.ts` 零 diff 全绿。
- `page.tsx` ≤ 707 行；`api.ts`、`conversation-view.tsx`、`composer.tsx` ≤ 800；jscpd 克隆数 178 不增；knip 零新增。
- `submitComposer`、`createAndSelect`、`dispatchPrompt` 不动；发送的 `message` 仍是 draft 原文。

## Required evidence
`web/test/api-commands.test.ts`（真实 `createApiClient` + fetch 替身）：
- **A1** 合法四条（两内建 + `skill:weekly-report` + 一条 `hint: null` 的条目）：请求路径 `/api/commands`、方法 GET、无 body、`cache: "no-store"`、same-origin 凭据；返回值逐值相等、次序不变。
- **A2** 整体拒绝：元素缺 `hint`；`hint` 为数字；`source` 为 `"extension"`；元素多一个键；`name` 不是字符串；响应体多一个键；`commands` 不是数组；响应体不是对象——每种都拒绝且不返回部分结果。
- **A3** 401 → 既有未登录通知（`onUnauthorized` 被调用一次）；非 200 → 既有失败形态。
- **A4** `signal` 透传：abort 后按既有方法的方式拒绝。

`web/test/slash-menu-state.test.ts`（纯函数，issue 的十例 + 归约语义）：
- **M1** `/` → 全列，次序不变。**M2** `/t` → `todo` 一项。**M3** `/整` → `整理上下文`（label 前缀）。**M4** `/T` → 无匹配（大小写敏感）。**M5** `/todo x`、` /todo`、空串、`todo` → `isOpen` 为假、`filter` 为 `[]`。
- **M6** `↓` 到末项再 `↓` 回首项；**M7** `↑` 从首项到末项（反向循环）；`count === 0` 时 `move` 原样返回。
- **M8** `pickText("todo") === "/todo "`、`pickText("skill:weekly-report") === "/skill:weekly-report "`。
- **M9** `dismiss` 后同 draft 的 `draft` 动作返回同一个对象（保持关闭）；**M10** draft 变化 → `{index:0, dismissed:false}`；改回原文本后也是打开的。
- **M11** `/w` 命中 `weekly-report`（label），`/skill:w` 命中同一条（name），`/skill` 命中全部 skill 而不命中内建。

`web/test/chat-page-slash.test.tsx`（jsdom，生产页面装配 + fetch 替身；必要时拆 `chat-page-slash-support.tsx`）：
- **J1** 欢迎态输入 `/` → `命令候选` listbox 恰三项、次序为 `整理上下文`、`任务清单`、`weekly-report`；首项 `aria-selected="true"` 其余 `"false"`；listbox 的 `aria-activedescendant` 等于首项 id；listbox 与每个 option 的 `tabindex` 都是 `"-1"`；每项可见 label、description 与 hint（另一例目录里有 `hint: null` 的条目 → 该项没有 `.chat-slash-hint`）；listbox 是 `.chat-composer-card` 的 `firstElementChild`；`/api/commands` 恰被请求一次。
- **J2** 已选会话的 composer 同 J1。
- **J3** `/t` → 一项 `任务清单`；`↓` `↑` 后仍是它；`Enter` → draft 为 `/todo `、面板消失、没有 `prompt` 或 `createSession` 请求、焦点在 textarea。
- **J4** 三项时 `↓` 两次到第三项、再 `↓` 回首项、`↑` 到第三项（`aria-activedescendant` 与 `aria-selected` 随之变化）；被移到的高亮项调用了 `scrollIntoView({block:"nearest"})`。
- **J5** `/help` → 无面板；`Enter` → 发送，请求 body 的 `message` 为 `/help`，用户气泡文本为 `/help`。
- **J6** `/` 后 `Esc` → 面板消失且不发送；输入 `t` → 重现；再一例 `/` `Esc` → `/t` → 退回 `/` → 重现。
- **J7** 组合态：draft `/任`（按 label 命中 `任务清单`，面板可见），`isComposing: true` 的 Enter 与 `keyCode: 229` 的 Enter 各一次 → 不选中、不发送、draft 不变。组合态的 `ArrowDown` 在 draft `/`（三项）上取证：高亮仍在首项，且该事件没有被 `preventDefault`（`fireEvent.keyDown` 返回 `true`）。写法照既有的 IME 用例（`chat-page.test.tsx:198-199`、`chat-page-search-support.tsx:244`）。
- **J8** Scenario「候选目录的拉取时机」：延迟的 `listCommands` → 返回前无面板；在途期间清空 draft 再输入 `/`（一次真正的上升沿）不追加调用，改成 `/t` 再改回 `/` 也不追加；resolve 后面板出现，全程恰一次调用。另一例 resolve 时 draft 已不满足条件（请求没有被 abort）→ 无面板，之后输入 `/` 直接出现、不再请求。
- **J9** 失败：`listCommands` 拒绝 → 无面板、无 toast、无 `role="alert"` 新增、`console.error` 未被调用；继续输入 `/t` 不追加调用；清空后再输入 `/` → 第二次调用（恰两次），这次成功 → 面板出现。
- **J10** Scenario「点击与 Tab 选中」：点击 `任务清单` → draft `/todo `、面板消失、不发送、`document.activeElement` 仍是 textarea；`mousedown` 落在 option 上与落在面板的非 option 区域（listbox 容器本身）都被 `preventDefault`；`Tab` → 选中高亮项；`Shift+Tab` 与 `Shift+Enter` 不选中（`Shift+Enter` 也不发送）。
- **J11** 禁用：composer 禁用时（`enabled` 为假）draft 为 `/` 也没有面板、不请求。
- **J12** `client` 身份变化（整页装配：`chat-page-lifecycle-support.tsx` 的 `renderChatPageWithAuthProbe` + `renewAccount`）：draft 保持 `/` 时续期 → 旧目录作废、发出新的调用、新目录到达后面板按新目录显示；新目录比旧的短而高亮在末项时不抛错（下标按 0 处理）。卸载：在途请求的 `signal.aborted === true`。
- **J13** `Composer` 插槽契约：传 `interceptKeyDown` 返回 `false` 时 Enter 照旧提交；返回 `true` 时不提交；面板不可见时 `.chat-composer-card` 的子元素恰为 `label`、`textarea`、`.chat-composer-toolbar`（欢迎态另有 footer）——没有空的包裹元素。
- **J14** CSS 契约（静态读 `messages.css`，写法同 #538 的 S18，用 `web/test/ui-support.ts` 的 `ruleBody`）：`.chat-slash` 有 `max-height` 与 `overflow-y: auto`；`.chat-slash-option--active` 设置了背景且取自 token；`.chat-slash-hint` 的颜色取自 token；新增规则里没有裸色值。

J11、J13 可以用一个挂载 `useSlashMenu` + `Composer` 的小测试夹具（放在测试文件或 support 里）而不走整页；J12 走整页。J10 的 `document.activeElement` 断言在 jsdom 下不判别（`fireEvent` 不移动焦点），判别力在同一用例的 `preventDefault` 断言上，两者都保留。

RED：三个新测试文件在实现前全部失败（模块不存在 / 面板不存在）。实现前就成立的护栏逐条标出（预期：J5 的「`/help` 原样发送并显示气泡」、J11 的「无面板」、J13 的「返回 `false` 照旧提交」若夹具不依赖新 prop、J9 里的否定断言）。既有测试在实现前后都绿，`chat.css` 与全部既有测试文件零 diff。

## 变异自检（实现者在沙箱里做，脚本与日志不入库）
每个变异至少使一个用例变红：
1. `isOpen` 的正则放宽成 `^\/`（允许空白）→ M5。
2. `filter` 只比 `name` / 只比 `label` → M3 / M2、M11。
3. `filter` 大小写不敏感 → M4。
4. `move` 不循环（夹在两端）→ M6、M7、J4。
5. `reduce` 的 `draft` 动作不重置 `dismissed` → M10、J6；不重置 `index` → M10。
6. `pickText` 不带尾随空格 → M8、J3。
7. 拦截器在组合态仍处理 Enter / ArrowDown → J7。
8. 拦截器在面板不可见时仍返回 `true` → J5。
9. `Composer` 忽略拦截器的返回值（照旧提交）→ J3、J13。
10. 拉取改成电平触发（每次渲染 `wanted` 为真且无目录就调用）→ J9（调用次数）；在途期间的上升沿重复调用 → J8（清空再输入 `/`）；`wanted` 变假时 abort → J8 第二例。
11. 失败时 toast 或 `console.error` → J9。
12. 返回前就渲染空面板 / 用过期目录 → J8、J12。
13. `mousedown` 的 `preventDefault` 只挂在 option 上（面板空白处会抢焦点）/ 完全不挂 → J10；点击取高亮项而不是被点的项 → J10；listbox 或 option 用 `tabIndex={0}` → J1。
14. `Shift+Tab` / `Shift+Enter` 被当作选中 → J10。
15. `aria-activedescendant` 不随高亮更新 / `aria-selected` 全为 true → J1、J4。
16. `enabled` 为假时仍显示 → J11。
17. 解析放过多余键 / 缺 `hint` / 错误枚举 / 响应体多键 → A2；把 `hint` 解析成必须为字符串 → A1（`hint: null`）。
18. 请求带查询串或不带 `no-store` → A1。
19. `client` 变化后沿用旧目录 / 不重新拉取 → J12；高亮下标越界不兜底 → J12。
20. 面板不可见时渲染空包裹元素 → J13。

## 已知残留
1. **不是完整的 ARIA combobox**：`aria-activedescendant` 在 listbox 上而焦点在输入框，读屏器不会随 `↑/↓` 播报高亮项，输入框也没有 `aria-expanded`/`aria-controls`。要做对需要给 `Composer` 再开 prop 面（或把 id 交给输入框），超出父规格给的两个 prop。
2. **jsdom 看不到真实输入法**：组合态用合成事件的 `isComposing` / `keyCode 229` 取证；真实输入法下的候选确认、面板几何、窄屏表现与点击后的焦点由 #557 的 ui-walk 收口。
3. **目录在页面挂载期间不刷新**：平台新装的 skill 要重新进入页面才出现。
4. **鼠标悬停不移动高亮**：点击取被点的项；键盘高亮与鼠标位置互不影响。
5. **选中后的 `/todo `（带尾随空格）直接 Enter 会发送**：发送的是 draft 原文，服务端 trim 后按白名单执行。反过来，手动打完整的 `/todo`（无空格）时面板仍开着，第一次 Enter 是选中（draft 变成 `/todo `），要再按一次才发送——父规格如此，#557 的走查也按此写。
6. **候选很多时没有分组或搜索以外的手段**：只有前缀过滤与滚动。
7. **`Esc` 在面板打开时被 `preventDefault`**：事件照常冒泡；页面上的覆盖层（Dialog、Drawer）都是模态的，composer 获得焦点时没有别的 `Escape` 逻辑在听。
8. **面板可以在输入框未聚焦时出现**：fork 等路径把 `/todo` 这样的文本回填进 draft 时条件成立。此时点击选项不会把焦点移进输入框（规格说的是「不移走焦点」），键盘操作需要先聚焦输入框。

## Seams under test
- 纯函数直接调用（M 系列）。
- 真实 `createApiClient` + fetch 替身（A 系列、J 系列），与既有页面用例同一装配；没有手写的 `ApiClient` 替身。
- `scrollIntoView`：整页装配经 `web/test/radix-platform.ts` 已有空实现，J4 用 `vi.spyOn` 观察；不走整页的小夹具要自己装。
- CSS 以文本读取（J14），不是计算样式。
