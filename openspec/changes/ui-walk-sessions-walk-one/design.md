# Design: ui-walk-sessions-walk-one（#540）

## Context
- **配置**：`web/playwright.config.ts`——`testDir: "./e2e"`、`testMatch: "ui-walk.spec.ts"`（`:10`）、`workers: 1`、`retries: 0`、`timeout: 30_000`（`:14`，每测试）、`globalTimeout: 150_000`（`:15`）、`actionTimeout: 10_000`、`navigationTimeout: 15_000`；两个 project `desktop-light`（1440×900 light）与 `mobile-dark`（390×844 dark）。`make ui-walk` = `npm run ui-walk --workspace web` = `playwright test`。
- **谁钉着什么**：`scripts/test-ci-harness.sh` 钉 Make 配方、CI job 形状（含 `timeout-minutes: 15`）与 AGENTS.md 证据行，**不**钉 `testMatch`、`globalTimeout` 或 spec 文件名；`openspec/specs/**` 里也没有这些值。`web/test/chat-steps.test.tsx:294-302` 与 `web/test/chat-composer.test.tsx:252-259` 读 `ui-walk.spec.ts` 的源码并断言它 ≤ 800 行（现 799）——旧 spec 不能动。
- **扫描范围**：Biome 与 `tsc` 覆盖 `web/e2e`；jscpd 的 pattern 是 `{server,web,kbservice}/**/*.{ts,tsx,py}`，**覆盖** `web/e2e`；knip 与 size-guard 不覆盖 `web/e2e`；vitest 排除 `e2e/**`。
- **既有 oracle**（`web/e2e/ui-walk-oracle.ts`）：`runWithBrowserErrorOracle(page, baseURL, { watchAssets }, journey)`。它要求恰一次登录前、恰一次登出后 reload 的 `/api/auth/me` 401（`:232-241`）；`oracle.phase` 由旅程在登录后置 `"authenticated"`、登出后置 `"post-logout-reload"`。监听挂在 `page.on(...)` 上，`page.request.*` 的调用本身不经过它——但它引起的页面侧后果会经过：DELETE 让该会话的 SSE 以 200 干净收尾（`supervisor.ts` 的 `endAll`、`stream/sse.ts`），页面的 `EventSource` 处于 `CONNECTING` 时由浏览器原生重连（Chromium 约 3 s），重连的 `GET /api/sessions/<id>/events` 命中已删会话得 404，console 的 `Failed to load resource` 会被记为 `unexpectedConsole`。`about:srcdoc` 不是 http(s)，预览 iframe 不算跨源请求。旅程在登出前失败时 oracle 抛 `AggregateError`，其中除旅程自己的错误外总带一条「expected exactly one post-logout-reload … got 0」——读负对照的失败步骤时看旅程那一条。
- **既有辅助**（`web/e2e/ui-walk-layout.ts`，导出）：`DEV_ACCOUNT`、`walkProject`、`openSidebar`、`inspectSidebar`（mobile 结束时按 `Escape` 并断言 `导航` 对话框消失）、`expectAuthenticatedRoute`、`expectSelectedSessionStatus`。登录块、登出块、`DEV_PASSWORD`、`sessionIdFromUrl`、`EXPECTED_REPLY` 是 `ui-walk.spec.ts` 私有的；`ui-walk-stop.ts` 自己另有一份 `EXPECTED_REPLY`。
- **受控上游**（`server/test/support/fake-upstream.mjs`）：提示词含 `WORKBUDDY_WRITE` 时第一轮发一次 `write` 工具调用，参数 `{path:"workbuddy-report.html", content:"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n"}`；第二轮（已有 tool 消息）含 `WORKBUDDY_THINK` 时先发三段 reasoning（合起来 `先读需求，再列要点，最后作答。`），再发固定回复 `你好，这是 WorkBuddy 的第一条流式回复。`。不涉及 gate。
- **真实栈探针**（编排者，本机，官方 omp v18.0.10 + 受控上游 + 编译后的 server，HTTP）：绑定空间、`scene: "code"` 的会话发 `WORKBUDDY_THINK WORKBUDDY_WRITE 会话走查 <uuid>`，约 3.4 s 到 `done`；助手 `thinking` 恰为该文本、`approvals` 为空；唯一步骤 `write`、`status: "done"`、`changes` 为 `[{"path":"workbuddy-report.html","added":null,"removed":null,"kind":"write"}]`；`GET /api/workspaces/<id>/file?path=workbuddy-report.html` 返回写入的内容；会话标题 `WORKBUDDY_THINK WO`（提示词前 18 个码点——每次运行、两个 project 都相同）；随后 `DELETE` 204。这是 #522 留下的「真 omp 的 write 详情形状」第一次取证。
- **基线耗时**：`make ui-walk`（旧 spec，两个 project，本机）24.9 s，单条旅程 10–13 s；库里先有空间 `ui-walk-sessions` 时照常通过。
- **旧旅程不可在同一沙箱上重跑**：`ui-walk.spec.ts` 的 `walkFiles` 断言 `walk-out-<project>` 目录不存在（files-harness 要求调用方提供没有该目录的沙箱），`ci-compiled-server.sh` 只 `cp -R` 夹具、不清目录。所以完整的 `make ui-walk` 只能在全新状态上跑；复用状态上只跑新 spec。
- **执行次序**：Playwright 按 project 优先、文件名排序：`desktop-light`（新、旧）→ `mobile-dark`（新、旧）。全新状态下 `desktop-light` 的新旅程走 201，其后都是 409；旧旅程开始时 `ui-walk-sessions` 是库里最早的空间（`/files` 的默认空间）。
- **未选空间时的请求体**是 `{scene}`，没有 `workspaceId` 键（`welcome-options.ts`）。
- `expect` 的默认超时是 5 s（配置没设 `expect.timeout`）；既有辅助对回合类断言显式给更长的超时（`ui-walk-stop.ts`）。
- **页面事实**（实现者以源码为准，这里只列会绊脚的）：
  - 会话页只在挂载与建会话后读空间列表（`page.tsx` 的 `refreshList`）。
  - 场景胶囊：`fieldset[aria-label="场景"]` 里的 `button[aria-pressed]`；点击另一个胶囊会出 Toast `已切换到「代码开发」场景`（2400 ms）。`快捷任务`：办公 6 项（`文档处理`…），代码 5 项（`日常开发`、`网站开发`、`Agent 应用`、`Skill 开发`、`CI/CD`）。
  - footer 触发按钮的可访问名是 `任务启动于 未选择` / `任务启动于 ui-walk-sessions`；Popover 是 `dialog` `选择工作空间`；选项的可访问名是「名字 + 逻辑路径」的拼接。
  - 思考折叠块是 `.chat-msg-main` 的第一个子元素 `details.thinking-block`，回合结束后收起。
  - 步骤卡：`region` `write`，徽章 `status` `write 已完成`。审批条不存在时 `.chat-approvals` 不渲染。
  - 文件变更卡：`group` `文件变更（1 个）`；`查看详情` 是图标按钮，可访问名 `查看详情 zhangsan/ui-walk-sessions/workbuddy-report.html`，点击导航到 `/files?ws=<id>`。
  - 产物卡：`group` `workbuddy-report.html`，卡内有**两个**同名按钮 `打开网页预览 workbuddy-report.html`（头部图标与底部文字）；Dialog 标题 `workbuddy-report.html`，`iframe.artifact-preview-frame[sandbox="allow-scripts"]` 用 `srcdoc`。
  - 产物面板：顶栏按钮 `产物面板`（只在选中会话时存在）；抽屉标题 `产物面板`，行与变更卡同构，另多一个产物动作按钮；抽屉里有**两个** `关闭`（头部图标与底部按钮）。
  - 侧栏：`nav[aria-label="会话列表"]`；分区是 `fieldset`（role `group`），标题带计数——`空间 (N)`、`任务 (N)`，只有 `置顶任务` 不带；空间子组是以空间名命名的嵌套 `group`；空分区不渲染；会话项是 `button.chat-session-button`，选中项 `aria-current="true"`。

