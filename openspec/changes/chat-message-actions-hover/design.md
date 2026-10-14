# Design: chat-message-actions-hover

## Context

动机见 proposal。证据标签：**实测** = 2026-10-14 在本机用仓库的 Playwright 1.62.1（Chromium 151.0.7922.34）跑一次性探针（scratchpad，不入库）；**读代码推出** = 读本仓源码或依赖的发行代码，未运行。行号取自基线 `4d9eaeef`。

**今天的结构（读代码推出）：**

- `UserMessage`（`web/src/features/chat/message-thread.tsx:81-129`）：`article` 自己就是气泡（`rounded-2xl rounded-br-sm bg-(--wb-bg-hover-light) px-[15px] py-2.5`，`:105`），里面依次是正文 `p[data-slot=message-body]`、附件列表、工具调用组、错误文本、`UserActions`。当前匹配高亮 `CURRENT_MATCH`（`:71-72`）也在这个 `article` 上。
- `AssistantMessage`（`:174-242`）：`article` 无气泡，操作行在 `data-slot="message-content"` 列的末尾，运行中不渲染（`:232`）。
- 操作行 `Row`（`web/src/features/chat/message-action-row.tsx:16-22`）是 `ActionBarPrimitive.Root`，默认配置：不自动隐藏。`UserActions`（`:159-176`）今天是 `撤回`、`从此处分叉`；`撤回` 由 #969 上线（#907 已关闭）。`CopyAction`（`:54-75`）与 `useCopyFeedback`（`copy-feedback.ts`）是消息级 `复制` 的唯一实现，`复制失败` 是行内的 `span[role=alert]`。
- 悬停显现的先例：会话列表的「更多」按钮（`web/src/features/chat/session-menu.tsx:51`）——缺省可见，只在 `[@media(hover:hover)_and_(min-width:761px)]` 下 `opacity-0`，`group-hover/session:` 与 `group-focus-within/session:` 置 `opacity-100`；规格在 session-sidebar（`openspec/specs/session-sidebar/spec.md:9`）。
- `web/src` 里的组一律具名（`group/session`、`group/row`、拷入组件的 `group/tool-group-root`、`group/reasoning-root` 等），没有裸 `group` 类。
- Tailwind 4.3.3 的 `hover:`（以及由它组合出的 `group-hover:`）编译为 `&:hover` 外包 `@media (hover: hover)`（读 `node_modules/tailwindcss/dist/lib.js`）；没有内建的 `hover: none` 变体；`has-[…]:` 与 `focus-within:` 可用，本仓已在用 `has-[…]:`（`composer.tsx:131`）。
- `web/src/styles/theme.css` 的 `@layer base` 选择器清单由 `web/test/ui-foundation-entry.test.ts:264-294` 钉死、只减不增；块外顶层规则块也恰为五项（`:258`）。未分层的 `@media (prefers-reduced-motion: reduce) { [class*="transition"] { transition: none; } }` 已覆盖任何带 `transition` 字样的类（`ui-reduced-motion.test.ts` 守着它）。

**测量环境的事实（实测）：**

- Playwright 的可操作性检查与 `toBeVisible()` 不看不透明度：`opacity: 0` 的按钮照样「可见」、可点，`click()` 会先把鼠标移到元素上（Playwright 文档对 visible 的定义）。所以既有的 `重新生成` / `从此处分叉` / `撤回` 点击在改动后不会坏，但也什么都证明不了——显隐只能量计算样式。
- `page.emulateMedia({ hover: "none" })` 不报错但无效（`matchMedia("(hover: none)")` 仍为 false）；CDP `Emulation.setEmulatedMedia` 的 `features: [{name:"hover"}]` 同样无效。
- `browser.newContext({ hasTouch: true })` 单独即可让 `(hover: none)`、`(any-hover: none)`、`(pointer: coarse)` 为真；`isMobile: true` 单独不改变其中任何一项。`hasTouch` 上下文里 `page.hover()` 仍会触发 `:hover`。
- `:focus-visible` 依赖浏览器的启发式：鼠标点击按钮后为 false，键盘 Tab 到达后为 true；同一页先有过鼠标点击时，脚本 `focus()` 得到的焦点为 false。
- `web/playwright.config.ts` 的两个 project 都不带 `hasTouch`，并注明不用 `devices[...]` 预设（会改变交互语义）；`globalTimeout` 300 s；主旅程用例单测时限放宽到 60 s，放宽时它在 mobile-dark 下用了 26.6 s（`web/e2e/ui-walk.spec.ts:80-82` 的注释，此后又加过步骤）。先例：`web/e2e/ui-walk-layout.ts:691` 在走查里另开 `browser.newContext`。

