# Tasks: ui-tokens-foundation（#275）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate ui-tokens-foundation --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/ui-tokens.test.ts`：解析 demo:19-107 与 108-188、`web/src/styles/tokens.css` 两块，按 design.md 归一化后逐名逐值断言（font-heading 豁免、六个补定变量断言固定值、每块名集合 == demo 名集合 ∪ 六个补定名，即 `--wb-home-bg`/`--wb-control-bg` 不得残留）+ 未定义引用守卫（`web/src/**/*.css` 的 `var(--wb-*)` ⊆ tokens.css 定义）；先红。
- [x] 2.2 `web/src/styles/tokens.css`：两块全量移植 + 六个补定固定值 + 来源头注释；`web/src/styles.css` 移除 token 块、`@import "./styles/tokens.css"`、四处 `--wb-home-bg`/`--wb-control-bg` 改 `--wb-home-bg-primary`/`--wb-color-bg-input`；2.1 转绿，既有 `web/test` 绿。
- [x] 2.3 `web/test/ui-guardrails.test.ts`：grep 守卫（features/routes/ui css+tsx 无 `#hex`/`rgba?(`/`--wb-palette-`；`web/src/ui/**/*.tsx` 无 `style={`）+ `motion.css` reduced-motion 文本断言 + `ATTRIBUTION.md` 含 lucide/ISC 与 Radix/MIT；先红（chat.css:5 注释 hex、motion.css 缺失、ATTRIBUTION 未加）。
- [x] 2.4 `web/src/ui/motion.css`（六组关键帧、`ui-fadein/ui-pop/ui-pulse/ui-caret/ui-spin` 工具类、reduced-motion 块）+ styles.css `@import "./ui/motion.css"`；清理 `chat.css:5` 注释；2.3 转绿。
- [x] 2.5 `web/test/ui-icon-brand.test.tsx`：Icon 默认 aria-hidden / label→role=img / size 类名；BrandMark svg + 可选字标；先红。
- [x] 2.6 `npm i -w web lucide-react`；`web/src/ui/icon.tsx`（`IconName` 联合类型：message-square、folder、layout-grid、settings、shield、file-text、file-code、table、image、archive、file、terminal、wrench、send、copy、plus、search、check、x、chevron-down、chevron-right、menu、panel-left、arrow-down、log-out，内部映射）、`web/src/ui/brand-mark.tsx`、`web/src/ui/index.ts`；2.5 转绿。
- [x] 2.7 `ATTRIBUTION.md` 增 lucide（ISC）与 Radix UI Primitives（MIT，后续切片安装）条目；2.3 的 ATTRIBUTION 断言转绿。

## 3. Verification
- [x] 3.1 `make check` exit 0（lint/typecheck/test/anti-drift 含 knip、jscpd、size-guard）。
- [x] 3.2 `npm run build --workspace web` exit 0；`grep -rE "Poppins|fonts\.googleapis" web/dist` 零命中。
- [x] 3.3 本地起服务后 `make ui-walk` 全绿（视觉与 DOM 不变的运行时证据）。

## Risk pack mapping
- Selected Public API / CLI / script entry：`ui/index.ts` 唯一出口——2.6 + 2.5 RTL；后续切片只能经它导出。
- Selected Config / project setup：新依赖 lucide-react、ATTRIBUTION——2.6/2.7 + 3.1 knip 无未使用依赖。
- Not selected File IO / path safety / overwrite：纯前端静态资源，无运行时文件 IO。
- Selected Schema / columns / units / field names：token 名/值契约——2.1/2.2 归一化逐字对照 + 六个补定值断言 + 未定义引用守卫。
- Not selected Auth / permissions / secrets：不触碰。
- Not selected Concurrency / shared state / ordering：无运行时状态。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有 21 变量与 feature/styles.css 消费者——2.1 未定义引用守卫 + 2.2 既有测试绿 + 3.3 ui-walk。
- Not selected Error handling / rollback / partial outputs：无运行时错误路径。
- Selected Release / packaging / dependency compatibility：lucide 打包离线、无公网字体——3.2 dist grep。
- Selected Documentation / migration notes：来源头注释与 ATTRIBUTION——2.2/2.7，由 2.3 的 ATTRIBUTION 断言守住。
