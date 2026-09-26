# Spec: demo-parity-acceptance

## ADDED Requirements

### Requirement: 逐页验收清单与签收
`docs/acceptance/demo-parity-checklist.md` SHALL 按页面（登录、外壳、`/`、`/files`、`/settings`）逐组件列出：`demo:行号`、来源 `§4.x` 行、期望元素/状态/交互、对应实现 `file:line`、验证方式（`ui-shots` 态名 + 格 / `ui-walk` / jsdom）、签收列（通过/不通过/不适用 + 日期）；每一项 SHALL 可由一名评审者对着 `ui-shots` 的 `index.html` 或运行中的应用在 1 分钟内判定。**S1e 范围**定义为 `demo-parity-audit.md` §4 中"计划归属"落在 F-UI-1..6（或无 F-ID 且被 `s1e-frontend-parity` change spec、其晋升 spec 或其 proposal 偏差留痕/grill 结论认领）的行；其余行（归 S1b/S1c/S1d/S2c、明确不做、grill 删除的铃铛/设置快捷入口等）SHALL 在清单中标 `不适用` 并注明来源阶段或决策，不得留空。S1e Epic 关闭前 SHALL 把清单签收结果（全部通过或列出不通过项及其 issue）贴入 Epic。

#### Scenario: 清单可判定且与实现同步
- **WHEN** 评审者依清单逐项对照 `ui-shots` 产物
- **THEN** 每项有 demo 行号、§4 来源行、可观察的期望与签收格；§4 中分类为"实现偏差"或"计划遗漏"且属 S1e 范围的每一行在清单中至少有一项对应（一行含多个组件时逐组件拆项，各注明同一来源行）
