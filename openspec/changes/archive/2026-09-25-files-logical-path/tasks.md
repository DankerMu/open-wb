# Tasks: files-logical-path（#292）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 revise → r2 pass，报告 `.workplans/292/review/fixture-r{1,2}.md`）；`openspec validate files-logical-path --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新 `web/test/files-logical-path.test.tsx` L1–L6 先红并记录。
- [x] 2.2 `logicalPath` + `page.tsx`/`tree.tsx`/`dialogs.tsx`/`files.css` 按 design D1–D7；2.1 转绿。
- [x] 2.3 既有 files 测试与 ui-walk `:496` 按 Sibling surfaces 改定位文本；`web/test` 全绿。
- [x] 2.4 反向注入 1–6 各红并回退，逐条记入 PR。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。
- [x] 3.4 archive PR：父 `files-web`「工作空间页」块以晋升文本为底同步（保留父独有表述；本刀更严格的措辞——过滤"大小写无关"、不外泄清单含 `placeholder` 与下拉选项——同步进父 delta，不得回退为父原文）；勾选父 tasks 5.1；关闭 #292。

## Risk pack mapping
- Not selected Public API / CLI / script entry：无。
- Not selected Config / project setup：无依赖变更。
- Not selected File IO / path safety / overwrite：服务端路径校验不变。
- Selected Schema / columns / units / field names：`Workspace.root` 保留不渲染，逻辑路径由 `account`+`dir` 拼接。证据：L1、L3、注入 1/5。
- Selected Auth / permissions / secrets：沙箱绝对路径不出现在界面文本/title/aria/placeholder/option。证据：L2、注入 1。
- Not selected Concurrency / shared state / ordering：不改请求与代际逻辑；既有并发用例只改定位文本。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有 files 断言与 ui-walk 位置下拉 label。证据：`web/test` 全绿、3.3、注入 3/4/6。
- Not selected Error handling / rollback / partial outputs：无新增错误路径。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无对外文档。
