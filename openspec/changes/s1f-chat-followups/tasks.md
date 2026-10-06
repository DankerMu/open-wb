# Tasks: s1f-chat-followups

> 执行顺序：1 → 2 → 3 → 4 → 5 → 6，串行（共享 `docs/acceptance/functional-checklist.md`、`web/test/ui-layering.test.ts` 的清单断言与 ui-walk 文件）。
> 组 1 与组 4 改 `turn-actions.ts` / `use-chat-session.ts`：在 `fix-new-session-handoff`（#872）的 PR 合入之后开工，基于它的结果改。
> 组 6 不依赖代码，可提前，但不与组 1–3 并行（同改功能验收清单）。
>
> 通用纪律：
> - 每组一个小 PR（按各组的 `Minimal mergeable slice`），每个 PR 合入后 `make check`、`make test-guardrails`、`make ui-walk` 全绿、主干可运行。
> - 拷入层（`web/src/components/ui`、`web/src/components/assistant-ui`）不动：本 change 没有一处需要改拷入文件（design D4）。若实现中发现非改不可，停下来报告，不自行放宽 ADR-0013 的六类修改。
> - `web/src/ui/**` 冻结；外壳文件、文件页不动。会话列表的八个文件（`session-sidebar.tsx`、`session-filter.tsx`、`session-menu.tsx`、`session-groups.ts`、`session-actions.ts`、`session-path.ts`、
>   `rename-dialog.tsx`、`delete-dialog.tsx`）不再冻结，但本 change 对它们只有 4.5 的一行注释。
> - `web/src/features/chat/` 下新增的 `.ts`/`.tsx` 必须在同一个 PR 里登记进 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 并同步清单断言（终态守卫按文件逐个核对）；已迁移文件不得导入 `useToast`。
> - 单文件 800 行上限：`web/e2e/ui-walk-sessions.spec.ts`（776 行）与 `web/e2e/ui-walk-layout.ts`（793 行）不再加行，新的走查步骤写进别的 helper 文件（本 change 用到的 `ui-walk-scroll.ts`、
>   `ui-walk-approval.ts`、`ui-walk-steps.ts`、`ui-walk-stop.ts` 都有余量），或新建 helper。`server/test/session-rest.test.ts`（789 行）同样不加行。新测试写进新文件或有余量的既有文件。
> - 既有断言只要还有意义就不删除、不削弱。规格条文在本 change 被改的行为，其断言随条文改写，改写处写进 PR 的偏离记录；各任务已点名要改的断言之外若还有别的变红，先查原因再动。
> - 用户可见的变化在 `docs/acceptance/functional-checklist.md` 的「会话（CH）」节增改对应行，结论一律 `待签`；agent 不把任何行改为 `通过` / `不通过`。清单行不写带单位的像素值与点号、井号开头的选择器（守卫会拒）。
> - 每条新测试给出变异证据：去掉或写反对应实现时判红，写进 PR 描述。
> - 仓库是公开的：任何被跟踪文件里不出现主机绝对路径、用户名、IP 或密钥。

## 1. chat-web — 首次发送被拒后显示新会话的状态

- [x] 1.1 `web/src/features/chat/turn-actions.ts` 的失败收尾（未受理分支）：恢复草稿、写输入框错误、清掉交接登记之后，若这次交接是欢迎态首次发送（登记的 `originSessionId` 为空且会话 id 已有）、
  页面仍归同一 client 且仍选中该会话，调用一次 `loadHistory(sessionId, client)`（design D1）。`loadHistory` 经 `TurnActionDeps` 以 ref 注入（保持 `dispatchPrompt` 的引用稳定），`use-chat-session.ts` 传入既有的那一个；同时给派发 prompt 的 effect 的闸加「登记尚未受理」（`!pending.accepted`，design D1）。
  不新增状态；既有会话的 prompt 被拒、受理后的失败分支、401 都不走这条路。
