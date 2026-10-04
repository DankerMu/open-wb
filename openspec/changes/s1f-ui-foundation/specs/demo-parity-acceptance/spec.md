## REMOVED Requirements

### Requirement: ui-shots 截图对产物
**Reason**: ADR-0013：全站不再以 demo 为验收基线，demo-vs-app 截图对没有比较对象。
**Migration**: 删除 `web/e2e/ui-shots.mjs`、`web` 的 `ui-shots` 脚本与 Makefile 目标；界面验收改由 functional-acceptance 的功能验收清单与 `make ui-walk` 承担。

### Requirement: 控制面同步
**Reason**: `make ui-shots` 退役后其 AGENTS.md、constraints.yaml、Makefile 镜像不再存在。
**Migration**: 剩余 surface 的控制面同步由 verification-harness「CI 接线与控制面同步」规定（十个 surface）。

### Requirement: 逐页验收清单与签收
**Reason**: `docs/acceptance/demo-parity-checklist.md` 已于 2026-10-04 停用（ADR-0013），其 25 项待签不再签收。
**Migration**: 文件保留为历史记录、不再更新；新的签收对象是 functional-acceptance 规定的 `docs/acceptance/functional-checklist.md`。
