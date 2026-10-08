## MODIFIED Requirements

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `消息线程` 的助手块次序；它在工具调用组之外，不随工具调用组的收起而隐藏。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击以客户端导航前往 `/files?ws=<workspaceId>`（files-web 当前以 `?ws=` 表示空间，无文件预选参数；定位到该文件需 files-web 另行扩展，不在本 change）。会话 `workspaceId` 为 `null`、不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径，不渲染 `查看详情`。用临时空间的会话（会话视图 `temporaryWorkspace` 为 true，session-metadata「会话视图扩展键」）属于这一情形的行呈现——临时空间不在 `listWorkspaces` 结果里，行只显示空间内相对路径、不渲染 `查看详情`（文件页不列临时空间；从会话进入临时空间文件的入口随 change `s1f-files-page` 的工作空间侧边栏交付）——但它的空间是**可解析**的（见下）。

**空间可解析**的定义（本条、`产物卡` 与 `产物面板` 共用）：会话 `workspaceId` 非 null，且要么它在已成功读取的 `listWorkspaces` 结果里，要么该会话 `temporaryWorkspace` 为 true。后一种判定只看会话视图，不依赖空间列表：列表读取中或读取失败时，临时空间会话仍是空间可解析的。其余情形（`workspaceId` 为 null；`temporaryWorkspace` 为 false 而 `workspaceId` 不在列表中、列表读取中或读取失败）为空间不可解析。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内、工具调用组之外出现名为 `文件变更（2 个）` 的卡片（工具调用组保持收起时它仍可见），第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后 URL 为 `/files?ws=<该空间 id>`；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `temporaryWorkspace` 为 false 且 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间（`workspaceId` 为 null），或 `temporaryWorkspace` 为 false 而空间列表读取中或读取失败
- **THEN** 卡片行只显示相对路径，无 `查看详情` 按钮，也不渲染产物卡

#### Scenario: 临时空间会话的文件变更卡
- **WHEN** 账号在一个用临时空间的会话（`temporaryWorkspace` 为 true，`workspaceId` 不在 `listWorkspaces` 结果中）里完成一回合，步骤 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"},{path:"notes.md",added:3,removed:0,kind:"edit"}]`；另一例同样的会话在空间列表读取失败时渲染
- **THEN** 两例都出现名为 `文件变更（2 个）` 的卡片，两行分别含 `写入` 与 `out/index.html`、`+3` 与 `notes.md`（只有空间内相对路径，没有 `tmp-` 开头的目录名，也没有绝对根路径）；卡片里没有任何 `查看详情` 按钮；该消息仍渲染 `index.html` 与 `notes.md` 的产物卡

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感；文件名里唯一的 `.` 在开头时视为无扩展名，如 `.env`、`.html`）派生产物卡，位置在文件变更卡之后（同样在工具调用组之外）；正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本、不新增服务端端点。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击后拉取文本并打开模态对话框（`role="dialog"`，accessible name 为文件名；由拷入层 `dialog` 渲染），内含 `<iframe sandbox="allow-scripts" srcdoc="<取回文本>" title="<文件名>">`，sandbox SHALL 不含 `allow-same-origin` 或其它令牌；卡片本身不内嵌 iframe。预览响应带截断标记（超过 1 MiB）时对话框在 iframe 上方显示 `文件超过 1 MiB，仅预览前 1 MiB`。关闭对话框后焦点 SHALL 回到打开它的按钮，且不因此滚动消息线程。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，按钮 `下载`（`Icon download`，accessible name `下载 <文件名>`）。点击后拉取图片 Blob URL，以 `download=<文件名>` 的临时链接触发下载后撤销该 URL；不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（预览 API 其余可预览文本类型）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入；成功时按钮图标换成对勾约 2 秒，并渲染一个视觉隐藏的 `role="status"` 文本 `已复制`，不显示 Toast；剪贴板不可用、抛错或 reject 时就地显示 `复制失败`；响应带截断标记时不写剪贴板并就地显示 `文件过大，无法复制`。
其它扩展名（含无扩展名）不派生产物卡（仍在文件变更卡中列出）。`在编辑器中打开` SHALL 不渲染。预览请求失败（如文件已被删除的 404、415、图片过大的 413、网络错误）或返回的类型与卡片不符时 SHALL 就地显示失败文案：`ApiError` 信封 message（其余情况用 request_failed 的安全文案），不打开对话框、不写剪贴板、不触发下载、不留下未处理拒绝；401 不另出提示（沿用客户端既有的未登录通知）。「就地显示」指在触发控件旁渲染一行 `role="alert"` 文本，该卡片下一次操作成功或再次触发操作时清除；产物卡 SHALL NOT 调用 Toast。拉取期间该卡片的操作按钮禁用，重复点击不并发请求；拉取结束时若焦点已不在任何元素上（浏览器在按钮禁用时把焦点移到 `body`），焦点 SHALL 回到被点的那个操作按钮且不因此滚动页面（`preventScroll`），焦点在别处时不动；组件卸载、切换会话或换账号时 SHALL abort 进行中的拉取并撤销已创建的 Blob URL，被 abort 的拉取不出任何提示。会话空间不可解析（`文件变更卡` 的定义）时不渲染产物卡；用临时空间的会话空间可解析，产物卡照常渲染，其预览、下载与复制以该会话的 `workspaceId`（临时空间的 id）调用同一预览 API（temporary-workspaces「临时空间的可见性」：按 id 的 file 端点对所有者的临时空间照常工作）。user 消息不渲染产物卡。

