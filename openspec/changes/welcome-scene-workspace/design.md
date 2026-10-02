# Design: welcome-scene-workspace（#533）

## 基线（master 8e668a9）
- `welcome.tsx`（75 行）：`WelcomeIntro` = hero `h1.chat-hero` + `fieldset[aria-label=快捷任务].chat-quick-row`（读 `WELCOME_QUICK_PROMPTS`）；`WelcomePlaybooks` 在 composer 之后。两者的 `disabled` 即 composer 锁。`welcome-content.ts`（71 行）：`WELCOME_QUICK_PROMPTS`（六项，`web/test/chat-page.test.tsx:413` 断言其内容）。
- `composer.tsx`（124 行）：`.chat-composer-card` = label + textarea + `.chat-composer-toolbar`；`web/test/chat-composer.test.tsx:84-92` 断言表单内恰一个按钮、`card.lastElementChild === toolbar`——那个用例挂在 `/?session=`，欢迎态的 footer 不影响它。
- `conversation-view.tsx:203-233`：无 `requestedSessionId` 时渲染 `WelcomeIntro`、`Composer`、`WelcomePlaybooks`。
- `page.tsx` **680 行**（本刀上限 690）。`useWorkspaceList(client)` 在 `:71`；两条创建路径共用 `createAndSelect`（`:445`），其 `createSession(undefined, { signal })` 在 `:481`，成功后 `refreshList(client)`（`:509`）；侧栏 `新建会话` 在 `:645` 调 `createAndSelect()`。
- `workspace-list.ts`（61 行）：返回 `{ refresh, workspaces }`；`workspaces` 为当前 client 最近一次成功读取的结果，首次读取完成前与最近一次读取失败后为 null（失败的错误被丢弃，`:55`）；同一 client 重读期间沿用上一次结果。
- `createSession(body?, options?)`（`web/src/lib/api-sessions.ts:43-49`）：`body` 为 undefined 或空对象时不带 body，否则 `Content-Type: application/json` + `JSON.stringify(body)`。服务端（`server/src/sessions/rest-metadata.ts:43`、`:131-145`）接受键 ⊆ `{workspaceId, scene}` 的对象，`{"scene":"office"}` 单独合法。
- `Popover`（`web/src/ui/popover.tsx`）：受控 `open`/`onOpenChange`、`contentLabel`；非模态，程序化关闭后焦点回 trigger，外点关闭不回。先例：`web/src/features/files/page.tsx:66-150`（搜索框 + `aria-pressed` 列表 + `logicalPath(account, dir)`，`web/src/features/files/file-meta.ts:52`）。`Button` 缺省 `type="button"`（`web/src/ui/button.tsx:34`），`sm` 高 26px。图标 `file-text`、`code`、`palette`、`file-code`、`layout-grid`、`image`、`folder`、`chevron-down` 均已注册。
- 首屏约束（chat-web「Welcome state」）：1440×900、1024×768、390×844 下免责声明在首屏内；回归门是 CI `ui-walk` 的 `expectWelcomeFirstScreen`（`web/e2e/ui-walk-layout.ts:112-160`）。实测 master：三个视口的空余分别为 413 / 241 / 56px；390 下快捷任务行换成三行共 112px。

## Governing invariant
创建请求的 body 与欢迎态当下显示的选择一致：`scene` 恒为选中胶囊的值；`workspaceId` 存在当且仅当 footer 按钮显示着某个空间名，且就是那个空间的 id。两条创建路径（欢迎态首次发送、侧栏 `新建会话`）发出相同的 body；在会话页（footer 与胶囊不渲染）点侧栏 `新建会话` 时发出的是「此刻回到欢迎态会显示的那个选择」——同一份保留状态、同一条按当前列表的解析。选择只是会话页的内存状态：不写 storage、不进 URL、不触发任何请求。

