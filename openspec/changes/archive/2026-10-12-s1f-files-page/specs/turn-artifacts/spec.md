## MODIFIED Requirements

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `消息线程` 的助手块次序；它在工具调用组之外，不随工具调用组的收起而隐藏。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击打开会话页的工作空间侧边栏并定位到该文件（workspace-sidebar「从卡片定位到文件」），不导航、不改变地址。会话 `workspaceId` 不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径（无从拼出逻辑路径），`查看详情` 照常渲染，其 accessible name 与 tooltip 为 `查看详情 <相对路径>`——侧边栏只需要 `workspaceId`。会话 `workspaceId` 为 `null` 时行只显示空间内相对路径，不渲染 `查看详情`（没有工作空间就没有侧边栏）。用临时空间的会话（会话视图 `temporaryWorkspace` 为 true，session-metadata「会话视图扩展键」）属于这一情形的行呈现——临时空间不在 `listWorkspaces` 结果里，行只显示空间内相对路径，`查看详情 <相对路径>` 照常渲染（文件页不列临时空间；这个按钮打开的工作空间侧边栏就是从会话进入临时空间文件的入口）——且它的空间是**可解析**的（见下）。

**空间可解析**的定义（本条与 `产物卡` 共用；`产物面板` 已由 s1f-files-page 移除）：会话 `workspaceId` 非 null，且要么它在已成功读取的 `listWorkspaces` 结果里，要么该会话 `temporaryWorkspace` 为 true。后一种判定只看会话视图，不依赖空间列表：列表读取中或读取失败时，临时空间会话仍是空间可解析的。其余情形（`workspaceId` 为 null；`temporaryWorkspace` 为 false 而 `workspaceId` 不在列表中、列表读取中或读取失败）为空间不可解析。空间是否可解析只决定产物卡是否渲染（`产物卡`）与行里显示逻辑路径还是相对路径；`查看详情` 是否渲染只取决于 `workspaceId` 是否非 null。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内、工具调用组之外出现名为 `文件变更（2 个）` 的卡片（工具调用组保持收起时它仍可见），第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后工作空间侧边栏打开并选中 `src/app.ts`，URL 仍是该会话的地址、没有到 `/files` 的导航；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `temporaryWorkspace` 为 false 且 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间（`workspaceId` 为 null），或 `temporaryWorkspace` 为 false 而空间列表读取中或读取失败
- **THEN** 三种情形的卡片行都只显示相对路径，都不渲染产物卡；`workspaceId` 非 null 的两种情形每行仍有 `查看详情 <相对路径>` 按钮，点击打开工作空间侧边栏并定位到该文件；`workspaceId` 为 null 的情形没有 `查看详情` 按钮，页面也没有工作空间侧边栏

