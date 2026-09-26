# Proposal: demo-parity-checklist（#301）

## Why
父 change `s1e-frontend-parity` tasks 6.4，S1e 的关闭证据。demo 一致性验收方式在 grill 中定为"截图对 + 人工清单签收、不做像素 diff"（父 design 决策 15）；`make ui-shots`（#297/#298）已能产出 60 张截图对，但还没有把审查报告 §4 的差距行逐组件落成"一分钟可判定"的清单，签收也无处落地。

## What Changes
- 新增 `docs/acceptance/demo-parity-checklist.md`：由 `docs/reviews/2026-09-24-demo-parity-audit.md` §4.1–4.7 生成，按页面（外壳、登录、`/`、`/files`、`/settings`，另附 `/center` 与 §4.7 汇总）逐组件列 `demo:行号 | §4 来源行 | 期望 | 实现 file:line | 验证方式 | 签收`；S1e 范围外行 `不适用` + 来源阶段/决策；附签收规则与 Epic 签收记录模板。
- `docs/architecture/system.md` §3.3 补 `web/src/ui` 基元层一段（基元清单、Radix 依赖边界、token/动效/图标归属、feature 只经 `ui/index.ts` 使用）。
- 一次 `make ui-shots` 实跑（本地运行面），产物交签收人；签收结果（全部通过，或不通过项 + issue）由签收人确认后贴入 Epic #274。

## Non-goals
- 任何代码改动：不通过项开 issue，不在本 change 修。
- 由 agent 代替人工签收：S1e 范围内项的签收结论只由签收人（仓库所有者）本人给出；agent 只照抄结论并注明出处，自身意见只以"预审"标注出现在评论中。

## Capabilities
- ADDED `demo-parity-acceptance`「逐页验收清单与签收」：父 delta 原文，一处修订——"被本 change spec 认领"晋升后会悬空，改为指名 `s1e-frontend-parity` change spec、其晋升 spec 或其 proposal 偏差留痕/grill 结论。

## Impact
- 仅文档；`make check` 覆盖（naming-guard 等）。签收完成前 Epic #274 不关闭。