## Sibling surfaces
- `createAndSelect`（`page.tsx:445-552`）：两条创建路径唯一的 `createSession` 调用点；本刀只改它的第一个实参。创建失败的既有处理（恢复草稿、`promptError`）不动；失败后选择保留。
- `useWorkspaceList` 的另一个消费者：`SessionSidebar` 的分区（`session-groups.ts` `groupSessions(sessions, workspaces | null)`）。`workspaces` 的取值规则不变；`error` 是新增的并列字段。
- `refreshList`（`page.tsx:143-181`）每次都重读工作空间列表：选中的空间可能在重读后消失、重读可能失败——生效空间按「当前列表里找得到」解析（D2）。
- `WelcomeIntro`/`WelcomePlaybooks`/`Composer` 的 `disabled`（composer 锁）：胶囊与 footer 按钮跟随同一个值。
- `chat-quick-row` 在 `≥761px` 的换行表现、`WELCOME_QUICK_PROMPTS` 的内容与 `PLAYBOOKS` 不变。
- 会话页（有 `?session=`）：不渲染胶囊与 footer；composer 卡片结构与 `chat-composer.test.tsx`、`chat-stop-button.test.tsx`、`chat-regenerate-button.test.tsx`、`chat-fork-button.test.tsx` 读取的 `.chat-composer-toolbar` 不变。
- CI `ui-walk`：`createSessionFromSidebar`（`ui-walk-layout.ts:299-305`）此后发 `{"scene":"office"}`；8.2a 将走「选场景 → 选空间 → 发送」。
- `docs/acceptance/demo-parity-checklist.md` 的 CH-03、CH-13 两行（「不渲染场景胶囊」「不渲染任务启动于」）合入后过期；本刀不改 docs（Non-goals），在 PR 里报告。
- `features/files` 的空间切换器：同一份 `logicalPath`；它按「名称或路径」过滤，本刀按父规格只按名称过滤（两处规格不同，不统一）。

## 决定

### D1 状态归 `ChatPage`，经 `useWelcomeOptions` 收拢
胶囊与 footer 都挂在欢迎态子树里，选中会话即卸载；状态必须活在 `ChatPage`。新文件 `welcome-options.ts`：
```ts
useWelcomeOptions(workspaces: readonly Workspace[] | null, workspacesError: string | null)
  → { scene, selectScene(scene), workspace, selectWorkspace(id | null), workspaces, workspacesError, createBody() }
```
- `scene`：`ChatSessionScene`，初值 `"office"`。
- 选中空间只存 id；`workspace` = 当前 `workspaces` 里 id 相同的那一项，找不到（含 `workspaces` 为 null）即 null。
- `createBody()`：`workspace ? { scene, workspaceId: workspace.id } : { scene }`——键缺席，不写 null/undefined。
- 返回对象整体作为一个 prop（`welcome`）交给 `ConversationView`，由它分给 `WelcomeIntro`（`scene`、`selectScene`）与 `ComposerFooter`（其余）。

`page.tsx` 行计划（680 → ≤690）：`welcome-options` 的 import（+1）；`:71` 的解构加 `error: workspacesError`（超过 100 列，折成多行，约 +4）；`const welcome = useWelcomeOptions(...)`（+1）；`:481` 改为 `.createSession(welcome.createBody(), …)`（+0）；`createAndSelect` 的依赖数组加一项（+1）；`<ConversationView welcome={welcome} …>`（+1）。`createBody` 须在所选状态不变时引用稳定（`useCallback`），否则 `createAndSelect` 每次渲染重建。

### D2 生效空间按当前列表解析
选中空间的 id 与列表分开存；每次渲染用当前 client 的 `workspaces` 解析。列表被重读后该空间已不存在、读取失败（`workspaces` 为 null）或换了账号（新 client 的列表里没有这个 id）时，`workspace` 为 null：按钮显示 `任务启动于 未选择`，`createBody()` 不带 `workspaceId`。空间重新出现在列表里时选择自动恢复。不为此加提示，也不清空已存的 id。

