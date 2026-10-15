# Tasks: chat-message-actions-hover

> 跟踪：直接在 #908 上实现，不拆子 issue；只有一个组、一个 PR。
>
> 通用纪律：
> - 合入前 `make check`、`make test-guardrails`、`make ui-walk`（两个 project）全绿；本 change 不碰服务端，`make smoke` 照常跑一遍作回归，不新增冒烟用例。
> - 任务里点名的 `文件:行` 是在 `4d9eaeef` 上读的。开工先重跑 1.1 的核对；有出入先改本 change 的 design 与任务，再继续。
> - 显隐的唯一判据是真实浏览器里的计算 `opacity`（design D5）：`toBeVisible()`、可点、可聚焦都不能证明「隐藏」，Playwright 把 `opacity: 0` 的元素当作可见。jsdom 用例只断言结构、类名、可达性属性与复制行为。
> - 不改 `web/src/styles/theme.css`，不新增全局规则；`web/test/ui-foundation-entry.test.ts` 的 `BASE_SELECTORS` 与块外五项保持原样（design D3）。如实现中发现必须改它，停下来报告。
> - 不给 `web/playwright.config.ts` 的既有 project 加 `hasTouch` / `isMobile`，不新增 project 与 make target，不调单测时限与 `globalTimeout`。
> - 既有断言只要还有意义就不删除、不削弱；因结构或次序变化而改写的断言（`chat-thread-attachments.test.tsx:150` 的子元素槽位、`chat-copy.test.tsx:283-287` 的「用户消息无 `复制`」与按钮清单、`chat-archive.test.tsx:176` 的「归档时用户消息无操作行」、`chat-undo.test.tsx:72-78` 的 `aria-label` / `title` / `disabled` / `aria-disabled` / `type` 各恰两项、`chat-fork-button.test.tsx:238` 的 `getAllByRole("button")` 等于 `[undo, button]`，以及 1.1 找到的其它处），在 PR 的偏离记录里逐条列出旧断言与新断言。
> - 一次性探针写在系统 scratchpad，不入库；输出贴进 PR。
> - `Suggested fixture level` 只用 `none | compact | expanded`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Public API / CLI / script entry | 不选：不改任何接口与线协议 | — |
| Config / project setup | 不选：不改 Playwright 配置与构建配置（通用纪律） | — |
| File IO / path safety / overwrite | 不选 | — |
| Schema / columns / units / field names | 不选 | — |
| Auth / permissions / secrets | 不选：走查新上下文复用登录态只在测试里 | 1.6 |
| Concurrency / shared state / ordering | 不选 | — |
| Resource limits / large input / discovery | 选中：ui-walk 的时长预算 | 1.6 的实测与落点选择 |
| Legacy compatibility / examples | 选中：既有以 `article` 为范围找按钮的单测与走查、`walkFork` 的 `align-self` 与 `white-space` 断言 | 1.1、1.3、1.5 |
| Error handling / rollback / partial outputs | 选中：`复制失败` 在鼠标移开后保持可见 | 1.4、1.6 |
| Release / packaging / dependency compatibility | 选中：触屏测量依赖 Playwright `hasTouch` 对媒体特性的映射（1.62.1 实测） | 1.6 的前提自证 |
| Documentation / migration notes | 选中：验收清单 | 1.8 |

## 1. chat-web / chat-harness — 操作行出气泡、用户消息 `复制`、悬停显隐（组 1）

- [x] 1.1 开工核对：`message-thread.tsx` 的 `UserMessage`（`:81-129`）与 `AssistantMessage` 操作行（`:232`）、`message-action-row.tsx` 的 `Row` / `CopyAction` / `UserActions`（`:16-22`、`:54-75`、`:159-176`）、`session-menu.tsx:51` 的先例；`grep -rn 'message-actions\|"用户"' web/test web/e2e` 列出以操作行或用户 `article` 为范围的全部用例；确认 `web/src` 仍没有裸 `group` 类（组一律具名）。
  验证：核对结果与受影响用例名单写进 PR；行号有出入时先改 design 的引用。