## Decisions

### D1 `web/playwright.config.ts`
恰两行：`testMatch: "ui-walk*.spec.ts"`、`globalTimeout: 300_000`。其它值与注释不动。

### D2 `web/e2e/ui-walk-sessions.spec.ts`（新，唯一的新文件）
```ts
test.describe.configure({ mode: "serial" });
test("…", async ({ baseURL, page }, testInfo) => {
  const project = walkProject(testInfo.project.name);
  await runWithBrowserErrorOracle(page, baseURL, { watchAssets: project === "desktop-light" }, (oracle) =>
    walkSessionMeta(page, oracle, project),
  );
});
```
`walkSessionMeta` 的次序（每一步是一个模块私有函数，名字带步骤号，便于日后 #541 / #557 续写）：
1. **登录**：`goto("/files")` → 登录表单 → `expectAuthenticatedRoute(page, project, "/files", "工作空间", "工作空间")` → `oracle.phase = "authenticated"`。
2. **确保空间**：`page.request.post("/api/workspaces", { data: { name: "ui-walk-sessions" } })`，状态只接受 201 或 409；随后 `page.request.get("/api/workspaces")` 取名为 `ui-walk-sessions` 的那一条的 `id`（32 位 hex）与 `dir`（断言 `dir === "ui-walk-sessions"`——逻辑路径的前提）。
3. **`try`**：
   - **进入欢迎态**：真实导航到 `/`（h1 `WorkBuddy，我帮你`）。
   - **第 2 步**：点 `代码开发`；三个胶囊的 `aria-pressed` 为 `false/true/false`；`快捷任务` 的按钮文本序列恰为代码场景五项。footer 触发按钮名为 `任务启动于 未选择` → 打开 → `搜索工作空间` 输入 `ui-walk-sessions` → 选中该项 → Popover 关闭、触发按钮名为 `任务启动于 ui-walk-sessions`。
   - **第 3 步**：`const created = page.waitForRequest(POST /api/sessions)`（只观测；全文件不得出现 `route.fulfill`、`page.route`）→ 填入提示词、`Enter` → `const request = await created; const response = await request.response()`（先断言非空），断言状态 201 并**立刻**从响应体取顶层的 `id`（建会话的响应体就是八键会话视图，不嵌在 `session` 下） 记进外层变量供 `finally` 使用（先于对请求体的任何断言——请求体断言失败时会话已经建好）→ `request.postDataJSON()` 深等于 `{ workspaceId, scene: "code" }`（键集合也相等）→ URL 的 `session` 参数等于该 id → 助手消息的 `.chat-md` 文本恰为固定回复（这一条是等回合完成的断言，可带显式 `{ timeout }`，取值照 `ui-walk-stop.ts` 的先例；其余断言用默认超时）；选中会话的状态为 `已完成`（`expectSelectedSessionStatus`）；`write` 步骤徽章 `已完成`；助手消息内 `需要你的确认`、`已允许执行`、`已拒绝执行` 三种 group 计数都是 0；转录恰一条用户消息、一条助手消息。
   - **第 4 步**：`details.thinking-block` 恰一个、无 `open` 属性、位于 `.chat-md` 之前（同一父元素内的先后）；summary 文本 `深度思考过程`；点 summary 后 `open`，`.thinking-body` 文本恰为该常量。
   - **REST 回读**：`page.request.get("/api/sessions/<id>/messages")` → `session.scene === "code"`、`session.workspaceId === <id>`、`session.status === "done"`；助手消息 `thinking` 恰为常量、`steps` 恰一条且 `name === "write"`、`changes` 深等于 `[{path:"workbuddy-report.html",added:null,removed:null,kind:"write"}]`。
   - **第 5 步**：变更卡 group `文件变更（1 个）` 恰一行；`.file-change-path` 文本恰为 `zhangsan/ui-walk-sessions/workbuddy-report.html`；`.file-change-kind` 文本 `写入`；`.file-change-add`、`.file-change-del` 计数 0。产物卡：`.artifact-lang` 文本 `HTML`；点卡内底部的 `打开网页预览`（限定在产物卡内、取文字链接那一个）→ Dialog `workbuddy-report.html` → iframe 的 `sandbox` 属性**字符串**恰为 `allow-scripts` → `frameLocator` 内 heading `WorkBuddy` 可见 → 关闭 Dialog。顶栏 `产物面板` → 抽屉内恰一行、路径同上 → 关闭抽屉（消失后再继续）。**最后**点变更卡的 `查看详情` → URL 为 `/files` 且 `ws` 参数等于空间 id、`选择工作空间` 按钮含 `ui-walk-sessions` → 真实导航回 `/?session=<id>`，等到助手消息的固定回复重新可见。
     - `查看详情` 放在第 5 步最后做，是为了只离开会话页一次；规格里第 5 步各项没有先后要求。
   - **第 6 步**：`inspectSidebar(page, project, …)` 里：`会话列表` 内 `button[aria-current="true"]` 恰一个；它位于名字匹配 `/^空间 \(\d+\)$/` 的 group 之内、且在其下名为 `ui-walk-sessions` 的子 group 之内；`置顶任务` group 与名字匹配 `/^任务 \(\d+\)$/` 的 group 内 `aria-current="true"` 的计数都是 0（分区不存在时计数自然为 0）。会话按 `aria-current` 定位，不按标题（标题每次相同）。
   - **离开会话页**（`try` 的最后一步）：真实导航到 `/settings`，等它的 h1 `设置`。此后页面不再订阅该会话，删除不会引出重连 404。