### D3 `workspace-list.ts`：返回值加 `error`
状态加 `error: string | null`：读取失败（非 401）时置为 `errorMessage(error)`、`workspaces` 置 null（既有）；成功时清空；同一 client 开始重读时若还没有成功结果则清空（回到「读取中」），已有成功结果则沿用（既有）；换 client 清空。返回 `{ refresh, workspaces, error }`，`error` 同样只对当前 client 可见。footer 的三态：`workspaces !== null` → 列表；`workspaces === null && error === null` → `正在读取工作空间`；`error !== null` → 失败文案。既有的 abort、generation、client 归属检查不变。

### D4 `scene-pills.tsx` 与 `welcome-content.ts`
- `welcome-content.ts` 加
  ```ts
  export const WELCOME_SCENES = [
    { value: "office", label: "日常办公", icon: "file-text", prompts: WELCOME_QUICK_PROMPTS },
    { value: "code", label: "代码开发", icon: "code", prompts: [...] },
    { value: "design", label: "创意设计", icon: "palette", prompts: [...] },
  ] as const
  ```
  `代码开发`：`日常开发`（`code`，`帮我实现一个带校验的登录组件`）、`网站开发`（`layout-grid`，`帮我搭建一个内部系统首页`）、`Agent 应用`（`file-code`，`帮我设计一个 Agent 应用的交互流程`）、`Skill 开发`（`file-code`，`帮我写一个数据处理 Skill`）、`CI/CD`（`code`，`帮我生成一条 CI 流水线配置`）。`创意设计`：`网站设计`（`palette`，`帮我设计一个内部系统首页`）、`PPT 设计`（`file-text`，`帮我美化这份 PPT 的配色与排版`）、`视觉海报`（`image`，`帮我设计一张科技感的产品发布海报`）、`移动端 App`（`image`，`帮我设计一个移动端打卡界面`）、`设计系统`（`palette`，`帮我整理一套设计系统规范`）。`WELCOME_QUICK_PROMPTS` 保持导出且内容不变。
- `ScenePills({ scene, disabled, onSelect })`：`<fieldset aria-label="场景" className="chat-scene-pills">`（`fieldset` 即 `role="group"`，同快捷任务行；Biome 不接受 `div[role=group]`）内三个 `<button type="button" aria-pressed>`，图标 16px 装饰性。点击未选中的场景 → `onSelect(value)` 并 `toast.show({ type: "info", message: "已切换到「<label>」场景" })`；点击已选中的不做任何事。`disabled` 时三个按钮禁用。
- `WelcomeIntro` 多收 `scene`、`onSelectScene`：hero → `ScenePills` → 快捷任务行（取该场景的 `prompts`）。文件头注释里「scene pills 不渲染」的说法随之更新（`welcome.tsx:1`、`welcome-content.ts:1`）。

