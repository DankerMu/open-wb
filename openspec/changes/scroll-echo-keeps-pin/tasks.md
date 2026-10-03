# Tasks: scroll-echo-keeps-pin（#726）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 chat-web 与 conversation-search delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta。

## 1. 实现
- [ ] 1.1 `scroll-follow.tsx`：上一次 `scrollTop` 的记录与 `onScroll` 新判据（proposal「What Changes」第一条）；注释同步。记录值是写入后**读回**的 `el.scrollTop`（不是赋的 `scrollHeight`）；比较用严格 `<`、不加容差；初始记录值由挂载时的 `settle()` 确立。
- [ ] 1.2 `chat-scroll-follow.test.tsx`：(a) 贴底赋值后 `clientHeight` 变小、派发 `scrollTop` 未变的 scroll 事件 → 仍贴底、`scrollTop` 被写到底、无 `回到最新`，随后内容更新继续跟随；(b) 贴底时 `scrollTop` 变小且距底 >4px → 解除贴底（现有 F2/F4 语义）；(c) 未贴底时 `scrollTop` 未变小的 scroll 事件不会把它置为贴底（除非距底 ≤4px）。
- [ ] 1.3a 纯搬移：`ui-walk.spec.ts` 已 799 行（上限 800）。把 `walkScrollFollow` 及只被它使用的常量与 helper 搬到新文件 `web/e2e/ui-walk-scroll.ts`（做法同 `ui-walk-stop.ts`；函数体逐字不变，只调整 import/export 与参数传递）。搬移单独成一个 commit 级别的 diff 段落，在报告里给出「搬移前后函数体 diff 为空」的证明。
- [ ] 1.3b 在 W-scroll 1 之后、强制溢出的视口内新增一步「刷新后仍贴底」：用 `web/e2e/route-hold.ts` 的 `holdRoute` 挂住会话列表请求，`page.reload()`，等转录渲染出该对消息后放行（快照先于列表——顶栏在转录贴底之后才挂载）；再等既有的完成判据（`expectCompletedPair`）与 desktop 的 `header.topbar h1` 可见，等两帧，做一次性读取：距底 ≤4px 且无 `回到最新`。`desktop-light` 上该步在未改 `scroll-follow.tsx` 的构建上必须失败（E1b）；`mobile-dark` 同样执行，作为不回归。不引入 `waitForTimeout` 与新的超时字面量。若 `holdRoute` 的次序在真实栈上做不出 RED，停下报告。
- [ ] 1.4 除 `scroll-follow.tsx`、`chat-scroll-follow.test.tsx`、`ui-walk.spec.ts`、`ui-walk-scroll.ts`（新）与本 change 目录外不改其它被跟踪文件。

## Must preserve
- `chat-scroll-follow.test.tsx` 现有 F1–F8、R1–R8 全绿且断言不动；`chat-search` 的 `scrollToMessage` 相关测试全绿。
- ui-walk W-scroll 1–4 与两个 spec 文件、两个 project 全绿；每测试 30 s。
- jscpd 不增；`ui-walk.spec.ts` 与 `ui-walk-scroll.ts` 行数均 ≤ 800。
- `web/test/chat-page-search-follow.test.tsx`（S10、S11、S17）断言不动且全绿。
- `web/test/chat-scroll-follow.test.tsx` 测试桩对 `scrollTop` 的钳制不改。

## Required evidence
- E1 RED→GREEN：1.2(a) 在未改 `scroll-follow.tsx` 时失败，改后通过。
- E1b 1.3b 的新步骤在未改 `scroll-follow.tsx` 的构建上于 `desktop-light` 失败（记录距底数值），改后通过。
- E2 `npm test --workspace web` 全绿（文件数/测试数）。
- E3 真实栈一次性探针（脚本留在 scratch，不入库；溢出历史靠压矮视口高度得到，宽度保持 ≥761 才是宽屏判据）。修复前后各跑：(i) 自然次序刷新 10 次，1440×900 与 1024×768（矮高度变体），记录「加载稳定后距底 >4px」的次数与距离；(ii) 强制次序——`holdRoute` 挂住列表（快照先）与挂住 `…/messages`（列表先）各一次，外加 390×844；(iii) 修复后在 (ii) 的每种次序稳定后再压矮视口一次，断言仍贴底；(iv) `deviceScaleFactor: 2` 下重复 (ii) 的快照先次序一次。期望：修复后全部 ≤4px、无 `回到最新`；修复前快照先次序在宽屏 >4px。
- E4 全新状态 `make ui-walk`（CI wrapper）两遍全绿，记录每测试时长。
- E5 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh web/e2e/ui-walk.spec.ts`、`openspec validate scroll-echo-keeps-pin --strict --no-interactive` exit 0。

## Negative controls
- N1 `onScroll` 改回无条件解除 → 1.2(a) 失败。
- N2 `onScroll` 改成「距底 >4px 一律保持贴底」（不看 `scrollTop`）→ 1.2(b) 与现有 F2 失败。
- N3 `settle()` 写入后不更新记录值 → 记录哪条用例失败（预期：内容增长后用户上滚的用例，或如实记录无用例失败并补一条）。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 贴底赋值、布局变化与 scroll 事件的先后 → E1、E3、N1–N3 |
| Legacy compatibility / examples | yes | 上滚、搜索定位、回到最新语义不变 → Must preserve、E2 |
| Accessibility / keyboard / focus | yes | 键盘滚动仍解除贴底 → 1.2(b) |
| Resource limits / large input / discovery | yes | 走查 30 s 预算 → E4 |
| 其它 | no | 无 API、权限、依赖改动 |