- [x] 1.2 结构（design D6、D7）：`UserMessage` 的 `article` 保留 `aria-label`、`aria-current`、`data-message-id`（由运行时基元给出）、`self-end`、宽度上限与 `CURRENT_MATCH`，加 `group/message`、纵向排列靠右与 `aria-[current=true]:rounded-2xl`；新增内层 `div[data-slot="message-bubble"]` 承接底色、圆角、内边距与内容间距，内含正文、附件列表、工具调用组与错误文本；操作行在气泡之后、`article` 之内。`AssistantMessage` 的 `article` 加 `group/message`，其余不动。
  验证：chat-web「用户气泡与操作行的结构」通过（`article` 直接子元素槽位依次为 `message-bubble`、`message-actions`；气泡内无按钮；底色类在气泡上不在 `article` 上；`aria-current` 只在 `article` 上）；「只有附件的用户消息」与 message-attachments「只有附件的气泡」改写后通过；`chat-thread-attachments.test.tsx:150` 的槽位断言改为在气泡内断言 `["message-body","message-attachments"]`、在 `article` 上断言 `["message-bubble","message-actions"]`（列入偏离记录）。
- [x] 1.3 用户消息 `复制`（design D1、D2）：`UserActions` 增加 `text` 参数，文本非空时在最前渲染 `CopyAction`（复用，不另写复制逻辑）；归档时 `UserMessage` 仍渲染操作行但只含 `复制`（`撤回`、`从此处分叉` 不渲染）；行里一个按钮都没有（归档会话里只发附件的消息）时不渲染操作行；锁定只禁用 `撤回` 与 `从此处分叉`。
  验证：chat-web「复制用户原文」（剪贴板写入恰为 `  第一行\n第二行`、对勾约 2 秒、`已复制`、API 缺失与 reject 两种失败的 `复制失败`、恢复后清除、无轻提示）与「用户消息操作行的按钮与次序」（三例，含归档会话里只发附件的消息没有 `message-actions`）通过；「复制助手原文」改写后通过；`chat-copy.test.tsx:283-287`、`chat-archive.test.tsx:176` 按新规则改写（列入偏离记录）；`chat-fork-button.test.tsx`、`chat-undo.test.tsx`、`chat-stop-button.test.tsx` 中以行内按钮次序或个数为断言的用例同步。
- [x] 1.4 显隐类名（design D3、D4）：`Row` 加 `transition-opacity`、`[@media(hover:hover)]:opacity-0`、`group-hover/message:opacity-100`、`focus-within:opacity-100`、`has-[[role=alert]]:opacity-100`；不改 `ActionBarPrimitive.Root` 的自动隐藏配置（保持关闭）；不用 `hidden`、`invisible`、`aria-hidden`、`inert`、`tabindex`。文件头注释写明显隐规则与理由（一处，不复述规格）。
  验证：jsdom 新用例「隐藏的操作行仍可达」通过（用户与助手两条消息的按钮可按名找到，按钮及祖先无 `aria-hidden` / `inert` / `tabindex="-1"`，`userEvent.tab()` 依次到达可用按钮）；一条类名契约用例断言两种消息的 `article` 带 `group/message`、行带上述五个类；`make lint typecheck`；`ui-foundation-entry.test.ts` 与 `ui-reduced-motion.test.ts` 不改即通过。