#### Scenario: 临时空间会话的文件变更卡
- **WHEN** 账号在一个用临时空间的会话（`temporaryWorkspace` 为 true，`workspaceId` 不在 `listWorkspaces` 结果中）里完成一回合，步骤 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"},{path:"notes.md",added:3,removed:0,kind:"edit"}]`；另一例同样的会话在空间列表读取失败时渲染
- **THEN** 两例都出现名为 `文件变更（2 个）` 的卡片，两行分别含 `写入` 与 `out/index.html`、`+3` 与 `notes.md`（只有空间内相对路径，没有 `tmp-` 开头的目录名，也没有绝对根路径）；两行各有 `查看详情 <相对路径>` 按钮，点击 `查看详情 notes.md` 后工作空间侧边栏打开、对该会话的 `workspaceId` 请求 `tree` 并选中 `notes.md`，URL 不变；该消息仍渲染 `index.html` 与 `notes.md` 的产物卡

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感；文件名里唯一的 `.` 在开头时视为无扩展名，如 `.env`、`.html`）派生产物卡，位置在文件变更卡之后（同样在工具调用组之外）；代码卡的正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本；html 卡与图片卡自身不拉取正文（见下）。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击 SHALL 打开会话页的工作空间侧边栏、定位到该文件并显示其渲染视图（workspace-sidebar「从卡片定位到文件」；渲染视图由隔离预览来源提供，同空间的相对资源可加载，不受 1 MiB 文本上限约束，见 file-previewers「隔离来源的嵌入与令牌」）；卡片自身 SHALL NOT 为此调用 `fetchPreview`，SHALL NOT 打开对话框，SHALL NOT 渲染任何 `srcdoc` iframe；卡片本身不内嵌 iframe。窄屏下侧边栏是模态层，关闭后焦点 SHALL 回到打开它的按钮，且不因此滚动消息线程（规则在 workspace-sidebar）。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，`下载`（`Icon download`，accessible name `下载 <文件名>`）SHALL 是一个链接，`href` 为 `downloadUrl(workspaceId, path)`（`/api/workspaces/<id>/download?path=<编码后的路径>`，file-operations「下载」），带 `download` 属性——与 file-previewers「预览头、下载与不可预览的呈现」的下载链接同一实现。下载由浏览器直接导航完成：服务端写 `file.download` 审计、不受图片预览上限约束；卡片 SHALL NOT 为下载调用 `fetchPreview`，SHALL NOT 经 `fetch` 读取文件内容，SHALL NOT 创建 Blob 地址；文件已不存在时由浏览器自己报告下载失败，页面不显示错误。不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（s1f-files-page 之前预览 API 的其余可预览文本类型；这个集合不随该 change 扩大）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入；成功时按钮图标换成对勾约 2 秒，并渲染一个视觉隐藏的 `role="status"` 文本 `已复制`，不显示 Toast；剪贴板不可用、抛错或 reject 时就地显示 `复制失败`；响应带截断标记时不写剪贴板并就地显示 `文件过大，无法复制`。
其它扩展名（含无扩展名）不派生产物卡（仍在文件变更卡中列出）；可派生的扩展名集合不随 s1f-files-page 新增的预览格式扩大——其它格式经文件变更卡的 `查看详情` 在侧边栏里预览与下载。`在编辑器中打开` SHALL 不渲染。`复制代码` 的预览请求失败（如文件已被删除的 404、415、网络错误）或返回的类型不是文本时 SHALL 就地显示失败文案：`ApiError` 信封 message（其余情况用 request_failed 的安全文案），不写剪贴板、不留下未处理拒绝；401 不另出提示（沿用客户端既有的未登录通知）。「就地显示」指在触发控件旁渲染一行 `role="alert"` 文本，该卡片下一次操作成功或再次触发操作时清除；产物卡 SHALL NOT 调用 Toast。拉取期间该卡片的操作按钮禁用，重复点击不并发请求；拉取结束时若焦点已不在任何元素上（浏览器在按钮禁用时把焦点移到 `body`），焦点 SHALL 回到被点的那个操作按钮且不因此滚动页面（`preventScroll`），焦点在别处时不动；组件卸载、切换会话或换账号时 SHALL abort 进行中的拉取，被 abort 的拉取不出任何提示。会话空间不可解析（`文件变更卡` 的定义）时不渲染产物卡；用临时空间的会话空间可解析，产物卡照常渲染，其定位、下载与复制以该会话的 `workspaceId`（临时空间的 id）调用与正式空间相同的按 id 端点（temporary-workspaces「临时空间的可见性」：按 id 的 file 端点对所有者的临时空间照常工作；s1f-files-page 新增的 `download`、`preview-token` 等按 id 的端点同样只经所有者作用域的 `rootOf` 解析，不区分临时与正式）。user 消息不渲染产物卡。

#### Scenario: html 预览隔离
- **WHEN** 助手消息变更含 `out/index.html`，点击 `打开网页预览 index.html`（卡头按钮与卡脚链接各一次）
- **THEN** 两次都使工作空间侧边栏打开并选中 `out/index.html`、显示渲染视图：一个 `src` 在隔离预览来源下、`sandbox` 属性不含 `allow-same-origin` 的 iframe（file-previewers「隔离来源的嵌入与令牌」）；卡片标签 `HTML`、卡脚有 `可交互预览`；无 `在编辑器中打开`；页面里没有以 `index.html` 为名的对话框，没有 `srcdoc` iframe；卡片没有调用预览 API（`GET …/file` 的次数不因点击卡片而增加）
- **WHEN** 该 html 文件超过 1 MiB
- **THEN** 渲染视图照常加载完整文件，页面没有 `文件超过 1 MiB，仅预览前 1 MiB` 的提示（截断只作用于侧边栏里的源码视图）
- **WHEN** 窄屏下转录贴底、回合仍在输出时从较早一条消息的 html 产物卡打开预览，期间内容把该卡片顶出转录视口，随后以 Escape 或 `关闭` 关闭侧边栏
- **THEN** 焦点回到打开它的 `打开网页预览 index.html` 按钮，消息线程不因焦点归还而滚动（仍贴底跟随，不出现 `回到最新`）

