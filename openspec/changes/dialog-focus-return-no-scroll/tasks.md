# Tasks: dialog-focus-return-no-scroll（#735）

Fixture level: compact

归档次序（前提）：父 change `s1c-session-metadata-presentation` 不含 ui-primitives delta，无次序约束。

## 1. 实现
- [x] 1.1 `dialog.tsx` `useFocusHandoff().onCloseAutoFocus`：`focus({ preventScroll: true })`；JSDoc/注释写明代价（归还目标可在可视区外；随后的 Tab 会滚动）以及「有 `trigger` 且未传 `returnFocus` 时由 Radix 归还、不经此处」。不要写「与 Radix 一致」。`onOpenAutoFocus` 不动。
- [x] 1.2 `web/test/ui-dialog.test.tsx`：对「无 trigger、无 returnFocus」「传 returnFocus（含同时传 trigger）」「ConfirmDialog returnFocus 透传」三类既有归还用例，各补一条对归还目标 `focus` 入参的断言：spy 装在归还目标**实例**上，或按 `web/test/chat-page-artifacts-panel-focus.test.tsx` 的 Q1 写法 spy 原型后用 `mock.contexts` 过滤到归还目标，断言该元素的调用列表恰为 `[[{ preventScroll: true }]]`。不要对未过滤的原型 spy 用 `toHaveBeenCalledWith`——Radix 打开时的自动聚焦本身就带 `preventScroll`，那样的断言恒绿。spy 须在用例自己的 `opener.focus()` 之后安装。Drawer 的归还用例在同一文件（现 `:536` 附近），补同样一条。既有「焦点落在哪个元素」的断言不动。
- [x] 1.3 除 `web/src/ui/dialog.tsx`、`web/test/ui-dialog.test.tsx` 与本 change 目录外不改其它被跟踪文件。

## Must preserve
- `ui-dialog.test.tsx` 全部既有断言不动且全绿；`web/test/ui-dialog.test.tsx` 行数 ≤ 800（现 699）。
- 其它消费者的焦点归还测试（auth footer、files dialogs、rename/delete、artifacts panel）全绿。

## Required evidence
- E1 RED→GREEN：1.2 的新断言在未改 `dialog.tsx` 时失败，改后通过。
- E2 `npm test --workspace web` 全绿（文件数/测试数）。
- E3 真实浏览器：用既有的一次性复现脚本（scratch 下 `735/repro.mjs`、`upstream.mjs`、`stack.sh`，不入库）对**本补丁的构建**重跑场景 A（两个视口、Escape 与按钮）与场景 B（40ms 间隔，每视口 ≥5 次）：场景 A 关闭后 `scrollTop` 不变、距底 ≤4、无 `回到最新`、焦点在卡片按钮上；场景 B 在流式中，`scrollTop` 会随输出增长，判据只有距底 ≤4、无 `回到最新`、焦点在卡片按钮上。另在补丁构建上重跑一次 Tab / Shift+Tab 残留探针并记录数字。只读脚本与汇总文件，不读原始结果目录里的 cookie。
- E4 `make ui-walk`（CI wrapper）全绿；`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate dialog-focus-return-no-scroll --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉 `{ preventScroll: true }` → 1.2 的新断言失败。
- N2 只在传了 `returnFocus` 时带 `preventScroll`（打开者分支不带）→ 「无 trigger、无 returnFocus」与 Drawer 的断言失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Accessibility / keyboard / focus | yes | 归还目标不变、只是不滚动；代价已登记 → 1.2、Must preserve、proposal |
| UI state / layout / responsive | yes | 两个视口的贴底保持 → E3 |
| Shared primitive blast radius | yes | Dialog/ConfirmDialog/Drawer 全部消费者 → Must preserve、E2、E4 |
| 其它 | no | 无 API、数据、依赖改动 |
