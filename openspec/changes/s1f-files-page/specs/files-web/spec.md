## MODIFIED Requirements

### Requirement: API 客户端扩展
`lib/api` SHALL 提供 `listWorkspaces()`、`createWorkspace({name, dir?})`、`listTree(workspaceId, path)`、`createDir(workspaceId, path)`、`fetchPreview(workspaceId, path) → {kind:'text'|'image', text?|url?, size, truncated}`（`size` 取自 `X-Workbuddy-Size`，文本与图片响应均带）、`listAudit({limit?, before?})`，以及 change s1f-files-page 新增的 `listArchive(workspaceId, path) → {format, entries, truncated}`、`moveEntry(workspaceId, {from, to}) → {path}`、`deleteEntry(workspaceId, path) → void`（204）、`issuePreviewToken(workspaceId) → {token, base, officeBase, expiresAt, documentMaxBytes, officeAvailable}`，与两个只拼地址、不发请求的纯函数 `fileUrl(workspaceId, path)`（`/api/workspaces/<id>/file?path=<编码>`）和 `downloadUrl(workspaceId, path)`（`/api/workspaces/<id>/download?path=<编码>`）。它 SHALL 把 403 `sandbox_denied`、409 `conflict`、413 `preview_too_large`、415 `preview_unsupported` 解析为带 `code` 的错误对象；沿用既有 401 → 未登录态。全部发请求的方法 SHALL 保持同源凭证和既有可选取消信号契约；路径作为数据进行 URL 编码。`fetchPreview` 按响应的 `Content-Type` 判定：`text/plain` → `text`；`image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/bmp`、`image/x-icon` → `image`（以保留正文与 MIME 的 Blob 地址返回）；其它类型（含 `audio/*`、`video/*`、`image/svg+xml`、`text/html`）一律按失败处理——音视频不经它读取。图片地址的释放 SHALL 由调用方在替换或卸载时负责。新增方法的实现 SHALL 放在 `web/src/lib/api-files.ts`，其请求传输由 `api.ts` 注入、对 `api.ts` 只有类型导入、导出只供 `api.ts` 使用（与 chat-web「API 客户端源码模块划分」对 `api-sessions.ts` 的规定同形）；`api.ts` 仍是唯一公共入口，每个文件 ≤800 行。各响应 SHALL 严格解析：键集或类型不符的成功响应按 request_failed 处理，不把残缺对象交给调用方。

#### Scenario: 方法与错误码
- **WHEN** 以 mock fetch 分别返回合法 201/200/204 与四种错误信封
- **THEN** 十个发请求的方法的路径、方法、body 与返回形状符合 workspaces、file-operations、preview-origin 与 audit-core 契约（`moveEntry` 为 `POST …/move` + JSON `{from,to}`；`deleteEntry` 为 `DELETE …/entries?path=`、无 body；`issuePreviewToken` 为无 body 的 `POST …/preview-token`；`listArchive` 为 `GET …/archive?path=`）；错误保留 status/code/message，401 回调保持既有语义

#### Scenario: 预览元数据与资源
- **WHEN** 文本/图片响应携带原始大小头且正文长度与之不同，截断头为 1，或空文本 size 0；图片响应的类型为 `image/gif`、`image/webp`
- **THEN** size 保留头值而非正文大小，truncated 为 true（空文件无截断头则 false），文本原样返回，图片以保留正文与 MIME 的 Blob URL 返回供调用方释放

#### Scenario: 失败不变成预览
- **WHEN** 响应是错误信封、非 JSON 401、成功响应缺失/非法大小头或不支持的 Content-Type（`text/html`、`image/svg+xml`、`video/mp4`）
- **THEN** 使用既有 ApiError/稳定 request_failed 回退；401 通知一次；不得把错误正文返回为预览或分配图片 URL

#### Scenario: 地址函数与严格解析
- **WHEN** 调用 `fileUrl("w1", "报告 2026/a b#1.mp4")` 与 `downloadUrl("w1", "a&b.txt")`；`issuePreviewToken` 的成功响应缺少 `base`、或 `listArchive` 的 `entries` 含一个 `type` 为 `link` 的项、或 `moveEntry` 的响应是 `{}`
- **THEN** 两个地址的 `path` 参数经 `encodeURIComponent` 编码、解码后等于原路径，调用它们没有发出请求；三个残缺响应都以 request_failed 拒绝

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 web 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`api-files.ts` 对 `./api.js` 只有 `import type`，调用方仍只从 `lib/api.js` 取得客户端与类型

