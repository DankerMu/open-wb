# Design: harness-slash-whitelist（#557）

## Context
- **冒烟现状**（`smoke/session-meta.hurl`，310 行）：登录 → 采用空间 `smoke-sessions` → (1) 绑定创建 → (2) 被拒的创建与无 body 创建 → (3) PATCH → (4) `WORKBUDDY_THINK` 回合与审批 → (5) done 快照 → (6) DELETE → (7) 所有权。页头注释写着「slash 白名单步骤由后续 issue 追加」。`make smoke` 以 `--retry 0` 运行，轮询只靠条目自己的 `[Options] retry`；变量 `content_pattern` 是固定回复的全匹配正则。`chat.hurl` 的 prompt 条目同时捕获 `userMessageId` 与 `assistantMessageId`。
- **走查现状**（`web/e2e/ui-walk-sessions.spec.ts`，566 行）：`walkSessionMeta` 的 `try` 里走第 2–9、11 步；第 9 步结束时：在会话页，转录两条消息，搜索框已关，焦点在顶栏 `对话内搜索` 按钮上，mobile 导航覆盖层关闭，会话已改名并置顶，没有 Toast，composer 空闲、未聚焦。第 8 步做过 `page.reload()`——候选目录在这次页面挂载里还没有取过。`TURN_DONE_TIMEOUT_MS` 是文件里唯一的显式超时。
- **真实栈探针**（编排者，官方 omp v18.0.10 + 受控上游；REST 与 Chromium 两种，1440×900 与 390×844）：
  - `GET /api/commands` → 200 `{"commands":[{name:"compact",label:"整理上下文",…,source:"builtin"},{name:"todo",label:"任务清单",…,source:"builtin"}]}`。
  - `POST …/prompt {"message":"/todo"}` → 202 `{userMessageId, assistantMessageId}`；约 0.6 s 后 done；用户 `content` `/todo`；助手 `content` `No todos. Use /todo append <task> to start one.`、`steps` `[]`、`approvals` `[]`、`thinking` null。
  - `POST …/prompt {"message":"/session WORKBUDDY_WRITE 探针"}` → 202；done 后用户 `content` 恰为所发文本（无前导空格）；助手 `content` 为固定回复，`steps` 恰一项 `write` / `done`，`approvals` `[]`。
  - 浏览器：输入 `/` → `listbox` `命令候选`，两个 `option`，`.chat-slash-label` 依次 `整理上下文`、`任务清单`（`option` 的可访问名是 label + 描述 + hint 拼接，不等于 label）；`/t` → 一项 `任务清单`；`Enter` → 输入框值 `/todo `、面板消失、没有新消息；再 `Enter` → 用户气泡 `/todo`，助手 `.chat-md` 文本恰为 omp 原文（`<task>` 被转义成文本，原样可见），输入框清空且可用；`/s`、`/session`、`/session WORKBUDDY_WRITE x` 都没有面板；发送后气泡原文、固定回复、`write` 步骤 `已完成`。整个过程除登录前那一次预期的 401 外没有 console error。
- **候选面板**（`slash-menu.tsx`、`slash-menu-state.ts`）：草稿匹配 `/^\/[^\s]*$/` 且 composer 可用时才「想要」面板；目录在第一次想要时懒取一次并留到页面卸载；没有匹配项（或目录未到）时面板不渲染，此时 `Enter` 走 composer 自己的发送规则。匹配按 `name` 或 `label` 的前缀。选中把草稿设为 `/<name> `（尾随空格使面板关闭）。
- **发送**（`page.tsx` 的 `submitComposer`）：发出去的是草稿原文（`/todo `），服务端 trim 后落库为 `/todo`。
- **步骤卡**（`conversation-view.tsx`）：`<section aria-label={step.name} class="chat-step">`，即 `region`；既有断言用 `getByRole("region", { name: "write" })` 与 `status` `write 已完成`。

## Decisions

