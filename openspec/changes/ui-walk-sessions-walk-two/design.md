# Design: ui-walk-sessions-walk-two（#541）

## Context
- **现状**（`web/e2e/ui-walk-sessions.spec.ts`，374 行）：`walkSessionMeta` 在 `try` 里走第 2–6 步，末尾真实导航到 `/settings`；`finally` 调 `deleteCreatedSession`（soft 断言：DELETE 204|404，随后列表不含该 id）；之后 `logout`。提示词是 `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 <uuid>`，UUID 只存在于提示词字符串里。等回合完成的 10 s 是全文件唯一的显式超时。每测试 30 s；第 1–6 步连同登录、清理、登出在 CI 上约 4.8–5.5 s。
- **真实栈探针**（编排者，官方 omp v18.0.10）：`PATCH {pinned:true}` 200、`PATCH {title}` 200（返回八键会话视图）；done 会话的 `DELETE` 204，耗时 31–40 ms（回合结束后立刻删与 3 s 后再删都一样）；随后 `GET …/messages` 404 `{"error":{"code":"not_found",…}}`。
- **标题**：建会话后标题恒为 `WORKBUDDY_THINK WO`（提示词前 18 个码点），每次运行、两个 project 都相同；复用状态上若有残留会话就会重名。服务端 `title` 限 1–80 个码点、会 trim；`pinned` 重复置顶保持原时间；PATCH 不改 `updated_at` 与 `status`，没有 409 路径。
- **行菜单**（`session-menu.tsx`、`session-sidebar.tsx`、`session-actions.ts`）：
  - 触发按钮 `更多操作：<标题>`，与选择按钮同在 `li.chat-session-item` 里；1440 下 hover / focus 才不透明（Playwright 的 click 会先 hover），390 下恒可见。
  - Radix DropdownMenu（`menu` / `menuitem`，portal）；菜单项依次为 `重命名`、`置顶任务` 或 `取消置顶`、`删除`。
  - 都不是乐观更新：置顶成功后只把响应里的 `pinnedAt` 合进本地列表（不重新拉取），Toast `已更新置顶状态`；重命名成功 Toast `已重命名`；删除成功 Toast `任务已删除`。Toast 存活 2400 ms，固定在 `top: 52px` 居中。
  - 置顶后条目换到另一个 `fieldset`，DOM 节点重挂；若它是唯一绑定该空间的会话，整个 `空间 (n)` 分区会消失。分区标题：`置顶任务`（无计数）、`任务 (n)`、`空间 (n)`。
  - mobile：选菜单项不会关闭导航覆盖层；重命名对话框与删除确认框渲染在页面层（覆盖层之外），它们打开时覆盖层被标成 `aria-hidden`——对话框要用页面级定位器。
