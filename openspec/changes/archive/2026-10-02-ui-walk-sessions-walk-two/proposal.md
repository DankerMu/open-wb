# Proposal: ui-walk-sessions-walk-two（#541，父 change `s1c-session-metadata-presentation` tasks 8.2b）

## Why
置顶、重命名、对话内搜索与会话删除都已合入，但 PATCH / DELETE 在真实浏览器下没有端到端证据：分区迁移、重命名跨 reload 持久、搜索的当前匹配、删除后的 REST 404 都只有 jsdom 与服务端测试。#540 的走查一在第 6 步之后就经 REST 删除了会话。

## What Changes
- `web/e2e/ui-walk-sessions.spec.ts`：在第 6 步之后、同一 `try` 块内追加第 7、8、9、11 步（置顶 → 重命名与 reload → 对话内搜索 → UI 删除）；去掉「离开会话页」那一步（第 11 步之后页面已在欢迎态）；`finally` 的 REST 删除保留（成功路径上得 404）。顺带修 #540 复审留下的一处：`查看详情` 的 `waitForEvent` 与 click 并成 `Promise.all`。
- 规格：chat-harness MODIFIED「UI 走查会话元数据」。

## Non-goals
- 第 10 步（slash 候选）：#557。
- 顶栏的 `重命名` 入口：jsdom 已覆盖，不进走查。删除 running 会话：服务端集成测试。
- `web/playwright.config.ts`、`ui-walk.spec.ts`、既有 e2e 辅助、`web/src`、server、Makefile、CI：零 diff。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **清理段是改写而不是插入**：主规格现文是「After step 6 the journey leaves the session page by a real navigation …」。第 11 步经 UI 删除后页面自己回到欢迎态，那一步不再需要，去掉；`finally` 的范围改成第 2–11 步；成功路径上 DELETE 得 404。失败路径上页面可能仍在会话页，`finally` 的删除之后可能多出一条重连 404 的 oracle 错误——旅程本来就已失败，与 #540 的口径相同。父文的清理段写的是「If the journey fails before step 11」加 409 回退，沿用 #540 的偏差（无条件 `finally`、不实现回退）。
2. **第 9 步的「scrolls the user message into view」写成「is fully in the viewport」**：走查断言的是结果（当前匹配的用户消息完整可见，`toBeInViewport({ ratio: 1 })`），不是「滚动发生过」。`mobile-dark` 上它有判别力——搜索前用户消息顶部被转录框裁掉约 39–62 px（可见比 0.53–0.64，随 UUID 折行而定），命中后完整可见；把同一断言挪到搜索之前，mobile 失败、desktop 通过。`desktop-light` 上消息前后都完整可见，分辨不出滚动。滚动行为本身另有 jsdom 的对话内搜索测试。
3. **第 9 步的次序写明**：搜索框一打开计数就是 `0/0`，所以「无匹配 → `0/0`」必须排在观察到 `1/1` 之后才有判别力；`Esc` 之前重新输入 UUID，使「清除高亮」有前后对比。父文没写次序。「`Esc` in the box」是收窄：只有输入框处理 `Esc`。
4. **第 8 步加 REST 回读**（`GET /api/sessions` 的 `title` 与 `pinnedAt`）与「对话框里预填当前标题」「保存后对话框关闭」；新标题每个 project 唯一。父文没写。唯一标题让第 11 步的「条目从所有分区消失」可以按名字断言。
5. **第 7 步写成「不再提供 `置顶任务`」**：父文只写「the menu then offers `取消置顶`」。
6. **行菜单按钮的名字**：父文写 `更多`，产品里是 `更多操作：<标题>`（issue 的 Key interfaces 已更正）。子 delta 写「the button named `更多操作：<title>` of that entry」。
7. **第 10 项占位**：子 delta 里留一个列表项「10. (Slash candidates are not part of this journey yet.)」，保持编号连续（Markdown 会把跳号的 `11.` 渲染成 10），#557 原位替换它。
8. **`查看详情` 的 `Promise.all`**（#540 复审 P3，已在本 issue 留言交接）：不改变任何规格句子；加一条负对照覆盖「click 自己失败时清理仍执行」。并成 `Promise.all` 之后先 reject 的仍可能是 `waitForEvent`（两者同为 10 s，`waitForEvent` 先注册），所以报出的首错不保证是 click 的定位错误——修的是「unhandled rejection 打断清理」，不是报错文案。
9. **Toast 的定位**：既有旅程用 `getByRole("region", { name: /通知/ })` 找 Toast；本刀的置顶与删除 Toast 出现时 mobile 的导航覆盖层开着，覆盖层把页面其余部分标成 `aria-hidden`，按 role 找不到。按文本定位。只断言规格点名的 `任务已删除`。
10. **没有 RED 阶段**：产品行为都已在 master；证据是负对照，这次两个 project 都做。

## Impact
- `web/e2e/ui-walk-sessions.spec.ts` 一个文件。每条新旅程多一次 reload 与若干次点击，没有新的真实回合。
- 主规格：chat-harness 一条 Requirement。
