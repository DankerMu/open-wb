# Tasks: fix-new-session-handoff

> 通用纪律：不改会话列表的八个文件与外壳文件；拷入层不动；新测试写进新文件或未近 800 行上限的既有文件；既有断言不删除、不削弱。
> 不新增功能清单行（行为对用户不可见，窗口人手极难命中）。

## 1. session-sidebar — 交接未落定时「新建会话」不导航

- [x] 1.1 判定写成一个纯函数（放 `web/src/features/chat/ownership.ts`，与 `ownsCreateSend` 并列）：交接未落定 ⇔ 登记存在、归当前页面所有（client 与会话 id 同一，即 `ownsCreateSend` 的条件）、
  `originSessionId === null`（欢迎态首次发送；既有会话 prompt 在途时点击会中止的现行为不变）、且尚未受理。`use-chat-session.ts` 的 `新建会话` 改用它，不再读 prompt 请求的控制器。
  「已受理」是登记上的一个标记（`types.ts` 的 `PendingCreateSend` 加一个字段），在 `turn-actions.ts` 收到 prompt 受理、发出随后的历史读取之前置位；prompt 被拒绝、创建失败、交接被放弃时登记照旧被清除。
- [x] 1.2 纯函数的状态表单测（新文件）：无登记；创建在途（会话 id 为空）；创建已返回未派发；已派发未受理；已受理；client 不同；会话 id 不同；`originSessionId` 非空——只有「创建已返回未派发」「已派发未受理」为未落定
  （创建在途时页面仍在欢迎态，`新建会话` 走只聚焦分支，不经本判定）。
- [x] 1.3 整页测试（加在 `web/test/chat-page-new-session.test.tsx`，N4 之后）：创建已返回、URL 已带新会话 id、prompt 尚未发出时点击 `新建会话` → URL 不变，随后恰有一次 prompt 请求且其 signal 未被中止，受理后转录含所发文本。
  进入窗口的手段：prompt 由与新 `requestedSessionId` 同一次提交的 passive effect 派发，`act` 内进不去；用真实调度器写法（先例 `web/test/ui-toast-drawer-escape.test.tsx` 的 T1：`IS_REACT_ACT_ENVIRONMENT=false`、原生事件派发、逐宏任务轮询）。
  点击那一刻必须同时满足并断言三个前置条件：地址已含新 id；页面已提交新会话（欢迎态已不在 DOM：hero `WorkBuddy，我帮你` 与 `场景` 组都不存在——否则点击走的是欢迎态的只聚焦分支，到不了判定）；该会话的 prompt 请求数为 0。
  用例结束须恢复 `IS_REACT_ACT_ENVIRONMENT`（同一先例文件的做法）。
  若逐宏任务轮询全程从未同时观察到这三个条件（提交与 effect 之间没有可插入点击的宏任务边界），窗口在 jsdom 下不可达：本条改由 1.2 的状态表加一条接线断言承担——把该纯函数 mock 成恒真 / 恒假，断言在已选中会话时 `新建会话` 导航与否完全跟随它（改回控制器判定时必然判红）；并在 PR 偏离记录里直说「该亚帧窗口没有行为级测试」。
- [x] 1.4 先过一遍可能被这处行为变化翻转的既有用例（在「已受理、读取挂起」时点击 `新建会话` 的：`chat-page-lifecycle.test.tsx`、`chat-todo-panel.test.tsx` 等），按新规格改写并写进偏离记录。整页测试（同文件）：prompt 已受理（202）而随后的历史读取仍挂起时点击 `新建会话` → 回到欢迎态（URL 不含 `session`），点击之后没有新请求；另一条：历史读取失败之后点击，同样回到欢迎态。
- [x] 1.5 变异证据：判定改回依赖控制器是否已建立 → 1.3（或其退路）判红；去掉「尚未受理」条件（登记存在即在途）→ 1.2 与 1.4 的「读取在途」一条判红；去掉 `originSessionId === null` → N5 判红。

Suggested fixture level: compact - 单一状态判定加 1.2–1.4 的测试，无公共契约变化
Minimal mergeable slice: atomic - 判定与其测试同刀