### D5 `composer-footer.tsx` 与 `composer.tsx`
- `Composer` 加可选 prop `footer?: ReactNode`，渲染为 `.chat-composer-card` 内工具栏之后的最后一个子元素；`ConversationView` 只在欢迎态传入 `<ComposerFooter …/>`。会话页不传，卡片 DOM 与现状逐一相同。
- `ComposerFooter({ disabled, workspace, workspaces, workspacesError, onSelect })`：`<div className="chat-workspace-picker">`（类名不得以 `.chat-composer-foot` 开头——`web/test/chat-composer.test.tsx:237` 断言 `chat.css` 不含该子串）内一个 `Popover`（`contentLabel="选择工作空间"`，受控 `open`；`disabled` 变为 true 时把 `open` 置 false——关闭而不是隐藏，解锁后不自动重开）；trigger 为 ghost `Button size="sm"`（`type="button"`，在 composer 的 `<form>` 内不得提交表单），内容 `Icon folder` + 文本 `任务启动于 <空间名|未选择>`（两段之间是字面空格，accessible name 恰为 `任务启动于 未选择` 这样的文本）+ `Icon chevron-down`（图标装饰性）。account 取 `useAuth().principal`（经 `../auth/index.js`）；`principal` 为 null 时（会话页挂载期间不会出现）不渲染副文本。
- 弹层内容（只在打开时挂载，查询是它的局部 state，故每次打开为空）：`Input`（缺省变体，角色 `textbox`——`variant="search"` 会变成 `searchbox`；`aria-label` 与 `placeholder` 均为 `搜索工作空间`）；列表首项 `未选择`（`aria-pressed` = 当前无生效空间）；`workspaces` 中名称包含查询（`trim()` 后 `toLocaleLowerCase()` 子串）的各项，按返回顺序，每项一个 `<button type="button" aria-pressed>`，内含名称与副文本 `logicalPath(account, dir)`（复用 `../files/file-meta.js` 的既有 helper，不另写格式；DTO 里的绝对路径 `root` 不渲染）；有列表但无匹配 → `<p>没有匹配的工作空间</p>`；`workspaces === null && error === null` → `<p>正在读取工作空间</p>`；`error !== null` → `<p role="alert">` 显示它（D3：失败后重读在途时 `error` 已清空，显示的是「正在读取」）。弹层内容经 portal 渲染在 `<form>` 之外，搜索框里的 Enter 不会提交 composer。
- 点任一项：`onSelect(id | null)` 并把受控 `open` 置 false（程序化关闭，Radix 把焦点还给 trigger）。不渲染权限元素、`新建工作空间`、`挂载目录到当前空间`。

### D6 样式（`chat.css`，现 625 行；超过 800 时新样式落 `chat-welcome.css`）
- `.chat-scene-pills`：胶囊容器（demo:345-351：`inline-flex`、2px 内边距、圆角 100px、高 36px），按钮高 32px、选中态深色底白字；容器与快捷任务行间距 12px（demo 的 `margin-bottom: 64px` 不采用——首屏约束）。只用既有 token；禁用态沿用 `.chat-quick-chip:disabled` 的写法。
- `.chat-workspace-picker`：卡片内一行，左对齐；弹层内搜索框、列表项（名称 + 副文本两行、`aria-pressed="true"` 的选中底色）、空/读取中/失败文案；列表 `max-height` + `overflow-y: auto`。
- `@media (max-width: 760px)`：`.chat-quick-row { flex-wrap: nowrap; justify-content: flex-start; max-width: 100%; overflow-x: auto; scrollbar-width: none; }`、`.chat-quick-chip { flex: none; }`。`overflow-x: auto` 会连带让块向也裁剪，chip 的全局焦点环（`web/src/styles.css:84-88`，2px + offset 2px）会被切掉：给该行加块向与行内各 4px 的 padding 并以等量负 margin 抵消（`max-width: 100%` 必须保留，`min-width: 0` 既有）。原型实测（模拟胶囊 36+12、footer 24）：390×844 免责声明距首屏底 37px，页面无横向滚动；真实组件的余量由一次性观察复测。`≥761px` 不受影响。
- 非 reduce 媒体块内不写 `transition`（`web/test/ui-reduced-motion.test.ts`）；`chat.css` 不得出现 `outline: none`（`chat-composer.test.tsx:238`）；`conversation-view.tsx` 连注释都不得出现 `新建会话`、`会话列表`（`chat-composer.test.tsx:207-209`）。