### Requirement: 文件预览纯组件
`mdRender(src)` 与预览面板 `PreviewPane` SHALL 提供安全预览。Markdown SHALL 支持标题、列表、代码块、表格、行内代码、粗体和不可跳转链接，源 HTML 作为文本转义；代码内容 SHALL 保持字面值。`PreviewPane` SHALL 显示 file-previewers「预览头、下载与不可预览的呈现」规定的预览头（路径、大小、修改时间、下载链接）并按 file-previewers「类别判定与预览器选择」选择预览器；各类预览器的行为（表格、源码与高亮、图片、网页、PDF、办公文档、音视频、Notebook、压缩包）由 file-previewers 规定，本条不重复。修改时间由纯函数 `formatMtime(ms)` 以 `Date` 的本地分量拼接为查看者本地时区的 `YYYY-MM-DD HH:mm`（24 小时制、各段补零），不经 `toISOString`/`toLocale*`；毫秒 epoch `0` 按普通时刻格式化，非有限值显示 `—`。Markdown 默认渲染且可切换 `查看源码`/`渲染视图`，切换文件重置模式。组件不负责图片地址的分配与释放。`web/src/lib/md-render.ts` 的移植来源说明 SHALL 保留。预览面板与各预览器 SHALL 只用 `web/src/components/ui` 的组件与 Tailwind 类实现，不依赖旧类名与 `.css` 文件。
用户授权的病态深度规范化 SHALL 将规范节点每条祖先链的 `strong` 限制为最多 64 层；可省略超出的冗余粗体包装，但 SHALL 保留全部文字顺序、所有不可跳转链接及其作用范围和可见格式。普通/浅层行为不变，代码保持字面值；HTML 与 React SHALL 使用同一规范化结构，不使用文本截断、纯文本降级或危险 HTML 注入。

#### Scenario: 安全 Markdown
- WHEN 输入标题/列表/代码/链接及 script、javascript 目标、onerror 属性注入载荷
- THEN 语义 DOM 与支持的子集一致；源载荷不生成执行元素或事件属性；HTML 与 React 预览链接均为 href="#" 且鼠标/键盘操作不跳转，代码中标记保持字面值

#### Scenario: 表格与代码
- WHEN CSV 为一行表头及两行数据，或代码含两行和末尾空行
- THEN CSV 表头可见且注记共2行；代码表有三行并显示1..3行号，内容安全且保留空白（表格与源码预览器的完整规则在 file-previewers「Markdown、表格、图片与 SVG」与「源码视图与语法高亮」，本场景只保留既有的两条断言）

#### Scenario: 预览状态
- WHEN 切换 Markdown 渲染/源码后换文件，或展示图片、不支持类型、错误、截断文本
- THEN 新 Markdown 默认渲染；各状态显示 file-previewers 规定的内容、文案与原始大小，图片使用传入 URL 且不发起 API 调用；每种状态下预览头都有 `下载 <文件名>` 链接

#### Scenario: 深层结构生命周期
- WHEN 同一实例从浅层预览切换到接近 1 MiB 的深层重建格式，再切换到普通文档、操作源码按钮并卸载
- THEN `strong` 祖先最多 64 层，全部文字及链接保留，开发/生产及 StrictMode 生命周期完成且无新增控制台/页面错误