#### Scenario: html 预览隔离
- **WHEN** 助手消息变更含 `out/index.html`，点击 `打开网页预览 index.html`，预览 API 返回文本 `<h1>hi</h1><script>document.title='x'</script>`
- **THEN** 打开名为 `index.html` 的对话框，内含 `sandbox` 属性恰为 `allow-scripts`、`srcdoc` 为该文本的 iframe；卡片标签 `HTML`、卡脚有 `可交互预览`；无 `在编辑器中打开`；预览 API 恰被调用一次且在点击之前未被调用
- **WHEN** 预览响应带 `X-Workbuddy-Truncated: 1`
- **THEN** 对话框内显示 `文件超过 1 MiB，仅预览前 1 MiB`
- **WHEN** 转录贴底、回合仍在输出时从较早一条消息的 html 产物卡打开预览，期间内容把该卡片顶出转录视口，随后以 Escape 或 `关闭` 关闭对话框
- **THEN** 焦点回到打开它的 `打开网页预览 index.html` 按钮，消息线程不因焦点归还而滚动（仍贴底跟随，不出现 `回到最新`）

#### Scenario: 图片下载与代码复制
- **WHEN** 变更含 `assets/chart.PNG` 与 `src/app.ts`，分别点击 `下载 chart.PNG` 与 `复制代码 app.ts`
- **THEN** 前者卡片标签 `PNG`，触发以 `chart.PNG` 为文件名的下载且其 Blob URL 随后被撤销；后者卡片标签 `TS`，剪贴板写入恰为预览 API 返回的文本，按钮图标换为对勾，存在 `role="status"` 文本 `已复制`，页面无 Toast；约 2 秒后图标恢复

#### Scenario: 不派生与失败
- **WHEN** 变更含 `main.py` 与已被外部删除的 `gone.md`，点击 `复制代码 gone.md` 时预览 API 返回 404
- **THEN** `main.py` 只在文件变更卡中列出、无产物卡；`gone.md` 点击后该按钮旁出现 `role="alert"`，文本为信封文案，页面无 Toast，无剪贴板写入、无未处理拒绝
- **WHEN** 剪贴板写入被 reject；另一次预览响应带截断标记；随后再次点击同一按钮且这次成功
- **THEN** 前两者分别在该按钮旁以 `role="alert"` 显示 `复制失败` 与 `文件过大，无法复制`（后者无剪贴板写入）；再次点击时该 `role="alert"` 即被清除，成功后不再出现

#### Scenario: 拉取中与卸载
- **WHEN** 点击 `打开网页预览 index.html` 后预览响应尚未返回，再次点击该卡片的任一操作按钮；另一例在图片预览响应返回之前切换到另一个会话，随后响应返回
- **THEN** 前者只发出一个预览请求，该卡片的两个 `打开网页预览` 按钮在响应返回前均为禁用；后者的请求被 abort，迟到的响应不触发下载、不出任何提示，其 Blob URL 被撤销

#### Scenario: 临时空间会话照常渲染产物卡
- **WHEN** 用临时空间的会话（`temporaryWorkspace` 为 true）的助手消息变更含 `out/index.html`、`assets/chart.png` 与 `notes.md`，依次点击 `打开网页预览 index.html`、`下载 chart.png`、`复制代码 notes.md`
- **THEN** 三张产物卡都渲染（标签 `HTML`、`PNG`、`MD`）；三次操作各恰发出一次 `GET /api/workspaces/<该会话的 workspaceId>/file?path=…` 并分别打开 `sandbox="allow-scripts"` 的预览对话框、触发下载、写入剪贴板；空间列表读取失败的另一例结果相同
- **WHEN** 该会话的临时空间随后被转正（`temporaryWorkspace` 变为 false、空间出现在 `listWorkspaces` 结果中）并重取列表
- **THEN** 产物卡仍在，文件变更卡的行改为显示逻辑路径并带 `查看详情`