## Goals / Non-Goals

**Goals:**

- 用户消息的气泡只包内容，一句 `hello` 的气泡是一行高；操作行在气泡下方靠右。
- 用户消息与全部助手消息的操作行缺省不可见、悬停 / 焦点 / `复制失败` 时可见、`(hover: none)` 下常显；隐藏不影响 Tab 顺序、无障碍树与布局。
- 真实显隐在 `make ui-walk` 里以计算样式取证，单测只证结构、类名与复制行为。

**Non-Goals:**

- 不改 `撤回` 的行为与条件（message-undo），不改 `从此处分叉`、`重新生成` 的行为。
- 不改助手消息的结构（它本来就没有气泡）。
- 不新增全局样式规则，不改 `theme.css`。
- 不给既有 ui-walk project 加设备参数，不新增 make target。
- 消息编辑、点赞 / 点踩、分支切换。

## Decisions

### owner 的裁定（已定，不是选项）

- **O1（2026-10-06，#908 需求 1–3）**：用户消息操作行移到气泡外、气泡下方靠右；用户消息加 `复制`（原文，反馈规则同助手）；用户消息与全部助手消息的操作行悬停或键盘聚焦才显示。
- **O2（2026-10-06）**：回答刚结束时末条助手消息的操作行不做特殊处理。
- **O3（2026-10-13）**：触屏以 `@media (hover: none)` 判定，那里操作行常显；带鼠标的触屏笔记本按悬停处理（主指针能悬停）。不按视口宽度判定。

### 起草者的技术决定

**D1 按钮次序为 `复制`、`撤回`、`从此处分叉`。** #908 正文写「次序 `复制`、`从此处分叉`」「`撤回` 本次不做」，写于 `撤回` 上线之前；#907 的 owner 裁定（2026-10-06）是「复制、撤回、从此处分叉」，主规格 chat-web「消息线程」与 message-undo「web 撤回」也已写明 `撤回` 在 `从此处分叉` 之前、`复制` 归 #908。所以保留 `撤回`，`复制` 放最前。

**D2 `复制` 的边界与助手消息对齐。** (a) 文本为空的用户消息（只发附件）不渲染 `复制`——助手消息正文为空时同样没有 `复制`；这也让 message-attachments「用户气泡中的附件」里「操作行（`撤回`、`从此处分叉`）照旧」继续成立，不必改那份规格。(b) 已归档会话里用户消息只剩 `复制`（只发附件的消息此时一个按钮都没有，不渲染操作行，与助手消息「有按钮才有行」一致）：复制是只读操作，助手消息的 `复制` 在归档会话里本来就在（`chat-archive.test.tsx:177`）。(c) 输入框锁定不禁用 `复制`，与助手消息一致。(d) 写入的文本是气泡里显示的同一个 `text`（`partText(message,"text")`），不含附件列表。放弃的方案：空文本消息复制空串——点了没东西可粘，徒增一个按钮。

**D3 显隐机制沿用 session-menu 先例，只去掉宽度条件。** 行上缺省 `opacity-100` 不写，只在 `[@media(hover:hover)]:opacity-0` 下隐藏；`group-hover/message:opacity-100`（根元素 `article` 带具名组 `group/message`）、`focus-within:opacity-100`、`has-[[role=alert]]:opacity-100` 让它显现；`transition-opacity` 交给 `theme.css` 既有的 reduce 规则置零。理由：
- `hover` 只有 `none` / `hover` 两个取值，「`(hover: hover)` 下才隐藏」与 owner 的「`(hover: none)` 下常显」等价，而且 CSS 失效时退化为常显（按钮不会丢）。Tailwind 的 `group-hover:` 本身就包在 `(hover: hover)` 里，两半用的是同一个媒体特性。
- 用具名组：裸 `group-hover:` 会被任何祖先 `.group` 的悬停触发，日后外壳或消息内加一个裸 `group` 就会串；本仓的组也一律具名。
- 不改 `theme.css`：不新增 base 层选择器（清单只减不增），也不加 `@custom-variant`；任意值变体有先例，没有守卫禁止它。
- 不改 assistant-ui 的 `ActionBarPrimitive.Root` 配置：它的 `autohide` 会让按钮不可聚焦（#908 实现提示）。
- 放弃的方案：在 `theme.css` 加 `@custom-variant hover-none (@media (hover: none))` 写成「缺省 `opacity-0`、`hover-none:opacity-100`」——多一处全局声明，且 CSS 失效时退化为全部不可见。
- 实现时以 ui-walk 的计算样式为准（几个显现类的选择器特异度都高于隐藏类，读代码推出；ui-walk 若红，先查变体次序）。