4. **`finally`**：调用一个清理辅助函数：若已记下会话 id，`page.request.delete("/api/sessions/<id>")`，状态只接受 204 或 404；再 `page.request.get("/api/sessions")` 断言列表里没有这个 id。清理里的断言用 `expect.soft`、请求自身包 try/catch（把异常转成 soft 失败），这样它不会盖掉 `try` 里的原始失败；`finally` 体内不写 `throw` / `return`（Biome `noUnsafeFinally`）。失败路径上页面可能仍在会话页，此时重连 404 会多出一条 oracle 失败——旅程本来就已失败，可接受。
5. **登出**（在 `/settings` 上）：经 UI（`用户菜单` → `退出登录` → 确认 `退出`）→ 登录页可见 → `oracle.phase = "post-logout-reload"` → `reload()` → 登录页仍可见。不重复旧旅程里「请求挂起期间的焦点陷阱」那一段——那是旧旅程自己的证据。

约束：
- 不 `import` `ui-walk.spec.ts`（它是测试文件）；需要的私有常量与小函数在新文件里自写。**jscpd**：登录与登出块按本旅程自己的需要自然地写（比旧旅程短），不为躲检测而打乱写法，也不改旧文件。若 jscpd 因此多报克隆且都只落在登录块或登出块上（两块不相邻，各至多一个：178 → 至多 180），接受并在报告里给出每个克隆的两端行号；出现任何其它新增克隆则停下来报告。
- 不用 `waitForTimeout`、不用 `page.route` / `route.fulfill` / `route.continue`、不替换 `EventSource`、不 arm gate、不读 `MODEL_UPSTREAM_*`。等待一律是对可观察状态的 `expect`（自动重试）或 `waitForRequest` / `waitForResponse`。
- 每个 project 用 `crypto.randomUUID()` 生成自己的 UUID。
- Toast（场景切换）不作断言；若它挡住后续操作（mobile 的侧栏浮层由 `inspectSidebar` 用 `Escape` 关闭），等它消失再继续，写法照既有辅助。
- 整条旅程必须在每测试 30 s 内完成，不调用 `test.setTimeout` / `test.slow`。若做不到，停下来报告实测分解。