## Must-preserve
1. `WELCOME_QUICK_PROMPTS` 的导出与内容、`PLAYBOOKS`、`playbookWindow`、`换一批`、免责声明、hero 文案与 heading 级别（`web/test/chat-page.test.tsx` 除 `:338-340` 外零 diff 全绿）。
2. 会话页（有 `?session=`）的 composer：表单内按钮数、`card.lastElementChild === toolbar`、工具栏内容（`chat-composer.test.tsx`、stop/regenerate/fork 按钮的套件）。
3. `useWorkspaceList` 的 `workspaces`/`refresh` 语义与请求时机：`/api/workspaces` 只随会话列表读取而读取，打开弹层、切换场景、选择空间都不发请求（`chat-page-sidebar.test.tsx` 全绿）。
4. `createAndSelect` 的互斥、fence、失败恢复与导航；`refreshList` 的调用点。
5. `≥761px` 的欢迎态布局：五张卡同行、三个视口的首屏约束（CI `ui-walk`）。
6. `web/src/ui/**`、`web/src/lib/**`、`web/e2e/**`、`stream.ts`、`turn-actions.ts`、`session-*.ts(x)`、server 零 diff。

## Required evidence
新建 `web/test/chat-page-welcome-scene.test.tsx`（首行引入 `./radix-platform.js`；页面 fixture `renderChatPage` + `createFetchMock`，`authenticatedPrincipal.account` 为 `zhangsan`；`/api/workspaces` 路由按用例给出；超过 800 行时拆 `chat-page-welcome-scene-support.tsx`）。创建请求按路径 `/api/sessions` 且 `method === "POST"` 取出，断言 `body` 文本与 `Content-Type`。全部 RED，除注明者。
- W1 胶囊渲染：欢迎态有 `role="group"` name `场景`，位于 hero 之后、`快捷任务` 组之前；其内恰三个按钮，次序 `日常办公`、`代码开发`、`创意设计`，图标类依次含 `lucide-file-text`、`lucide-code`、`lucide-palette`，`aria-pressed` 依次为 `true`、`false`、`false`；快捷任务行为日常办公六项。
- W2 切换（Scenario「场景切换替换快捷任务」）：点 `代码开发` → `aria-pressed` 为 `false`/`true`/`false`；快捷任务行按钮文本恰为 `日常开发`、`网站开发`、`Agent 应用`、`Skill 开发`、`CI/CD`；Toast 恰为 `已切换到「代码开发」场景` 且类型为 info（`ui-toast--info`）；点 `网站开发` → 输入框值 `帮我搭建一个内部系统首页`、没有 `POST`；再点 `代码开发` → `aria-pressed` 与快捷任务行不变、Toast 仍只有一条。另一例 `创意设计`：五项文本 `网站设计`、`PPT 设计`、`视觉海报`、`移动端 App`、`设计系统`，Toast `已切换到「创意设计」场景`。
- W3 静态清单：`WELCOME_SCENES` 的 `value`/`label`/`icon` 恰为 D4 的三组；`office` 的 `prompts` 与 `WELCOME_QUICK_PROMPTS` 是同一引用；`code`、`design` 各五项的 `label`/`icon`/`prompt` 恰为 D4 列出的值。
- W4 场景随创建请求发送（Scenario）：选 `创意设计` → 输入并发送 → 恰一个 `POST /api/sessions`，`body` 文本恰为 `{"scene":"design"}`、`Content-Type: application/json`。另一例默认场景下点侧栏 `新建会话` → `body` 恰为 `{"scene":"office"}`、同样的 `Content-Type`。
- W5 选择空间后创建绑定会话（Scenario）：工作空间 `项目A`（dir `项目A`）与 `客服`（dir `kefu`）。footer 按钮名为 `任务启动于 未选择`，在 `.chat-composer-card` 内且位于 `.chat-composer-toolbar` 之后（卡片最后一个子元素包含它）；点击 → `dialog` name `选择工作空间`，其内 `textbox` name `搜索工作空间`（`placeholder` 相同、值为空）、按钮依次 `未选择`（`aria-pressed="true"`）、`项目A`（含文本 `zhangsan/项目A`）、`客服`（含 `zhangsan/kefu`），后两者 `aria-pressed="false"`；打开弹层前后 `/api/workspaces` 请求数不变。输入 `项目` → 只剩 `未选择` 与 `项目A`。选 `项目A` → 弹层消失、按钮名 `任务启动于 项目A`、焦点在该按钮。再打开 → 查询为空、`项目A` 的 `aria-pressed="true"`、`未选择` 为 `false`。输入并发送 → `POST` body 恰为 `{"scene":"office","workspaceId":"<项目A id>"}`；夹具里两个空间的 `root` 为可辨识的绝对路径（如 `/srv/ws-root-a`），弹层打开时与全程页面文本都不含它。创建后的列表读取返回该会话（`workspaceId` 为项目A）→ 侧栏出现 `空间 (1)` 组及其 `项目A` 子组、内含该会话；会话被选中后页面上没有 `任务启动于` 按钮与 `场景` 组。
- W6 无权限元素与无匹配（Scenario）：`.chat-workspace-picker` 内恰一个按钮；页面上没有文本 `权限`、`完全访问`、`默认权限`；弹层内搜索 `不存在` → 按钮只剩 `未选择`、显示 `没有匹配的工作空间`；没有 `新建工作空间`、`挂载目录到当前空间`。大小写：空间 `Alpha` 被查询 `alp` 与 `  ALPHA ` 命中。
- W7 读取中与失败：`/api/workspaces` 挂起 → 弹层显示 `正在读取工作空间` 与 `未选择`（可选，选择后弹层关闭、按钮仍为 `任务启动于 未选择`）；503 信封 `服务暂不可用` → 弹层内 `role="alert"` 文本恰为该 message，`未选择` 仍在；非信封失败 → `请求失败，请稍后重试`；失败后的重读在途时弹层显示 `正在读取工作空间`、无 alert；重读成功后弹层显示列表、无 alert。欢迎态下触发列表重读的方式：侧栏 `新建会话` 成功（`page.tsx:509` 的 `refreshList`）后用 `renderChatPage` 返回的 `router.navigate("/")` 回到欢迎态。
- W8 改回未选择：选 `项目A` 后再打开并选 `未选择` → 按钮名 `任务启动于 未选择`；发送 → body 恰为 `{"scene":"office"}`（无 `workspaceId` 键）。
- W9 两条路径一致：选 `代码开发` 与 `项目A` 后点侧栏 `新建会话` → body 恰为 `{"scene":"code","workspaceId":"<项目A id>"}`。
- W10 锁定：欢迎态发送后创建请求挂起期间，三个胶囊与 footer 按钮均 `disabled`。另一例弹层打开时提交表单（`fireEvent.submit(form)`），创建请求挂起 → 弹层消失；随后请求以 400 信封结束（同 W14）→ 解锁后 footer 按钮可用，`dialog` name `选择工作空间` 仍不存在（关闭而非隐藏，不自动重开）。
- W11 会话页：`/?session=<id>` 下没有 `场景` 组与 `任务启动于` 按钮；（保持项）`.chat-composer-card` 的最后一个子元素是 `.chat-composer-toolbar`。
- W12 状态保留与复位：选 `代码开发` 与 `项目A` → 从侧栏选中一个既有会话（胶囊与 footer 消失）→ `router.navigate("/")`（`renderChatPage` 的返回值，`web/test/chat-page-support.tsx:25-34`）回到欢迎态 → `代码开发` 仍为选中、按钮仍为 `任务启动于 项目A`、快捷任务行为代码开发五项。另一例离开会话页（`/center`）再回到 `/` → `日常办公` 选中、`任务启动于 未选择`。
- W13 生效空间按当前列表解析：选 `项目A` → 触发一次列表重读（侧栏 `新建会话`，其后的 `/api/workspaces` 读取不再含 `项目A`）→ 回到 `/` → 按钮名 `任务启动于 未选择`；发送 → body 不含 `workspaceId`。另一例重读失败（503）→ 同样为 `未选择`、body 不含 `workspaceId`；再一次成功读取含 `项目A` → 按钮恢复 `任务启动于 项目A`。（重读均以「侧栏 `新建会话` 成功 → `router.navigate("/")`」触发。）账号切换（`renderChatPageWithAuthProbe` + `renewAccount`，先例 `web/test/chat-page-sidebar.test.tsx:568-599`）：选 `项目A` 后续期为另一账号且其 `/api/workspaces` 挂起 → 按钮立即为 `任务启动于 未选择`、页面不含 `项目A`、弹层显示 `正在读取工作空间`（不显示上一账号的列表）；列表到达（不含该 id）后发送 → body 无 `workspaceId` 键。
- W14 创建失败后选择保留：选 `创意设计` 与 `项目A`，发送，`POST /api/sessions` 返回 400 信封 → 既有的错误提示与草稿恢复；`创意设计` 仍选中、按钮仍为 `任务启动于 项目A`；再次发送的 body 与第一次相同。

