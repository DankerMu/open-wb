# Tasks: ui-walk-fork（#492）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.2d 原文）

- [ ] 8.2d ui-walk 分叉：用户消息点 `从此处分叉` → 跳转新会话、composer 草稿为该用户文本。验证：`make ui-walk` 两个 project 全绿；CI 不传 `OMP_MAX_PROCESSES`
- [ ] （本 fixture 追加，见 design「Must add/change」1、3；决定 2、5）首条用户 `.chat-msg-body` 恰为首条模板 prompt；该 article 内 `从此处分叉`（`exact`）等到可用再点；先挂 `waitForResponse` 再点，断言 **201**。验证：design E1、E2 M1/M3
- [ ] （本 fixture 追加，design 4；决定 2）URL `?session=` 轮询到等于 201 体 `session.id`，且匹配会话 id 格式、≠ 走查会话。不按会话名定位（分叉复制标题）。验证：design E1
- [ ] （本 fixture 追加，design 5；决定 4）`main` 内 `region 消息` 先可见，再断言 `article` 数量 0、`重新生成` 数量 0。验证：design E2 M3/M6a
- [ ] （本 fixture 追加，design 6–7）composer 草稿 `toHaveValue(prompt)` 精确相等、form 内 `发送` 可用；`inspectSidebar` 内 `aria-current` 项状态元素名为 `<aria-label> 未开始`。不等 Toast（分叉无 Toast）。验证：design E2 M2/M3b/M4
- [ ] （本 fixture 追加，design 2、8；决定 3）点击前挂 `page.on("request")` 记录任何会话的 prompt POST，侧栏断言后断言为空，`finally` 里 `page.off`；不加 sleep。验证：design E2 M5（承重，6/6）、M6a/M6b（立即发送在有利次序下两道都抓，非保证）、M6c（如实记录窗口外残余，恒绿）
- [ ] （本 fixture 追加；决定 6）`selectFirstSessionInOverlay` 跳过 `未开始` 会话，`ui-walk.spec.ts:121-124` 的 #424 断言不改。验证：design E0-4、E2 M7
- [ ] （本 fixture 追加；决定 1）`walkFork` 导出自 `ui-walk-stop.ts`（`sessionPost` 端点联合加 `"fork"`）；`ui-walk.spec.ts` 复用 import 行，调用点净增 1 行，≤800 行（预期 799）。验证：design E3、E4

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 自动发送与 `setDraft`/`refreshList`/`selectSession` 同一回调：监听须先于点击，窗口须晚于其下游渲染；空转录须等历史装载后再数；列表按 `updated_at` 倒序使空分叉排第一；messages GET 禁止区间不被延长 → design「Must add/change」2/5/8、决定 3/4/6，E2 M5/M6a/M6b/M6c/M7 |
| Resource limits / large input / discovery | yes | fork 201 走真 omp 临时进程（560–611ms，满载 1.31s）；action 10s、expect 5s、单测 30s，本机满载旅程 14.3s；spec 799/800 → design「超时」、E0-2、E1（含满载一遍）、行数预算 |
| Legacy compatibility / examples | yes | 停止、重新生成步骤零改动；#424 断言原文不变、只改 helper 选择条件；走查结束停在带未发送草稿的空分叉会话，后段欢迎态、设置、主题、登出与 error oracle 仍全绿 → E0-3、E1、E4，决定 6 |
| Error handling / rollback / partial outputs | yes | 草稿被发送（部分完成的「分叉 + 回合」）或取自错误分叉点必须红；监听在 `finally` 里摘除，不掩盖旅程错误 → E2 M3/M3b/M5/M6a |
| Public API / CLI / script entry | no | 不改 `make ui-walk` 配方与 Playwright 配置，不新增 project |
| Config / project setup | no | Makefile、CI、env 零 diff；CI 不传 `OMP_MAX_PROCESSES`（默认 16 容纳 fork 临时进程）→ E4 |
| File IO / path safety / overwrite | no | 不涉文件读写；omp 会话文件由服务端 fork 路径管理，本刀只消费其 REST 结果 |
| Schema / columns / units / field names | no | 只消费已定形的 aria 契约、URL `session` 参数与 fork 201 `{session, draft}`（#469/#479） |
| Auth / permissions / secrets | no | 沿用既有登录态；分叉不涉 gate 控制面，不引入新凭证 |
| Release / packaging / dependency compatibility | no | 无依赖变化；omp 仍为 v18.0.10 |
| Documentation / migration notes | no | demo-parity-checklist CH-09/CH-12/CH-22 更新不归本刀，至 #486 时另开 docs issue（carry-forward :134、:141），本刀只提供证据 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `web/e2e/ui-walk-stop.ts`（头注释、`type Request` import、两个正则常量、`sessionPost` 端点联合、新增 `walkFork`（含 `mark()` 打点））、`web/e2e/ui-walk.spec.ts`（import 名 + 1 行调用）与 `web/e2e/ui-walk-layout.ts`（`selectFirstSessionInOverlay` 选择条件与注释）。`web/src`、server、Makefile、CI、env 以及其它 `web/e2e/*` 零 diff。
- [ ] 既有测试断言零改动，不搬 helper。若出现 design「Sibling surfaces」之外的破坏，停下上报。
- [ ] 红/绿：
  - E2 的 M1/M2/M3/M3b/M4/M5/M6a/M6b/M7 各自施加后红，失败输出记入 PR body；
  - M6c 记录恒绿；M6 系列改动的 `turn-actions.ts` 测后按原件还原并重建 web；
  - E1、E3、E4 为守护，恒绿。
- [ ] 按 design E0 条件自起服务：Node 24、编译 server/web、真 omp `var/omp/omp`、假上游。`make ui-walk` 连跑 ≥3 遍加满载 1 遍，全部退出 0；结束后确认没有残留进程。
- [ ] `make lint`、`make typecheck` 退出 0；`wc -l web/e2e/ui-walk.spec.ts` ≤800，实测值记入 PR body。
- [ ] PR CI `ui-walk` job 绿。
- [ ] `openspec validate ui-walk-fork --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「决定与偏离」与 Orchestrator decisions / Open questions，并附 E1 步骤时序日志（两个 project）。
