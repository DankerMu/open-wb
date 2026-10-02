# Delta: session-sidebar

## ADDED Requirements

### Requirement: 欢迎页场景胶囊与场景化快捷任务
欢迎态 SHALL 在 hero 与快捷任务行之间渲染场景胶囊组（accessible name `场景` 的 `role="group"`），三个按钮 `日常办公` / `代码开发` / `创意设计`（对应 `office` / `code` / `design`，图标分别为 `file-text` / `code` / `palette`），以 `aria-pressed` 表示选中，默认 `日常办公`（demo:1221-1225、2540-2542）。选择另一场景 SHALL 更新 `aria-pressed`、把快捷任务行替换为该场景的清单（标签与 prompt 取自 demo `SCENES[k].quick` 与 `QUICK_PROMPTS`，demo:1221-1239；图标只用已注册键：`日常办公` 六项沿用既有图标，`代码开发` 五项只用 `code`/`file-code`/`layout-grid`，`创意设计` 五项只用 `palette`/`image`/`file-text`），并显示 info `Toast` `已切换到「<场景名>」场景`（demo:2652-2663）；再次点击已选场景不改变状态、不显示 Toast。快捷任务的点击行为（只填草稿、不发送）与 composer 锁定期间禁用的规则同样适用于场景胶囊。选中场景为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为 `日常办公`）。

会话页由欢迎态首次发送或侧栏 `新建会话` 创建会话时，SHALL 以 `POST /api/sessions` body `{scene:<选中场景>}` 发送，当 composer footer 的按钮显示着某个工作空间时同时带它的 `workspaceId`，显示 `未选择` 时 body 不含 `workspaceId` 键（见「composer footer 工作空间选择」）；两条创建路径的 body 相同。场景只决定新会话的 `scene` 与欢迎页快捷任务清单，SHALL NOT 改变模型、工具面或 prompt 内容（与 F-CHAT-1「决定默认专家与工具面」的有意偏差）；会话内切换场景的入口不渲染（归 S1d）。

#### Scenario: 场景切换替换快捷任务
- **WHEN** 欢迎态点击 `代码开发`
- **THEN** `代码开发` 的 `aria-pressed="true"`、其余为 `false`；快捷任务行恰为 `日常开发`、`网站开发`、`Agent 应用`、`Skill 开发`、`CI/CD`；出现 `Toast` `已切换到「代码开发」场景`；点击 `网站开发` 后输入框草稿为 `帮我搭建一个内部系统首页` 且未发送

#### Scenario: 场景随创建请求发送
- **WHEN** 选中 `创意设计` 后在欢迎态输入并发送，另一次在默认场景下点击侧栏 `新建会话`
- **THEN** 前者的 `POST /api/sessions` body 为 `{"scene":"design"}`，后者为 `{"scene":"office"}`，均为 `application/json`；新会话视图的 `scene` 与之相同

### Requirement: composer footer 工作空间选择
欢迎态 composer（且仅欢迎态；有当前会话时不渲染）SHALL 在 composer 卡片末尾（卡片内、工具栏之后）渲染 footer，内含一个按钮，可见文本与 accessible name 为 `任务启动于 <空间名>`，未选择时为 `任务启动于 未选择`（`Icon folder`，demo:2579-2582）。footer SHALL NOT 渲染权限元素（demo 的 `权限 默认权限|完全访问` 不渲染，归 S3b）。点击按钮 SHALL 打开 `Popover`（demo:3588-3606），内含：accessible name 与 placeholder 为 `搜索工作空间` 的搜索输入框；选项 `未选择`；以及会话页已读取的该账号工作空间列表中的每个空间（按 `GET /api/workspaces` 的返回顺序；打开弹层不另发请求），显示空间名与 ADR-0011 逻辑路径 `<account>/<dir>`（`account` 取当前 Principal；不渲染空间根路径）。输入框按空间名做大小写不敏感子串过滤（查询先去掉首尾空白；`未选择` 始终保留），无匹配时显示 `没有匹配的工作空间`；每次打开弹层查询为空。当前选中项 SHALL 以 `aria-pressed="true"` 标示。选择任一项 SHALL 关闭弹层、更新按钮文本并把焦点还给按钮；`新建工作空间` 与 `挂载目录到当前空间`（demo:3601-3602）SHALL NOT 渲染。空间列表尚无成功读取结果时显示 `正在读取工作空间`，最近一次读取失败时以 `role="alert"` 显示信封 message 或 `请求失败，请稍后重试`，两种情况下仍可选 `未选择`。选中空间为会话页内存状态（选中会话后再回到欢迎态保留；刷新或离开会话页复位为未选择），作用于其后由欢迎态发送与侧栏 `新建会话` 发起的创建请求（`workspaceId`）。选中的空间不在当前已读取的列表中时（列表被重新读取后它已不存在、读取失败或换了账号）按钮显示 `任务启动于 未选择` 且创建请求不带 `workspaceId`——按钮文本与请求体始终一致。composer 锁定期间按钮禁用，已打开的弹层随之关闭。

#### Scenario: 选择空间后创建绑定会话
- **WHEN** 账号 `zhangsan` 有空间 `项目A`（dir `项目A`）与 `客服`，欢迎态打开 `任务启动于 未选择`，在 `搜索工作空间` 输入 `项目`，选择 `项目A`，再输入并发送
- **THEN** 弹层只列 `未选择` 与 `项目A`（副文本 `zhangsan/项目A`）；选择后按钮文本为 `任务启动于 项目A`、焦点在该按钮；`POST /api/sessions` body 为 `{"scene":"office","workspaceId":"<项目A 的 id>"}`；新会话出现在侧栏 `空间 (1)` 的 `项目A` 子组内；footer 随会话被选中而消失

#### Scenario: 无权限元素与无匹配
- **WHEN** 欢迎态查看 footer 并在弹层中搜索 `不存在`
- **THEN** footer 只含 `任务启动于` 按钮，无 `权限`、`完全访问` 或 `默认权限` 文本；弹层显示 `未选择` 与 `没有匹配的工作空间`，无 `新建工作空间` 与 `挂载目录到当前空间`