- [x] 1.5 既有走查的悬停前置（chat-harness「UI 走查消息操作行显隐」第一项）：`web/e2e/ui-walk-stop.ts` 的 `walkRegenerate`（`:121` 附近的点击）与 `walkFork`（`:177` 附近），`web/e2e/ui-walk-session-list.ts` 的 `undoFirstTurn`（`:338` 附近），点击前先把鼠标移到所有消息之外、把焦点移到中性元素（输入框 `给助手发消息`；不能只靠「焦点大概不在行内」）并断言行 `opacity` 为 `0`，再 `hover()` 该消息的 `article` 并断言 `1`；`walkFork` 既有的 `align-self: flex-end`（`article`）与 `white-space: pre-wrap`（`message-body`）断言保持原样并通过。悬停 / 断言写成 `web/e2e/` 里的一个共享 helper（放进 1.6 的新模块），三处调用。
  验证：两个 project 下这三步通过；chat-harness「既有步骤先悬停」通过。
- [x] 1.6 显隐一步（chat-harness「UI 走查消息操作行显隐」第二、三项；design D5）：新模块 `web/e2e/ui-walk-action-row.ts`。会话：已完成、含文本非空的用户消息与正文非空的末条助手消息。依次量：鼠标移开（两行 `0`，行包围盒高度 > 0）→ 悬停用户消息（用户行 `1`、助手行 `0`）→ 悬停助手消息（反过来）→ 两条 `article` 的包围盒在悬停前后相等 → 鼠标移开、经真实 `Tab` 到达用户行的一个按钮：起点是固定的——聚焦输入框 `给助手发消息` 后按 `Shift+Tab`，每按一次检查一次，至多 N 次（N 取行内与输入框之间可聚焦元素数的上界，写成常量），直到 `document.activeElement` 是目标按钮，超过 N 次判失败（或聚焦紧挨在行前的一个固定元素后按一次 `Tab`，同样先断言 `document.activeElement` 是目标）→ 用户行 `1` → 剪贴板失败段**用末条用户消息**（`walkFork` 用的是第一条，互不干扰）：页面脚本把 `navigator.clipboard.writeText` 换成必定 reject 的函数，悬停并点末条用户消息的 `复制`，见 `复制失败`，鼠标移开并把焦点移到输入框 → 该行仍 `1` → 把 `writeText` 换成必定 resolve 的桩，悬停并再点一次该 `复制`，`复制失败` 消失（它只在下一次点击时清除，`copy-feedback.ts:21-26`；不清除的话 `has-[[role=alert]]` 会让该行一直为 `1`）→ 还原原来的 `writeText`，鼠标移开、焦点移到输入框，该行回到 `0` → `emulateMedia({reducedMotion:"no-preference"})` 下先断言行的计算 `transition-duration` 不为 `0s`（短渐变存在），再切到 `reduce` 断言为 `0s` → 恢复 `no-preference`。触屏：`browser.newContext({ hasTouch: true, viewport/colorScheme 与当前 project 相同 })`，登录态先试 `storageState: await page.context().storageState()`，不能直接打开会话时改为在该上下文里走登录表单；断言 `matchMedia("(hover: none)").matches` 为 `true` 后，不移动鼠标断言两行都为 `1`；上下文在 `finally` 里关闭；触屏上下文打开期间主页面的 error oracle 保持干净、转录不变（同一会话被两个上下文同时打开，流的所有权逻辑若有反应会在这里显形）。落点：**实测**把这一步并入主旅程（`walkHeldDialogue` 里 `walkRegenerate` 之后、`walkFork` 之前）后两个 project 的用例时长；任一 project 超过当前时限的八成，就改为独立 `test`（照「输入框能力」用例自带登录、oracle 与清理的写法，自建会话并按「冒烟与走查不留会话与临时空间」删除）。
  验证：两个 project 通过；chat-harness「显隐、键盘与复制失败」「触屏上下文常显」与 chat-web「真实浏览器下操作行的显隐」「显隐的短渐变与减少动态效果」通过；PR 里贴出登录态复用方式的实测结论与两个 project 的用例时长（并入前后）。
