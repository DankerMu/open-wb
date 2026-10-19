# Tasks: welcome-handoff-superseded

> 跟踪 #1543。只动 `use-chat-session.ts` 的一处 `navigate`、`main.tsx` 的导入、渲染应用路由的测试 helper / 测试的导入与一个新测试文件；不碰 server、`ownership.ts`、`新建会话`、测试基建。测试先行。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 选中：正确性依赖「创建续延内同步提交目标、同步 flush 派发 effect，之后的导航是另一个宏任务」；须由 replace 与 POP 两种合并方式证明 | 1.1、1.2 |
| Config / project setup | 选中：`main.tsx` 的 `RouterProvider` 改从 `react-router/dom` 导入（全应用路由入口）；测试 helper 同步改，须证等价 | 2.2、3.1 |
| Error handling / rollback / partial outputs | 选中：无待上传附件时 prompt 请求恰一次、不丢不重；离开后欢迎态可再发送；选中该会话不补发。有待上传附件时的作废沿用既有规则，列为非目标（design Non-goals） | 1.1–1.3 |
| Legacy compatibility / examples | 选中：既有交接 / 作废 / #872 / 被拒后读历史 / #1541 相关用例不改即绿；`use-chat-session.ts` ≤800 行 | 3.1、3.3 |
| Public API、File IO、Schema、Auth、Resource limits、Release、Documentation | 未选：不改接口、文件、依赖（`react-router/dom` 是已装 `react-router` 的子路径导出，不新增依赖）或文档 | — |

## 1. 测试先行

- [x] 1.1 新测试文件，用例 A（replace，design Required evidence）：在未改动代码上红（记录报文：停在「停止」或 prompt 0 次）
- [x] 1.2 用例 B（POP：`router.navigate(-1)`，同一个 `act()` 内 await 到 URL 为 `/`）：在未改动代码上红
- [x] 1.3 用例 C（A 之后选中 `CREATED_IDS[0]` 不补发 prompt）

## 2. 实现

- [x] 2.1 `use-chat-session.ts` 创建成功续延里的 `navigate(…)` 加 `{ flushSync: true }`（design D1）；其它 `navigate` 不动
- [x] 2.2 `web/src/main.tsx` 与渲染应用路由的测试 helper / 测试改为从 `react-router/dom` 导入 `RouterProvider`（design D2 列出的文件；以 `grep -rn "RouterProvider" web/src web/test` 为准）。验证：1.1–1.3 转绿；`react-router` 的 `flushSync` warnOnce 不出现

## 3. 证据

- [x] 3.1 `npm test --workspace web` 全绿（含所有经 `RouterProvider` 渲染的用例）
- [x] 3.2 扰动配置（#1541 archive design 的 3ms 片段，scratch，不入库）下 web 全量 0 红
- [x] 3.3 `make check` 0（含 size-guard、knip、jscpd）
- [x] 3.4 `docs/acceptance/functional-checklist.md`：按文件头规则判断本修复是否需增改一行（写 `待签`）；不需要则在 PR 写明理由
