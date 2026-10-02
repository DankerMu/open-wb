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
15. `aria-activedescendant` 不随高亮更新 → J4（J1 杀不了：初始高亮本来就在首项）；`aria-selected` 全为 true → J1、J4。
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

9. **`Shift+Esc` 也关闭面板**：规格只写了 `Shift+Enter`、`Shift+Tab` 与带 `Ctrl/Alt/Meta` 的按键不拦截，没有写 `Shift+Esc`；实现先判 `Escape` 再判 `Shift`。
10. **选项没有 hover 样式**：只有 `cursor: pointer`。键盘高亮是面板里唯一的高亮，避免与鼠标悬停同时出现两处。
11. **目录里重名的条目**：解析不做去重（服务端保证内建名与 `skill:<名>` 不重复）；重名时 React 只给 key 告警，第二条仍可点击选中。

## 交付记录（实现后补记）
- **abort effect 读 `client`**：只依赖 `[client]`、清理函数只碰 ref 的 effect 过不了 Biome 的 `useExhaustiveDependencies`，所以清理函数里比对 `call.current?.client === client` 再 abort。拉取 effect 依赖 `[client, wanted]`、无清理；调用记录在成功后保留（后续上升沿不再拉取），失败时只在记录仍是自己时清掉——被 abort 的旧请求迟到的 reject 不会清掉新 client 的在途记录（用例「J12 an aborted request that fails, as fetch does, leaves the request of the new client in flight」）。
- **超出 Required evidence 的用例**：整页 J11（切到 running 会话后面板消失、draft 保留——夹具版测不出 `page.tsx` 把 `enabled` 接错）、一个 StrictMode 用例、`Ctrl/Alt/Meta` 不拦截的用例。
- **测试 support**：`web/test/chat-page-slash-support.tsx`（页面测试不拆是 857 行；fix pass 1 之后测试 796 行、support 328 行，J11 与 J13 的夹具搬进了 support）；目录夹具由它导出，`api-commands.test.ts` 与 `slash-menu-state.test.ts` 也从它取，避免三份目录字面量变成 jscpd 克隆。
- **行数**（`wc -l`）：`page.tsx` 697 → 700、`api.ts` 722 → 725、`conversation-view.tsx` 316 → 322、`composer.tsx` 128 → 136、`messages.css` 744 → 789、`chat.css` 797 零 diff；新文件 `api-commands.ts` 68、`slash-menu-state.ts` 55、`slash-menu.tsx` 169；测试 154 / 147 / 775 + support 296。（Context 里的 798 与 745 是 `split("\n").length` 口径，比 `wc -l` 多 1。）
- **RED**（基线 + 仅测试）：三个文件全部失败——A1–A4 22 例 `listCommands is not a function`，M 与 J 两个文件因模块不存在而收集失败。「实现前就成立的护栏」在纯基线上观察不到（文件收集失败）；用一个不接线的 hook 桩做的诊断运行里 43 例 40 红 3 绿，绿的三例都是 J13（不传拦截器照旧提交、两种卡片无包裹元素）；J5、J9、J11 的否定断言在基线成立，但各自所在用例因同例的肯定断言为红。
- **GREEN**：`npm test --workspace web` 86 文件 / 1792 例；`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 178）、`bash scripts/size-guard.sh`、`openspec validate slash-command-menu --strict --no-interactive` 均退出 0。三个新产品文件的语句与分支覆盖率 100%。三个新测试文件连跑三次稳定。
- **变异**：上面 20 条的全部变体 42 个加实现者自加的 5 个，47 个全部被杀。
- **J5 的判别力**：页面没有乐观气泡，「用户气泡显示 `/help`」来自测试桩返回的快照；有判别力的是请求体的 `message` 为 `/help`。
- **J10 的判别力**：`fireEvent.click` 在 jsdom 里不移动焦点；判别力在 option 与 listbox 容器上的 `mousedown` 都被 `preventDefault`。
- **Chromium 一次性观察**（production build + `vite preview`，`/api/**` 由 Playwright 路由桩应答，16 条目录；1440×900 欢迎态 / 已选会话 / 暗色，390×844 欢迎态 / 已选会话；脚本与截图不入库）：
  - 面板是卡片的第一个子元素、在输入框上方、宽度随卡片（726/752、324/350）；高度 220px 封顶、内部滚动；页面与面板都没有横向溢出；390px 下 hint 换到第二行。
  - `↓` 15 次到末项时该项在面板可视范围内；再 `↓` 回到首项；光标位置不动。
  - `Esc` 关闭、焦点仍在输入框；再输入重现。
  - **真实鼠标点击**选项：draft 变为 `/todo `、面板关闭、焦点仍在输入框（随后键入的字符接在 draft 后）、无 prompt 请求。按在面板自身的 padding 上（命中元素是 `.chat-slash` 而不是选项；两项目录，1440 与 390 两个视口）：面板保持打开、draft 不变、焦点仍在输入框。
  - `Tab` 选中高亮项且焦点不离开输入框；面板关闭时 `Tab` 照常移到发送键。
  - 每次页面装配 `/api/commands` 恰一次；无控制台错误；暗色下高亮与 hint 取自暗色 token。
  - **触摸**（Chromium 的触摸仿真：Pixel 7 预设与 390×844 `hasTouch`）：tap 选项后 draft 为 `/todo `、面板关闭、焦点仍在输入框。WebKit 未安装，没有观察。

## 评审第一轮与 fix pass 1（1/2）
三席（correctness；test-evidence + spec-compliance；integration + invariant，带 a11y / 键盘 / IME 视角）无 P0/P1，产品代码无缺陷，fix pass 1 只动测试。采纳三处证据缺口，三条变异在 fix 前的树上都存活、之后各被恰一个新用例杀死：
- **abort 守卫没有判别用例**（`slash-menu.tsx` 的 `if (!own.controller.signal.aborted) setCatalogue(…)`）：原 J12 第二例只让旧答案先到，它带着旧 `client` 存进去也会被身份比对挡掉。反过来——新目录先到、无视 abort 的旧请求后到——删掉守卫时目录被旧结果覆盖、面板消失且本次挂载内不再拉取。`web/src/lib` 在 fetch 返回后不复查 signal，守卫是唯一防线。新增 J12「the late answer of the aborted request does not replace the catalogue of the new client already shown」。
- **下标兜底之后的方向键**：`move` 以兜底后的下标为起点；改成以存储的下标为起点时原用例测不出（原 J12 第一例是下标 2、新长度 2，两种算法结果相同，且按的是 Enter）。新增 J12「an arrow key moves from the first option of the shorter catalogue, not from the old highlight」（存储下标 3、新长度 2）。
- **`Shift+Esc`**（已知残留 9）两个方向都没钉住。新增 J6「Shift+Esc closes the panel as Esc does」。

fix 后：`npm test --workspace web` 86 文件 / 1795 例；`make lint`、`make typecheck`、`make anti-drift`（jscpd 178）、`bash scripts/size-guard.sh` 退出 0。评审另指出的事项：
- 变异清单里 12b 与 19a 语义相同，独立变异是 46 个加本轮 3 个。
- J3 的 `document.activeElement` 断言与 J10 的一样在 jsdom 下不判别。
- 「三个新产品文件覆盖率 100%」是从覆盖率表省略满覆盖文件推出的，没有直接数字。
- **整页的重新启用路径**（锁解除后面板重现且不追加调用）只有夹具版 J11 取证；**fork 锁 → 无面板**没有专门用例（与 running 共用 `composerDisabled` 同一个表达式）；**按住 Enter**（第一下选中，后续 repeat 落到既有的 `!event.repeat`）没有用例；**输入 `/` 时目录请求 401** 的页面级交接没有用例（与 `listSessions` 共用同一机制）。均按弱缺口记录，不在本轮补。

本轮新增的已知残留（接上面的编号）：
12. **触摸**：只有 Chromium 触摸仿真的观察；iOS Safari 上 tap 选项后输入框是否失焦、软键盘是否收起没有证据。#557 的 ui-walk 只有鼠标，也收不了这一条——需要真机。
13. **真实输入法的事件时序**：J7 在单个合成事件上翻 `isComposing` / `keyCode 229`，测不到 compositionend 与随后 keydown 的先后；Playwright 驱动不了真实输入法，#557 同样收不了口。若某个输入法在上屏后给出 `keyCode 13` 且 `isComposing=false` 的 Enter：master 上是直接发送，本刀在面板可见时变成选中——同一暴露面，后果更轻。另外中文标点模式下 `/` 键通常产出 `、`，面板不会打开。
14. **390px 加软键盘**：欢迎态下面板把输入框下推约 228px，软键盘打开时输入框是否仍在可视区没有观察。
15. **「面板出现」没有读屏播报**：残留 1 说的是高亮项的播报；面板出现本身也不播报，读屏用户输入 `/t` 回车时 draft 被改成 `/todo ` 而不是发送。在面板节点里放一个 polite live region 不需要新 prop——留给后续 issue。
16. **`client` 变化后高亮可能留在原下标**：只在越界时兜底到 0；规格只要求 draft 变化时重置。

第二轮复审（correctness + test-evidence 一席，head `3006716`）：clean，无 P0/P1；PR #744 该 head 的 CI 九项检查全部通过（run 37034049467），合并提交 `26f2f9f`。

给 #557 的提示：option 的可访问名是 label、description、hint 的拼接，走查按子串或 `.chat-slash-label` 匹配，不能用 `exact: true`。

父 change rebase（归档前）：`openspec/changes/s1c-session-metadata-presentation/specs/chat-web/spec.md` 仍写「`api.ts` 只加一行接线」「once per page mount」「pure page state」，与本刀合入后的主规格不一致（proposal 偏差 2、3、6、8）；父 delta 归档时是整段替换，须先按主规格重同步。主规格未改动的 Scenario「输入框键盘发送」对 `/todo` 这类 draft 不再无条件成立（残留 5），重同步时可加限定语。

## Seams under test
- 纯函数直接调用（M 系列）。
- 真实 `createApiClient` + fetch 替身（A 系列、J 系列），与既有页面用例同一装配；没有手写的 `ApiClient` 替身。
- `scrollIntoView`：整页装配经 `web/test/radix-platform.ts` 已有空实现，J4 用 `vi.spyOn` 观察；不走整页的小夹具要自己装。
- CSS 以文本读取（J14），不是计算样式。
