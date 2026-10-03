# Tasks: scroll-echo-keeps-pin（#726）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `scroll-follow.tsx`：上一次 `scrollTop` 的记录与 `onScroll` 新判据（proposal「What Changes」第一条）；注释同步。
- [ ] 1.2 `chat-scroll-follow.test.tsx`：(a) 贴底赋值后 `clientHeight` 变小、派发 `scrollTop` 未变的 scroll 事件 → 仍贴底、`scrollTop` 被写到底、无 `回到最新`，随后内容更新继续跟随；(b) 贴底时 `scrollTop` 变小且距底 >4px → 解除贴底（现有 F2/F4 语义）；(c) 未贴底时 `scrollTop` 未变小的 scroll 事件不会把它置为贴底（除非距底 ≤4px）。
- [ ] 1.3 `ui-walk.spec.ts` `walkScrollFollow`：在强制溢出的视口内新增一步——`page.reload()` 后等转录就绪，断言距底 ≤4px 且无 `回到最新`（`desktop-light`；`mobile-dark` 同样执行，作为不回归）。不引入 `page.route`、`waitForTimeout`、新的超时字面量。
- [ ] 1.4 不改其它被跟踪文件。

## Must preserve
- `chat-scroll-follow.test.tsx` 现有 F1–F8、R1–R8 全绿且断言不动；`chat-search` 的 `scrollToMessage` 相关测试全绿。
- ui-walk W-scroll 1–4 与两个 spec 文件、两个 project 全绿；每测试 30 s。
- jscpd 不增；`ui-walk.spec.ts` 行数 ≤ 800。

## Required evidence
- E1 RED→GREEN：1.2(a) 在未改 `scroll-follow.tsx` 时失败，改后通过。
- E2 `npm test --workspace web` 全绿（文件数/测试数）。
- E3 真实后端修复前的命中情况：在未改的构建上，`desktop-light`（1440×900）与 1024×768 各直接打开/刷新溢出历史的会话 10 次，记录「加载稳定后距底 >4px」的次数与距离（一次性 Playwright 探针，脚本留在 scratch，不入库）；修复后同样 10 次全部 ≤4px。若修复前一次都不命中，如实记录并说明 1.3 的走查步骤对本缺陷没有 RED 能力（单测 (a) 为唯一 RED）。
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
