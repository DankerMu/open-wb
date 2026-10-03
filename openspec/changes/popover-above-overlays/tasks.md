# Tasks: popover-above-overlays（#715）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `web/src/ui/popover.css`：`.ui-popover` `z-index: 1500`；文件头注释不改语义（定位交给 Radix Popper）。
- [ ] 1.2 `web/test/ui-popover-tooltip.test.tsx`：`.ui-popover` 期望 `z-index: 1500`；新增一条：从 `popover.css`、`dialog.css`、`menu.css` 读出数值，断言 popover 大于 `.ui-dialog-overlay`、`.ui-drawer-overlay`、`.ui-drawer`，小于 `.ui-menu`。
- [ ] 1.3 `web/e2e/ui-walk-sessions.spec.ts`：`step6Sidebar` 的同一侧栏检查里追加筛选步骤（spec delta 第 6 步原文）：`筛选任务` → 点 `状态` 组的 `已完成`（真实点击，无 `force`）→ `aria-checked="true"` 且会话在原分组仍恰一个条目 → 点 `全部` → `aria-checked="true"` → Escape 关闭弹层，`mobile-dark` 上 `dialog 导航` 仍在，焦点回 `筛选任务`。之后的步骤按原样关闭覆盖层（现有 `inspectSidebar` 的收尾），第 7–11 步不变。
- [ ] 1.4 不改其它被跟踪文件。

## Must preserve
- ui-walk 两个 spec、两个 project 全绿；第 1–11 步断言不被削弱；30 s 单测、`globalTimeout` 不变。
- `/files` 工作空间切换器、composer 页脚工作空间 Popover 的行为与现有断言不变（`ui-walk.spec.ts` 与走查第 2 步）。
- 走查文件 ≤ 800 行；jscpd 克隆数不增（基线 179）。
- 走查硬规则：无 `waitForTimeout`、`page.route`、`force: true`、`page.evaluate`、新的显式超时字面量、`test.setTimeout`/`test.slow`。

## Required evidence
- E1 `npm test --workspace web` 全绿（含 1.2 两条）。
- E2 RED→GREEN：在基线 CSS（1300）上，带 1.3 的走查在 `mobile-dark` 第 6 步失败，失败信息为点击被遮罩/面板拦截或单选项不可见；`desktop-light` 通过。改为 1500 后两个 project 通过。
- E3 长驻栈上本走查两个 project 各连续 5 遍通过，记录时长；会话残留计数前后不变。
- E4 全新状态 `make ui-walk`（CI wrapper，两个 `RUNNER_TEMP`）各一遍全绿，记录每个测试时长。
- E5 `make lint`、`make typecheck`、`make anti-drift`（报告 jscpd 数）、`bash scripts/size-guard.sh`、`bash scripts/size-guard.sh web/e2e/ui-walk-sessions.spec.ts`、`make test-guardrails`、`openspec validate popover-above-overlays --strict --no-interactive` 退出 0。

## Negative controls（各在 `mobile-dark` 与单测上各跑一次，记录失败位置）
- N1 `.ui-popover` 回到 1300 → 走查 `mobile-dark` 第 6 步失败（即 E2 的 RED）。
- N2 `.ui-popover` 改 1390（高于 Drawer、低于 Dialog 遮罩）→ 1.2 的关系断言失败；走查仍通过（记录即可，说明关系断言的必要性）。
- N3 `.ui-popover` 改 1650 → 1.2 的关系断言失败（高于 Menu）。
- N4 走查里把 `已完成` 的点击换成只断言可见（不点击）→ 记录在 1300 下是否仍能发现遮挡（预期发现不了或以不同信息失败；用于说明真实点击是取证核心）。
- N5 走查里删掉点 `全部` 的复位 → 后续步骤的表现（预期第 7 步或之后的分区断言因筛选残留而失败，或不受影响——如实记录）。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Accessibility / keyboard / focus | yes | 覆盖层内弹层可点、Escape 只关弹层、焦点回 trigger → E2、E3 |
| Legacy compatibility / examples | yes | 其它 Popover 消费方不变 → E4 |
| Concurrency / shared state / ordering | yes | 筛选是页内状态，复位后续步骤不受影响 → N5、E3 |
| Resource limits / large input / discovery | yes | 30 s 预算 → E3、E4 |
| 其它 | no | 无 API、权限、文件 IO、配置、依赖改动 |