静态样式断言（同 7.2a M1 读 `chat.css` 的写法）：`(max-width: 760px)` 媒体块内 `.chat-quick-row` 含 `flex-wrap: nowrap` 与 `overflow-x: auto`；该规则不出现在媒体块之外。

既有断言更新（非 RED 新增）：`web/test/chat-page.test.tsx:338-340` 三行删除。实现时若发现其它既有用例变红，先报告再改（不在闭合清单内的不改）。

评审后补充（fix pass 1，只加测试；各以一次产品代码变异确认会红，记录在 PR）：
- X1 会话页创建：选 `代码开发` 与 `项目A` → 从侧栏选中既有会话 → 点侧栏 `新建会话` → body 恰为 `{"scene":"code","workspaceId":"<项目A id>"}`；变体：其后的 `/api/workspaces` 重读失败 → 在会话页再点 `新建会话` → body 恰为 `{"scene":"code"}`。
- X2 W13 账号例去掉发送前的「改选 `未选择`」：新账号列表到达（不含该 id）后直接发送 → body 无 `workspaceId`。
- X3 搜索框回车：有草稿时打开弹层，在 `搜索工作空间` 上按 Enter → 没有 `POST`、弹层仍在、草稿不变；弹层节点不在 composer 的 `<form>` 内。
- X4 三态互斥：读取在途与读取失败时都不出现 `没有匹配的工作空间`；读取在途时没有 `role="alert"`。
- X5 上一账号的读取失败不带到新账号：上一账号 `/api/workspaces` 失败（弹层为 alert）→ 续期且新账号读取挂起 → 弹层为 `正在读取工作空间`、无 alert。
- X6 场景不改变 prompt：选 `创意设计` 后发送 `你好` → `POST /api/sessions/<id>/prompt` 的 body 恰为 `{"message":"你好"}`。
- X7 选择不发请求：切换场景前后 `fetch` 的调用总数不变。
- X8 静态样式补全：`(max-width: 760px)` 块内 `.chat-quick-row` 含 `max-width: 100%`，`.chat-quick-chip` 含 `flex: none`。
- X9 footer 按钮：`type="button"`、图标类含 `lucide-folder`；W5 的「不含 `root`」改读 `innerHTML`；W11 两例先断言 `.chat-composer-card` 存在。
fix pass 1 记录：X5 按原文的终态断言杀不死「`error` 去掉 client 归属门」的变异（换 client 的 effect 在同一个 `act` 内就重读并清掉 error），另加逐次提交断言——侧栏已显示新账号的每一次提交都不含上一账号的失败文案；为此 `web/test/chat-page-lifecycle-support.tsx` 的 `renderChatPageWithAuthProbe` 加可选第三参 `onCommit`（既有 support 文件 +5 行，纯增量）。测试文件 559 → 683 行（29 例），support 243 → 279。

