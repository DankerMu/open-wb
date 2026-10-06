## MODIFIED Requirements

### Requirement: 欢迎页场景胶囊与场景化快捷任务
欢迎态 SHALL 在 hero 与快捷任务行之间渲染场景胶囊组（accessible name `场景` 的 `role="group"`），三个按钮 `日常办公` / `代码开发` / `创意设计`（对应 `office` / `code` / `design`，图标分别为 `file-text` / `code` / `palette`），以 `aria-pressed` 表示选中，默认 `日常办公`。场景只是欢迎页的建议分组：选择另一场景 SHALL 只更新 `aria-pressed` 并把快捷任务行替换为该场景的清单（标签与 prompt 取自 `welcome-content.ts`；图标只用已注册键：`日常办公` 六项沿用既有图标，`代码开发` 五项只用 `code`/`file-code`/`layout-grid`，`创意设计` 五项只用 `palette`/`image`/`file-text`），SHALL NOT 显示 Toast，也不产生任何 `role="status"` 或 `role="alert"` 的播报；再次点击已选场景不改变状态。快捷任务的点击行为（只填草稿、不发送）与 composer 锁定期间禁用的规则同样适用于场景胶囊。选中场景为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为 `日常办公`）。选中会话后（含零消息会话）界面 SHALL NOT 显示场景胶囊与快捷任务。

会话 SHALL 只由欢迎态的首次发送创建：发送时恰发出一次 `POST /api/sessions`，body 为 `{scene:<选中场景>}`，当 composer 能力栏的工作空间选择显示着某个工作空间时同时带它的 `workspaceId`，显示 `未选择` 时 body 不含 `workspaceId` 键（见「composer footer 工作空间选择」）；随后选中返回的会话 id，再恰发出一次 prompt 请求。场景只决定新会话的 `scene` 与欢迎页快捷任务清单，SHALL NOT 改变模型、工具面或 prompt 内容（与 F-CHAT-1「决定默认专家与工具面」的有意偏差）；会话内切换场景的入口不渲染（归 S1d）。

侧栏 `新建会话` SHALL 只把页面带回欢迎态，不创建会话：点击后以 replace 清除 URL 的 `?session=`（其它 search 与 hash 保留），SHALL NOT 发出任何请求（尤其没有 `POST /api/sessions`），输入框草稿保持不变。首次发送的「创建—发送」交接尚未落定时点击 SHALL NOT 导航，也不中止该交接——否则会留下一个没有消息的会话。交接从欢迎态发送起算，到那一次 prompt 请求被受理或被拒绝、创建请求失败、或交接被放弃（切换到别的会话、切换账号）为止；其间的任何时刻都算未落定，包括创建请求已返回、URL 已带新会话 id 而 prompt 请求尚未发出的时刻。prompt 被受理之后交接即落定：随后对该会话的历史读取无论在途、成功还是失败，`新建会话` 都照常可用。交接未落定时切换到别的会话条目或浏览器后退不在本条约束之内。侧栏不是覆盖层时（`≥761px`）点击后把焦点放到会话页输入框（composer 的多行文本框）；已在欢迎态时点击只聚焦输入框，URL 与草稿不变、不发请求。`≤760px` 下承载它的导航覆盖层照常关闭，关闭后焦点按 spa-shell 既有规则归还 `打开导航`（与覆盖层内其它导航相同，本 change 不改外壳），此时不聚焦输入框。

#### Scenario: 场景切换替换快捷任务且无提示
- **WHEN** 欢迎态点击 `代码开发`
- **THEN** `代码开发` 的 `aria-pressed="true"`、其余为 `false`；快捷任务行恰为 `日常开发`、`网站开发`、`Agent 应用`、`Skill 开发`、`CI/CD`；页面没有 Toast，也没有新出现的 `role="status"` / `role="alert"` 播报，任何位置都不出现文本 `已切换到「代码开发」场景`；没有网络请求；点击 `网站开发` 后输入框草稿为 `帮我搭建一个内部系统首页` 且未发送

#### Scenario: 场景随首次发送写入创建请求
- **WHEN** 选中 `创意设计` 后在欢迎态输入并发送；另一次在默认场景下输入并发送
- **THEN** 前者的 `POST /api/sessions` body 为 `{"scene":"design"}`，后者为 `{"scene":"office"}`，均为 `application/json`；每次恰一个 `POST /api/sessions`，其后恰一个 prompt 请求发往返回的会话 id；新会话视图的 `scene` 与 body 相同；会话被选中后页面不再显示 `场景` 组与快捷任务

#### Scenario: 新建会话只回欢迎态
- **WHEN** 在 `≥761px`（侧栏不是覆盖层）位于 `/?session=<id>&foo=1#x`、输入框草稿为 `半句话` 时点击侧栏 `新建会话`
- **THEN** URL 为 `/?foo=1#x`（不含 `session`）；点击之后没有任何新请求，`POST /api/sessions` 调用次数为 0；hero `WorkBuddy，我帮你` 可见；焦点在会话页输入框，草稿仍为 `半句话`；侧栏会话列表没有新增条目
- **WHEN** 同样在 `≥761px`，已在欢迎态（URL 无 `?session=`）时点击 `新建会话`
- **THEN** 没有任何请求，URL 与草稿不变，焦点在会话页输入框
- **WHEN** 在 `≤760px` 的 `导航` 覆盖层内点击 `新建会话`
- **THEN** 覆盖层关闭，没有任何请求，页面为欢迎态，草稿不变，焦点回到 `打开导航`（不在会话页输入框）
- **WHEN** 欢迎态发送 `你好` 后创建已返回、URL 已是 `?session=<新 id>`，而该会话的 prompt 请求尚未返回时点击 `新建会话`
- **THEN** URL 不变、prompt 请求未被中止；prompt 受理后恰有一次 prompt 请求，转录含 `你好`
- **WHEN** 欢迎态发送 `你好` 后创建已返回、URL 已是 `?session=<新 id>`，而 prompt 请求尚未发出时点击 `新建会话`
- **THEN** URL 不变；随后恰发出一次 prompt 请求且未被中止，受理后转录含 `你好`
- **WHEN** 欢迎态发送后 prompt 已被受理，而随后对该会话的历史读取仍在途时点击 `新建会话`；另一次在该读取失败之后点击
- **THEN** 两次都是：URL 不含 `session`，页面为欢迎态，点击之后没有任何新请求