### D1 冒烟第 6 步（插在 (5) 的 done 轮询之后、DELETE 之前；五个条目）
1. `GET /api/commands` → `HTTP 200`；断言 `$.commands` count == 2、`$.commands[0].name` == `compact`、`$.commands[1].name` == `todo`、两条的 `source` == `builtin`。不带 `[Options]`。
2. `POST …/prompt {"message":"/todo"}` → `HTTP 202`；捕获 `todo_assistant_id`、`todo_user_id`。不带 `[Options]`。
3. `GET …/messages`，`[Options] retry: 40` / `retry-interval: 500ms`（约 20 s；内建命令不经模型、没有审批）→ `HTTP 200`；断言按 id 定位：助手 `status` == `done`、`content` == `No todos. Use /todo append <task> to start one.`、`steps` 没有任何元素、`approvals` 没有任何元素；用户 `content` == `/todo`；`session.status` == `done`；`session.title` == `冒烟会话`。
4. `POST …/prompt {"message":"/session WORKBUDDY_WRITE 冒烟"}` → `HTTP 202`；捕获 `session_cmd_assistant_id`、`session_cmd_user_id`。不带 `[Options]`。
5. `GET …/messages`，同样 `retry: 40` / `500ms`（约 20 s，低于 60 s 的自动允许：万一出现待审批，是失败而不是被自动放行）→ `HTTP 200`；断言：用户 `content` == `/session WORKBUDDY_WRITE 冒烟`；助手 `status` == `done`、`content` matches `{{content_pattern}}`、`steps` 恰一个元素、`write` 步骤 `status` == `done`、`approvals` 没有任何元素；`session.status` == `done`。

「没有任何元素」「恰一个元素」的 jsonpath 写法由实现者在真实栈上定（文件里已有 `… steps[?(@.status!='done')]" not exists` 与 `… approvals" count == 1` 两种先例；过滤表达式之后的 `count` 数的是什么要实测），并各用一条负对照证明它会咬（HN5、HN6）。
注释：新条目标 `# (6)`；原 `# (6)`、`# (7)` 改为 `# (7)`、`# (8)`；页头流程行加上第 6 步、顺延编号，「slash 白名单步骤由后续 issue 追加」那半句删掉。其余条目逐字不变。

### D2 走查第 10 步 `step10Slash`（`step9Search` 之后、`step11Delete` 之前，同一 `try`；带 `mark`）
定位：`composer = page.getByLabel("给助手发消息")`；`listbox = page.getByRole("listbox", { name: "命令候选", exact: true })`；标签用 `listbox.locator(".chat-slash-label")`（不按 `option` 的可访问名）。此时用户、助手消息各一条；第 10 步里的消息用 `.nth()` 定位。
1. `composer.fill("/")` → `listbox` 可见；`option` 计数 2；标签文本依次恰为 `整理上下文`、`任务清单`。
2. `composer.fill("/t")` → `option` 计数 1，标签恰为 `任务清单`。**这条断言必须在 `Enter` 之前**。
3. `composer.press("Enter")` → 输入框值恰为 `/todo `（`toHaveValue`）；`listbox` 计数 0；用户、助手消息仍各 1 条（没有发送）。
4. `composer.press("Enter")` → 用户消息 2 条，第二条正文 `/todo`；助手消息 2 条，第二条 `.chat-md` 文本恰为 `No todos. Use /todo append <task> to start one.`（等回合完成，用既有的超时常量）；它里面没有步骤卡（`region` 计数 0——若助手消息里还有别的 `region`，改用 `.chat-step` 计数 0，并说明）、没有三种审批条；`composer` 可用且值为空。
5. `composer.fill("/session")` → `listbox` 计数 0（候选态、目录已在第 1 步加载，零匹配）。`composer.fill("/session WORKBUDDY_WRITE <uuid2>")`（新的 UUID）→ `listbox` 计数 0。
6. `composer.press("Enter")` → 用户消息 3 条，第三条正文恰为所输入的文本；助手消息 3 条，第三条 `.chat-md` 为固定回复（超时常量）、`write` 步骤 `已完成`、没有审批条；`composer` 可用。
7. REST 回读 `page.request.get("/api/sessions/<id>/messages")` → 200；`messages` 共 6 条；第 3 条用户 `content` 恰为 `/todo`；第 4 条助手 `content` 恰为 omp 原文、`steps` 为空数组、`status` `done`；第 5 条用户 `content` 恰为 `/session WORKBUDDY_WRITE <uuid2>`（严格相等，前导空格在这里才看得见）；第 6 条助手 `content` 恰为固定回复、`steps` 恰一项且 `name` `write`、`status` `done`。

