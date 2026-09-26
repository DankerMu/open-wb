# files-web Specification

## Purpose
定义文件工作空间与审计的浏览器 API 客户端、安全预览组件及 `/files` 页面集成契约，包括同源请求、错误信封、工作空间 URL、惰性目录树、预览元数据、图片资源所有权及用户授权的病态格式深度规范化；正式扩展的浏览器走查由 files-harness 切片维护。
## Requirements
### Requirement: API 客户端扩展
`lib/api` SHALL 新增 `listWorkspaces()`、`createWorkspace({name, dir?})`、`listTree(workspaceId, path)`、`createDir(workspaceId, path)`、`fetchPreview(workspaceId, path) → {kind:'text'|'image', text?|url?, size, truncated}`（`size` 取自 `X-Workbuddy-Size`，文本与图片响应均带）、`listAudit({limit?, before?})`，并把 403 `sandbox_denied`、409 `conflict`、413 `preview_too_large`、415 `preview_unsupported` 解析为带 `code` 的错误对象；沿用既有 401 → 未登录态。六方法 SHALL 保持同源凭证和既有可选取消信号契约；路径作为数据进行 URL 编码。图片 URL 的释放 SHALL 由调用方在替换或卸载时负责。
#### Scenario: 方法与错误码
- WHEN 以 mock fetch 分别返回合法 201/200 与四种错误信封
- THEN 六方法路径、方法、body 与返回形状符合 workspaces/audit-core 契约；错误保留 status/code/message，401 回调保持既有语义
#### Scenario: 预览元数据与资源
- WHEN 文本/图片响应携带原始大小头且正文长度与之不同，截断头为 1，或空文本 size 0
- THEN size 保留头值而非正文大小，truncated 为 true（空文件无截断头则 false），文本原样返回，图片以保留正文与 MIME 的 Blob URL 返回供调用方释放
#### Scenario: 失败不变成预览
- WHEN 响应是错误信封、非 JSON 401、成功响应缺失/非法大小头或不支持的 Content-Type
- THEN 使用既有 ApiError/稳定 request_failed 回退；401 通知一次；不得把错误正文返回为预览或分配图片 URL