- [x] 1.2 整页测试（新文件 `web/test/chat-page-first-send-rejected.test.tsx`）：
  (a) 欢迎态选中工作空间后发送，创建返回、prompt 收到 503 `agent_capacity` → URL 选中新会话；被拒之后恰一次对该会话的历史读取、随后恰一次事件连接；线程区显示零消息空态（提示语与 `工作空间 <名>`）；
  输入框上是信封文案，草稿恢复，历史返回后输入框可用，没有 `生成中` / `停止`；全程恰一次 `POST /api/sessions`、恰一次 prompt。
  (b) 400、409、502 与网络失败各一例（`it.each`），结果同 (a)，文案各为其信封或安全文案。
  (c) (a) 之后直接再次发送：恰新增一次 prompt、没有第二次创建，受理后空态消失、出现用户消息。
  (d) 历史已加载的既有会话里 prompt 收到 503：被拒之后没有新的历史读取，事件连接没有被关掉重开。
  (e) prompt 被拒之前用户已切到别的会话 / 已回欢迎态（交接未落定时 `新建会话` 不导航，回欢迎态须走路由导航或浏览器后退来驱动）：不为新会话发出历史读取，当前界面没有它的错误。
  (f) 补读的历史读取失败：显示历史错误与输入框错误，不显示空态；补读返回 404：回到欢迎态。
  这些用例的假路由必须为新会话提供消息快照路由：没有路由等于 404，补读会把页面带回欢迎态，「再次发送」就变成再建一个会话。
- [x] 1.3 #879 备注里缺的断言（加在 `web/test/chat-empty-state.test.tsx`，现 292 行）：
  既有的零消息会话里发送、prompt 被拒 → 空态重新出现且草稿恢复；零消息会话的事件流终止失败（现有 E7c）之后切到别的会话再切回 → 空态恢复、没有流错误；
  运行环境没有 `EventSource` 时打开零消息会话 → 显示 `无法连接会话事件` 加刷新指引、输入框锁定、不显示空态、没有 `生成中` / `停止`（去掉全局构造器即可，用后还原）。
- [x] 1.4 变异证据：去掉 1.1 的调用 → 1.2(a) 判红；把条件放宽成任何被拒的 prompt 都补读 → 1.2(d) 判红。1.2(e) 钉的是既有的中止 fence（切走时登记已清、请求已中止，失败收尾提前返回）；
  1.1 的「同一 client / 仍选中」与派发 effect 闸上的 `!pending.accepted` 都是防御条件，没有独立变异，写进 PR 偏离记录。
- [x] 1.5 CH 行：在容量已满 / 发送失败的既有行里补一句期望（首次发送就失败时对话区显示「还没有消息，发一条开始吧」，不是空白），没有合适的行就新增一行；结论 `待签`。

Suggested fixture level: compact - 失败收尾分支上的一次既有调用；风险在所有权 fence，由 (d)(e) 两条反例与「恰一次 prompt」钉住
Minimal mergeable slice: atomic - 调用、整页测试与清单行同刀；1.3 的三条断言不依赖 1.1，可并入同一 PR 或单独先行

## 2. tool-approval / session-todo / chat-web — 可访问性（owner 决定 3 的 a–d）

- [x] 2.1 显式列表语义：四处带 `list-none` 的列表加 `role="list"`——`web/src/features/chat/todo-panel.tsx:83`、`project-config.tsx:73`、`capability-bar.tsx:195`、`welcome.tsx:78`
  （当前 `web/src` 里只有这四处；Biome 的冗余角色规则会报，按文件既有写法加带理由的 ignore 注释）。
  静态测试（新文件或并入 `web/test/chat-module-layout.test.ts`）：`MIGRATED_AREAS` 内的 `.tsx` 里，凡开标签带 `list-none` 的也带 `role="list"`；注入样本自证。
- [x] 2.2 测量 hook：把 `approval-card.tsx` 里「内容高度超过可见高度」的测量抽到新文件 `web/src/features/chat/use-clipped.ts`（登记 `MIGRATED_AREAS`），提问卡正文改用它，行为不变
  （`web/test/chat-approval-dock.test.tsx` D1 原样通过）。hook 的单元测试（新文件）：挂载时量一次；触发量变化时重量；用可控的 `ResizeObserver` 替身触发回调后重量；没有 `ResizeObserver` 时不抛错。