- **覆盖层与 `aria-hidden`**：导航覆盖层打开时页面其余部分（含 Toast 区域、`main`）是 `aria-hidden`。按 role 找 Toast 或欢迎态 h1 在覆盖层开着时找不到。`inspectSidebar` 在 mobile 结束时按 `Escape` 并断言覆盖层消失；`escape-fallback.ts` 让 Toast 在场时 `Escape` 仍能关覆盖层，但按键目标须在覆盖层内——条目被重挂或删除之后焦点落在哪里没有验证过。
- **重命名对话框**（`rename-dialog.tsx`）：`dialog` `重命名任务`；输入 `任务名称`，初值为当前标题，打开即聚焦（不全选）；`保存` 在内容 trim 后为空时禁用；Enter 提交。
- **标题出现的位置**：侧栏条目按钮的 `aria-label`、状态元素 `<标题> 已完成`、触发按钮 `更多操作：<标题>`、顶栏 h1（可访问名是 `我的工作 / <标题>`，裸标题在 `.topbar-crumb-current`）。`document.title` 不变。
- **reload 之后**：列表与历史都从 REST 恢复；搜索状态、折叠块的展开状态、mobile 覆盖层都复位。
- **对话内搜索**（`conversation-search.tsx`、`search-match.ts`）：
  - 顶栏按钮 `对话内搜索`（带 `aria-expanded`；每个顶栏动作都包着 Tooltip，按文本定位会重名——按 role 定位）。
  - 搜索框是 `main` 里的 `search` `对话内搜索`；输入 `搜索对话内容`（`searchbox`），打开即聚焦；计数 `span.chat-search-count`，文本 `i/n`，**一打开就是 `0/0`**；按钮 `上一个`、`下一个`、`关闭`。
  - 只搜每条消息的 `content`（不含步骤、思考、审批），大小写不敏感的子串，按消息计数，无去抖。
  - 当前匹配：该消息的 `<article>` 带 `aria-current="true"` 与类 `chat-msg--search-current`；滚动是同步的 `scrollIntoView({ block: "center" })`。
  - `Esc` 只在输入框获得焦点时处理；关闭后无任何 `aria-current`，焦点回到顶栏按钮（其 Tooltip 随之出现）。
  - 本旅程的转录下：UUID → `1/1`（用户消息）；`WorkBuddy` → `1/2`（提示词里的 `WORKBUDDY_…` 与固定回复都命中）；思考文本 `先读需求` → `0/0`。
- **删除**（`delete-dialog.tsx`、`session-actions.ts`）：`alertdialog` `删除任务`，正文 `确定要删除「<打开时的显示标题>」吗？删除后不可恢复。`，按钮 `取消`、`删除`。204 之后依次：本地移除条目、关闭确认框、Toast、（若是当前会话）关闭事件流并 `replace` 导航到不带 `session` 的地址——欢迎态 h1 `WorkBuddy，我帮你`。服务端在应答 204 之前就结束了该会话的 SSE，页面在 204 之后才关闭事件流；浏览器的原生重连约 3 s，而实测 DELETE 约 40 ms，窗口内不会重连。
- **#540 留下的一处**：`step5ViewDetails` 的 `waitForEvent("framenavigated")` 先于 click 注册、之后才 `await`；click 自己超时时它先 reject 而没有 handler，成为 unhandled rejection，`finally` 的清理可能来不及。

## Decisions

### D1 结构
`walkSessionMeta` 的 `try` 块在 `step6Sidebar` 之后依次调用 `step7Pin`、`step8Rename`、`step9Search`、`step11Delete`（各带 `mark`）；删掉末尾导航到 `/settings` 的那两行与它的注释。`finally`、`deleteCreatedSession`、`logout` 不动（登出在欢迎态上做）。UUID 提到外层变量，提示词由它拼出。

### D1a 两个文件内辅助（避免四处重复，jscpd 不增）
- `rowMenu(sidebar)`：返回选中条目所在 `li` 里名字以 `更多操作：` 开头的按钮（行菜单触发按钮）；四处用到（第 7 步两次、第 8、11 步）。
- 一个分区归属断言：给定侧栏与期望的分区，断言选中条目在全列表计数 1、在期望分区计数 1、在其余两个分区计数 0。`step6Sidebar` 现有的计数断言改用它（行为不变），第 7、8 步复用。
- 实现：`sections(sidebar)`（四个定位器）+ `expectSelectedIn(list, home, others)`；`step6Sidebar` 仍是四条计数（全表 1、`空间 › ui-walk-sessions` 子组 1、`任务` 0、`置顶任务` 0）。另有三个只为不产生克隆的小辅助：`welcomeHeading`、`expectTranscriptReady`、`menuItem`（第 2 步与第 5 步末尾改用前两个，行为不变）。