### D3 不做的事
- 不抽共享的登录 / 登出辅助（要动 `ui-walk.spec.ts` 才有意义，而它不能动）。
- 不实现 409 → stop → 轮询 → DELETE 的回退（proposal 偏差 3）。
- 不给 `make ui-walk`、CI、Makefile、AGENTS.md 加任何东西。

## Governing invariant
1. `web/playwright.config.ts` 的 diff 恰两行；`npx playwright test --list` 恰列出每个 project 的 `ui-walk-sessions.spec.ts` 一条与 `ui-walk.spec.ts` 两条，共 6 条，没有来自辅助模块的条目。
2. 新旅程的每个断言都依赖服务端真实状态：没有 route fulfillment、假 EventSource 或睡眠。
3. 旅程结束后（成功或某一步断言失败）不留下它建的会话行或 running 回合；测试超时除外（见已知残留 8）。
4. `ui-walk.spec.ts` 与全部既有 e2e 辅助零 diff，且在新 spec 先跑的前提下两个 project 照常通过。
5. `web/src`、`server`、`Makefile`、`.github`、`AGENTS.md`、`scripts` 零 diff。

## Sibling surfaces
- `ui-walk.spec.ts`：新 spec 先跑，留下空间 `ui-walk-sessions`（及其中的 `workbuddy-report.html`），不留会话。旧旅程对 `/files` 显式选 `smoke-fixture`，对会话只看选中项——不受影响（基线运行已在「库里先有该空间」的状态下通过）。
- `ui-shots.mjs`（`make ui-shots`）：独立入口，不经 `testMatch`，不受影响。
- `smoke/session-meta.hurl`：用的是空间 `smoke-sessions`，与本旅程的空间互不相干；两者在 CI 里是不同 job、不同库。
- CI `uid-isolation` job 不跑 ui-walk。
- `web/test` 里读 `ui-walk.spec.ts` 源码的两个测试：旧文件零 diff，不受影响。

