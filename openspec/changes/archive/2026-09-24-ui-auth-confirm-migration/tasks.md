# Tasks: ui-auth-confirm-migration（#280）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（revise ×1）；`openspec validate ui-auth-confirm-migration --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/settings-footer.test.tsx`：`import "./radix-platform.js"`；`getFooter()` 与 `:655` 加 `hidden: true`；F2/F3 改 Escape keydown + `aria-modal` 断言 + `waitFor` 焦点归还；F3 增 `关闭` 文案断言；末尾加 F7 静态契约 describe；`web/test/render-app-router.tsx` +shim。先红（F2 `aria-modal`、F7）。
- [x] 2.2 `web/src/features/auth/footer.tsx` 改 `ConfirmDialog` + `returnFocus` getter，删 `<dialog>`/`trapDialogFocus`/dialogRef/cancelRef/effect；`web/src/styles.css` 删 `.logout-dialog*` 五条；2.1 转绿，`web/test` 全绿（含 `chat-page-lifecycle.test.tsx:389-392` 不改定位仍绿）。
- [x] 2.3 反向注入五项各红并回退：去 `returnFocus` → F2；getter 忽略 `disabled` → F3 禁用分支；`onOpenChange` 忽略 false → F2/F3；去 `pending` 透传 → F4；去 `cancelText` 切换 → F3。
- [x] 2.4 核实 `web/e2e/ui-walk.spec.ts:99-110` 无需改动（逐行记录到 PR 偏离记录）。

## 3. Verification
- [x] 3.1 `make check` exit 0（含 size-guard：`settings-footer.test.tsx` < 800；`chat-page-lifecycle.test.tsx` 未改仍绿）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`ConfirmDialog` 首个消费者的 props 用法（`returnFocus`/`pending`/`cancelText`/`children`）——2.1/2.2 F1–F4。
- Not selected Config / project setup：不加依赖、不改配置（shim 引入属测试 fixture，归 Legacy）。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：只改确认 UI，不改 logout 请求/凭证边界（`useAuth().logout` 不动）。
- Selected Concurrency / shared state / ordering：同 tick 双击去重、pending 中关闭不取消请求、unmount 中止——F3/F4/F5。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：退出语义与文案逐字保留、`lib/dialog.ts` 与 files 不动、ui-walk 退出段不改——F1–F6 + 3.3。
- Selected Error handling / rollback / partial outputs：logout 失败 → 关闭 + `alert` + 可重试——F6。
- Selected Release / packaging / dependency compatibility：Radix Dialog 首次进产物、传递依赖许可上报——3.2 + proposal Impact。
- Selected Documentation / migration notes：`hidden:true`/Escape/`waitFor` 三条改法记入 design（供 #302）；PR 偏离记录含 ui-walk 核实——2.4。
