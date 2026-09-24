# Tasks: ui-form-primitives（#276）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate ui-form-primitives --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/ui-form.test.tsx`：按 design.md Required evidence 写五组件 RTL 断言 + 静态断言（spinner 绝对定位；button.css 末规则 `.ui-btn.ui-btn--loading` 含 `color: transparent`；所有 `:hover` 含 `:not(:disabled)`；Tag brand 深色覆盖；button/input/switch/chip 四个 css 各含 `:focus-visible`（规则体含 `border-radius`）与 reduced-motion 块；primary spinner 变体上色；`ref` 透传用例）；先红（导入失败）。
- [x] 2.2 `npm i -w web @radix-ui/react-switch`；`web/src/ui/{button,input,switch,tag,chip}.tsx` + 同名 css；`ui/ui.css` 追加五行 `@import`；`index.ts` 增量导出；2.1 转绿。
- [x] 2.3 `web/test/ui-guardrails.test.ts`：模式拆为字面量组（全路径）与调色板组（排除 `web/src/ui/**/*.css`）；先对 2.2 产出跑一次（组件 css 引用调色板 → 旧规则红），改后绿；按 design.md 做五个注入正反例并回退。
- [x] 2.4 `ATTRIBUTION.md` §3 Radix 条目用途行更新（已安装 `react-switch`，其余后续切片）；既有 ATTRIBUTION 断言仍绿。

## 3. Verification
- [x] 3.1 `make check` exit 0（lint/typecheck/test/anti-drift：knip、jscpd、naming-guard、size-guard）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 `make ui-walk` exit 0（经 `.github/scripts/ci-compiled-server.sh ui-walk`）。

## Risk pack mapping
- Selected Public API / CLI / script entry：五个组件 props/类名契约与 `index.ts` 导出——2.1/2.2 RTL + 出口导入断言。
- Selected Config / project setup：Radix 依赖、ATTRIBUTION、守卫规则变更——2.2/2.3/2.4 + 3.1 knip。
- Not selected File IO / path safety / overwrite：纯前端组件，无文件 IO。
- Not selected Schema / columns / units / field names：无数据结构；props 契约归 Public API。
- Not selected Auth / permissions / secrets：不触碰。
- Not selected Concurrency / shared state / ordering：Switch 状态由 Radix 受控/非受控处理，无共享状态。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：`.ui-button*` 11 处消费者与类名命名空间——`ui-btn` 前缀 + 既有 `web/test` 绿 + 3.3 ui-walk。
- Not selected Error handling / rollback / partial outputs：无运行时错误路径。
- Selected Release / packaging / dependency compatibility：Radix peer（react ^19）、ESM、jsdom 无 shim 可渲染——2.2 测试在 jsdom 通过 + 3.2 build。
- Selected Documentation / migration notes：ATTRIBUTION 措辞、demo 字面量→token 映射留痕（映射表只在 design.md；css 头注释用文字描述、不含字面量）——2.4 + 2.2 css 头注释 + 2.3 守卫零命中。
