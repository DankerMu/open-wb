# Tasks: files-dialog-migration（#302）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 revise → r2 pass，报告 `.workplans/302/review/fixture-r{1,2}.md`）；`openspec validate files-dialog-migration --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 新 `web/test/files-overlays.test.tsx` O1–O7 先红（迁移前运行并记录失败项）。
- [x] 2.2 `dialogs.tsx`/`page.tsx`/`tree.tsx` 按 design D1–D5 迁移；删 `web/src/lib/dialog.ts`、`web/test/dialog.test.tsx`、`web/test/dialog-platform.ts`（及 9 处 import，files-fixture 改引入 `radix-platform.ts`）；`files.css` 按 D6 删死规则。
- [x] 2.3 既有 files 测试按 design Sibling surfaces 与 D7 调整（菜单改 pointer 打开；模态背后的点击改走真实路径，断言意图不变）；`web/test` 全绿。
- [x] 2.4 `web/e2e/route-hold.ts` + `ui-walk.spec.ts` 按 D8（页面范围定位、walk-out 挂起期焦点断言、退出段改用共用 helper）；`ui-walk.spec.ts` ≤ 800 行。
- [x] 2.5 反向注入 1–6 各红并回退（design Required evidence），逐条记入 PR。

## 3. Verification
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。
- [x] 3.4 archive PR：父 `ui-primitives` 中「既有对话框迁移不回归」由父独有转为已晋升（父 delta 以晋升文本为底同步迁移句）；父 `files-web`「文件界面与键盘可用性」同步本刀新增句与 Scenario；勾选父 tasks 1.6b；关闭 #302。

## Risk pack mapping
- Not selected Public API / CLI / script entry：不改基元 API；files 组件为 feature 内部。
- Not selected Config / project setup：无依赖变更（Radix 包已装）。
- Not selected File IO / path safety / overwrite：服务端与路径校验不变。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：退出段只换 helper，行为不变。
- Selected Concurrency / shared state / ordering：挂起期取消（abort）、迟到响应代际守卫、Radix 菜单/弹层关闭与对话框打开的焦点时序。证据：O4、files-concurrency 与 files-page 迟到用例、注入 1/2、3.3。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：files 既有断言语义、初始焦点、焦点归还、菜单/切换器键盘行为、ui-walk walkFiles。证据：O1–O3、O5–O7，`web/test` 全绿，3.3，注入 3/5。
- Selected Error handling / rollback / partial outputs：409 后对话框保持打开且可重试，焦点在框内。证据：O5、`files-page.test.tsx:215-300`。
- Not selected Release / packaging / dependency compatibility：无。
- Not selected Documentation / migration notes：无对外文档。