### D3 辅助与不变的部分
- 「等回合完成 + 无审批条」已在 `step3SendPrompt` 里：抽成一个文件内辅助（参数：助手消息定位器、期望正文），第 3 步改用它（行为不变），第 10 步两处复用；`write` 步骤 `已完成` 的断言同理。显式超时仍只有 `TURN_DONE_TIMEOUT_MS` 一处字面量。jscpd 保持 179。
- `finally`、`deleteCreatedSession`、`logout`、第 1–9、11 步的断言不动。第 11 步按选中项与唯一新标题定位，不受多出的四条消息影响；标题没有被 `/todo` 改掉这件事由第 11 步的确认文案兜住。
- 约束沿用：不用 `waitForTimeout`、`page.route` / `fulfill` / `continue`、假 `EventSource`、`test.setTimeout` / `test.slow`、`force: true`、`evaluate`；不新增显式超时字面量；只改这两个文件；`web/e2e/ui-walk-sessions.spec.ts` ≤ 800 行；整条旅程在每测试 30 s 内。

## Governing invariant
1. 改动只有 `smoke/session-meta.hurl` 与 `web/e2e/ui-walk-sessions.spec.ts`；`Makefile`、`scripts/test-ci-harness.sh`、`AGENTS.md`、`web/playwright.config.ts` 零 diff；`npx playwright test --list` 仍是 6 条、2 个文件。
2. 新断言都依赖真实服务端状态：`/todo` 的正文来自真 omp 的 `command_output`，固定回复来自受控上游经真 omp，`steps` 来自落库的回合。
3. hurl 文件里任何 POST / PATCH / DELETE 条目都不带 retry；带 retry 的只有 messages GET（原有两处加新增两处），每处有界。
4. 冒烟文件仍可重跑、不留认证会话 / running 回合 / 会话行；走查成功或断言失败后都不留会话。
5. 既有步骤不被削弱；`ui-walk.spec.ts` 与其它四个 hurl 文件照常通过。
6. error oracle 零意外 console / page error。

## Sibling surfaces
- `smoke/chat.hurl`、`files.hurl`：各用自己的会话 / 空间（`smoke-fixture`）；`smoke-sessions` 空间里多出的 `workbuddy-report.html` 没有任何文件读它。
- `make smoke-live`：不跑 `session-meta.hurl`，不受影响。
- `ui-walk.spec.ts`：新旅程仍不留会话；`ui-walk-sessions` 空间里的 `workbuddy-report.html` 被第二次写入覆盖，内容相同。
- `make test-guardrails`：只对 Makefile 配方、AGENTS.md 证据行等做文本契约，不读 hurl 条目内容。

## Must-preserve
- `make lint`、`make typecheck`、`make anti-drift`（jscpd 179、knip 零新增）、`bash scripts/size-guard.sh`、`npm test --workspace web`、`make test-guardrails` 全绿。

## Required evidence
### 冒烟（实现者自己起的 smoke 栈；不要用长驻走查栈——会往它的库里加空间）
- **H1 两次运行**：CI 同款包装 `.github/scripts/ci-compiled-server.sh smoke`，同一组状态目录连续两次，均退出 0；记录每次 `session-meta.hurl` 的耗时与整个 `make smoke` 的耗时。
- **H2 残留**（自己起服务、`make smoke` 两次之后，负对照之前）：经 REST 以 `zhangsan` 读 `GET /api/sessions`：没有标题为 `冒烟会话` 的会话、没有 `title` 为 null 的会话、没有 running。
- **H3 负对照**（改 hurl 文件的一处，单独跑该文件，记录非零退出与失败的条目；交付文件须与通过的那份逐字节相同）：
  - HN1 `commands` 期望 count == 3 → `GET /api/commands` 条目失败。
  - HN2 两个 `name` 的期望对调 → 同上。
  - HN3 `/todo` 期望正文改一个字符 → `/todo` 的轮询条目失败（约 20 s 后）。
  - HN4 用户正文期望带前导空格（` /session WORKBUDDY_WRITE 冒烟`）→ 第二个轮询条目失败。
  - HN5 把「`steps` 没有任何元素」那条断言原样搬到第二个轮询条目里（那里有一个 `write` 步骤）→ 失败：证明该写法在有步骤时会咬。
  - HN6 把「`steps` 恰一个元素」那条断言原样搬到 `/todo` 的轮询条目里 → 失败。
  - HN7 第二条提示词改成白名单内的 `/todo WORKBUDDY_WRITE 冒烟`（omp 当命令执行）→ 第二个轮询条目失败（没有 `write` 步骤、正文不是固定回复）：证明断言分得清「被当命令执行」与「被模型回答」。
  - 每条失败的运行里，失败条目之后没有再发任何请求（hurl 在首个失败条目停止），POST 没有被重试（服务端访问日志或 hurl `--very-verbose` 的请求计数）。
