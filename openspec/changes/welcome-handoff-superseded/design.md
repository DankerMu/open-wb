# Design: welcome-handoff-superseded

## Context（核对于 origin/master d410687b，react-router 8.3.1）

- `use-chat-session.ts:517-573` `createAndSelect`：创建返回后在同一个 promise 续延里先写 `pendingCreateSendRef.sessionId = id` 与 `setMutationOwner`，再 `navigate(sessionNavigation(…, session.id))`。
- `:454-501` 清理 effect、`:503-513` 派发 effect：都只在 `requestedSessionId` 变化时重跑；派发后 `turn-actions.ts:253-257` 把 owner 改写成 `originSessionId: sessionId`。
- `node_modules/react-router/dist/development/lib/components.js:145-149`：`RouterProvider` 收到 router state 时，`reactDomFlushSyncImpl && flushSync` 为真则 `flushSync(() => setState(newState))`，否则 `startTransition`。`reactDomFlushSyncImpl` 只有 `react-router/dom` 导出的 `RouterProvider`（`dom-export.js:12`）才接上；用 `react-router` 的 `RouterProvider` 传 `flushSync` 只 `warnOnce`、照走 transition。`NavigateOptions.flushSync?: boolean`（`router.d.ts:442`）。
- `web/src/main.tsx:2` 从 `react-router` 导入 `RouterProvider`。测试里渲染应用路由的 helper（`render-app-router.tsx`、`chat-page-lifecycle-support.tsx`、`chat-page-shell-support.tsx`、`settings-support.tsx` 及 `routes`/`auth-router`/`auth-session-client`/`topbar-actions` 测试）同样从 `react-router` 导入。
- 后退（POP）：`createBrowserLocation`（`history.js:137-148`）从 `history.state` 读回 key，回到发送前那条记录时 location 与发送前逐字段相同（fixture review r1）。

## 决策

- **D1 同步提交自己的导航**：`createAndSelect` 的成功续延里，`navigate(target, { flushSync: true })`。目标在续延内同步提交；同步 lane 的被动 effect 在 commit 末同步 flush（react-dom `pendingEffectsLanes & 3`），派发 effect 在同一续延里发出 prompt 并改写 owner。之后的任何导航都发生在另一个宏任务里，此时交接已完成，按既有路径处理：
  - 离开到 `/` 或别的会话：清理 effect 看到 `requestedSessionId` 由 `id` 变为别的值；pending 已不属于当前选择 → 中止在途 prompt 请求（`abortMutation`）并复位——与今天「prompt 在途时用户导航走」完全相同。⚠️ 这意味着 prompt 请求若尚未受理就被中止：服务端是否已收到取决于请求是否已发出；用例须断言实际行为（见 Required evidence，prompt 用 deferred 应答时请求**已发出**，中止只影响客户端对应答的处理）。
  - 规格因此只承诺 prompt **请求**恰发出一次；在途时离开对其应答的作废沿用「会话页」既有规则，服务端是否处理一个已发出又被客户端中止的请求不在本 change。
  - 实施时核对：若既有路径在 prompt 已发出、应答未到时离开会回滚或恢复草稿等，以既有行为为准、不新增分支；如发现既有行为与「prompt 不丢」冲突，停下报告。
- **D2 Provider**：`main.tsx` 改为 `import { RouterProvider } from "react-router/dom"`；上面 Context 列出的测试 helper / 测试同样改（与生产一致，`flushSync` 在测试里才生效）。`files-fixture.tsx` 等不经 `RouterProvider` 的渲染不动。除带 `flushSync` 的导航外行为不变（同一组件，只多传了 `flushSync` 实现）。
- **D3 不新增 effect、不改判定**：清理、派发 effect 与 `ownership.ts` 不动。

## Change surface / 约束