- [x] 2.3 被裁剪时可键盘聚焦（design D3）：`todo-panel.tsx` 的列表 `ul`（触发量：清单内容、限高档位与展开状态）与 `project-config.tsx` 里包着各分组的滚动 `div`（触发量：文件列表）在被裁剪时带 `tabindex="0"`，否则不带。任务清单的触发量含展开状态（或把 hook 放进随 `ul` 一起挂载的子组件）：补一例「收起态挂载后展开、内容被裁剪 → `tabindex="0"`」。
  测试：`web/test/chat-todo-panel.test.tsx` 的 S1 按 `chat-approval-dock.test.tsx:58-61` 的打桩方式补「200 项被裁剪 → 列表 `tabindex="0"`、`role="list"`」；
  T1 第 193 行的查询（面板内没有 `[tabindex]`）保留，它断言的是未被裁剪的五项清单，把上一行注释改成写明这一前提。
  `web/test/chat-page-project-config-dialog.test.tsx` 加 H4：被裁剪时滚动容器 `tabindex="0"`、打开时焦点仍在 `关闭`、对话框内按钮仍只有 `关闭`；未被裁剪时没有 `tabindex`
  （`chat-page-project-config.test.tsx:208-209` 的「唯一按钮」断言不变）。
- [x] 2.4 提问卡的描述关联：`approval-card.tsx` 的待决卡在 `role="group"` 上加 `aria-describedby`，依次指向本卡的工具徽章与 `title` 正文（各一个 `useId`）；已结算记录不加。
  测试（`web/test/chat-approval-dock.test.tsx`，现 364 行）：两张工具与正文不同的卡，各自的 `aria-describedby` 恰两个 id、依次解析到本卡的徽章与正文、两卡互不相同；卡名与四个按钮名不变。
- [x] 2.5 卡消失后的焦点（design D2）：规则与两路判定在 `composer-dock.tsx`；`ApprovalPromptCard` 上报每次被受理的作答及其是否由键盘激活且焦点在本卡内（#901 审核后收窄：只有键盘作答移动焦点；卡内按钮忽略重复按键；对应用例 F7–F10）；`conversation-view.tsx` 把输入框 ref 与锁定状态传给停靠区，
  最后一张卡消失而输入框仍锁定时延后到解锁那次提交、且焦点仍未落到别处才聚焦。
  测试（同文件，F1–F6）：三张卡依次作答的焦点落点（id 8 → 9 的 `允许`；9 → 7 的 `允许`；7 → 回合结束解锁后的输入框）；作答后显式 `blur()` 模拟禁用失焦，结果相同；
  焦点在 `停止` 上时卡因超时消失 → 不动；作答后用户把焦点移到 `停止` → 不动；延后聚焦期间焦点去了 `停止`、回合结束时 `停止` 卸载焦点回到 `body` → 解锁时不抢（延后聚焦按「期间有过别处的 focusin 即作废」实现，不是只在解锁那一刻看 `activeElement`）；卡出现时不夺焦；
  焦点在卡的按钮上、未作答、卡因超时消失且还有别的卡 → 移到那一张的 `允许`；移动后 400 毫秒内对新按钮的点击不作答。
  既有用例里用 `fireEvent.click` 作答的不聚焦按钮，不受影响；`chat-todo-panel.test.tsx` V4（第 297 行，焦点留在输入框）原样通过。
- [x] 2.6 ui-walk（`web/e2e/ui-walk-approval.ts`，现 140 行）：现有作答步骤改为先聚焦 `允许` 再按 Enter；回合结束后断言焦点在输入框。只此一处真实浏览器证据（走查栈只产生一张卡）。
  （后半句未取证：走查在回合结束前刷新页面，焦点记录随之丢失，见 PR #901 偏离记录；该行为由 `chat-approval-dock.test.tsx` 的 F1、F2、F4 在 jsdom 覆盖，真实浏览器里没有焦点落点的证据。）
- [x] 2.7 变异证据：去掉 `role="list"` → 2.1 判红；`tabindex` 恒为 0 → T1 第 193 行与 H4 的未裁剪一例判红，恒不加 → S1 与 H4 判红；触发量去掉展开状态 → 「收起态挂载后展开」一例判红；延后聚焦改成只在解锁那一刻看 `activeElement` → 「焦点去了 `停止`」一例判红；去掉 `aria-describedby` 或两卡共用 id → 2.4 判红；
  去掉焦点移动 → F1 判红；无条件移动 → 「焦点在别处」两例判红；不延后直接 `focus()` → 「解锁后在输入框」判红。
- [x] 2.8 CH 行：多张卡的那一行（CH-22）补「用 Tab 聚焦下面那张的按钮并按 Enter 作答后，焦点落到上面那张的『允许』；最后一张答完、回答结束后焦点在输入框」；
  任务清单与项目配置各补一句「内容超出时可按 Tab 聚焦列表并用方向键滚动」；结论 `待签`。

