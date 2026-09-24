# Tasks: ui-dialog-primitives（#277）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate ui-dialog-primitives --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/radix-platform.ts`（只补缺的 jsdom shim）+ `web/test/ui-dialog.test.tsx`（design.md Seams (1)–(10)）；先红（导入失败）。
- [x] 2.2 `npm i -w web @radix-ui/react-dialog`；`web/src/ui/{dialog,confirm-dialog,drawer}.tsx` + `dialog.css`；`ui/ui.css` +`@import`；`index.ts` +3；`icon.tsx` +`triangle-alert`/`info` 与 `ui-icon-brand.test.tsx` 名清单同步；2.1 转绿。
- [x] 2.3 反向注入六项各红并回退：去掉 `dismissible=false` 的 `onEscapeKeyDown` 分支 → (4) 红；ConfirmDialog 去掉 `role="alertdialog"` → (7) 红；去掉 `onCloseAutoFocus` 归还处理器 → (6) 无 trigger 用例红；有 description 时误传 `aria-describedby={undefined}` → (1) 红；Drawer 类名拼错 → (8) 红；`radix-platform.ts` 改为无条件覆盖 → (9) 红。
- [x] 2.4 `ATTRIBUTION.md` §3 Radix 用途行登记 `@radix-ui/react-dialog`；`ui-guardrails.test.ts` 的 Radix 包断言绿。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：三组件 props 契约、出口、`Icon` 名集合扩展——2.1/2.2 RTL + 出口导入断言。
- Selected Config / project setup：Radix 依赖、ATTRIBUTION、`radix-platform.ts` 测试基础设施——2.2/2.4 + 3.1 knip。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无数据结构。
- Not selected Auth / permissions / secrets：不触碰。
- Not selected Concurrency / shared state / ordering：open 状态受控于调用方；Radix 内部处理焦点/层叠。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有 `<dialog>`、`lib/dialog.ts`、`dialog-platform.ts`、`.logout-dialog`/`.files-dialog` 不动——既有 `web/test` 绿 + 3.3 ui-walk。
- Not selected Error handling / rollback / partial outputs：无运行时错误路径。
- Selected Release / packaging / dependency compatibility：react-dialog 传递依赖（remove-scroll、aria-hidden 等）许可与 ESM、jsdom 兼容——2.2 测试在 jsdom 通过 + 3.2 build。
- Selected Documentation / migration notes：shim 头注释与 ATTRIBUTION；design.md 记录 portal 定位器改动预告——2.1/2.4。
