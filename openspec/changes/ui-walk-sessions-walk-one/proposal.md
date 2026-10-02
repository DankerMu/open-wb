# Proposal: ui-walk-sessions-walk-one（#540，父 change `s1c-session-metadata-presentation` tasks 8.2a）

## Why
场景胶囊、footer 空间选择、思考折叠、文件变更卡、产物卡与产物面板、分区侧栏都已合入，但它们只有 jsdom 证据。真 omp 下「绑定空间的 `write` 回合产生 `thinking` 与 `changes`、页面按逻辑路径呈现」没有任何真实浏览器证据；`make ui-walk` 只选中 `ui-walk.spec.ts` 一个文件。

## What Changes
- `web/playwright.config.ts`：`testMatch` `"ui-walk.spec.ts"` → `"ui-walk*.spec.ts"`；`globalTimeout` `150_000` → `300_000`。恰两行。
- `web/e2e/ui-walk-sessions.spec.ts`（新）：每个 project 一条串行旅程，走 chat-harness「UI 走查会话元数据」第 1–6 步，`finally` 删除所建会话，随后 UI 登出。
- 规格：chat-harness ADDED「UI 走查会话元数据」（第 1–6 步）。

## Non-goals
- 走查第 7–11 步（置顶、重命名、搜索、slash 候选、删除）：#541、#557，在本 issue 的同一 `try` 块内追加。
- `ui-walk.spec.ts` 及既有 e2e 辅助：只消费，不改。
- `web/src`、server、Makefile、CI、env：零 diff。不新增 Playwright project、Make 目标或 CI job。
- edit 的 `+N/−N` 计数：真 omp 加受控上游不可达，由服务端 fake-omp 测试证明。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **只并入第 1–6 步**：子 delta 是 ADDED，不含父文第 7–11 步与两个 Scenario 里对应的子句。Scenario 标题逐字同父文。配置段写终态（`SHALL be`），父文写的是变更动作。相对父文另有这些增删：Scenario「会话元数据走查」的 THEN 加了「产物抽屉列出该文件」与「旅程结束时会话被删除」；Scenario「假进度不能满足走查」的 WHEN 加了「建会话时没带所选空间或场景」；配置段去掉了父文的「except where B's sidebar partitions change the locator path …」（分区侧栏已合入，旧旅程没有因此改动）；第 5 步去掉了源码行号引用。
2. **旅程以 UI 登出收尾，且自带两次预期的 401**：既有 error oracle（`web/e2e/ui-walk-oracle.ts`）要求恰一次登录前、恰一次登出后 reload 的 `/api/auth/me` 401，否则判失败。父文的步骤表没有登出。于是 `make ui-walk` 每个 project 里有两个 oracle 实例、共四次预期 401。verification-harness「UI 走查（Playwright）」的 Scenario「登录、四路由、主题持久与退出全绿」写「恰有两次 expected `/api/auth/me` 401 … 两 project 的 401 计数 … 各自独立成立」——那句的主语是它自己那条旅程（`WHEN 对 /files 执行 make ui-walk … 上述全部步骤`），按旅程计数仍然成立，本刀不改它（该 Requirement 正文的主语同样是「本 journey」；「以两个 project 执行同一条生产路径」说的是两个 project 走同一路径，不是旅程条数）。chat-harness「UI 走查对话步骤」那句也限定为「the preexisting … journey」。
3. **running 删除的 409 回退不实现**：issue 写「4.3c 合入前若得 409，先 `POST …/stop`、轮询到终态再 DELETE」。4.3c 已合入（`server/src/sessions/session-delete.ts`：running 会话先停止再删除，返回 204）；409 `session_busy` 现在只来自并发的控制占用（regenerate / fork / stop / 另一个 DELETE），本旅程不制造。`finally` 只接受 204|404，409 判失败。
4. **`finally` 在成功路径也删除**：父文写「If the journey fails before step 11」。第 11 步不在本刀，所以本刀无条件删除；#557 加第 11 步时改回条件式。
4a. **会话 id 取自建会话的 201 响应、先于任何对该请求的断言**；**第 6 步之后先以真实导航离开会话页再删除**。父文都没写。前者：请求体断言失败时会话已经建好，`finally` 手里必须有 id。后者：DELETE 会让该会话的 SSE 干净收尾，仍订阅着它的页面会由浏览器原生重连（约 3 s 后），重连命中 404，Chromium 的 `Failed to load resource` 会被 oracle 记为意外的 console error。
4b. **30 s 测试超时触发时清理不保证执行**：超时后浏览器 context 已关闭，`page.request` 不可用。子 delta 写的是「on success and when a step fails」。
5. **空间在打开会话页之前确保存在**：会话页只在挂载与建会话后读取空间列表；先建空间再进入 `/`，否则 Popover 里没有它。
6. **REST 回读**：父文第 4、5 步只写 DOM 断言；Scenario「假进度不能满足走查」要求「DOM or REST assertion」。子 delta 写明经页面请求上下文回读 `GET /api/sessions/<id>/messages`：`thinking`、`changes`、会话视图的 `scene` 与 `workspaceId`。
7. **`查看详情` 之后以真实导航回到会话**（issue 行为契约已写，父文步骤没写）。
8. **辅助模块清单**：父文列了五个文件名；现在 `web/e2e/` 还有 `ui-walk-approval.ts`、`ui-walk-stop.ts`。子 delta 写成「`web/e2e/` 下没有以 `.spec.ts` 结尾的辅助模块」。
9. **每测试 30 s 超时是实际约束**：父文只谈 `globalTimeout`。`timeout: 30_000` 不变，本旅程必须在 30 s 内跑完；实测时长写进 PR，给 #541 / #557 留出余量的判断依据。
10. **没有 RED 阶段**：产品行为都已在 master。证据是负对照（把期望值或提示词改错，旅程在预期的步骤失败），见 design。
10a. **jscpd**：`.jscpd.json` 覆盖 `web/e2e`，门禁是重复率 ≤ 3%。旧旅程的登录块是 `ui-walk.spec.ts` 私有的，新旅程自写一份；若 jscpd 因此在两个 spec 之间多报一个仅限于登录 / 登出块的克隆（178 → 179），接受并记录——消除它要动旧 spec（不在边界内，且它已 799 行）。其它新增克隆不接受。
11. **运行次序**：`ui-walk-sessions.spec.ts` 按文件名排在 `ui-walk.spec.ts` 之前，旧旅程开始时库里已有空间 `ui-walk-sessions`。旧旅程在这个前提下照常通过是本刀的证据项。

## Impact
- 新文件 1 个（`web/e2e/ui-walk-sessions.spec.ts`），`web/playwright.config.ts` 两行。
- `make ui-walk` 每个 project 多一条旅程；CI ui-walk job 的身份与 `timeout-minutes` 不变。
- 主规格：chat-harness 新增一条 Requirement。
