# Proposal: welcome-scene-workspace（#533）

## Why
父 change `s1c-session-metadata-presentation` tasks 7.3（epic #509，design D7「欢迎页场景胶囊」「composer footer」）。服务端 `POST /api/sessions {workspaceId?, scene?}`（4.1）与客户端 `createSession(body?, options?)`（5.1）已就位，但页面创建会话时不带 body：没有任何前端入口能选场景或把会话绑定到工作空间，7.1 的 `空间` 分区只能显示别处建出的绑定会话。本刀在欢迎态加场景胶囊（并按场景换快捷任务清单）与 composer footer 的空间选择，并让两条创建路径（欢迎态首次发送、侧栏 `新建会话`）都带 `{scene, workspaceId?}`——胶囊、清单与 footer 都是创建请求 body 的输入源，缺一个 body 就不完整。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: 欢迎态的布局（三个视口的首屏约束）；每一次会话创建请求的 body（含 CI ui-walk 里所有 `新建会话`）；`useWorkspaceList` 的返回形状（侧栏分区也消费它）；composer 卡片结构（欢迎态多一个 footer）；`page.tsx` 行数预算（680 → ≤690）。
Selected risk packs: Public API / CLI / script entry（创建请求 body 是会话绑定空间的唯一前端入口）；Schema / columns / units / field names（body 恰为 `{scene}` 或 `{scene, workspaceId}`，键缺席而非 null）；Concurrency / shared state / ordering（选中空间与列表重读、账号切换、composer 锁定）；Error handling / rollback / partial outputs（空间列表读取中/失败、创建失败后选择保留）；Legacy compatibility / examples（欢迎态静态内容、首屏约束、会话页 composer 结构、侧栏分区不变）
Evidence floor: 新建 `web/test/chat-page-welcome-scene.test.tsx` 覆盖 design「Required evidence」W1–W14；既有测试除一处「无场景胶囊」断言外零 diff 全绿；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；CI `ui-walk` 两个 project 全绿（`expectWelcomeFirstScreen` 是首屏约束的回归门；所有 `新建会话` 步骤此后带 `{"scene":"office"}` 打真实服务端）。真实浏览器 + 视口矩阵验收由 8.2a 承担；本刀另附一次 1440×900、1024×768 与 390×844 的一次性真实浏览器观察（不入库）。

## What Changes
- 新建 `web/src/features/chat/scene-pills.tsx`：`场景` 组三个按钮。
- 新建 `web/src/features/chat/composer-footer.tsx`：`任务启动于 …` 按钮 + 空间选择 Popover。
- 新建 `web/src/features/chat/welcome-options.ts`：`useWelcomeOptions`（场景与空间选择的页面内存状态、生效空间的解析、创建请求 body）。
- `welcome-content.ts`：加 `WELCOME_SCENES`（三组场景清单，`office` 引用既有 `WELCOME_QUICK_PROMPTS`）。
- `welcome.tsx`：`WelcomeIntro` 在 hero 与快捷任务行之间渲染胶囊，快捷任务行按场景取清单。
- `composer.tsx`：可选 `footer` 节点渲染在卡片内工具栏之后；`conversation-view.tsx`：欢迎态传入胶囊与 footer 的 props。
- `workspace-list.ts`：`useWorkspaceList` 的返回值加 `error`（最近一次读取失败的文案），`workspaces` 与 `refresh` 不变。
- `page.tsx`：`useWelcomeOptions`、`createSession` 的 body、`ConversationView` 的一个 prop（680 → ≤690）。
- `chat.css`：胶囊样式、footer 与弹层内列表样式、`≤760px` 快捷任务行改为单行横向滚动。
- 新建 `web/test/chat-page-welcome-scene.test.tsx`（超过 800 行时另拆 support 模块）；`web/test/chat-page.test.tsx:338-340` 的「无场景胶囊」断言删除。

## Capabilities
- ADDED `session-sidebar`「欢迎页场景胶囊与场景化快捷任务」「composer footer 工作空间选择」。
- MODIFIED `session-sidebar`「分区侧栏」：工作空间读取失败一句（偏差 9）。
- MODIFIED `chat-web`「会话页」：Welcome state 段（胶囊、按场景的清单、`≤760px` 单行滚动、锁定规则含胶囊）、Composer card 段（欢迎态 footer）、Scenario「欢迎态与静态引导」的 THEN。