Suggested fixture level: expanded - 焦点移动有「不夺取」的多条反例与禁用失焦、输入框锁定两处时序；改两份规格的条文
Minimal mergeable slice: 2.1 + 2.2 + 2.3 一刀（列表语义与被裁剪可聚焦，含新 hook 的登记）；2.4 + 2.5 + 2.6 一刀（提问卡的描述与焦点，同改 `approval-card.tsx` / `composer-dock.tsx`）；各自带走 2.7、2.8 中自己的份额

## 3. chat-web — 代码块复制不带末尾换行（owner 决定 2）

- [x] 3.1 `web/src/features/chat/markdown-body.tsx` 的 `CodeHeader`：传给 `useCopyFeedback` 的文本去掉末尾恰一个 `\n`（design D4）。拷入文件 `markdown-text.tsx` 不动；`copy-feedback.ts` 不动（消息级 `复制` 共用它，不裁）。
- [x] 3.2 测试（`web/test/chat-markdown.test.tsx`）：第 153 行现断言写入值等于以换行结尾的 `CODE`，改为去掉末尾一个换行后的文本；新增一例代码块以空行结尾 → 写入值仍以恰一个换行结尾、内部换行原样；
  `web/test/chat-copy.test.tsx` 的消息级断言（写入 Markdown 原文）原样通过。
- [x] 3.3 CH-05：期望里写明粘贴出的内容末尾不带多余的换行；该行「禁用该站点的剪贴板权限」一步换成 CH-16 已用的控制台替换写法（权限开关多半不影响用户手势内的写入）；结论 `待签`。
- [x] 3.4 变异证据：不裁 → 3.2 第一例判红；裁掉全部末尾换行 → 空行结尾一例判红；裁到消息级复制上 → `chat-copy.test.tsx` 判红。

Suggested fixture level: compact - 应用层一处字符串处理，规格一句一场景
Minimal mergeable slice: atomic - 改动、断言改写与清单行同刀

## 4. 源码整理（逐条核对过仍存在；除 4.2、4.6 外无行为变化）

- [x] 4.1 `web/src/features/chat/message-thread.tsx:247-275`：`ThreadPrimitive.Messages` 的 children 改为 `useCallback` 的稳定函数（依赖是它闭包里用到的那几个 props 与 `regenerableId`）。既有线程测试原样通过。
- [x] 4.2 `max-[760px]:` 换成 `narrow:`（design D6，视口恰为 760 宽时与外壳一致）：`web/src/features/chat/composer.tsx:59`、`:73`，`message-thread.tsx:81`、`:244`，
  `web/src/features/settings/page.tsx:32`、`:166`，`web/src/features/auth/login-form.tsx:76`；换完 `web/src` 里除 `styles/theme.css:16` 的注释外不再有 `max-[760px]`。
  加一条静态断言（并入 `web/test/ui-foundation-entry.test.ts` 或同类文件）：`web/src` 的 `.tsx` 不含 `max-[760px]:`。
- [x] 4.3 `web/src/features/chat/conversation-search.tsx:62`：`BoxButton` 里的 `size={14}` 被拷入按钮的图标尺寸规则盖掉，删去这个属性（渲染结果不变）；第 115 行那个不在按钮里，不动。
- [x] 4.4 `regenerateTurn` 的布尔返回值无人读取（消费方都按 `Promise<unknown>` 收）：`turn-actions.ts:311` 起改为 `Promise<void>`，
  `conversation-view.tsx:30` 与 `message-thread.tsx:35` 的类型同步；测试替身（`web/test/chat-thread-runtime.test.tsx:45`、`chat-page-search-support.tsx:292`）按需跟着改。
- [x] 4.5 过期注释与标题：`message-thread.tsx:4`（「文件变更卡与产物卡此刻仍是旧组件」）；`session-sidebar.tsx:88`（「同 approval-bar」，该组件已删）；
  `artifact-card.tsx` `PreviewDialog` 的文档注释（收窄为「只决定打开时的初始落点；页面脚本自行聚焦或用户 Tab 进 iframe 后，Escape 到不了本文档，`关闭` 与点遮罩仍可用」）；
  `web/test/chat-page-file-changes.test.tsx:3`（「C1–C15」，C15 已删）；`web/test/chat-page-file-changes-support.tsx:2`（「只供……使用」，实际被多个测试导入）；
  `web/test/chat-page-project-config-dialog.test.tsx:2`（归档前的 change 路径）；`web/test/chat-steps.test.tsx:288` 的用例标题（「the .chat-md body」）。
