# Tasks: dialog-busy-focus（#315）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass；`openspec validate dialog-busy-focus --strict --no-interactive` exit 0。

## 2. Implementation（TDD：先红后绿）
- [x] 2.1 B1–B5 与 ui-walk 退出段改写；先红（ui-walk 在无救回时红，同时即为注入 1 的真实浏览器证据）。
- [x] 2.2 `useBusyFocusRescue` + `Dialog`/`DialogFrame` `busy` + `ConfirmDialog` 传 `busy`；2.1 转绿，`web/test` 全绿。
- [x] 2.3 反向注入七项（fix pass 1 补 7）各红并回退（design Required evidence）。

## 3. Verification
- [ ] 3.0 archive PR：
  - 父 delta `ui-primitives` 三条需求由 `## ADDED` 改为 `## MODIFIED`，以晋升文本为底（三条均已晋升，父最终归档不再冲突），并同步本刀的忙碌期焦点句与 Scenario；
  - 父 `verification-harness`「UI 走查（Playwright）」块同步退出行；
  - 关闭 #315；
  - 修改父 `tasks.md` 的 1.6b 行（#302 的执行任务），加上：`Dialog` 传 `busy={pending}`；files 表单提交按钮被禁用后焦点仍在模态内，需有真实浏览器断言（与 #315 验收第 1 条同类）；同时在 #302 留言说明。
- [x] 3.1 `make check` exit 0。
- [x] 3.2 `npm run build --workspace web` exit 0。
- [x] 3.3 ui-walk（CI 环境变量）exit 0。

## Risk pack mapping
- Selected Public API / CLI / script entry：`Dialog.busy` 可选 prop。证据：B3、B4。
- Not selected Config / project setup：无依赖变更。
- Not selected File IO / path safety / overwrite：无。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：退出语义不变，焦点处理不涉及鉴权。
- Selected Concurrency / shared state / ordering：busy 上升沿 × fixup 时序。证据：B1、B2、B5，注入 1–4，3.3。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：焦点归还、初始焦点、Tab 循环，settings-footer、chat-page-lifecycle。证据：`web/test` 全绿，ui-walk 401 oracle。
- Selected Error handling / rollback / partial outputs：救回触发后 logout 失败（403）时，footer 关闭模态，焦点经 `returnFocus` 回到 `用户菜单` trigger（不是留在模态内）。证据：fix pass 1 新增 settings-footer 用例（先聚焦 `退出` 再点击，断言救回到 `关闭`，403 后断言对话框消失且焦点回到 trigger），以及对应反向注入；settings-footer 既有 403 用例不回归。
- Not selected Release / packaging / dependency compatibility：不升级 Radix。
- Not selected Documentation / migration notes：#302 的接入说明放在 archive PR 留言。