### D2 第 7 步（置顶）
在侧栏里（mobile 在覆盖层里；实现者决定用 `inspectSidebar` 还是 `openSidebar` 加自己收尾，见 D7）：
- 行菜单经**选中条目所在的 `li`** 定位（`li` 里有 `button[aria-current="true"]`，取同一 `li` 里名字以 `更多操作：` 开头的按钮），不按标题。
- 点开 → `menuitem` `置顶任务` → 点击。
- 断言：`置顶任务` 分区里选中条目计数 1；整个 `会话列表` 里选中条目计数 1；名字匹配 `/^空间 \(\d+\)$/` 的分区里选中条目计数 0（分区消失时自然为 0）。
- 再点开行菜单：有 `menuitem` `取消置顶`、没有 `menuitem` `置顶任务`；关掉菜单（不选任何项）。

### D3 第 8 步（重命名与 reload）
- 行菜单 → `重命名` → 页面级 `dialog` `重命名任务`；`任务名称` 的值是 `WORKBUDDY_THINK WO`。
- 新标题 `走查重命名 <uuid 的前 8 位>`（每个 project 唯一，远小于 80 个码点）；`fill` 后点 `保存`；对话框消失。
- 断言：选中条目按钮的可访问名是新标题（侧栏内；mobile 此时覆盖层仍开着）；顶栏 h1 的可访问名是 `我的工作 / <新标题>`（mobile 先关覆盖层——覆盖层开着时顶栏是 `aria-hidden`）。
- `page.reload()` → 先等转录就绪（助手消息的固定回复可见，写法同 `step5ViewDetails` 末尾；第 9 步的搜索只在输入那一刻取匹配，历史没装载完就输入会得到 `0/1`）→ 顶栏 h1 仍是新标题；侧栏里（mobile 重新打开覆盖层）选中条目在 `置顶任务` 分区、可访问名是新标题、全列表选中条目计数 1。
- REST 回读：`page.request.get("/api/sessions")` 里该 id 的 `title` 等于新标题、`pinnedAt` 是整数。

### D4 第 9 步（对话内搜索）
次序固定：
1. 点顶栏 `对话内搜索`（按 role）→ `search` `对话内搜索` 可见，`搜索对话内容` 获得焦点，按钮的 `aria-expanded` 为 `true`。
2. 记录（`mark` 日志）此刻用户消息的 `article` 是否已在视口内——只是记录，供判断 `toBeInViewport` 在该 project 有没有判别力。
3. `fill(uuid)` → 计数文本恰为 `1/1`；用户消息的 `article` 有 `aria-current="true"` 且 `toBeInViewport`；带 `aria-current="true"` 的 `article` 全页恰一个。
4. `fill("WorkBuddy")` → 计数恰为 `1/2`（按消息计数：提示词与固定回复各一条）。
5. `fill` 一个不会命中的词（含另一个新 UUID）→ 计数恰为 `0/0`；带 `aria-current` 的 `article` 计数 0。
6. `fill(uuid)` → 再次 `1/1` 与高亮（给 `Esc` 一个「之前有高亮」的前提）。
7. 在输入框上 `press("Escape")` → `search` 框计数 0；带 `aria-current` 的 `article` 计数 0；顶栏按钮 `aria-expanded` 为 `false`。

### D5 第 11 步（删除）
- 行菜单 → `删除` → 页面级 `alertdialog` `删除任务`；其中恰有文本 `确定要删除「<新标题>」吗？删除后不可恢复。`。
- 点 `删除`（确认框里的按钮）→ Toast 文本 `任务已删除` 可见（按文本定位，见 D7）。
- 侧栏：`会话列表` 里选中条目计数 0；名字恰为新标题的条目计数 0（新标题唯一，所以这条对「从所有分区消失」有判别力）。
- 页面：URL 没有 `session` 参数；欢迎态 h1 `WorkBuddy，我帮你` 可见（mobile 先关覆盖层）。
- REST：`page.request.get("/api/sessions/<id>/messages")` 状态 404。
- 之后 `finally` 的 DELETE 得 404（已在接受集合里），列表不含该 id。

