# Delta: turn-artifacts（artifact-card，#536）

## ADDED Requirements

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感；文件名里唯一的 `.` 在开头时视为无扩展名，如 `.env`、`.html`）派生产物卡，位置在文件变更卡之后；正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本、不新增服务端端点。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击后拉取文本并打开 `Dialog`（标题为文件名），内含 `<iframe sandbox="allow-scripts" srcdoc="<取回文本>" title="<文件名>">`，sandbox SHALL 不含 `allow-same-origin` 或其它令牌；卡片本身不内嵌 iframe。预览响应带截断标记（超过 1 MiB）时 Dialog 在 iframe 上方显示 `文件超过 1 MiB，仅预览前 1 MiB`。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，按钮 `下载`（`Icon download`，accessible name `下载 <文件名>`）。点击后拉取图片 Blob URL，以 `download=<文件名>` 的临时链接触发下载后撤销该 URL；不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（预览 API 其余可预览文本类型）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入并 Toast `已复制到剪贴板`；剪贴板不可用、抛错或 reject 时 Toast `复制失败`；响应带截断标记时不写剪贴板并 Toast `文件过大，无法复制`。
其它扩展名（含无扩展名）不派生产物卡（仍在文件变更卡中列出）。`在编辑器中打开` SHALL 不渲染。预览请求失败（如文件已被删除的 404、415、图片过大的 413、网络错误）或返回的类型与卡片不符时 SHALL 显示 Toast，文案为 `ApiError` 信封 message（其余情况用 request_failed 的安全文案），不打开 Dialog、不写剪贴板、不触发下载、不留下未处理拒绝；401 不另出 Toast（沿用客户端既有的未登录通知）。拉取期间该卡片的操作按钮禁用，重复点击不并发请求；组件卸载、切换会话或换账号时 SHALL abort 进行中的拉取并撤销已创建的 Blob URL，被 abort 的拉取不出 Toast。会话空间不可解析时不渲染产物卡。user 消息不渲染产物卡。

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

## MODIFIED Requirements

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `会话页` 的助手块次序。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击以客户端导航前往 `/files?ws=<workspaceId>`（files-web 当前以 `?ws=` 表示空间，无文件预选参数；定位到该文件需 files-web 另行扩展，不在本 change）。会话 `workspaceId` 为 `null`、不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径，不渲染 `查看详情`。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内出现名为 `文件变更（2 个）` 的卡片，第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后 URL 为 `/files?ws=<该空间 id>`；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间，或空间列表读取中或读取失败
- **THEN** 卡片行只显示相对路径，无 `查看详情` 按钮，也不渲染产物卡
