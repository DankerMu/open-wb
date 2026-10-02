## ADDED Requirements

### Requirement: 产物面板
选中会话时，会话页 SHALL 经 spa-shell 顶栏 `actions` 插槽注入 `产物面板` 图标按钮（`Icon package`，accessible name 与 tooltip `产物面板`，不带 `aria-expanded`）；欢迎态不渲染。点击时 SHALL 以当前聊天视图中全部已结束步骤的 `changes` 按路径聚合（同一路径取最新者：消息次序靠后者优先，同一消息内步骤 ordinal 大者优先；位置取首次出现处）：结果为空时只显示 Toast `当前任务暂无产物`、不打开抽屉（未绑定空间的会话没有 `changes`，同样落在这里）；否则打开右侧 `Drawer`（宽 420，对话框 accessible name `产物面板`），每项一行，行内容与文件变更卡行相同（计数或 `写入`、逻辑路径、`查看详情`；会话空间不可解析时同样只显示空间内相对路径、不渲染 `查看详情`），且在会话空间可解析时对可派生产物卡的扩展名在 `查看详情` 之后附带同名操作按钮（`打开网页预览 <文件名>`/`下载 <文件名>`/`复制代码 <文件名>`，请求、拉取纪律、拉取结束后的焦点归还与结果同产物卡：html 预览 Dialog 叠在抽屉之上，关闭预览后抽屉仍开、焦点回到该行的按钮）。抽屉头部的 `关闭` 图标按钮、脚部的 `关闭` 按钮、Escape 与遮罩 SHALL 关闭抽屉（html 预览打开时 Escape 只关闭预览），关闭后焦点归还 `产物面板` 按钮（按钮仍在顶栏时）；抽屉关闭时在途的行内拉取被 abort，不出 Toast、不写剪贴板、不触发下载。抽屉打开期间视图更新时列表 SHALL 随之更新；当前会话视图不再可用时（切换到另一个会话、换账号、URL 变化使历史整体重新读取；重同步与重连不在此列，抽屉保持打开）抽屉 SHALL 关闭，回到原会话不自动重开。面板不读取任何新端点，完全由快照与事件归约的视图派生；页面任何文本与属性 SHALL NOT 出现空间绝对根路径。

#### Scenario: 聚合与空态
- **WHEN** 会话两条助手消息分别变更 `a.md`（`+1`）与 `a.md`（`+3 -1`）、`out/index.html`（写入），点击顶栏 `产物面板`
- **THEN** 打开名为 `产物面板` 的抽屉，恰两行：`a.md` 显示 `+3`、`-1`，`out/index.html` 显示 `写入` 并带 `打开网页预览 index.html` 按钮；`关闭` 后焦点回到 `产物面板` 按钮
- **WHEN** 当前会话没有任何非空 `changes`（含未绑定空间的会话）
- **THEN** 点击后出现 Toast `当前任务暂无产物`，无抽屉

#### Scenario: 打开期间更新与行操作
- **WHEN** 抽屉打开期间一个已带 `changes` 的 running 步骤收到 `step.end`；随后点击某行的 `打开网页预览 index.html`，再关闭预览
- **THEN** 该步骤的变更行出现在抽屉列表里（不必重开）；预览以 `sandbox="allow-scripts"` 的 iframe Dialog 叠在抽屉之上，关闭预览后抽屉仍开、焦点在该行的按钮上

## MODIFIED Requirements

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感；文件名里唯一的 `.` 在开头时视为无扩展名，如 `.env`、`.html`）派生产物卡，位置在文件变更卡之后；正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本、不新增服务端端点。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击后拉取文本并打开 `Dialog`（标题为文件名），内含 `<iframe sandbox="allow-scripts" srcdoc="<取回文本>" title="<文件名>">`，sandbox SHALL 不含 `allow-same-origin` 或其它令牌；卡片本身不内嵌 iframe。预览响应带截断标记（超过 1 MiB）时 Dialog 在 iframe 上方显示 `文件超过 1 MiB，仅预览前 1 MiB`。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，按钮 `下载`（`Icon download`，accessible name `下载 <文件名>`）。点击后拉取图片 Blob URL，以 `download=<文件名>` 的临时链接触发下载后撤销该 URL；不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（预览 API 其余可预览文本类型）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入并 Toast `已复制到剪贴板`；剪贴板不可用、抛错或 reject 时 Toast `复制失败`；响应带截断标记时不写剪贴板并 Toast `文件过大，无法复制`。
其它扩展名（含无扩展名）不派生产物卡（仍在文件变更卡中列出）。`在编辑器中打开` SHALL 不渲染。预览请求失败（如文件已被删除的 404、415、图片过大的 413、网络错误）或返回的类型与卡片不符时 SHALL 显示 Toast，文案为 `ApiError` 信封 message（其余情况用 request_failed 的安全文案），不打开 Dialog、不写剪贴板、不触发下载、不留下未处理拒绝；401 不另出 Toast（沿用客户端既有的未登录通知）。拉取期间该卡片的操作按钮禁用，重复点击不并发请求；拉取结束时若焦点已不在任何元素上（浏览器在按钮禁用时把焦点移到 `body`），焦点 SHALL 回到被点的那个操作按钮且不因此滚动页面（`preventScroll`），焦点在别处时不动；组件卸载、切换会话或换账号时 SHALL abort 进行中的拉取并撤销已创建的 Blob URL，被 abort 的拉取不出 Toast。会话空间不可解析时不渲染产物卡。user 消息不渲染产物卡。

#### Scenario: html 预览隔离
- **WHEN** 助手消息变更含 `out/index.html`，点击 `打开网页预览 index.html`，预览 API 返回文本 `<h1>hi</h1><script>document.title='x'</script>`
- **THEN** 打开标题为 `index.html` 的 Dialog，内含 `sandbox` 属性恰为 `allow-scripts`、`srcdoc` 为该文本的 iframe；卡片标签 `HTML`、卡脚有 `可交互预览`；无 `在编辑器中打开`；预览 API 恰被调用一次且在点击之前未被调用
- **WHEN** 预览响应带 `X-Workbuddy-Truncated: 1`
- **THEN** Dialog 内显示 `文件超过 1 MiB，仅预览前 1 MiB`

#### Scenario: 图片下载与代码复制
- **WHEN** 变更含 `assets/chart.PNG` 与 `src/app.ts`，分别点击 `下载 chart.PNG` 与 `复制代码 app.ts`
- **THEN** 前者卡片标签 `PNG`，触发以 `chart.PNG` 为文件名的下载且其 Blob URL 随后被撤销；后者卡片标签 `TS`，剪贴板写入恰为预览 API 返回的文本并 Toast `已复制到剪贴板`

#### Scenario: 不派生与失败
- **WHEN** 变更含 `main.py` 与已被外部删除的 `gone.md`，点击 `复制代码 gone.md` 时预览 API 返回 404
- **THEN** `main.py` 只在文件变更卡中列出、无产物卡；`gone.md` 点击后出现信封文案 Toast，无剪贴板写入、无未处理拒绝

#### Scenario: 拉取中与卸载
- **WHEN** 点击 `打开网页预览 index.html` 后预览响应尚未返回，再次点击该卡片的任一操作按钮；另一例在图片预览响应返回之前切换到另一个会话，随后响应返回
- **THEN** 前者只发出一个预览请求，该卡片的两个 `打开网页预览` 按钮在响应返回前均为禁用；后者的请求被 abort，迟到的响应不触发下载、不出 Toast，其 Blob URL 被撤销