## Must-preserve
- `make test-guardrails`、`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（jscpd 178，至多因登录、登出块各一个到 180；knip 零新增）、`bash scripts/size-guard.sh` 全绿。
- CI ui-walk job 的身份、步骤与 `timeout-minutes: 15` 不变。

## Required evidence
- **E1** `git diff origin/master -- web/playwright.config.ts`：恰两行变化。
- **E2** `cd web && npx playwright test --list`：恰 6 条（每个 project：`ui-walk-sessions.spec.ts` 1 条、`ui-walk.spec.ts` 2 条），没有别的文件。
- **E3 全新状态**（CI 同款包装 `bash .github/scripts/ci-compiled-server.sh ui-walk`，全新的 `RUNNER_TEMP`；环境变量照 `.github/workflows/ci.yml` 的 ui-walk job：`HOST`、`PORT`、`UI_WALK_BASE_URL`、`DB_PATH`、`STATIC_ROOT`、`OMP_BIN`（官方 v18.0.10）、`OMP_STATE_DIR`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY=fake`、`FAKE_UPSTREAM_PORT`，端口自选；web 与 server 先 build）：退出 0；记录 Playwright 报告的每条用例时长与总时长。此时 `desktop-light` 的新旅程走 201 建空间、`mobile-dark` 走 409 采用；旧旅程在「`ui-walk-sessions` 是最早的空间」的前提下通过。全新状态至少跑两次（两个不同的 `RUNNER_TEMP`）。
- **E4 复用状态**（长驻栈，只跑新 spec：`cd web && UI_WALK_BASE_URL=… npx playwright test ui-walk-sessions.spec.ts`）：两个 project 都走 409、文件被覆盖写，通过。完整的 `make ui-walk` 不能在复用的沙箱上重跑（旧旅程的 `walk-out-*` 前提），所以复用状态只验证新 spec。
- **E5 残留清点**（长驻栈，E4 / E6 之后）：以 `zhangsan` 查 `GET /api/sessions`：没有 `workspaceId` 为该空间的会话、没有 `running` 会话；`GET /api/workspaces` 里名为 `ui-walk-sessions` 的恰一条。
- **E6 稳定性**：长驻栈上只跑新 spec（两个 project）连续五遍全绿；记录每遍每条的时长，最大值须明显低于 30 s（给出数字）。
- **E7 负对照**（沙箱里改新 spec 的一处，在长驻栈上只跑新 spec 的 `desktop-light`，记录失败所在的步骤与旅程错误的消息，然后还原；脚本与日志不入库）。每条都必须失败在预期的步骤；N1–N9 每条之后做一次清点，确认**失败路径上会话也被删除**。清点口径：`GET /api/sessions` 的总条数与运行前相同、没有 `running` 会话、且（能从失败输出或服务端取到时）本次建的会话 id 不在列表里——N3 建的是未绑定会话，只按「绑定该空间」数看不见它：
  - N1 期望的思考文本改一个字 → 第 4 步。
  - N2 期望的请求体 `scene` 改成 `"office"` → 第 3 步的请求体断言（此时会话已建；随后的 DELETE 与页面的 prompt 派发竞争，两种先后残留都应为零——这条不算 running 路径的证据，那是 N5）。
  - N3 不选空间（跳过 Popover 选择）→ 第 3 步的请求体断言（实际请求体是 `{scene:"code"}`，没有 `workspaceId` 键）。
  - N4 提示词去掉 `WORKBUDDY_THINK` → 第 4 步（没有折叠块）。
  - N5 提示词去掉 `WORKBUDDY_WRITE` → 第 3 步：上游改发 bash，回合停在待决审批上，固定回复不出现（首个失败的是等回合完成的那条断言）。其后的清点证明「带待决审批的 running 回合被 DELETE → 204、不留会话」——这是 proposal 偏差 3 的实证。
  - N6 期望的逻辑路径前缀改成别的（如去掉 `zhangsan/`）→ 第 5 步。
  - N7 期望的 `sandbox` 改成 `allow-scripts allow-same-origin` → 第 5 步。
  - N8 期望会话在 `任务` 分区而不是 `空间` → 第 6 步。
  - N9 REST 回读的 `changes` 期望里 `kind` 改成 `"edit"` → REST 回读。
  - N10 去掉登出收尾 → oracle 报「expected exactly one post-logout-reload … 401」。
  - N11 把清理辅助函数整体去掉（DELETE 与「列表不含该 id」两句一起）→ 旅程通过，但 E5 式清点发现一条绑定该空间的残留会话（说明清点有判别力）；做完后手工 DELETE 该残留并再清点一次。
  - N12（观察性，允许在这条负对照里显式等待）去掉「离开会话页」一步，DELETE 之后在会话页停留 5 s 再登出 → oracle 报意外的 console error（消息形如 `console.error: Failed to load resource … 404`，不含 URL）。若观察不到，照实记录现象与时序——那样规格里「would reconnect its event stream into a 404」的括注要在合入前改弱。