### Requirement: 产物面板
选中会话时，会话页 SHALL 经 spa-shell 顶栏 `actions` 插槽注入 `产物面板` 图标按钮（`Icon package`，accessible name 与 tooltip `产物面板`，不带 `aria-expanded`）；欢迎态不渲染。点击时 SHALL 以当前聊天视图中全部已结束步骤的 `changes` 按路径聚合（同一路径取最新者：消息次序靠后者优先，同一消息内步骤 ordinal 大者优先；位置取首次出现处）：随后打开右侧面板（由拷入层 `sheet` 渲染，对话框 accessible name `产物面板`）。结果为空时面板照常打开，面板内只显示空态文本 `当前任务暂无产物`，SHALL NOT 以 Toast 替代打开（未绑定空间的会话没有 `changes`，同样落在这里）；否则每项一行，行内容与文件变更卡行相同（计数或 `写入`、逻辑路径、`查看详情`；会话空间不可解析时、以及用临时空间的会话，同样只显示空间内相对路径、不渲染 `查看详情`），且在会话空间可解析时（`文件变更卡` 的定义，含用临时空间的会话）对可派生产物卡的扩展名在行尾（有 `查看详情` 时在它之后）附带同名操作按钮（`打开网页预览 <文件名>`/`下载 <文件名>`/`复制代码 <文件名>`，请求、拉取纪律、拉取结束后的焦点归还与结果同产物卡：失败同样在该行的触发按钮旁以 `role="alert"` 就地显示；html 预览对话框叠在面板之上，关闭预览后面板仍开、焦点回到该行的按钮）。面板头部的 `关闭` 图标按钮、脚部的 `关闭` 按钮、Escape 与遮罩 SHALL 关闭面板（html 预览打开时 Escape 只关闭预览），关闭后焦点归还 `产物面板` 按钮（按钮仍在顶栏时）；面板关闭时在途的行内拉取被 abort，不出任何提示、不写剪贴板、不触发下载。面板打开期间视图更新时列表 SHALL 随之更新（空态在出现第一条变更后换成列表）；当前会话视图不再可用时（切换到另一个会话、换账号、URL 变化使历史整体重新读取；重同步与重连不在此列，面板保持打开）面板 SHALL 关闭，回到原会话不自动重开。面板不读取任何新端点，完全由快照与事件归约的视图派生；页面任何文本与属性 SHALL NOT 出现空间绝对根路径。

#### Scenario: 聚合与空态
- **WHEN** 会话两条助手消息分别变更 `a.md`（`+1`）与 `a.md`（`+3 -1`）、`out/index.html`（写入），点击顶栏 `产物面板`
- **THEN** 打开名为 `产物面板` 的面板（`role="dialog"`），恰两行：`a.md` 显示 `+3`、`-1`，`out/index.html` 显示 `写入` 并带 `打开网页预览 index.html` 按钮；`关闭` 后焦点回到 `产物面板` 按钮
- **WHEN** 当前会话没有任何非空 `changes`（含未绑定空间的会话）
- **THEN** 点击后名为 `产物面板` 的面板打开，面板内显示 `当前任务暂无产物` 且没有变更行；页面无 Toast；Escape 关闭面板后焦点回到 `产物面板` 按钮

#### Scenario: 打开期间更新与行操作
- **WHEN** 面板打开期间一个已带 `changes` 的 running 步骤收到 `step.end`；随后点击某行的 `打开网页预览 index.html`，再关闭预览
- **THEN** 该步骤的变更行出现在面板列表里（不必重开）；预览以 `sandbox="allow-scripts"` 的 iframe 对话框叠在面板之上，关闭预览后面板仍开、焦点在该行的按钮上

#### Scenario: 临时空间会话的面板行
- **WHEN** 用临时空间的会话有变更 `out/index.html`（写入）与 `main.py`（`+2`），点击顶栏 `产物面板`
- **THEN** 面板恰两行，都只显示空间内相对路径、没有 `查看详情`；`out/index.html` 一行带 `打开网页预览 index.html` 按钮且点击后以该会话的 `workspaceId` 拉取并打开预览，`main.py` 一行没有操作按钮