#### Scenario: 修改时间本地格式
- WHEN 在固定的非 UTC 时区（如 `Asia/Shanghai`）下调用 `formatMtime`，输入 `new Date(2026, 0, 5, 7, 3).getTime()`、当日 `23:59` 与次日 `00:00`、`Date.UTC(2026, 8, 25, 8, 31)`、`0` 与 `NaN`，并渲染 `PreviewPane` 预览头
- THEN 依次得到 `2026-01-05 07:03`、`… 23:59`、`… 00:00`、`2026-09-25 16:31`（本地而非 UTC 的 `08:31`）、`1970-01-01 08:00`、`—`；预览头的元数据文本（`data-slot="preview-meta"`）匹配 `/^\S+ \S+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/` 且不含 ISO 的 `T` 分隔与 `Z` 后缀

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间`）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人、不存在，或 `s1f-session-list-temp-space` 规定的不列出的临时空间）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数，同时移除 `path`），不向该 id 发起 tree/file 请求、不产生 console error。空间列表恰为 `GET /api/workspaces` 的结果，本页不另行过滤或补充。无空间时 SHALL 显示 `未选择工作空间` 与树区空态选择/创建引导（`先选择或创建工作空间` / `使用左上角 ＋ 新建工作空间`），区别于已选空间的空目录，不宣传未交付的挂载与上传能力。左栏为切换器按钮（`Icon layout-grid` + 空间名 + **逻辑路径** `<account>/<dir>`，由 Principal `account` 与 workspace `dir` 拼接；服务器返回的绝对 `root` SHALL 不出现在任何界面文本、`title`、`aria-*` 属性、`placeholder` 或下拉选项中）、`工作空间目录` 标题、`刷新` 按钮与 `＋` 按钮（accessible name `新建`；菜单：`新建文件夹`、`新建工作空间`）、目录树（目录条目 `Icon folder`，文件条目按 file-previewers 的类别取图标并在行尾显示大小（`< 1024` → `N B`，否则 `KB`/`MB`/`GB` 保留一位小数）；文件条目的可访问名恰为文件名；展开后为空的目录显示 `空目录`；空间根一层为空时树区显示空态（`该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹`，不提挂载））；右栏为预览面板；未选文件时显示空态（`未选择文件` / `在左侧目录树中选择一个文件进行预览`）。树根行 SHALL 显示 `Icon shield` + 空间名（可访问名 `展开|折叠 <空间名>`）与副行逻辑路径。切换器弹层 SHALL 含搜索框（placeholder `搜索工作空间`，按空间名/逻辑路径的大小写无关子串过滤列表，无匹配显示 `无匹配的工作空间`）、空间列表（每项空间名 + 逻辑路径，当前项打勾）与 `＋ 新建工作空间`；选择即更新 `?ws=`、移除 `path` 并清空展开态与当前文件。`新建工作空间` 对话框 SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与沙箱目录创建提示（说明恰为 `将在你的沙箱内创建同名目录`），空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录，根项文案 `根目录　<空间名>`），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。本页 SHALL NOT 提供上传、工作空间删除与工作空间改名的入口。整页 SHALL 只用 `web/src/components/ui` 的组件与 Tailwind 类实现，`web/src/features/files` 下不存在 `.css` 文件（ui-foundation「组件分层」）。

#### Scenario: 空间切换与新建
- WHEN 已登录且有两个空间，访问 `/files`、打开切换器选第二个、再新建第三个
- THEN URL 依次为 `?ws=<第一个>`、`?ws=<第二个>`、`?ws=<新建>`；切换器按钮与树根行显示新名与逻辑路径 `zhangsan/<dir>`，页面任何文本不含服务器绝对路径；刷新后仍停留在 `?ws=` 指向的空间

#### Scenario: 非法 ?ws= 回退
- WHEN 访问 `/files?ws=<他人或不存在的 id>&path=a.md`
- THEN 页面显示列表首个空间且 URL 被 `replace` 为 `?ws=<首个 id>`（`path` 被移除）；对非法 id 零请求；无 console error

#### Scenario: 无空间空态
- WHEN 账号无任何空间
- THEN 显示 `未选择工作空间`、树区空态文案，`＋` 菜单仍可新建工作空间：经 `新建` → `新建工作空间` 填名提交后恰一次 `POST /api/workspaces`，对话框关闭、URL 为 `?ws=<新 id>`、切换器显示新空间名、树区空态 `先选择或创建工作空间` 消失；`新建文件夹` 提示 `当前工作空间没有可写目录`

#### Scenario: URL 纠正不丢上下文
- WHEN 缺省或非法 ws 需要纠正且 URL 有其它查询参数/hash
- THEN replace 保留 `ws`、`path` 之外的其它参数与 hash，无空间时移除 ws；列表确定前及纠正期间对非法 id 零 tree/file 请求

#### Scenario: 创建校验和错误
- WHEN 新建空间为空名或返回 409，或新建目录为空名、含任一斜线、返回 409
- THEN 分别显示约定文案；本地无效输入零 mutation；其它 ApiError 显示 message，网络/非法信封使用既有稳定回退

#### Scenario: 树条目图标与大小
- WHEN 根一层含目录 `out` 与文件 `readme.md`（2048 B）、`notes.csv`（1536 B）、`logo.png`（90492109 B）、`归档.zip`（12 B），点击 `readme.md`
- THEN 目录行为 `folder` 图标；四个文件依次显示 `file-text`/`table`/`image`/`archive` 图标与 `2.0 KB`、`1.5 KB`、`86.3 MB`、`12 B`；文件按钮可访问名恰为文件名；预览头显示 `file-text` 图标、路径与 `2.0 KB · <formatMtime(mtime)>`（本地 `YYYY-MM-DD HH:mm`）

#### Scenario: 空目录与空态文案
- WHEN 空间根一层为空；或根含空目录 `out`，展开 `out`
- THEN 空根时树区显示 `该工作空间暂无目录` 与 `点击左上角 ＋ 新建文件夹`，不出现 `空目录`；未选文件时预览区显示 `未选择文件` 与 `在左侧目录树中选择一个文件进行预览`；展开 `out` 显示 `空目录`

#### Scenario: 绝对路径不出界面且可按逻辑路径过滤
- WHEN 已登录账号 `zhangsan` 有空间 `数据分析`（dir `analytics`）与 `设计文档`（dir `design-docs`），其 `root` 带服务器私有前缀；依次处于初始页、切换器打开、`新建文件夹` 对话框打开、`新建工作空间` 对话框打开；在切换器搜索框分别输入 `数据`、`DESIGN`、`zhangsan/ana`、`不存在`
- THEN 每个状态下页面文本与所有 `title`/`aria-label`/`aria-description`/`placeholder` 属性都不含任一 `root` 值或其私有前缀；切换器按钮含 `layout-grid` 图标、空间名与 `zhangsan/analytics`；树根按钮可访问名 `折叠 数据分析`、含 `shield` 图标、副行 `zhangsan/analytics`；位置下拉首项 `根目录　数据分析`；四次输入分别只剩 `数据分析`、只剩 `设计文档`、只剩 `数据分析`、列表为空并显示 `无匹配的工作空间`

#### Scenario: 没有范围外的入口
- WHEN 查看文件页的全部按钮、菜单项与切换器弹层
- THEN 没有上传、删除工作空间、重命名工作空间相关的控件

### Requirement: 目录树与预览
目录树 SHALL 进入空间请求根一层并默认展开根；目录首次展开请求该层，折叠重开复用成功缓存，保持服务端排序与 workspace-relative 路径。位置下拉 SHALL 仅包含根和成功加载过的目录，已折叠缓存可复用，不额外递归请求。点击文件 SHALL 交给 `PreviewPane`（「文件预览纯组件」与 file-previewers），不得另写渲染器。浏览器 SHALL NOT 以扩展名白名单预先判定「不支持」：除 file-previewers「类别判定与预览器选择」里按扩展名确定走其它数据来源的类别（PDF、办公文档、音视频、压缩包）与网页的渲染视图（`html`、`htm` 默认由隔离预览来源加载，切到源码视图时才发 `file` 请求，见 file-previewers「隔离来源的嵌入与令牌」）之外，选中文件恰发出一次 `file` 请求，是否可预览由响应决定。`刷新` 按钮 SHALL 对全部已加载过的目录重新请求 `tree` 并重新取当前文件的预览，保留展开状态、选中文件与 Markdown 等视图模式；刷新失败时保留旧列表并就地显示失败文案。
页面 SHALL 以 workspace identity 隔离树/当前文件/预览局部模式；同 workspace 同文件文本刷新保留视图模式。取消、切换和卸载 SHALL 阻止旧响应提交状态；图片 URL SHALL 在替换、卸载及迟到结果丢弃时释放，abort 本身不替代释放。

#### Scenario: 一次浏览
- WHEN 根包含 out/、readme.md、notes.csv、logo.png、归档.zip、blob.bin，展开 out 并依次点击五个文件，随后新建目录
- THEN out 首次展开恰一次 tree 请求，重开不重取；Markdown h1/源码行号切换、CSV 表头/共2行、图片可见；zip 显示压缩包列表（一次 `archive` 请求、零 `file` 请求）；`blob.bin` 恰一次 `file` 请求、收到 415 后显示 `该类型不支持预览`；新目录成功后所属层更新
- WHEN 同一棵树里另有 `site/index.html`，选中它，再点 `查看源码`
- THEN 选中时零 `file` 请求（渲染视图来自隔离预览来源）；点 `查看源码` 后恰一次 `file` 请求

#### Scenario: 工作空间和请求归属
- WHEN 两空间均有 readme.md，旧树/预览/创建响应在切换后完成，或同文件刷新
- THEN 新空间不被旧响应污染且 Markdown 默认渲染；同文件刷新保留模式；新建目录下拉不触发未展开目录探测

#### Scenario: 图片资源完整生命周期
- WHEN 图片被替换、页面卸载、或已取消请求迟到分配图片 URL，包含 StrictMode 生命周期
- THEN 每个分配的 URL 在失去 owner 时释放，旧结果不显示；新请求/新会话保持可用

#### Scenario: 内联错误
- WHEN 当前 tree/preview/mutation 返回非 401 错误或网络失败
- THEN 对应表面结束 loading 并显示信封 message 或稳定回退；当前 401 交由认证守卫，不显示旧页面错误

#### Scenario: 手动刷新
- WHEN 根与 `out` 已展开、当前以源码模式预览 `readme.md`，磁盘上新增了 `out/new.md`，点 `刷新`
- THEN 恰对根与 `out` 各发一次 `tree`、对 `readme.md` 发一次 `file`；`out/new.md` 出现；`out` 仍展开，`readme.md` 仍被选中且仍是源码模式

### Requirement: 文件界面与键盘可用性
文件页 SHALL 使用与应用一致的浅色/深色主题变量。文件页 SHALL NOT 自涂页面级底色：树与预览的分栏容器（`data-slot="files-layout"`）与预览区容器（`data-slot="files-preview"`）不设背景，页面底色只来自 `body` 的 `--background`（ui-foundation「主题映射」；#420）。视口宽于外壳的窄屏断点（大于 760）时目录树与预览左右分栏（树在左、预览在右，预览区占剩余宽度）；不超过 760 时纵向排列（树在上、预览在下，各自内部滚动）。任何视口下页面 SHALL NOT 出现横向滚动：长路径与文件名单行省略（条目 `title` 为全名），源码、表格、图片、视频与 iframe 在预览容器内部滚动或缩放。目录树 SHALL 可由键盘操作：每个条目是可聚焦的按钮，目录按钮带 `aria-expanded`，Enter / 空格展开折叠或选中；每个非根条目另有 `更多操作 <名>` 菜单按钮（见「文件操作界面」）。创建对话框 SHALL 为阻止背景交互的模态，打开时聚焦首个表单控件，Tab/Shift+Tab 留在框内，Escape/取消关闭并恢复触发器焦点；请求进行中保持忙碌反馈且不得重复提交，但仍允许取消等待，通过既有 AbortController 与代际守卫防止迟到响应影响新界面。取消等待不承诺撤销服务端已完成操作，界面 SHALL 明示可刷新确认结果。创建对话框 SHALL 经拷入层 `dialog` 渲染：打开时的首个表单控件为 `新建工作空间` 的 `工作空间名称`、`新建文件夹` 的 `位置`；右上 `关闭`、Escape、遮罩点击与 `取消` 同义；取消类关闭后焦点 SHALL 回到发起该流程的触发器——经切换器 `＋ 新建工作空间` 打开时为 `选择工作空间`，经 `＋` 菜单打开时为 `新建`；提交按钮因请求进行中被禁用后焦点 SHALL 仍在对话框内。`＋` 菜单与切换器 SHALL 分别经拷入层 `dropdown-menu` 与 `popover`（切换器打开时聚焦搜索框，Escape 关闭后焦点回 `选择工作空间`）。既有账号/请求代际隔离与安全预览语义 SHALL 保持。

#### Scenario: 创建弹窗的键盘闭环
- WHEN 用户以键盘打开创建弹窗、循环 Tab、按 Escape
- THEN 背景控件不接收焦点，弹窗关闭后触发器重新获得焦点；进行中的创建可取消等待，迟到响应不得关闭或覆盖较新的弹窗

#### Scenario: 长名截断与布局规则
- WHEN 树根含名称 ≥48 字符的目录与文件，并预览一个单行 5000 字符的源码文件与一张宽 4000 的图片
- THEN 两个条目按钮的 `title` 恰为全名，目录按钮可访问名仍为 `展开|折叠 <名>`、文件按钮可访问名仍恰为文件名；名称元素带单行省略的样式；源码容器可内部横向滚动；页面本身无横向溢出与图片不超出预览区由浏览器走查证明（files-harness）

#### Scenario: 创建流程焦点闭环
- WHEN 在 jsdom 经切换器 `＋ 新建工作空间` 打开对话框后按 Escape；经 `＋` 菜单 `新建工作空间` 打开后点击 `取消`；经 `＋` 菜单 `新建文件夹` 打开后点击 `关闭`；在 `新建文件夹` 中聚焦 `创建` 并提交、`POST …/dirs` 挂起后点击 `取消`；经 `＋` 菜单 `新建文件夹` 打开后点击遮罩；打开切换器后按 Escape；在 `新建工作空间` 中聚焦 `创建` 并提交、`POST /api/workspaces` 挂起后以 409 解决
- THEN 切换器打开时焦点在搜索框；两个对话框打开时焦点分别在 `工作空间名称` 与 `位置`，且 `aria-modal="true"`；四种取消类关闭（Escape、`取消`、`关闭`、遮罩）后焦点依次回到 `选择工作空间`、`新建`、`新建`、`新建`，均 0 次 POST；切换器 Escape 后焦点回 `选择工作空间`；挂起期间 `创建` 禁用、焦点在对话框内的 `关闭`，取消后请求 signal 已中止、焦点回 `新建`；工作空间挂起期间 `创建` 禁用、焦点在 `关闭`，409 后显示 `同名工作空间已存在`、对话框仍开、`创建` 可用、焦点在对话框内；菜单项恰为 `新建文件夹`、`新建工作空间`，菜单 Escape 后焦点回 `新建`

#### Scenario: 树的键盘操作
- WHEN 以 Tab 聚焦目录 `out` 的按钮并按 Enter，再聚焦文件 `readme.md` 的按钮并按空格
- THEN `out` 展开且其按钮 `aria-expanded="true"`；`readme.md` 被选中并显示预览；每个非根条目旁有可聚焦的 `更多操作 <名>` 按钮

#### Scenario: 文件页不自涂底色
- **WHEN** `make ui-walk` 在 `desktop-light` 与 `mobile-dark` 两个 project 下打开 `/files` 并选中一个文件，读取 `data-slot="files-layout"` 与 `data-slot="files-preview"` 两个元素的计算 `background-color`
- **THEN** 两者都是 `rgba(0, 0, 0, 0)`（透明）；页面底色仍等于 `body` 的计算底色（由走查既有的页面底色断言证明）；给其中任一容器加上背景类的候选实现在该断言处失败

### Requirement: 创建浮层的焦点时序与模态清理
经切换器或 `新建` 菜单打开的 `新建工作空间`、`新建文件夹` 对话框，以及「文件操作界面」的 `重命名`、`移动到` 对话框与删除确认框，SHALL 均为 `aria-modal="true"`，其初始焦点（`工作空间名称` / `位置` / `名称` / `目标位置` / `取消`）SHALL 在菜单或弹层关闭后延迟一个宏任务的回焦执行之后仍然成立。任一取消类关闭（`取消`、`关闭`、Escape、点遮罩）之后，`document.body` SHALL 不残留 `pointer-events` 内联样式，应用根 SHALL 不残留 `aria-hidden`。请求挂起期间点遮罩 SHALL 与 `取消` 等价：关闭对话框、中止该请求、焦点回到触发器，且不再发出新请求。

#### Scenario: 初始焦点经受延迟回焦
- **WHEN** 经菜单或切换器打开 `新建工作空间`，或经菜单选择 `新建文件夹`，或经行菜单选择 `重命名`、`移动到…`、`删除`，并等待一个宏任务
- **THEN** 对话框为 `aria-modal="true"`，`document.activeElement` 仍依次为 `工作空间名称` / `位置` / `名称` / `目标位置` / `取消`

#### Scenario: 取消类关闭无模态残留
- **WHEN** 经菜单路径、切换器路径与行菜单路径各做一次取消类关闭且焦点已回到触发器
- **THEN** `document.body.style.pointerEvents` 为空串，渲染容器无 `aria-hidden` 属性

#### Scenario: 挂起期点遮罩中止请求
- **WHEN** `新建文件夹` 提交后 `POST …/dirs` 挂起，等待一个宏任务后按压遮罩；`重命名` 提交后 `POST …/move` 挂起时同样操作
- **THEN** 对话框关闭，该请求 signal 已中止，焦点回到触发器（`新建` / 该行的 `更多操作 <名>`），全程各恰 1 次 POST

## ADDED Requirements

### Requirement: 地址定位到文件
文件页 SHALL 以查询参数 `path=<空间内相对路径>`（`/` 分隔，经 `URLSearchParams` 编码）表示当前文件，与 `ws` 并列：`/files?ws=<id>&path=<rel>`。进入页面或地址变化使 `path` 有值时，页面 SHALL 逐级请求并展开它的各级父目录（已加载的不重复请求），然后：`path` 在其父目录的列表里是文件 → 选中它并显示预览；是目录 → 展开到它、不选中任何文件；不在列表里 → 展开到已成功的最深一级，预览区显示 `文件不存在`，树保持可用。某一级父目录请求失败（404、403 等）时停在上一级，预览区显示该错误的信封 message。用户在树里选中文件时 SHALL 以 `replace` 把 `path` 写入地址（不新增历史记录）；切换工作空间、当前文件被删除时移除 `path`；当前文件被重命名或移动时把 `path` 改为新路径。`path` 只在 `ws` 合法时生效：`ws` 被纠正时 `path` 一并移除。`path` 的值 SHALL 只作为数据经 `listTree` / `fetchPreview` 等客户端方法发给服务端，是否越界由服务端沙箱裁决，浏览器不做规范化。刷新页面 SHALL 回到同一个空间、同一个文件。

#### Scenario: 深链打开
- **WHEN** 直接访问 `/files?ws=<id>&path=src%2Fdeep%2Fapp.ts`
- **THEN** 页面依次对根、`src`、`src/deep` 请求 `tree`（各一次），三级都展开，`app.ts` 被选中并显示预览；刷新后状态相同

#### Scenario: 选中写入地址
- **WHEN** 在树里依次选中 `readme.md` 与 `out/a.md`，随后按浏览器后退
- **THEN** 地址依次为 `?ws=<id>&path=readme.md`、`?ws=<id>&path=out%2Fa.md`；两次选中没有新增历史记录（后退离开文件页，而不是回到 `readme.md`）

#### Scenario: 指向目录、不存在与越界
- **WHEN** 分别访问 `path=out`（目录）、`path=out/gone.md`（不存在）、`path=nodir/x.md`（父目录不存在）、`path=../x`
- **THEN** 第一例展开到 `out`、不选中文件、预览区为 `未选择文件`；第二例展开到 `out`，预览区显示 `文件不存在`；第三例停在根，预览区显示服务端的 404 文案；第四例预览区显示服务端的 403 文案（服务端写了 `sandbox.reject`）；四例的树都可继续操作，没有 console error

#### Scenario: 随操作更新
- **WHEN** 当前文件 `a.md` 被重命名为 `b.md`；随后被删除；随后切换工作空间
- **THEN** 地址的 `path` 依次变为 `b.md`、被移除、保持移除；`ws` 相应为原空间、原空间、新空间

### Requirement: 文件操作界面
目录树的每个非根条目 SHALL 有 `更多操作 <名>` 菜单按钮（拷入层 `dropdown-menu`），菜单项为 `重命名`、`移动到…`、`删除`，文件条目另有 `下载`（指向 `downloadUrl`，带 `download` 属性）。根行没有该菜单。

- **重命名**：对话框（标题 `重命名`，输入框 `名称` 初值为当前名并全选，按钮 `取消` / `重命名`）。空名 → `请输入名称`；含 `/` 或 `\` → `名称不能包含路径分隔符`；与原名相同 → 直接关闭、不发请求；否则 `moveEntry({from, to:<同一父目录>/<新名>})`；409 → `该目录下已存在同名条目`；其它错误显示信封 message，对话框保持打开。
- **移动到…**：对话框（标题 `移动到`，下拉 `目标位置` 只列已加载的目录——根 + 已展开目录，去掉条目自身、其后代与其当前父目录；按钮 `取消` / `移动`）。没有可选目标时显示 `没有可用的目标目录，请先展开目标目录` 且 `移动` 禁用。提交即 `moveEntry({from, to:<目标>/<原名>})`；409 → `目标位置已存在同名条目`。
- **拖拽移动**：条目行可拖动（原生拖放）；拖到一个目录行或根行上放下即 `moveEntry` 到该目录下；拖到自身、自身的后代或当前父目录上时不接受放下、不发请求；拖动经过可接受的目录行时该行高亮。失败（409 → `目标位置已存在同名条目`，其它为信封 message）在树区上方以 `role="alert"` 就地显示，下一次成功的操作或再次拖放时清除。
- **删除**：确认框（拷入层 `alert-dialog`，标题 `删除「<名>」？`，说明——文件为 `文件将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。`，目录为 `文件夹及其全部内容将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。`；按钮 `取消` / `删除`，初始焦点在 `取消`）。确认后 `deleteEntry`；失败在确认框内显示信封 message，确认框保持打开。

每次成功的操作之后 SHALL 重新请求受影响的目录层（重命名：父目录；移动：源父目录与目标目录；删除：父目录）。被操作的条目是当前文件或其祖先时：重命名与移动后选中项与 `path` 跟到新路径并保持预览；删除后清除选中、预览区回到 `未选择文件`。被重命名或移动的目录的展开状态与已加载的子层 SHALL 跟到新路径（不强制重新逐级展开）。请求进行中对话框的提交按钮禁用、不可重复提交，`取消` 中止等待；迟到的响应不影响新界面。成功与失败都 SHALL NOT 使用 Toast。回合进行中这些操作照常可用，不另加提示（workspace-sidebar「随助手改动刷新」）。只在同一工作空间内操作：界面没有把条目移到另一个工作空间的途径。

#### Scenario: 重命名
- **WHEN** 对 `notes.md` 选 `重命名`，把名称改为 `todo.md` 并提交；另一例提交时服务端返回 409；另一例名称留空、含 `/`、或不改就提交
- **THEN** 第一例恰一次 `POST move {from:"notes.md",to:"todo.md"}`，对话框关闭，根层被重新请求，树里是 `todo.md`；409 一例显示 `该目录下已存在同名条目`、对话框仍开、可再次提交；后三例依次显示 `请输入名称`、`名称不能包含路径分隔符`、直接关闭，三者都没有请求

#### Scenario: 移动到
- **WHEN** 根下有 `a.md`、已展开的 `out` 与未展开的 `docs`，对 `a.md` 选 `移动到…`；选 `out` 提交；另一例对已展开的目录 `out` 选 `移动到…`，而它的子目录 `out/sub` 也已展开
- **THEN** 第一例下拉恰含 `out`（不含根——它是当前父目录，不含未展开的 `docs`）；提交后恰一次 `POST move {from:"a.md",to:"out/a.md"}`，根与 `out` 两层被重新请求；第二例下拉不含 `out` 与 `out/sub`，没有其它已加载目录时显示 `没有可用的目标目录，请先展开目标目录` 且 `移动` 禁用

#### Scenario: 拖拽
- **WHEN** 把 `a.md` 拖到目录 `out` 上放下；把目录 `out` 拖到它自己的子目录 `out/sub` 上；把 `out/b.md` 拖到 `out` 上；把 `out/b.md` 拖到根行上且根下已有 `b.md`
- **THEN** 第一例恰一次 `POST move {from:"a.md",to:"out/a.md"}` 且拖动经过时 `out` 行高亮；第二、三例不接受放下、没有请求；第四例发出请求、收到 409 后树区上方出现 `role="alert"` 的 `目标位置已存在同名条目`，树内容不变，页面无 Toast

#### Scenario: 删除
- **WHEN** 对目录 `out` 选 `删除`；先点 `取消`；再次打开并点 `删除`；另一例 `deleteEntry` 返回 404
- **THEN** 确认框标题为 `删除「out」？`，说明以 `文件夹及其全部内容将从工作空间移除。` 开头，初始焦点在 `取消`；取消后没有请求、焦点回到 `更多操作 out`；确认后恰一次 `DELETE …/entries?path=out`，确认框关闭，根层被重新请求，`out` 不在树里；404 一例在确认框内显示信封文案、确认框仍开

#### Scenario: 当前文件随操作变化
- **WHEN** 当前预览 `out/a.md`：把目录 `out` 重命名为 `dist`；再把 `dist/a.md` 移到根；再删除 `a.md`
- **THEN** 选中项与地址的 `path` 依次为 `dist/a.md`（`dist` 仍是展开的，没有为它重新逐级请求之外的多余请求）、`a.md`、无（预览区为 `未选择文件`）

#### Scenario: 请求中的对话框
- **WHEN** `重命名` 提交后 `POST …/move` 挂起，再点一次 `重命名`、随后点 `取消`
- **THEN** 挂起期间提交按钮禁用、只发出一次请求；取消后请求的 signal 已中止、对话框关闭；之后到达的响应不重新打开对话框也不显示错误

### Requirement: 工作空间浏览器组件
`web/src/features/files/` SHALL 经其 `index.ts` 导出 `WorkspaceBrowser`：给定 API 客户端、工作空间 id、账号与可选的空间名 / `dir`，它渲染目录树、预览区与全部文件操作，并以受控属性接收与上报「当前路径」（`path` / `onPathChange`）；它另接受可选的 `markedPaths`（带标记的路径集合及其可访问文本）、`onlyPaths`（只显示由这些路径构成的子树，此时不请求 `tree`）、`layout`（`columns`：树左预览右；`stacked`：树上预览下、树可收起）与一个命令式的 `reveal(path, {view?})`（逐级展开并选中，可指定网页文件的视图）与 `refresh(paths?)`（重新请求已加载目录中与这些路径相关的层；省略参数时全部已加载的层）。文件页以 `columns` 布局包一层并把当前路径接到地址的 `path`；会话页侧边栏以 `stacked` 布局包一层（workspace-sidebar）。目录树、预览与文件操作 SHALL 只有这一份实现；`WorkspaceBrowser` SHALL NOT 读写地址、SHALL NOT 依赖会话页的任何模块（`web/src/features/files` 不从 `web/src/features/chat` 导入）。

#### Scenario: 两处同一份实现
- **WHEN** 静态扫描 `web/src/features`
- **THEN** `web/src/features/files` 下没有文件导入 `web/src/features/chat`；`web/src/features/chat` 只经 `features/files/index` 导入文件页的东西；目录树的行组件与预览面板在仓库里各只有一个定义

#### Scenario: 受控路径与定位
- **WHEN** 以 `path="out/a.md"` 渲染 `WorkspaceBrowser`；随后调用 `reveal("src/deep/app.ts")`；再调用 `refresh(["out/b.md"])`
- **THEN** 初始时展开到 `out` 并选中 `a.md`；`reveal` 之后依次请求未加载的 `src`、`src/deep`，以 `src/deep/app.ts` 调用 `onPathChange`；`refresh` 只对根与 `out` 中已加载的层重新请求；组件自身没有读写 `location`

#### Scenario: 标记与子树
- **WHEN** 以 `markedPaths={"out/a.md"}`、标记文本 `本会话已改动` 渲染并展开 `out`；随后传入 `onlyPaths={"out/a.md","x/y.md"}`
- **THEN** `out` 与 `out/a.md` 两行带该文本的标记；传入 `onlyPaths` 之后树恰为 `out → a.md` 与 `x → y.md`，没有新的 `tree` 请求