### D6 `step5ViewDetails` 的 `Promise.all`
`await Promise.all([navigated, <查看详情按钮>.click()])`，其余不变。目的只是让 `waitForEvent` 的 reject 有 handler：click 自己超时时，先 reject 的仍可能是 `waitForEvent`（同为 10 s 且先注册），报出的错误可以是两者之一；关键是它不再是 unhandled rejection，`finally` 照常执行。

### D7 mobile 的三处已知陷阱（实现者在真实栈上定写法，报告实际采用的写法与原因）
> 实测（两个 project，长驻栈 8 次 + 全新状态 2 次 mobile 运行）：第 2、3 条的担心都没有发生。置顶 / 删除之后焦点落在覆盖层容器自身（仍在覆盖层内），`inspectSidebar` 结尾的 `Escape` 关得掉覆盖层，Toast 在场也一样；行菜单上的 `Escape` 只收起菜单、焦点回到触发按钮、覆盖层不关；删除不关 mobile 覆盖层（URL 在覆盖层开着时已去掉 `session`）；Toast 没有拖慢指针动作。采用的写法：三步都用 `inspectSidebar`，Toast 用 `.ui-toast` 过滤文本。置顶不是乐观更新——点击到 PATCH 落地之间条目仍在 `空间`。
1. **覆盖层开着时按 role 找不到 Toast 与 `main` 里的东西**：Toast 按文本定位，必须 exact（`page.getByText("任务已删除", { exact: true })` 或 `.ui-toast` 过滤文本）——Radix 在 Toast 出现后的约 1 s 内另挂一个文本为 `通知 任务已删除` 的隐藏播报节点，非 exact 的文本匹配会 strict 冲突；欢迎态 h1 在覆盖层关闭之后断言。只断言规格点名的 `任务已删除`，不断言 `已更新置顶状态` 与 `已重命名`。
2. **条目重挂或删除之后关覆盖层**：`inspectSidebar` 结尾的 `Escape` 依赖按键目标在覆盖层内。若置顶 / 删除之后 `Escape` 关不掉覆盖层，改为点覆盖层自己的 `关闭`；检查 `取消置顶` 时关菜单用 `Escape` 可能把覆盖层一起关掉——可以改为再点一次触发按钮收起菜单。不为此加任何睡眠。
3. **Toast 遮挡**：Toast 在 `top: 52px` 居中，390 下可能盖住搜索框一带；Playwright 的指针动作会等到可点为止（最多约 2.4 s），是变慢而不是失败。键盘与 `fill` 不受影响。若因此接近预算，报告实测。

约束（沿用 #540）：
- 不用 `waitForTimeout`、`page.route` / `fulfill` / `continue`、假 `EventSource`、gate、`MODEL_UPSTREAM_*`、`test.setTimeout` / `test.slow`；不新增显式超时（等回合完成的 10 s 仍是唯一一个）。
- 只改 `web/e2e/ui-walk-sessions.spec.ts`。jscpd 保持 179（现有的登录块一处）；出现新的克隆则停下来报告。
- 整条旅程在每测试 30 s 内。

## Governing invariant
1. 改动只有 `web/e2e/ui-walk-sessions.spec.ts`；`npx playwright test --list` 仍是 6 条、2 个文件。
2. 第 7、8、9、11 步的每个断言都依赖服务端真实状态（PATCH / DELETE 的结果、reload 后从 REST 恢复的列表、服务端存的消息正文）。
3. 旅程结束后（成功或某一步断言失败）不留下它建的会话；成功路径上会话由第 11 步经 UI 删除。
4. 第 1–6 步的断言不被削弱；`ui-walk.spec.ts` 在新 spec 先跑的前提下两个 project 照常通过。
5. error oracle 零意外的 console / page error——特别是 UI 删除不得引出事件流的重连 404（若出现，是产品发现，停下来报告，不在 spec 里绕开）。