- [x] 1.7 规格对照：chat-web「消息线程」改写与新增的八个场景、chat-harness 新要求的三个场景，各有对应测试名（PR 里列表）。
- [x] 1.8 验收清单（`docs/acceptance/functional-checklist.md`，结论一律 `待签`，不代签；design D8）：「运行方式」加一条总则（消息下方的按钮在能悬停的设备上只在鼠标移到该消息上或用键盘聚焦时出现；各行写「点某条消息的某按钮」时先把鼠标移到那条消息上）。改写期望已不成立的行：CH-16（用户消息有「复制」，按钮在鼠标移到回答上时才出现）、CH-17（「看每条消息末尾的按钮」改为逐条把鼠标移上去看）、CH-18（用户消息的按钮在气泡外下方靠右，依次为「复制」「撤回」「从此处分叉」）。CH-13、CH-45、CH-52、CH-56 在「点」之前写明「先把鼠标移到该消息上」。新增四行，ID 接在现有最大号之后（今天为 CH-111，故 CH-112 起）：(a) 一句「hello」的用户消息气泡只有一行高，按钮不在气泡里；鼠标不在任何消息上时用户消息与回答下方都看不到按钮，移到某条消息上该条的按钮出现、移开消失，出现与消失时页面不跳动；回答刚生成结束时末条回答也一样不显示；(b) 用 Tab 键把焦点移到某条消息的按钮上，该行按钮出现且有焦点框，可用回车触发；(c) 鼠标移到一条用户消息上点「复制」，粘贴出的是原文（含换行）；把剪贴板写入替换成必定失败（同 CH-16 的控制台手法）后再点，出现「复制失败」，鼠标移开后这一行仍显示；只发附件的用户消息没有「复制」；已归档会话里用户消息只有「复制」；(d) 在手机或平板上打开（或在开发者工具的设备模拟里选一个触屏设备并刷新），不碰任何消息，所有消息的按钮都显示；带鼠标的触屏笔记本用鼠标时仍按悬停显示。
  验证：清单格式守卫（`web/test/functional-checklist.test.ts`）通过；行里没有像素值与选择器；改动行的结论仍为 `待签`。
- [x] 1.9 变异证据（对真实文件逐条做、逐条撤销，结果贴进 PR）：去掉 `group-hover/message:opacity-100` → 1.5 与 1.6 的悬停断言判红；去掉 `focus-within:opacity-100` → 1.6 的键盘断言判红；去掉 `has-[[role=alert]]:opacity-100` → 1.6 的「`复制失败` 后移开仍为 `1`」判红；把 `[@media(hover:hover)]:opacity-0` 改成 `opacity-0` → 触屏上下文判红；把行的变体由 `group-hover/message:` 改成裸 `group-hover:`，**并且**在 `Thread` 的 `section`（`aria-label="消息"`）上临时加一个裸 `group` 类 → 1.6 的「悬停用户消息时助手行为 `0`」判红（证明具名组承重；两处随变异一并撤销）；隐藏改用 `invisible` → 「隐藏的操作行仍可达」或 1.6 的 Tab 断言判红（如实记录是哪一个）；`UserActions` 不再渲染 `复制` → 「复制用户原文」判红；用户行挪回气泡内 → 「用户气泡与操作行的结构」判红；临时删掉 `theme.css` 里未分层的 reduce 覆盖块 → 1.6 的 `transition-duration` 断言判红（守卫测试同时判红属预期，随变异撤销）。
- [x] 1.10 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk`（两个 project）全绿；`bash scripts/size-guard.sh` 退出 0；`npx openspec validate chat-message-actions-hover --strict --no-interactive` 通过。

Suggested fixture level: compact - 纯前端呈现与测试：不改共享入口、接口、格式、持久化与配置；风险在「隐藏得太狠」（键盘 / 读屏 / 触屏够不着），由 1.4 的可达性用例与 1.6 的计算样式测量兜住
Minimal mergeable slice: atomic - 气泡拆层单独合入没有可见效果，显隐类名单独合入会让用户消息的行在气泡里忽隐忽现；`复制` 与次序改写共用同一批以 `article` 为范围的测试改写；走查的悬停前置只有在行会隐藏之后才有意义