### Requirement: 文件预览纯组件
`mdRender(src)`、`CsvTable`、`CodeView`、`PreviewPane` SHALL 提供无网络依赖的安全预览。Markdown SHALL 支持 demo 的标题、列表、代码块、表格、行内代码、粗体和不可跳转链接，源 HTML 作为文本转义；代码内容 SHALL 保持字面值。CSV SHALL 以首行为表头并显示 `共 N 行 · 大文件仅预览前若干行`；其余文本 SHALL 显示带行号代码表，JSON 尝试格式化、失败保留原文。预览 SHALL 显示路径、大小、修改时间（查看者本地时区 `YYYY-MM-DD HH:mm`，24 小时制、各段补零）：由纯函数 `formatMtime(ms)` 以 `Date` 的本地分量拼接，不经 `toISOString`/`toLocale*`；毫秒 epoch `0` 按普通时刻格式化，非有限值显示 `—`；Markdown 默认渲染且可切换 `查看源码`/`渲染视图`，切换文件重置模式。图片 SHALL 用提供的 URL 渲染 img；组件不负责 URL 分配/释放。不支持类型 SHALL 显示 `该类型不支持预览`，提供的错误 message SHALL 内联显示；截断状态 SHALL 显示提示和原始总大小。移植文件 SHALL 保留来源说明，demo 原始文件头不得改动。
用户授权的病态深度规范化 SHALL 将规范节点每条祖先链的 `strong` 限制为最多 64 层；可省略超出的冗余粗体包装，但 SHALL 保留全部文字顺序、所有不可跳转链接及其作用范围和可见格式。普通/浅层 demo 行为不变，代码保持字面值；HTML 与 React SHALL 使用同一规范化结构，不使用文本截断、纯文本降级或危险 HTML 注入。
#### Scenario: 安全 Markdown
- WHEN 输入标题/列表/代码/链接及 script、javascript 目标、onerror 属性注入载荷
- THEN 语义 DOM 与支持的 demo 子集一致；源载荷不生成执行元素或事件属性；HTML 与 React 预览链接均为 href="#" 且鼠标/键盘操作不跳转，代码中标记保持字面值
#### Scenario: 表格与代码
- WHEN CSV 为一行表头及两行数据，或代码含两行和末尾空行
- THEN CSV 表头可见且注记共2行；代码表有三行并显示1..3行号，内容安全且保留空白
#### Scenario: 预览状态
- WHEN 切换 Markdown 渲染/源码后换文件，或展示图片、不支持类型、错误、截断文本
- THEN 新 Markdown 默认渲染；各状态显示对应内容、错误消息与原始大小，图片使用传入URL且不发起API调用
#### Scenario: 深层结构生命周期
- WHEN 同一实例从浅层预览切换到接近 1 MiB 的深层重建格式，再切换到普通文档、操作源码按钮并卸载
- THEN `strong` 祖先最多 64 层，全部文字及链接保留，开发/生产及 StrictMode 生命周期完成且无新增控制台/页面错误
#### Scenario: 修改时间本地格式
- WHEN 在固定的非 UTC 时区（如 `Asia/Shanghai`）下调用 `formatMtime`，输入 `new Date(2026, 0, 5, 7, 3).getTime()`、当日 `23:59` 与次日 `00:00`、`Date.UTC(2026, 8, 25, 8, 31)`、`0` 与 `NaN`，并渲染 `PreviewPane` 预览头
- THEN 依次得到 `2026-01-05 07:03`、`… 23:59`、`… 00:00`、`2026-09-25 16:31`（本地而非 UTC 的 `08:31`）、`1970-01-01 08:00`、`—`；`.files-preview-meta` 文本匹配 `/^\S+ \S+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/` 且不含 ISO 的 `T` 分隔与 `Z` 后缀

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间`）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人或不存在）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数），不向该 id 发起 tree/file 请求、不产生 console error。无空间时 SHALL 显示 `未选择工作空间` 与树区 `EmptyState` 选择/创建引导（`先选择或创建工作空间` / `使用左上角 ＋ 新建工作空间`），区别于已选空间的空目录，不宣传未交付的挂载能力。左栏为切换器按钮卡（`Icon layout-grid` + 空间名 + **逻辑路径** `<account>/<dir>`，由 Principal `account` 与 workspace `dir` 拼接；服务器返回的绝对 `root` SHALL 不出现在任何界面文本、`title`、`aria-*` 属性、`placeholder` 或下拉选项中）、`工作空间目录` 标题与 `＋` 按钮（菜单：`新建文件夹`、`新建工作空间`）、目录树（目录条目 `Icon folder`，文件条目按扩展名选图标（`png|jpg|jpeg` → `image`，`zip|tar|gz` → `archive`，`csv` → `table`，`md|txt|log` → `file-text`，`json|js|ts|tsx|html` → `file-code`，其它 `file`）并在行尾显示大小（`< 1024` → `N B`，否则 `KB`/`MB`/`GB` 保留一位小数）；文件条目的可访问名恰为文件名；展开后为空的目录显示 `空目录`；空间根一层为空时树区显示 `EmptyState`（`该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹`，不提挂载））；右栏为预览面板：预览头显示文件图标、路径、大小、修改时间（查看者本地时区 `YYYY-MM-DD HH:mm`，24 小时制、各段补零）；未选文件时显示 `EmptyState`（`未选择文件` / `在左侧目录树中选择一个文件进行预览`）；不支持类型显示 `EmptyState`（`该类型不支持预览` / `<文件名> · <大小>　二进制或未识别格式`，大小与树条目同一格式）。树根行 SHALL 显示 `Icon shield` + 空间名（可访问名 `展开|折叠 <空间名>`，不再显示字面 `root`）与副行逻辑路径。切换器弹层 SHALL 含搜索框（placeholder `搜索工作空间`，按空间名/逻辑路径的大小写无关子串过滤列表，无匹配显示 `无匹配的工作空间`）、空间列表（每项空间名 + 逻辑路径，当前项打勾）与 `＋ 新建工作空间`；选择即更新 `?ws=` 并清空展开态与当前文件。`新建工作空间` 对话框 SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与沙箱目录创建提示，空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录，根项文案 `根目录　<空间名>` 而非 `根目录　root`），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。

#### Scenario: 空间切换与新建
- WHEN 已登录且有两个空间，访问 `/files`、打开切换器选第二个、再新建第三个
- THEN URL 依次为 `?ws=<第一个>`、`?ws=<第二个>`、`?ws=<新建>`；切换器卡与树根行显示新名与逻辑路径 `zhangsan/<dir>`，页面任何文本不含服务器绝对路径；刷新后仍停留在 `?ws=` 指向的空间

#### Scenario: 非法 ?ws= 回退
- WHEN 访问 `/files?ws=<他人或不存在的 id>`
- THEN 页面显示列表首个空间且 URL 被 `replace` 为 `?ws=<首个 id>`；对非法 id 零请求；无 console error

#### Scenario: 无空间空态
- WHEN 账号无任何空间
- THEN 显示 `未选择工作空间`、树区空态文案，`＋` 菜单仍可新建工作空间；`新建文件夹` 提示 `当前工作空间没有可写目录`

#### Scenario: URL 纠正不丢上下文
- WHEN 缺省或非法 ws 需要纠正且 URL 有其它查询参数/hash
- THEN replace 保留其它参数/hash，无空间时移除 ws；列表确定前及纠正期间对非法 id 零 tree/file 请求

#### Scenario: 创建校验和错误
- WHEN 新建空间为空名或返回 409，或新建目录为空名、含任一斜线、返回 409
- THEN 分别显示约定文案；本地无效输入零 mutation；其它 ApiError 显示 message，网络/非法信封使用既有稳定回退

#### Scenario: 树条目图标与大小
- WHEN 根一层含目录 `out` 与文件 `readme.md`（2048 B）、`notes.csv`（1536 B）、`logo.png`（90492109 B）、`归档.zip`（12 B），点击 `readme.md`
- THEN 目录行为 `folder` 图标；四个文件依次显示 `file-text`/`table`/`image`/`archive` 图标与 `2.0 KB`、`1.5 KB`、`86.3 MB`、`12 B`；文件按钮可访问名恰为文件名；预览头显示 `file-text` 图标、路径与 `2.0 KB · <formatMtime(mtime)>`（本地 `YYYY-MM-DD HH:mm`）

#### Scenario: 空目录与空态文案
- WHEN 空间根一层为空；或根含空目录 `out` 与 `归档.zip`（90492109 B），展开 `out`、再点击 `归档.zip`
- THEN 空根时树区显示 `该工作空间暂无目录` 与 `点击左上角 ＋ 新建文件夹`，不出现 `空目录`；未选文件时预览区显示 `未选择文件` 与 `在左侧目录树中选择一个文件进行预览`；展开 `out` 显示 `空目录`；点击 zip 后预览显示 `该类型不支持预览` 与 `归档.zip · 86.3 MB　二进制或未识别格式`，且不发 file 请求

#### Scenario: 绝对路径不出界面且可按逻辑路径过滤
- WHEN 已登录账号 `zhangsan` 有空间 `数据分析`（dir `analytics`）与 `设计文档`（dir `design-docs`），其 `root` 带服务器私有前缀；依次处于初始页、切换器打开、`新建文件夹` 对话框打开、`新建工作空间` 对话框打开；在切换器搜索框分别输入 `数据`、`DESIGN`、`zhangsan/ana`、`不存在`
- THEN 每个状态下页面文本与所有 `title`/`aria-label`/`aria-description`/`placeholder` 属性都不含任一 `root` 值或其私有前缀；切换器卡含 `layout-grid` 图标、空间名与 `zhangsan/analytics`；树根按钮可访问名 `折叠 数据分析`、含 `shield` 图标、副行 `zhangsan/analytics`；位置下拉首项 `根目录　数据分析`；四次输入分别只剩 `数据分析`、只剩 `设计文档`、只剩 `数据分析`、列表为空并显示 `无匹配的工作空间`

### Requirement: 目录树与预览
目录树 SHALL 进入空间请求根一层并默认展开根；目录首次展开请求该层，折叠重开复用成功缓存，保持服务端排序与 workspace-relative 路径。位置下拉 SHALL 仅包含根和成功加载过的目录，已折叠缓存可复用，不额外递归请求。点击文件 SHALL 接入既有 `文件预览纯组件` 要求（安全 Markdown/CSV/代码/图片、元数据、截断与错误），不得重写 renderer。前端 SHALL 先按不区分大小写的 md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg 集合判断；其它类型显示 `该类型不支持预览`，不发 file 请求。
页面 SHALL 以 workspace identity 隔离树/当前文件/预览局部模式；同 workspace 同文件文本刷新保留 Markdown 模式。取消、切换和卸载 SHALL 阻止旧响应提交状态；图片 URL SHALL 在替换、卸载及迟到结果丢弃时释放，abort 本身不替代释放。

#### Scenario: 一次浏览
- WHEN 根包含 out/、readme.md、notes.csv、logo.png、归档.zip，展开 out 并依次点击四文件，随后新建目录
- THEN out 首次展开恰一次 tree 请求，重开不重取；Markdown h1/源码行号切换、CSV 表头/共2行、图片可见；zip unsupported 且零 file 请求；新目录成功后所属层更新

#### Scenario: 工作空间和请求归属
- WHEN 两空间均有 readme.md，旧树/预览/创建响应在切换后完成，或同文件刷新
- THEN 新空间不被旧响应污染且 Markdown 默认渲染；同文件刷新保留模式；新建目录下拉不触发未展开目录探测

#### Scenario: 图片资源完整生命周期
- WHEN 图片被替换、页面卸载、或已取消请求迟到分配图片 URL，包含 StrictMode 生命周期
- THEN 每个分配的 URL 在失去 owner 时释放，旧结果不显示；新请求/新会话保持可用

#### Scenario: 内联错误
- WHEN 当前 tree/preview/mutation 返回非 401 错误或网络失败
- THEN 对应表面结束 loading 并显示信封 message 或稳定回退；当前 401 交由认证守卫，不显示旧页面错误

### Requirement: 文件界面与键盘可用性
文件页 SHALL 使用与应用一致的浅色/深色设计 token，桌面左右分栏（树栏 `280px`，`≤900px` 时 `210px`），`≤760px` 纵向布局（树在上、预览在下，各自内部滚动）；长路径与文件名不得撑宽页面（树条目单行 `text-overflow: ellipsis`，条目 `title` 为全名），代码和表格在预览容器内部滚动（容器 `overflow: auto`）。创建对话框 SHALL 为阻止背景交互的模态，打开时聚焦首个表单控件，Tab/Shift+Tab 留在框内，Escape/取消关闭并恢复触发器焦点；请求进行中保持忙碌反馈且不得重复提交，但仍允许取消等待，通过既有 AbortController 与代际守卫防止迟到响应影响新界面。取消等待不承诺撤销服务端已完成操作，界面 SHALL 明示可刷新确认结果。创建对话框 SHALL 经 `Dialog` 基元渲染并以请求进行中作为 `busy`：打开时的首个表单控件为 `新建工作空间` 的 `工作空间名称`、`新建文件夹` 的 `位置`；右上 `关闭`、Escape、遮罩点击与 `取消` 同义；取消类关闭后焦点 SHALL 回到发起该流程的触发器——经切换器 `＋ 新建工作空间` 打开时为 `选择工作空间`，经 `＋` 菜单打开时为 `新建`；提交按钮因请求进行中被禁用后焦点 SHALL 仍在对话框内。`＋` 菜单与切换器 SHALL 分别经 `Menu` 与 `Popover` 基元（切换器打开时聚焦搜索框，Escape 关闭后焦点回 `选择工作空间`）。既有账号/请求代际隔离与安全预览语义 SHALL 保持。

#### Scenario: 创建弹窗的键盘闭环
- WHEN 用户以键盘打开创建弹窗、循环 Tab、按 Escape
- THEN 背景控件不接收焦点，弹窗关闭后触发器重新获得焦点；进行中的创建可取消等待，迟到响应不得关闭或覆盖较新的弹窗

#### Scenario: 长名截断与布局规则
- WHEN 树根含名称 ≥48 字符的目录与文件
- THEN 两个条目按钮的 `title` 恰为全名，目录按钮可访问名仍为 `展开|折叠 <名>`、文件按钮可访问名仍恰为文件名；`files.css` 中树栏为 `280px`、`max-width: 900px` 下为 `210px`、`max-width: 760px` 下纵向，`.files-tree-name` 单行省略，代码/表格预览容器 `overflow: auto`（像素宽度与无横向溢出由浏览器验收证明）

#### Scenario: 创建流程焦点闭环
- WHEN 在 jsdom 经切换器 `＋ 新建工作空间` 打开对话框后按 Escape；经 `＋` 菜单 `新建工作空间` 打开后点击 `取消`；经 `＋` 菜单 `新建文件夹` 打开后点击 `关闭`；在 `新建文件夹` 中聚焦 `创建` 并提交、`POST …/dirs` 挂起后点击 `取消`；经 `＋` 菜单 `新建文件夹` 打开后点击遮罩；打开切换器后按 Escape；在 `新建工作空间` 中聚焦 `创建` 并提交、`POST /api/workspaces` 挂起后以 409 解决
- THEN 切换器打开时焦点在搜索框；两个对话框打开时焦点分别在 `工作空间名称` 与 `位置`，且 `aria-modal="true"`；四种取消类关闭（Escape、`取消`、`关闭`、遮罩）后焦点依次回到 `选择工作空间`、`新建`、`新建`、`新建`，均 0 次 POST；切换器 Escape 后焦点回 `选择工作空间`；挂起期间 `创建` 禁用、焦点在对话框内的 `关闭`，取消后请求 signal 已中止、焦点回 `新建`；工作空间挂起期间 `创建` 禁用、焦点在 `关闭`，409 后显示 `同名工作空间已存在`、对话框仍开、`创建` 可用、焦点在对话框内；菜单项恰为 `新建文件夹`、`新建工作空间`，菜单 Escape 后焦点回 `新建`

### Requirement: 创建浮层的焦点时序与模态清理
经切换器或 `新建` 菜单打开的 `新建工作空间`、`新建文件夹` 对话框 SHALL 均为 `aria-modal="true"`，其初始焦点（`工作空间名称` / `位置`）SHALL 在菜单或弹层关闭后延迟一个宏任务的回焦执行之后仍然成立。任一取消类关闭（`取消`、`关闭`、Escape、点遮罩）之后，`document.body` SHALL 不残留 `pointer-events` 内联样式，应用根 SHALL 不残留 `aria-hidden`。创建请求挂起期间点遮罩 SHALL 与 `取消` 等价：关闭对话框、中止该请求、焦点回到触发器，且不再发出新请求。

#### Scenario: 初始焦点经受延迟回焦
- **WHEN** 经菜单或切换器打开 `新建工作空间`，或经菜单选择 `新建文件夹`，并等待一个宏任务
- **THEN** 对话框为 `aria-modal="true"`，`document.activeElement` 仍为 `工作空间名称` / `位置`

#### Scenario: 取消类关闭无模态残留
- **WHEN** 经菜单路径与切换器路径各做一次取消类关闭且焦点已回到触发器
- **THEN** `document.body.style.pointerEvents` 为空串，渲染容器无 `aria-hidden` 属性

#### Scenario: 挂起期点遮罩中止请求
- **WHEN** `新建文件夹` 提交后 `POST …/dirs` 挂起，等待一个宏任务后按压遮罩
- **THEN** 对话框关闭，该请求 signal 已中止，焦点回到 `新建`，全程恰 1 次 POST