实现记录：
- 测试落 `web/test/chat-page-welcome-scene.test.tsx`（24 例）与 `web/test/chat-page-welcome-scene-support.tsx`。W6 另加纯路径查询（`misc`、`kefu`、`zhangsan` 不命中）——W5 的 `项目` 同时命中名称与路径，区分不了「也按路径过滤」；W11 拆成「欢迎态 → 选中会话」（RED）与深链保持项（实现前后皆绿）。
- `WELCOME_SCENES` 的类型为 `readonly WelcomeScene[]`（不是 D4 草图的 `as const`），值与 `office.prompts === WELCOME_QUICK_PROMPTS` 不变；场景值类型取 `WelcomeScene["value"]`。
- 胶囊 hover 底色用 `--wb-bg-primary` 而非 demo 的 `--wb-bg-pill-hover`（后者是浅色字面量，深色主题下浅底浅字）。
- 未覆盖：`createBody` 把 `workspaceId` 写成 `undefined` 的变体在页面 seam 上不可观察（`JSON.stringify` 丢弃该键，请求体逐字节相同）。
- `page.tsx` 680 → 688；`chat.css` 625 → 797（上限 800，下一刀的欢迎态样式须落新文件）。

实现前后各跑一次并记录：RED 集合 = W1–W14（W11 的保持项除外）；既有套件实现前后皆绿。

