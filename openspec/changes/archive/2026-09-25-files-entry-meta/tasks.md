# Tasks: files-entry-meta（#293）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate files-entry-meta --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 `web/test/file-meta.test.ts`（F1）与树/预览头结构断言（F2–F4）。先红。
- [x] 2.2 `file-meta.ts`；`tree.tsx` 图标与大小；`preview.tsx` 删 `formatByteSize`、加图标；`files.css`。2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入十项各红并回退（design Required evidence）。

## 3. Verification
- [x] 3.0 archive PR 同步父 delta `s1e-frontend-parity/specs/files-web/spec.md` 左栏句：补"文件条目的可访问名恰为文件名"，预览头"文件名" → "文件图标、路径"（父 Scenario「树条目图标、大小与空目录」已是本刀 Scenario 的超集，不另同步）。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：文件行可访问名（exact）是 jsdom 与 ui-walk 定位面。证据：F2、3.3。
- Not selected Config / project setup：不加依赖。
- Not selected File IO / path safety / overwrite：纯呈现。
- Selected Schema / columns / units / field names：大小单位与进位规则（B/KB/MB/GB 一位小数）。证据：F1。
- Not selected Auth / permissions / secrets：无。
- Not selected Concurrency / shared state / ordering：无。
- Not selected Resource limits / large input / discovery：GB 封顶由 F1 覆盖。
- Selected Legacy compatibility / examples：既有预览大小与截断断言、ui-walk 不变；文件树用例只改写 `files-page.test.tsx:102-106` 的行名列举。证据：既有测试全绿、3.3。
- Not selected Error handling / rollback / partial outputs：无。
- Not selected Release / packaging / dependency compatibility：不加依赖。
- Not selected Documentation / migration notes：无迁移。
