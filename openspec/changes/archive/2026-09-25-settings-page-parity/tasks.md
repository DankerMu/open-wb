# Tasks: settings-page-parity（#300）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate settings-page-parity --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 抽 `web/test/settings-support.tsx`，把 `describe("settings route")` 从 `settings-footer.test.tsx` 迁到新 `web/test/settings-page.test.tsx`；在现实现上保持全绿，记录迁移前后用例数。
- [x] 2.2 `settings-page.test.tsx` 新增 S1–S7，并按改写规则 2–3 更新迁入用例锚点。先红。
- [x] 2.3 `page.tsx` 结构、`settings.css`、`styles.css` 删除旧规则并 import、`ui.css` 增 `.ui-sr-only`。2.2 转绿，`web/test` 全绿。
- [x] 2.4 反向注入十二项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.1 `make check` exit 0（size-guard、jscpd、knip、ui-guardrails）。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：radiogroup/radio 名、`当前生效：…` 可访问文本、region 名是 ui-walk 与 6.1 的定位面。证据：S1、S2、3.3。
- Not selected Config / project setup：不加依赖、不改配置。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：只消费 3.1 已定的 `ServiceInfo`。
- Not selected Auth / permissions / secrets：关于卡不展示 provider（S4），数据流不变。
- Not selected Concurrency / shared state / ordering：Provider operation 不改；迁移用例覆盖既有竞态。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：迁移用例不弱化，ui-walk 不改且全绿。证据：S7、改写规则、3.3。
- Not selected Error handling / rollback / partial outputs：失败文案与收敛不变，由迁移用例与 S5 覆盖。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Selected Documentation / migration notes：测试拆分与锚点改写规则。证据：PR 迁移说明。
