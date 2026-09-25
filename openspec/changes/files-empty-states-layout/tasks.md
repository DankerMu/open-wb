# Tasks: files-empty-states-layout（#294）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate files-empty-states-layout --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/files-empty-layout.test.tsx`（E1–E5）、`files-page.test.tsx` F4 反转、`preview.test.tsx` 不支持态两例改写。先红。
- [x] 2.2 `tree.tsx`、`page.tsx`、`preview.tsx`、`types.ts`、`files.css`。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入各项变红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR 同步父 delta `s1e-frontend-parity/specs/files-web/spec.md`：无空间句补树区文案（父 Scenario「无空间空态」只说"树区空态文案"，补出具体文案）；空根与不支持态注明 `EmptyState`。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：条目按钮可访问名（exact）是 jsdom 与 ui-walk 定位面；加 `title` 不得改变它。证据：E4、3.3。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Not selected Schema / columns / units / field names：大小格式复用 `formatSize`，不改。
- Not selected Auth / permissions / secrets：无。
- Not selected Concurrency / shared state / ordering：无新状态。
- Not selected Resource limits / large input / discovery：长名只影响样式，由 E4/E5 与 6.1 覆盖。
- Selected Legacy compatibility / examples：`未选择文件` 既有断言（`main.test.tsx:74`、`files-page.test.tsx:372`）与 `该类型不支持预览` 断言保持绿；ui-walk 不改。证据：既有测试全绿、3.3。
- Selected Error handling / rollback / partial outputs：不支持态不发 file 请求（既有行为）。证据：E2。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Not selected Documentation / migration notes：无迁移。