## Sibling surfaces
- `ui-walk.spec.ts`：新旅程仍不留会话；它留下的空间不变。旧旅程在 mobile-dark 开始时看到的列表与现在相同。
- 旧旅程留下的会话（未绑定，在 `任务` 分区；含一个 fork 出的 `未开始` 会话）与新旅程共处一个库：新旅程的置顶使 `置顶任务` 分区出现——它在 `finally` 之前已被删除，旧旅程看不到。
- `smoke/session-meta.hurl` 也做置顶 / 重命名 / 删除，但在另一个 job、另一个库。

## Must-preserve
- `make lint`、`make typecheck`、`make anti-drift`（jscpd 179、knip 零新增）、`npm test --workspace web`、`make test-guardrails` 全绿；`web/playwright.config.ts` 零 diff。

## Required evidence
- **E1** `git diff --stat origin/master`（除 `openspec/`）只有 `web/e2e/ui-walk-sessions.spec.ts`；`npx playwright test --list` 为 6 条 / 2 文件。
- **E2 全新状态**（CI 同款包装，环境变量同 #540；两个不同的 `RUNNER_TEMP`）：完整 `make ui-walk` 退出 0，`5 passed, 1 skipped`；记录每条时长、总时长、新旅程每步的 `mark` 累计。
- **E3 复用状态**（长驻栈，只跑新 spec）：两个 project 连续五遍全绿；记录每遍时长（最大值须明显低于 30 s）；`mobile-dark` 的五遍单独列出（D7 的写法靠它作证）。
- **E4 残留清点**（E3 之后）：会话总数与运行前相同、无 running、无绑定走查空间的会话、没有标题以 `走查重命名` 开头的会话。
- **E5 负对照**（沙箱里改 spec 的一处，长驻栈，只跑新 spec；**每条在两个 project 上各跑一次**；记录失败所在的步骤与旅程错误；每条之后清点残留，须为零；脚本与日志不入库）：
  - N1 跳过 `置顶任务` 的点击 → 第 7 步（条目不在 `置顶任务`）。
  - N2 第 7 步期望 `空间` 分区里仍有该条目（计数 1）→ 第 7 步。
  - N3 第 7 步期望菜单仍提供 `置顶任务` → 第 7 步。
  - N4 重命名时点 `取消` 而不是 `保存` → 第 8 步（标题没变）。
  - N5 reload 之后期望旧标题 → 第 8 步。
  - N6 REST 回读期望 `pinnedAt` 为 null → 第 8 步的回读。
  - N7 UUID 的期望计数改成 `2/2` → 第 9 步。
  - N8 期望助手消息是当前匹配 → 第 9 步。
  - N9 无匹配词的期望计数改成 `1/1` → 第 9 步。
  - N10 去掉 `Escape` → 第 9 步（搜索框仍在）。
  - N11 删除确认框里点 `取消` → 第 11 步（没有 Toast / 条目仍在）；其后 `finally` 删除，残留为零。
  - N12 确认文案期望旧标题 → 第 11 步。
  - N13 删除后的 REST 期望 200 → 第 11 步。
  - N14 `查看详情` 的按钮名改成不存在的 → 第 5 步以一个被处理的超时失败（消息是 click 的定位超时或 `waitForEvent` 的超时，两者皆可）；运行输出里没有 unhandled rejection、worker 没有被中途停掉，`finally` 照常删除（清理日志行在）、残留为零。对照：同一变异打在修复前的写法上（base commit 的文件）会留下残留或报 unhandled rejection——跑一次并记录现象。
  - N15 删除之后期望名为新标题的条目计数 1 → 第 11 步的「条目消失」断言（Toast 断言已通过）。
  - N16 重命名对话框的预填值期望改成别的串 → 第 8 步。
  - 另：#540 的负对照里仍适用的（原 N1–N11、N13）在 `desktop-light` 上重跑一遍，确认第 1–6 步的断言没有被削弱。
  - 实测更正：原 N11（去掉 `finally` 的清理）在成功路径上已无判别力——第 11 步已经经 UI 删除，旅程照样通过、零残留。替代是「去掉清理并让第 9 步失败」：留下 1 条绑定走查空间的会话，证明失败路径上 `finally` 仍然必要。N2 在两个 project 上失败的断言行不同（desktop 上 `空间` 计数 1 在 PATCH 落地前短暂成立），另补一条无歧义的版本（保留真断言，再期望 `空间` 计数 1）。N14 的基线对照：测试被孤立的 `waitForEvent` reject 结束，`finally` 里的 DELETE 报 `Test ended.` 没到服务端，留 1 条会话；Playwright 的输出里没有 `unhandled` 字样，证据是错误的次序与残留。