- [x] 4.6 `server/src/sessions/store-todo.ts` 的 `readTodo`：存量文本 `JSON.parse` 失败、解析结果不是带自有属性 `phases` 的普通对象、或其 `phases` 经 `normalizeTodo` 判为不合规时返回 `null`（`normalizeTodo` 的入参是 `phases` 数组，不是整个对象），不抛错、不改写该列、不记日志（design D6；session-todo delta「任务清单快照」）。
  测试：`server/test/persist-todo.test.ts`（现 252 行）加两例（非 JSON、结构不合规 → `null`，列值未变）；`server/test/session-snapshot.test.ts` 加一例带外写坏值后快照 200 且 `todo` 为 `null`
  （`session-rest.test.ts` 已 789 行，不往里加）。变异：去掉降级 → 两处判红。
- [x] 4.7 走查探针：`web/e2e/ui-walk-steps.ts:63-64` 的 `expectFocusRingInside`——之前的焦点是 `body` 时改为 `blur()`，不再对 `body` 调 `focus()`；
  同文件 `paintedWithin`（第 108-121 行）——`elementFromPoint` 返回 `null` 时判为不成立（现在空过），恢复 `pointer-events` 放进 `try/finally`；
  `web/e2e/ui-walk-scroll.ts:164` 的 `pre.last()` 换成步骤卡输出块的稳定钩子（`data-slot="step-output"`）；
  `web/e2e/ui-walk-stop.ts:79`、`:98` 对 `已停止生成` 的缺席断言改为不重试的瞬时计数（自动重试的写法等得到旧提示自行消失，对旧实现不判红）。

Suggested fixture level: compact - 逐条小改；4.2 与 4.6 改变可观察行为，各带一条断言，4.6 另有规格一句一场景
Minimal mergeable slice: 4.1 + 4.2 + 4.3 + 4.4 + 4.5 一刀（web 源码与注释）；4.6 单独一刀（服务端，带规格 delta）；4.7 单独一刀（只改 `web/e2e`）

## 5. 补测试（不改产品代码）

- [ ] 5.1 流错误恢复：最近快照为 `running` 时事件连接终态失败（没有 `生成中` / `停止`）→ 切到别的会话再切回、历史重读为 `running` → `生成中` 与 `停止` 重新出现、流错误消失。新文件 `web/test/chat-stream-error-recovery.test.tsx`。
- [ ] 5.2 「+」菜单空目录：目录请求成功但为空 → 菜单只显示 `暂无可用项`、不显示错误（`web/test/chat-page-plus-menu.test.tsx`，现 368 行；真实后端到不了这一分支，只能在这里钉）。
- [ ] 5.3 「+」菜单点菜单外关闭：草稿不变、焦点回到 `技能与命令` 按钮（同文件，现只有 Esc 一条路径）。
- [ ] 5.4 原生跟随开关守卫（`web/test/chat-scroll-follow.test.tsx`，现 577 行，或新文件）：用户上滚后开始新回合，线程不被拉回底部——钉 `scrollToBottomOnRunStart`；
  变异：从 `thread-viewport.tsx` 的 `NATIVE_FOLLOW_OFF` 去掉该项应判红。jsdom 下若基元的这次滚动观察不到（变异不红），改为把四个开关的值作为可断言的结构钉住，并把「未能在 jsdom 层证明」写进 PR 偏离记录。
- [x] 5.5 走查里真实点击 `回到最新`（`web/e2e/ui-walk-scroll.ts`，现 276 行，在按钮可见的那一步之后）：点击后转录到达底部（距底在容差内）、按钮消失。
- [ ] 5.6 `web/test/chat-composer.test.tsx`（现 247 行）：补回 #893 丢掉的「窄屏外壳不带 gap」——`conversation-view.tsx` 里带 `grid-cols-[minmax(0,1fr)]` 的那个外层容器的类名里没有任何 `gap-` 记号（含 `narrow:` 前缀的；其内的 `chat-column` 带 `gap-2` 是对的，不改产品代码）；
  `chat.css` 选择器归属断言不再整体放行 `@media (hover` 块，改为进到块内对其选择器用同一归属规则，注入样本自证。