## Non-goals
- `POST /api/sessions` body 的服务端校验与绑定（4.1）；`createSession` 签名（5.1）；工作空间列表的拉取时机（7.1，仍只随会话列表读取）。
- 会话内切换场景入口、侧栏/会话页场景标签（S1d，不渲染）；权限开关（S3b）；`新建工作空间`、`挂载目录到当前空间`。
- `docs/acceptance/demo-parity-checklist.md` 的 CH-03、CH-13 两行合入后过期，本刀不改 docs，只在 PR 报告。
- ui-walk 场景与空间步骤（8.2a）；`api-sessions.ts`、`session-contract.ts`、`stream.ts`、`web/src/ui/**`、server 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **`≤760px` 快捷任务行改为单行横向滚动**：父文与 issue 都没提。实测（Chromium，master 构建）390×844 欢迎态只剩 56px 空余；加上胶囊（36 + 12）与 footer（卡片内再加一行）后免责声明超出首屏约 17px，违反 chat-web「390×844 下免责声明位于首屏内」（CI `ui-walk` `expectWelcomeFirstScreen` 会红）。日常办公六项在 390 宽下换成三行（112px）；改为单行滚动收回 80px。只压各处间距的方案实测只剩约 7px 余量，CI 的字体差异就能吃掉。`≥761px` 不变。已写进 chat-web 子 delta；父文应同步采纳。
2. **`workspace-list.ts`、`welcome.tsx`、`composer.tsx`、`conversation-view.tsx`、`chat.css` 有改动，新建 `welcome-options.ts`**：issue 的 PR Boundary 列了「欢迎态/composer 接线按需」，没列 `workspace-list.ts` 与第三个新文件。footer 要区分「读取中」与「读取失败（并显示文案）」，而 7.1 的 `useWorkspaceList` 把失败折叠成 `null`、丢掉了错误；本刀给它的返回值加 `error`，`workspaces`/`refresh` 的语义与时机不变。场景与空间状态、生效空间解析与 body 构造放进 `welcome-options.ts`，否则 `page.tsx` 超预算。
3. **一处既有断言改动**：issue 写「既有测试零 diff」。`web/test/chat-page.test.tsx:338-340` 断言三个场景名不在页面上，正是本刀改写的那句规格；删除这三行，其余不动，文件不增行。
4. **选中空间不在当前列表里时按 `未选择` 处理**：父文没说。列表会被重读（创建会话、分叉等之后），选中的空间可能已被删除；读取可能失败；账号可能切换。子 delta 写明：按钮显示 `任务启动于 未选择` 且创建请求不带 `workspaceId`，按钮文本与请求体始终一致；空间重新出现在列表里时选择恢复。
5. **状态的生命周期写明**：父文「离开欢迎态再回来保留，刷新复位」；子 delta 写成「选中会话后再回到欢迎态保留；刷新或离开会话页复位」（状态在 `ChatPage`，路由离开即卸载；同 7.1 筛选状态的先例）。
6. 子 delta 另加父文未写的可观察行为：切换提示为 info Toast；快捷任务图标的可用键集合；查询去首尾空白、每次打开弹层查询为空；打开弹层不另发请求；读取失败以 `role="alert"` 显示；composer 锁定时已打开的弹层关闭；未选空间时 body 不含 `workspaceId` 键。
7. chat-web 的 Composer card 段只并入 footer 一句与「permission part」的改写；父文同段的 Slash candidates、Scenario「顶栏入口」「斜杠命令候选」等归后续刀，不并入。
8. **跨 feature 深导入 `logicalPath`**：`composer-footer.tsx` 从 `../files/file-meta.js` 导入既有 helper。这是 chat 第一处不经 `index.js` 的跨 feature 导入（现有的都走 `../auth/index.js`）；没有 lint 规则禁止，取它是为了逻辑路径的格式只有一处定义。
9. **session-sidebar「分区侧栏」改一句**：主规格「工作空间读取失败只影响归组」在 footer 出现后不再精确，改为「在列表区只影响归组…；欢迎态 composer footer 对读取中与读取失败的呈现见「composer footer 工作空间选择」」。

## Impact
- web：三个新产品文件、`welcome-content.ts`/`welcome.tsx`/`composer.tsx`/`conversation-view.tsx`/`workspace-list.ts`/`page.tsx`/`chat.css` 改动、一个新测试文件、一处既有断言删除。server、shell、`web/src/ui/**`、`web/src/lib/**`、`web/e2e/**` 无改动。
- 运行时：创建会话的 `POST /api/sessions` 此后总带 JSON body（至少 `{"scene":"office"}`）；无新增请求。
- 依赖：#517（4.1）、#523（5.1）、#529（7.0）、#530（7.1）、A #489 已合并。