- **H4 结构**：`rg -n "retry" smoke/session-meta.hurl` 列出的每个 `[Options]` 都属于 messages GET 条目；`git diff` 里原有条目除注释标号外逐字不变。

### 走查
- **U1** `git diff --stat origin/master`（除 `openspec/`）只有这两个文件；`npx playwright test --list` 为 6 条 / 2 文件。
- **U2 全新状态**（CI 同款包装，两个不同的 `RUNNER_TEMP`）：完整 `make ui-walk` 退出 0，`5 passed, 1 skipped`；记录每条时长、总时长、新旅程的分步累计。
- **U3 复用状态**（长驻栈，只跑本 spec）：两个 project 连续五遍全绿；记录每遍时长。
- **U4 残留清点**（U3 之后）：会话总数与运行前相同、无 running、无绑定走查空间的会话。
- **U5 负对照**（改 spec 的一处，长驻栈，每条在两个 project 上各跑一次；记录失败所在的断言；每条之后残留为零）：
  - UN1 第 1 步期望标签次序对调 → 第 10 步。
  - UN2 `/t` 期望 2 项 → 第 10 步。
  - UN3 第一次 `Enter` 之后期望输入框值为 `/todo`（无尾随空格）→ 第 10 步。
  - UN4 第一次 `Enter` 之后期望用户消息 2 条（即「`Enter` 已经发送」）→ 第 10 步：证明面板开着时 `Enter` 没有发送。
  - UN5 `/todo` 的期望正文改一个字符 → 第 10 步。
  - UN6 期望 `/todo` 的助手消息里有一个步骤卡 → 第 10 步。
  - UN7 `/session` 期望 `listbox` 计数 1 → 第 10 步。
  - UN8 第二条提示词改成 `/todo WORKBUDDY_WRITE <uuid2>` → 第 10 步的固定回复 / `write` 步骤断言失败。
  - UN9 REST 回读期望第 5 条 `content` 带前导空格 → 第 10 步的回读。
  - UN10 REST 回读期望第 4 条 `steps` 长度 1 → 第 10 步的回读。
  - 另：#541 的 N13、N15（第 11 步）在 `desktop-light` 重跑，确认第 11 步在多出四条消息后仍有判别力。
- **U6 CI**：PR 的 `smoke` 与 `ui-walk` job 通过；从日志记录时长。

### 门禁
- **G1** `make lint`、`make typecheck`、`make anti-drift`（jscpd 计数与涉及本文件的克隆）、`bash scripts/size-guard.sh`、`bash scripts/size-guard.sh web/e2e/ui-walk-sessions.spec.ts`、`npm test --workspace web`、`make test-guardrails`、`openspec validate harness-slash-whitelist --strict --no-interactive` 退出 0。
- **G2** 源码清点：`rg -n "waitForTimeout|page\\.route|\\.fulfill|EventSource|setTimeout|test\\.slow|force: true|MODEL_UPSTREAM|evaluate" web/e2e/ui-walk-sessions.spec.ts` 零命中；显式 `timeout` 字面量仍只有一处。

## 已知残留
1. **未转义的 `/session` 的行为没有真实栈证据**（平台 API 够不到）；以 HN7 / UN8 的白名单内对照代替。
2. **`/compact` 不走**：只证明它在目录与候选里，不证明它的执行。
3. **skills 不在两个状态目录里**：目录里的 `skill` 来源与候选没有真实栈证据。
4. **鼠标选中候选不走**；只走键盘 `Enter`（`Tab`、方向键、`Esc` 由 jsdom 测试覆盖）。
5. **「composer 解锁」断言的是输入框可用且清空**，不单独断言发送键的状态。
6. **`/todo` 回合不改标题**：冒烟有断言；走查靠第 11 步的确认文案间接证明。
7. **测试超时不清理**（同 #540 / #541）。
8. **`smoke-sessions` 空间里留下 `workbuddy-report.html`**（proposal 偏差 6）。

## Seams under test
- 真实 HTTP 与真实浏览器对编译后的应用、真 omp 与受控上游；没有任何桩。