**D4 焦点显示用 `focus-within`，不用 `:focus-visible`。** 行内任一元素有焦点就显示。理由：与 session-menu 先例一致；`撤回` 的冲突对话框关闭后焦点以脚本还给 `撤回`（message-undo），`:focus-visible` 在那时取决于启发式（实测：先有鼠标交互时脚本聚焦为 false），可能出现「焦点在一个看不见的按钮上」。代价：鼠标点过 `复制` 后移开，该行在焦点离开前保持可见。放弃的方案：`has-[:focus-visible]`——严格只对键盘，但有上面的焦点丢失风险。#908 原文是「键盘聚焦到行内按钮时」，`focus-within` 是它的超集；owner 已裁决照此定，见文末「Owner 裁决（2026-10-14，起草后）」。

**D5 显隐只在 ui-walk 里取证，判据是计算 `opacity`。** jsdom 不计算样式，单测只断言：根元素带 `group/message`，行带上述类名，按钮及其祖先没有 `aria-hidden` / `inert` / `tabindex="-1"`，次序与复制行为。ui-walk 用 `toHaveCSS("opacity", "0" | "1")`（它会轮询，过渡期间的中间值不致误判）。触屏用走查里另开的 `browser.newContext({ hasTouch: true, ... })`，不用 `isMobile`、不加第三个 project（第三个 project 会把整条旅程再跑一遍，撞 300 s 的 `globalTimeout`）。新上下文要已登录：优先 `storageState: await page.context().storageState()` 复制登录态；若服务端会话不能这样复用，改为在新上下文里走一次登录表单（**未验证**，任务 1.6 实测选定）。键盘聚焦经真实 `Tab` 到达，并先断言 `document.activeElement` 是目标按钮。剪贴板失败用页面脚本把 `navigator.clipboard.writeText` 换成必定 reject 的函数（与验收清单 CH-16 同一手法），步骤结束前还原。（走查步骤的细节——Tab 的起点、剪贴板失败段用末条用户消息并以 resolve 桩清除提示——以 tasks 1.6 为准。）

**D6 结构：`article` 外层 + 气泡内层。** 用户消息的 `article` 保留 `aria-label`、`aria-current`、`data-message-id`、`self-end`、`max-w-[80%]` 与 `CURRENT_MATCH`，加 `group/message`、`flex-col items-end`；新增内层 `div[data-slot="message-bubble"]` 承接底色、圆角、内边距与内容间距。外层失去 `rounded-2xl` 后，当前匹配的底色与外扩阴影会是方角，所以外层加 `aria-[current=true]:rounded-2xl`（助手消息用 `aria-[current=true]:rounded-lg`，这里取与气泡一致的圆角）。高亮此后包住气泡与操作行两部分，气泡自己的底色叠在高亮之上。`walkFork` 断言的 `article` 的 `align-self: flex-end` 与 `[data-slot="message-body"]` 的 `white-space: pre-wrap` 都保持成立。

**D7 工具调用组与错误文本留在气泡内。** 用户消息今天也渲染 `ToolCallGroup` 与 `MessageError`（`message-thread.tsx:116-117`），它们是消息内容，留在气泡里；只有操作行移出。

**D8 验收清单的改法。** 「运行方式」加一条总则：消息下方的按钮（复制、撤回、从此处分叉、重新生成）在能悬停的设备上只在鼠标移到该消息上或键盘聚焦时出现，各行写「点某条消息的某按钮」时先把鼠标移到那条消息上——这样引用这些按钮的 24 行不必逐行改。期望已不成立的行逐行改写（CH-16「用户消息上没有复制」、CH-17「看每条消息末尾的按钮」、CH-18「气泡末尾有且只有一个从此处分叉」）；#908 点名的 CH-13、CH-45、CH-52、CH-56 在「点」之前写明「先把鼠标移到该消息上」；新增 CH-112…CH-115。全部 `待签`。

## 规格影响

