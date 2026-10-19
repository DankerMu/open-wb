# Tasks: workspace-path-stale-echo

> 跟踪 #1542。只动 `web/src/features/files/` 的 `host-channel.ts`、`workspace-browser.tsx`（必要时 `follow-entry.ts`）与一个新测试文件；不碰宿主、测试基建、server。测试先行。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 选中：正确性依赖「回声按上报顺序到达、可被合并跳过但不倒序」；须由 404、`reveal` 两种上报、同值重复与合并跳过证明 | 1.1、1.2、1.4、1.5 |
| Legacy compatibility / examples | 选中：宿主主动下发（深链、`pathSeq` 重新定位）不得被误判为回声；既有用例不改即绿 | 1.3、3.1 |
| Error handling / rollback / partial outputs | 选中：404 后的清除与在途预览的取消只能由宿主的新要求或组件自己触发，不能由陈旧回声触发 | 1.1 |
| Public API、Config、File IO、Schema、Auth、Resource limits、Release、Documentation | 未选：`WorkspaceBrowser` 的属性与回调签名不变，不改配置、依赖或文档 | — |

## 1. 测试先行

- [x] 1.1 新测试文件 `web/test/workspace-browser-path-echo.test.tsx`，用例 A（404 → 点击，design Required evidence）：在未改动代码上红（记录报文）
- [x] 1.2 用例 B（`reveal` 落地 → 点击）：在未改动代码上红
- [x] 1.3 用例 C1（`pathSeq` 下发 `null`）、C2（普通树里未上报过的 `c.md`）照常套用：改前改后都绿
- [x] 1.4 用例 D（`R=[a,b,a]` 逐个回声）：改前红（多出的 `file` 请求），改后绿
- [x] 1.5 用例 E（回声被合并跳过、splice 落在 index≥1，cross-review r1 G1）：改前红，改后绿

## 2. 实现

- [x] 2.1 `host-channel.ts` 新 hook：上报记账与「被取代的回声」判定（design D1）
- [x] 2.2 `workspace-browser.tsx`：所有上报点（含交给 `useFollowEntry` 的回调）改调记账的上报；`path` effect 在 `appliedPathRef` 非 `undefined` 时询问判定，回声只记为已套用（design D2）；文件头注释补一句。验证：1.1–1.4 绿

## 3. 证据

- [x] 3.1 `npm test --workspace web` 全绿（含 `workspace-browser*`、`files-deep-link*`、`chat-workspace-sidebar*`）
- [x] 3.2 `make check` 0（含 size-guard：`workspace-browser.tsx` ≤800 行）
- [x] 3.3 `docs/acceptance/functional-checklist.md`：按文件头规则判断是否需增改一行（写 `待签`）；不需要则在 PR 写明理由