- Change surface：`web/src/features/chat/use-chat-session.ts`（一处 `navigate` 选项与一条说明其依赖「路由无 loader/lazy/middleware」的注释）、`web/src/main.tsx`、`biome.json`（`noRestrictedImports` 禁止从 `react-router` 导入 `RouterProvider`，守卫 D2 不被悄悄回退；放在顶层而非 override，因 `ui-layering-exemptions` 守卫只允许一个 override）、上列测试 helper / 测试的导入、新测试文件（建议 `web/test/chat-page-welcome-handoff.test.tsx`，复用 `chat-page-welcome-scene-support.tsx` 的 `CREATED_IDS` / `welcomeRoutes`）。
- Must preserve：
  - 创建在途（`sessionId === null`）时欢迎态的「停止」（禁用）与锁定不变。
  - 正常首次发送恰一次创建、恰一次 prompt；#872「新建会话」在交接未完成时不导航；选中别的会话时既有作废路径。
  - 「首次发送被拒 → 读一次历史」（`:576-600` 与 `turn-actions.ts:229-237`）在现已同步的提交之后照常执行。
  - `react-router/dom` 的 `RouterProvider` 与原组件除 `flushSync` 外行为一致：不带 `flushSync` 的导航仍走 transition（#1541 的 `chat-permission-tier` 等用例不改即绿）。
  - `use-chat-session.ts` ≤800 行（现 792）。
- Governing invariant：欢迎态首次发送一旦创建成功、且此刻没有待上传的附件，prompt 请求恰一次发给该会话，与之后的导航无关；欢迎态在任何后续导航之后都可再发送。有待上传附件时，派发要等上传完成（`turn-actions.ts:331-358`），上传期间离开按既有规则作废（0 次 prompt、空会话留存、欢迎态可再发送）；附件标签在创建在途时被移除且正文为空时同样不发（`turn-actions.ts:288-291`）。
- Sibling surfaces：清理 / 派发 effect（不改，靠同步提交保证它们按序执行）；`ownership.ts:92`；`sendPrompt` 已选会话分支（不经 `createAndSelect`，不受影响）；其它 `navigate` 调用（`:367`、`:396` 不加 `flushSync`）；所有经 `RouterProvider` 渲染的测试（provider 换导入）。
- Seams under test：整页渲染（router + 页面），观察 URL、输入框按钮、请求序列。
- Required evidence：
  - 新用例 A（replace）：欢迎态发送 `你好`，`POST /api/sessions` 用 deferred、prompt 路由用 deferred；在同一个 `act()` 里放行创建，再 `router.navigate("/", { replace: true })`；act 结束后：URL 为 `/`；向 `CREATED_IDS[0]` 恰发出一次 prompt（body 为 `你好`）；输入框有可用的「发送」、没有「停止」；再输入并发送 `再来`：创建出 `CREATED_IDS[1]`，向它恰一次 prompt；全程向 `CREATED_IDS[0]` 只有那一次 prompt。
  - 新用例 B（POP）：同 A，但离开方式是后退：放行创建后 `router.navigate(-1)`（浏览器 history；jsdom 的 popstate 异步派发，须在同一个 `act()` 内 await 到 URL 回到 `/`）；断言与 A 相同。
  - 新用例 C：A 之后从侧栏选中 `CREATED_IDS[0]`：不再发 prompt（全程仍恰一次）。
  - 改前：A、B 在未改动代码上红（停在「停止」、prompt 0 次）；改后绿。
  - 既有：chat-*、routes、auth-router、auth-session-client、settings、topbar-actions 用例不改即绿；扰动配置（#1541 archive design 的 3ms 片段，scratch，不入库）下 web 全量 0 红；`make check` 0。
- Non-goals：有待上传附件时的交接（派发等上传，上传期间离开按既有规则作废、留空会话——行为不变，本 change 不改也不另测）；交接在途时拦截 URL 导航（#872）；`新建会话` 行为；其它 `navigate` 的提交方式。
- Review focus：`flushSync` 在 promise 续延里调用的安全性（不在 render 内）与同步 lane 被动 effect 的同步 flush 是否真成立（由用例 A/B 证）；provider 切换是否等价；离开时对在途 prompt 的处理与既有路径一致；800 行上限。