- **E6 门禁**：`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`npm test --workspace web`、`make test-guardrails`、`bash scripts/size-guard.sh web/e2e/ui-walk-sessions.spec.ts`（pre-commit 会把暂存文件传给它，≤ 800 行）、`openspec validate ui-walk-sessions-walk-two --strict --no-interactive` 退出 0；jscpd 计数与克隆位置。
- **E7 源码清点**：`rg -n "waitForTimeout|page\\.route|\\.fulfill|EventSource|setTimeout|test\\.slow|MODEL_UPSTREAM"` 零命中；显式 `timeout` 仍只有一处。
- **E8 CI**：PR 的 `ui-walk` job 通过；从日志记录四条旅程各自的时长、总时长与新旅程的分步累计。

## 已知残留
1. **「滚入视图」没有断言级的真实浏览器证据**：`desktop-light` 上用户消息搜索前已完整在视口内（位置不变）；`mobile-dark` 上搜索前被转录框顶部裁掉约 39 px、`1/1` 之后完整可见（`mark` 日志里消息的 y 从 54–77 变到 128）——位移只在日志里，不是断言；`toBeInViewport`（任意相交）在两个 project 上搜索前都会通过。滚动行为由 jsdom 的对话内搜索测试证明。
1a. **「助手消息没有 `aria-current`」按排除法断言**：全页带 `aria-current="true"` 的 `article` 恰一个且用户消息带它；没有对助手 article 的直接否定断言（N8 证明它会咬）。
2. **只走行菜单**：顶栏的 `重命名` 入口不在走查里。
3. **只删除 done 会话**：running 会话的 UI 删除没有真实浏览器证据（服务端集成测试覆盖 REST 路径）。
4. **Toast 只断言 `任务已删除`**；`已更新置顶状态`、`已重命名` 不断言。
5. **失败路径上的重连 404**：页面仍在会话页时 `finally` 删除，约 3 s 后事件流重连进 404，会给已失败的运行多加一条 oracle 错误。
6. **取消置顶**不走（菜单项的文案变化有断言，点击没有）。
6a. **有断言而没有负对照的句子**：「保存后对话框关闭」（`取消` 同样关框）、reload 前的顶栏标题、reload 后 DOM 上的置顶分区（N6 只打 REST）、`0/0` 时无当前匹配、`Esc` 之后高亮清除（N10 先失败在搜索框）、URL 与欢迎态、`1/2`。都是对真实 DOM 的肯定或计数断言。
7. **测试超时不清理**（同 #540）。
8. **每测试 30 s**：#557 还要加第 10 步的两个真实回合。实测（本地）：复用状态下新旅程 4.2–4.3 s（desktop）/ 5.6–5.7 s（mobile）；全新状态 6.3 s / 5.6 s，完整 `make ui-walk` 36 s。第 7–11 步合计约 1.7 s（desktop）/ 2.6 s（mobile）。

## Seams under test
- 真实浏览器对编译后的应用、真 omp 与受控上游；没有任何桩。
- REST 回读与清点经 `page.request`，不经过 error oracle 的监听。