- 改：chat-web「消息线程」（MODIFIED，全文替换；改写「复制助手原文」「用户消息操作行的按钮与次序」「只有附件的用户消息」，新增「用户气泡与操作行的结构」「复制用户原文」「隐藏的操作行仍可达」「真实浏览器下操作行的显隐」「显隐的短渐变与减少动态效果」）。
- 加：chat-harness「UI 走查消息操作行显隐」（ADDED；既有「UI 走查对话步骤」的点击条文仍成立，悬停前置写在新要求里，不改那条长要求）。
- 仍成立、不改：message-undo「web 撤回」（`撤回` 在 `从此处分叉` 之前，已注明 `复制` 与显隐归 #908）；message-attachments「用户气泡中的附件」（列表在气泡内文本下方；只发附件的消息没有 `复制`，操作行仍是 `撤回`、`从此处分叉`）；conversation-search「跳转与消息级高亮」（`aria-current` 在根元素上）；session-sidebar 的「更多」按钮（不动）。

## Risks / Trade-offs

- **[按钮看不见却能被点]** → 隐藏的按钮仍响应点击，但它在消息的根元素之内，鼠标到达它之前已在悬停该消息，行先显现；键盘到达时 `focus-within` 显现。读屏用户不受不透明度影响。
- **[触屏笔记本用手指]** → 主指针是鼠标时 `(hover: hover)` 成立，手指点按不产生悬停：行不可见但仍可点（点按区域里本来就有按钮）。owner 2026-10-13 已接受「按主指针判定」。
- **[点过的行在焦点离开前保持可见]** → D4 的代价，换来脚本还焦点时不丢可见性。
- **[`复制失败` 让行常驻]** → 直到下一次点击 `复制` 才清除（既有规则）；这是 #908 要求的效果。
- **[走查时长]** → 显隐一步含一个新上下文与若干次悬停；主旅程在 mobile-dark 的时长见 Context，余量未知。任务 1.6 先量；放不下时显隐一步改为独立用例（照「输入框能力」用例自带登录与清理的写法），不调时限。
- **[Playwright 升级改了 `hasTouch` 的媒体特性映射]** → 显隐一步先断言 `(hover: none)` 成立再量，映射变了会先在前提断言处判红，而不是静默变绿。

## Migration Plan

单个 PR，纯前端呈现与测试，无数据、无线协议、无配置。回滚即 `git revert`。

## Not yet specified

- **复用登录态的方式**：`storageState` 复制能否在新上下文里直接打开会话未验证（D5）；任务 1.6 实测后定。
- **两个上下文同开一个会话**：触屏上下文与主页面同时打开同一已完成会话，流的所有权逻辑是否有反应未验证；任务 1.6 断言主页面 error oracle 干净、转录不变。
- **显隐一步的落点**：并入主旅程（`walkHeldDialogue` 里 `walkRegenerate` 之后、`walkFork` 之前，会话此时有两轮问答）还是独立用例，取决于任务 1.6 实测的时长。
- **mobile-dark 下的悬停**：该 project 宽 390、无 `hasTouch`，`(hover: hover)` 成立，行按悬停规则隐藏——与 O3「不按宽度判定」一致；走查在两个 project 上都量。

## Sketch seams under test

- **`Thread` + jsdom（既有）**：结构、次序、类名契约、可达性属性、复制行为。
- **`UserActions` / `AssistantActions`**：经 `Thread` 渲染测，不单独导出新东西（knip）。
- **`make ui-walk`（既有）**：计算 `opacity`、包围盒、`transition-duration`、`hasTouch` 上下文；不新增 target。

## Traceability

| 来源 | 落点 |
|---|---|
| O1 操作行出气泡、用户 `复制` | D1、D2、D6、D7；chat-web「消息线程」用户消息段；tasks 1.2、1.3 |
| O1 悬停 / 键盘显示 | D3、D4、D5；chat-web「消息线程」操作行「显隐」；chat-harness 新要求；tasks 1.4、1.5、1.6 |
| O2 末条不特殊 | chat-web「显隐」首句；tasks 1.6 的助手消息取末条 |
| O3 `(hover: none)` | D3、D5；tasks 1.6 触屏上下文 |
| #908「`复制失败` 不随鼠标移开消失」 | D3 `has-[[role=alert]]`；tasks 1.6 |
| #908「验收清单」 | D8；tasks 1.8 |

## Owner 裁决（2026-10-14，起草后）

- 用户消息操作行次序：`复制`、`撤回`、`从此处分叉`（D1 照起草定）。
- 键盘聚焦显示用 `focus-within`（任何聚焦都显示；D4 照起草定）。
- 显隐用短渐变（`transition-opacity`），「减少动态效果」下由既有全局规则变为瞬时。
- 对话内搜索的当前匹配高亮包住整条消息（外层 `article`，D6 照起草定）。
- 复制的边界（D2：只发附件的消息没有 `复制`、已归档会话里用户消息只剩 `复制`、锁定时不禁用、复制气泡原文不含附件列表）：编排方按起草默认取，owner 可推翻。
