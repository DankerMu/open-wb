# Tasks: ui-popup-primitives（#278）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate ui-popup-primitives --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/ui-support.ts` 上收 `yieldMacrotask`/`pressPointer`/`ruleBody`，`ui-dialog.test.tsx` 改导入（既有 49 用例仍绿）；新建 `web/test/ui-menu.test.tsx`、`ui-popover-tooltip.test.tsx`、`ui-segmented-control.test.tsx`（design.md Seams M1–M8 / P1–P6 / T1–T6 / S / X / G1–G5）；先红（导入失败）。
- [x] 2.2 `npm i -w web @radix-ui/react-dropdown-menu @radix-ui/react-popover @radix-ui/react-tooltip @radix-ui/react-radio-group`；`web/src/ui/{menu,popover,tooltip,segmented-control}.{tsx,css}`；`ui/ui.css` +4 `@import`；`index.ts` +4 组件 + `MenuItem` 类型；2.1 转绿。
- [x] 2.3 反向注入八项各红并回退：`Menu` 去掉 `modal={false}` → (M8) 红；去掉 `loop` → (M3) 红；`Popover` 无条件 `role={contentRole}` → (P1) 红；`Tooltip` 去掉 `Provider` → (T2) 红；不透传 `side` → (T5) 红；`SegmentedControl` 去掉 `aria-label` → (G1) 红；删深色选中规则 → (S) 红；`Tooltip.Provider` 去掉 `disableHoverableContent` → (T6) 红。
- [x] 2.4 `ATTRIBUTION.md:37` 追加四个包全名（#278）并把"后续切片安装"改为只剩 toast；`ui-guardrails.test.ts` Radix 包断言绿。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `ci-compiled-server.sh ui-walk`（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：四组件 props 契约、`MenuItem` 类型、出口——2.1/2.2 RTL + 出口导入断言 (X)。
- Selected Config / project setup：四个 Radix 依赖、ATTRIBUTION、测试 helper 上收——2.2/2.4 + 3.1 knip/jscpd。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无数据结构。
- Not selected Auth / permissions / secrets：不触碰。
- Not selected Concurrency / shared state / ordering：open 状态由 Radix 或调用方持有；Tooltip Provider 每实例独立。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有手写菜单/切换器/radio 卡及其测试不动——既有 `web/test` 绿 + 3.3 ui-walk。
- Not selected Error handling / rollback / partial outputs：无运行时错误路径（Tooltip 缺 Provider 属实现错误，由 T2 覆盖）。
- Selected Release / packaging / dependency compatibility：四包传递依赖（popper/floating-ui/roving-focus）在 jsdom 的守卫与 ESM 兼容——2.2 测试通过 + 3.2 build。
- Selected Documentation / migration notes：design.md Sibling surfaces 记录 #283/#302/2.5 的定位器与断言改动；ATTRIBUTION——2.4。