#### Scenario: 图片下载与代码复制
- **WHEN** 变更含 `assets/chart.PNG` 与 `src/app.ts`，查看 `下载 chart.PNG` 并点击 `复制代码 app.ts`
- **THEN** 前者卡片标签 `PNG`，`下载 chart.PNG` 是一个链接，`href` 恰为 `/api/workspaces/<该空间 id>/download?path=assets%2Fchart.PNG`（或等价编码）且带 `download` 属性，页面没有为它发出 `GET …/file` 请求、没有创建 Blob 地址；后者卡片标签 `TS`，剪贴板写入恰为预览 API 返回的文本，按钮图标换为对勾，存在 `role="status"` 文本 `已复制`，页面无 Toast；约 2 秒后图标恢复

#### Scenario: 不派生与失败
- **WHEN** 变更含 `main.py` 与已被外部删除的 `gone.md`，点击 `复制代码 gone.md` 时预览 API 返回 404
- **THEN** `main.py` 只在文件变更卡中列出、无产物卡；`gone.md` 点击后该按钮旁出现 `role="alert"`，文本为信封文案，页面无 Toast，无剪贴板写入、无未处理拒绝
- **WHEN** 剪贴板写入被 reject；另一次预览响应带截断标记；随后再次点击同一按钮且这次成功
- **THEN** 前两者分别在该按钮旁以 `role="alert"` 显示 `复制失败` 与 `文件过大，无法复制`（后者无剪贴板写入）；再次点击时该 `role="alert"` 即被清除，成功后不再出现

#### Scenario: 拉取中与卸载
- **WHEN** 点击 `复制代码 app.ts` 后预览响应尚未返回，再次点击该按钮；另一例在该预览响应返回之前切换到另一个会话，随后响应返回
- **THEN** 前者只发出一个预览请求，该按钮在响应返回前为禁用；后者的请求被 abort，迟到的响应不写剪贴板、不出任何提示；两例全程都没有 Blob 地址被创建

#### Scenario: 临时空间会话照常渲染产物卡
- **WHEN** 用临时空间的会话（`temporaryWorkspace` 为 true）的助手消息变更含 `out/index.html`、`assets/chart.png` 与 `notes.md`，依次点击 `打开网页预览 index.html`、查看 `下载 chart.png`、点击 `复制代码 notes.md`
- **THEN** 三张产物卡都渲染（标签 `HTML`、`PNG`、`MD`）；`打开网页预览 index.html` 使工作空间侧边栏打开并以渲染视图选中 `out/index.html`（没有对话框，卡片没有为此发出 `file` 请求，预览令牌以该会话的 `workspaceId` 签发）；`下载 chart.png` 是指向 `/api/workspaces/<该会话的 workspaceId>/download?path=assets%2Fchart.png`（或等价编码）的链接；`复制代码 notes.md` 恰发出一次 `GET /api/workspaces/<该会话的 workspaceId>/file?path=notes.md` 并写入剪贴板；空间列表读取失败的另一例结果相同
- **WHEN** 该会话的临时空间随后被转正（`temporaryWorkspace` 变为 false、空间出现在 `listWorkspaces` 结果中）并重取列表
- **THEN** 产物卡仍在，文件变更卡的行改为显示逻辑路径，`查看详情` 的可访问名随之改为 `查看详情 <逻辑路径>`

## REMOVED Requirements

### Requirement: 产物面板
**Reason**: owner 2026-10-06 决定（#913）：会话页右侧只保留一个面板。产物面板（顶栏 `产物面板` 按钮与右侧 `Sheet` 里的改动列表）与网页预览对话框由工作空间侧边栏取代——产物就是工作空间里的文件，不再有独立的「产物面板」概念；原条文的「切换会话时关闭」也与新的「切换会话时保持打开」相反。本条移除的是「主规格 → s1f-session-list-temp-space」叠加后的全文，含后者新增的场景「临时空间会话的面板行」。
**Migration**: 顶栏同一槽位改为 `工作空间侧边栏` 按钮（workspace-sidebar「顶栏入口与可用性」）。「本会话改了哪些文件」由侧边栏目录树上的 `本会话已改动` 标记与 `只看本会话改动` 开关给出（同一聚合规则，见 workspace-sidebar「本会话改动标记与过滤」）；行内的预览、下载、复制由侧边栏的预览区与下载链接承担；临时空间会话原先在面板行上得到的操作，改由文件变更卡的 `查看详情`（临时空间会话同样渲染）与产物卡承担。`web/src/features/chat/artifacts-panel.tsx`、产物卡里的预览对话框及其测试删除；功能验收清单里以产物面板为对象的行（CH-34、CH-35、CH-36、CH-54 的前半）改写为侧边栏的对应行。空态文案 `当前任务暂无产物` 不再出现，对应的是 `本会话暂无文件改动`。