- [ ] 5.7 产物面板跨重同步保持打开：面板打开时到达未知回合事件、页面重装快照 → 面板仍开、内容来自新快照（`web/test/chat-page-artifacts-panel-focus.test.tsx`，现 257 行）。
- [ ] 5.8 只读工作空间标签的真实点击：已选会话里点击标签 → 不出现弹层、没有新请求（`web/test/chat-capability-bar.test.tsx`，现 112 行；现为「无按钮、无可聚焦元素」的代理断言）。
- [ ] 5.9 每条写明对应的变异或「去掉哪一行实现判红」；写不出变异的（纯结构钉子）在 PR 描述里说明。

Suggested fixture level: compact - 只加断言；产品代码零改动（发现缺陷则停下报告，不在本组修）
Minimal mergeable slice: 5.1–5.4、5.6–5.8 一刀（jsdom 测试）；5.5 单独一刀（ui-walk）

## 6. 文档：验收清单订正、删除旧清单、ADR 增补

- [x] 6.1 `docs/acceptance/functional-checklist.md` 订正无法执行或无从判定的行（改过的行结论保持或回到 `待签`）：
  CH-22 补一句「紧接着的那一下若点晚了、把上面那张正常答掉了，就换一轮重试」；
  CH-25 去掉对开发者工具的依赖，改成看得见的行为（说明再长也只在说明那一段里滚动、两个按钮始终可见、多出「内容较长，请滚动查看全部」一行、可 Tab 聚焦后用方向键滚动）；
  CH-27 去掉人工不一定触发得了的三处（同一文件两步修改改成明确的两轮请求并写明「模型未照做就换说法重试」；删去「步骤没结束时这张卡不出现」；末句改成真正验证「没有绑定工作空间的会话没有这张卡」的做法）；
  CH-31、CH-33、CH-34 里「到『文件』页删除」的步骤——文件页没有删除入口（`web/src/features/files/` 里没有，服务端也没有删除路由）——改为另发一句让助手执行删除该文件的命令（写明模型不照做时只能到服务器上删）；
  CH-31 里「到文件页新建同名文件并写入内容」同样核对文件页能否做到，做不到就改成让助手重新写入；
  CH-49 写明如何准备与平台同名的项目命令（按命令目录的实现写出放置位置与文件名，页面上没有入口）；
  CH-51 删去期望末尾「输入框里的文字与光标不受影响」（该情境下输入框是锁定的，人工无从判定；自动化由 `chat-todo-panel.test.tsx` V4 覆盖）；
  CH-37、CH-55 写明计数的前提（该工作空间的上级目录里没有同类配置文件）。改完跑清单的格式守卫。
- [x] 6.2 删除 `docs/acceptance/demo-parity-checklist.md`（design D5）；`docs/acceptance/functional-checklist.md` 第 4 行改为不再指向它（例如「它取代了按 demo 逐组件比对的旧清单（已删除）」）。
  不改：`docs/adr/0013-*.md` 正文第 12 行、`docs/adr/0011-*.md`、`IMPLEMENTATION_PLAN.md`（第 42、208 行）、`docs/reviews/2026-09-24-demo-parity-audit.md`、
  `web/test/functional-checklist.test.ts:242` 的样本字符串、`openspec/changes/archive/**`。`openspec/specs/functional-acceptance/spec.md` 的那一句由本 change 的 delta 在归档时替换。
  删完在仓库里搜一遍文件名，确认归档目录之外只剩上列几处，外加本 change 自己的目录（归档后是主规格 `functional-acceptance` 里的那一句）。
- [x] 6.3 `docs/adr/0013-assistant-ui-frontend-rebuild.md` 加一节「增补（2026-10-06，#874 跟进）」，每条一行、标明 owner 与日期：
  代码块复制去掉末尾恰一个换行，改在应用层、拷入文件不动，六类修改不变；
  可访问性四项（显式列表语义、提问卡描述关联、卡消失后的焦点规则、被裁剪列表可键盘聚焦）；
  不处理：正文比状态晚一帧（拷入的 `markdown-text` 沿用上游的 `defer`）、输入框增高依赖 `field-sizing`；
  包体：暂不设上限，S1f 全部 change 完成后再定上限与是否分割（#893 实测 JS 较重建前增加 488,187 字节）；
  `docs/acceptance/demo-parity-checklist.md` 删除，历史从 git 查看。

Suggested fixture level: compact - 只改文档；清单格式有守卫
Minimal mergeable slice: 6.1 一刀（清单订正）；6.2 + 6.3 一刀（删除与 ADR 增补同刀，ADR 那一行就是删除的依据）
