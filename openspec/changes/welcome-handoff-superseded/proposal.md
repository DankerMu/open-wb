# Proposal: welcome-handoff-superseded

## Why

#1543：欢迎态首次发送时，`createAndSelect` 置 `creating`/`submitting` 与 `mutationOwner {originSessionId: null, sessionId: <新 id>}`，创建返回后 `navigate` 到 `?session=<id>`。react-router 把这次 location 更新放进 `startTransition`；若它提交之前又发生一次导航（浏览器后退、地址栏、`router.navigate`），两次更新合并成一次提交，hook 看到的 `requestedSessionId` 是 `null → null`。唯一能收尾的两个 effect（`use-chat-session.ts:454` 清理、`:503` 派发）都只依赖 `requestedSessionId`，都不执行：欢迎态认领这个 owner（`ownership.ts:92` 的 `null === null`），输入框一直是禁用的「停止」，`sendPrompt` 被 `creating || submitting` 拦住，不会自愈；`pendingCreateSendRef` 还留着那条 prompt，之后从侧栏打开该会话时 `:503` 会把它补发出去。

后退（POP）恢复的是发送前那一条历史记录的 `key`，合并提交后的 location 与发送前逐字段相同——任何「观察到这次提交」的检测都看不到它（fixture review 第一轮）。所以本 change 不检测，而是消除窗口。

## What Changes

- **自己的那次导航同步提交**：创建返回后的 `navigate(<?session=id>)` 带 `flushSync: true`。目标 location 在创建续延里同步提交，同步 lane 的被动 effect 在 commit 末同步执行，派发 effect 随即发出 prompt、把 owner 改写为该会话；之后任何导航（后退、replace、地址栏）都是另一个宏任务，落进既有的「回合在途时离开」路径（清理 effect 按 `requestedSessionId` 变化收尾，欢迎态不再认领 owner，输入框可发送）。不新增状态机分支。
- **Provider 换成 `react-router/dom`**：`web/src/main.tsx` 的 `RouterProvider` 改从 `react-router/dom` 导入（它与 `react-router` 的同名组件只差接上了 `ReactDOM.flushSync`；不传 `flushSync` 的导航行为不变）。渲染应用路由的测试 helper 同样改导入，否则 `flushSync` 在测试里是静默的空操作（router 只 `warnOnce`）。
- **语义（issue 允许「按实现者定的语义」）**：prompt **请求**会发给新会话（恰一次，绝不为零）；该会话照常出现在侧栏；用户随后离开不再卡住、不补发。离开时在途的 prompt 请求按「会话页」既有规则被客户端中止，服务端是否已处理取决于请求是否已到达——极快的后退仍可能留下空会话（与「prompt 在途时导航走」相同）；此保证限于此刻没有待上传附件的发送——有待上传附件时派发要等上传，上传期间离开按既有规则作废（0 次 prompt、空会话留存），行为不变、属非目标。这与 chat-web「会话页」的「the create-send operation's own URL handoff SHALL NOT lose its prompt」一致，而检测-作废方案会与之冲突。#235 当时「不切 provider」是针对那个对账缺陷的范围限定，不是对 provider 的长期约束。
- 新增确定性用例：同一个 `act()` 里创建落定后立即 `replace("/")`；以及创建落定后立即后退（POP）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `chat-web`：ADDED「欢迎态交接不被后续导航打断」——不复制超长的「会话页」整条；新增一条，细化其「create-send operation's own URL handoff SHALL NOT lose its prompt」在后续导航紧随其后时的行为，不改其文字。

## Impact

- 改动面：`web/src/features/chat/use-chat-session.ts`（一处 `navigate` 加选项）、`web/src/main.tsx`（一行导入）、渲染应用路由的测试 helper 的导入、一个新测试文件。不碰 server、`ownership.ts`、`新建会话`、创建在途时的「停止」。
- 代价：每次新建会话有一次同步渲染整页会话视图（原本在 transition 里）。
- 残余：交接在途时是否拦截 URL 导航仍是 #872 的策略问题，不在本 change。

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (issue: S–M, implementation-ready)
Blast radius: 欢迎态首次发送（每个新会话的入口）与全应用的 RouterProvider 入口；provider 切换若不等价会影响所有路由渲染
Selected risk packs: Concurrency / shared state / ordering; Config / project setup; Error handling / rollback / partial outputs; Legacy compatibility / examples
Evidence floor: 两个新用例改前红、改后绿；chat-*、routes、auth-router、settings、topbar 等用 RouterProvider 的用例全绿；扰动配置（#1541，Scheduler +3ms）下 web 全量 0 红；make check 绿
```