- **E8 门禁**：`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`npm test --workspace web`、`make test-guardrails`、`openspec validate ui-walk-sessions-walk-one --strict --no-interactive` 退出 0。
- **E9 源码清点**：新 spec 里 `rg -n "waitForTimeout|page\.route|\.fulfill|EventSource|setTimeout|test\.slow|MODEL_UPSTREAM"` 零命中。
- **E10 CI**：PR 的 `ui-walk` job 通过；从日志记录 Playwright 的总时长与四条旅程各自的时长（「CI 记录实测总时长」）。

## 已知残留
1. **CI 每个 job 只跑一遍**：409 采用路径在 CI 里只由 `mobile-dark` 覆盖（同一次运行里 `desktop-light` 先建）；跨运行的复用只有本地证据（E4）。
2. **edit 的 `+N/−N`** 在真实栈上不可达，由服务端 fake-omp 测试证明。
3. **标题不唯一**：每次运行的会话标题都是 `WORKBUDDY_THINK WO`；旅程按选中项定位。若 `finally` 的删除失败留下会话，下一次运行仍能通过（它只看自己选中的那条），残留要靠 E5 式清点发现。
4. **预览 iframe 的文档断言**依赖 `srcdoc` 同步渲染；不验证脚本隔离的强度（那是 turn-artifacts 的 jsdom 与浏览器观察的范围）。
5. **`查看详情` 只验证落到空间**（`?ws=`），不验证选中文件——文件页没有 path 参数。
6. **每测试 30 s**：#541 / #557 往同一 `try` 块里追加第 7–11 步（含两个真实回合）后是否仍在 30 s 内，要由它们各自实测；本刀只给出第 1–6 步的实测时长。
7. **登出收尾是简化版**：不重复旧旅程的键盘确认与焦点陷阱断言。
8. **测试超时不清理**：30 s 超时触发时浏览器 context 已关闭，`finally` 里的 `page.request` 不可用，会话会留下；下一次运行不受影响（见 3），残留靠清点发现。
9. **仍订阅着已删会话的页面会重连出 404**：这是产品现状（别处删除当前打开的会话时，页面没有对「会话已不存在」的处理），本旅程用「先离开再删」避开；#557 的第 11 步经 UI 删除，由页面自己离开会话。
10. **jscpd 可能 178 → 至多 180**（登录、登出块各至多一个，见 proposal 偏差 10a）。

## 交付记录（实现后补记）
- **文件**：`web/e2e/ui-walk-sessions.spec.ts` 364 行；`web/playwright.config.ts` 恰两行。其它被跟踪文件零 diff。
- **E1 / E2**：配置 diff 恰两行；`npx playwright test --list` 为「6 tests in 2 files」，每个 project 新 spec 1 条、旧 spec 2 条。
- **E3 全新状态**（CI 同款包装，官方 omp v18.0.10；实现者两次、编排者在真实仓库一次，三个不同的 `RUNNER_TEMP`）：均退出 0，`5 passed, 1 skipped`。时长：新旅程 `desktop-light` 4.1–4.8 s、`mobile-dark` 4.8–4.9 s；旧旅程 10.4–10.5 s / 12.9–13.1 s；Playwright 总计 33.3–34.0 s（改动前的基线是 24.9 s）。201 / 409 两条路径是推断而非日志：spec 接受两者但不打印走了哪条；依据是运行后沙箱里出现了夹具里没有的 `ui-walk-sessions` 目录，且 Playwright 先跑 `desktop-light`。
- **E4 / E6 复用状态**（长驻栈，只跑新 spec）：连续五遍 10/10 通过，单条 4.4–4.9 s，一遍总计 9.7–10.0 s。
- **E5 残留清点**：运行前后 `zhangsan` 的会话总数相同（4）、`running` 0、绑定该空间的 0、名为 `ui-walk-sessions` 的空间恰 1。
- **预算**：第 1–6 步加登录、清理、登出共约 4.8 s，其中真实回合约 2.7 s；每测试 30 s 还剩约 25 s 给 #541 / #557。分步计时由 spec 的 `console.log` 打进运行日志（先例 `ui-walk-stop.ts`）。
- **E7 负对照**（长驻栈，`desktop-light`）：N1–N12 全部失败在预期的位置；N1–N10、N12 前后会话总数 4 → 4、`running` 0，清理的 DELETE 都是 204。
  - N1 → 第 4 步 `toHaveText`；N2、N3 → 第 3 步请求体 `toStrictEqual`（N3 的实际请求体没有 `workspaceId` 键）；N4 → 第 4 步折叠块计数 0；N5 → 第 3 步等回合完成的断言 10 s 超时；N6 → 第 5 步逻辑路径；N7 → 第 5 步 `sandbox`；N8 → 第 6 步分区计数；N9 → REST 回读；N10 → oracle「expected exactly one post-logout-reload … 401, got 0」；N11 → 旅程通过而清点 4 → 5（手工删除后回到 4）；N12 → oracle `console.error: Failed to load resource: the server responded with a status of 404 (Not Found)`。
  - **N5 另有探针**：被删时会话与助手消息都是 `running`、有一条未决的 bash 审批，DELETE 返回 204，之后不在列表里——proposal 偏差 3（不实现 409 回退）的实证。
  - **N12 与规格的括注一致**：不离开会话页、DELETE 后停留 5 s，重连 404 出现。N1–N9 的失败路径上页面都还在会话页，但没有出现这条 404——测试在约 3 s 的重连窗口之前就结束了。
- **E8 门禁**（真实仓库）：`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`npm test --workspace web`（86 文件 / 1795 例）、`make test-guardrails`（oracle 816 PASS）、`openspec validate` 退出 0。**jscpd 179**（基线 178）：唯一新增的克隆是登录块，`web/e2e/ui-walk-sessions.spec.ts` 111–117 行与 `web/e2e/ui-walk.spec.ts` 89–95 行；登出块没有克隆。
- **E9**：禁用模式的清点零命中。
- **相对 D2 的小出入**：点场景胶囊之前多断言一次初态（`true/false/false`）；多断言用户气泡文本等于提示词；预览 iframe 用 `locator.contentFrame()`；离开会话页只等 `/settings` 的 h1；等回合完成的显式超时取 10 s，是全文件唯一的显式超时；空间选项按其中的精确文本过滤而不是按拼接的可访问名（与旧旅程选 `smoke-fixture` 的写法一致）；第一版的 `test()` 包装段与旧 spec 构成一个不在登录 / 登出块上的克隆，改成本文 D2 给出的写法后消失。
- **观察**：390px 下顶栏 `产物面板`、footer 触发按钮、Popover、Dialog、抽屉都可直接操作；场景 Toast（2400 ms）在真实回合期间自然消失，mobile 读侧栏之前先等它消失。抽屉与 Dialog 的焦点归还没有验证（本刀不要求）。

## Seams under test
- 真实浏览器（Playwright Chromium）对编译后的应用、真 omp 与受控上游；没有任何桩。
- REST 回读经 `page.request`（与页面同一 cookie），不经过 error oracle 的监听。
- 配置的选择行为经 `playwright test --list` 观察。