一次性真实浏览器观察（不入库，写进 PR）：1440×900、1024×768、390×844 各一次——免责声明底边到首屏底的余量（真实组件，三个视口）、页面无横向滚动、五张卡同行（前两个视口）；390 下快捷任务行单行且可横向滚动到最后一项、键盘聚焦 chip 时焦点环完整（未被行容器裁掉）；胶囊切换后的样式；footer 弹层在视口内、可点中（`elementFromPoint`）、长空间名不溢出；选空间后发送的请求 body。

## 已知残留
1. 场景与空间选择不随账号切换显式复位：场景是纯界面偏好，保留；空间按 D2 自然失效。
2. `≤760px` 下超出一行的快捷任务需要横向滑动才能看到（滚动条隐藏）；键盘聚焦会把它滚入视野。
3. footer 弹层在外点关闭时焦点不回按钮（Radix 非模态 Popover 的既有行为，同 7.1 `筛选任务`）。
4. 360×740 等更小视口欢迎态仍会纵向滚动（规格只约束三个视口）。
5. 选中的空间在别处被删除、而本页尚未重读列表时发送：服务端按 4.1 拒绝，走既有的创建失败提示。创建失败路径不重读列表（`page.tsx:514-541`），按钮仍显示该空间，用户须手动改选；之后任一次列表读取会让它回到 `未选择`。
6. Scenario「场景随创建请求发送」的「新会话视图的 `scene` 与之相同」是服务端行为（4.1 的服务端测试为证），web 侧只钉请求 body；端到端由 8.2a 走查。
7. 账号没有任何工作空间且查询为空时弹层显示 `没有匹配的工作空间`（与 demo 一致；规格只写了「无匹配时」）。
8. 深色主题下选中胶囊为近黑底白字（`--wb-bg-pill-active` 只在浅色 `:root` 定义），可读，但与 Chip/SegmentedControl 的深色写法不一致。
9. `scrollbar-width: none` 没有 WebKit 对应写法：Safari 18.2 之前的桌面版在窄窗口下 chip 行会多出全局样式的 8px 滚动条（仍在首屏内）。
10. 在会话页点侧栏 `新建会话` 时带上此刻不可见的场景与空间选择（父规格明文：选择「作用于其后由…侧栏 `新建会话` 发起的创建请求」）；该页没有改选的控件，须回欢迎态改。是否让会话页的创建不带选择属父规格的取舍，本刀不改。

## Seams under test
- jsdom 页面 fixture：胶囊、快捷任务行、Toast、footer 弹层、创建请求 body、列表重读与失败、锁定、状态保留。
- 纯数据：`WELCOME_SCENES`（W3）；静态 CSS 文本。
- CI `ui-walk`：首屏约束与既有走查（`新建会话` 带 body 打真实服务端）。
