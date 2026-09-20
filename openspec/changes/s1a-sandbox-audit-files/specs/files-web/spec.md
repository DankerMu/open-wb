# Spec: files-web

## ADDED Requirements

### Requirement: API 客户端扩展
`lib/api` SHALL 新增 `listWorkspaces()`、`createWorkspace({name, dir?})`、`listTree(workspaceId, path)`、`createDir(workspaceId, path)`、`fetchPreview(workspaceId, path) → {kind:'text'|'image', text?|url?, size, truncated}`（`size` 取自 `X-Workbuddy-Size`，文本与图片响应均带）、`listAudit({limit?, before?})`，并把 403 `sandbox_denied`、409 `conflict`、413 `preview_too_large`、415 `preview_unsupported` 解析为带 `code` 的错误对象；沿用既有 401 → 未登录态。

#### Scenario: 方法与错误码
- WHEN 以 mock fetch 分别返回 201/200 与四种错误信封
- THEN 六方法路径/方法/body/返回形状正确；错误对象 `code` 与信封一致

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间`）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人或不存在）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数），不向该 id 发起 tree/file 请求、不产生 console error（无空间时显示 `未选择工作空间` 与空态 `该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹，或挂载本服务器/外部服务器目录`）；左栏为切换器按钮（空间名 + `root` 路径）、`工作空间目录` 标题与 `＋` 按钮（菜单：`新建文件夹`、`新建工作空间`）、目录树；右栏为预览面板（未选文件时 `未选择文件` / `在左侧目录树中选择一个文件进行预览`）。切换器弹层 SHALL 含搜索框、空间列表（当前项打勾）与 `＋ 新建工作空间`；选择即更新 `?ws=` 并清空展开态与当前文件。`新建工作空间` 对话框 SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与提示 `将在你的沙箱内创建同名目录`，空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → demo 专用文案 `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。

#### Scenario: 空间切换与新建
- WHEN 已登录且有两个空间，访问 `/files`、打开切换器选第二个、再新建第三个
- THEN URL 依次为 `?ws=<第一个>`、`?ws=<第二个>`、`?ws=<新建>`；新建后切换器显示新名与 `root`；刷新后仍停留在 `?ws=` 指向的空间

#### Scenario: 非法 ?ws= 回退
- WHEN 访问 `/files?ws=<他人或不存在的 id>`
- THEN 页面显示列表首个空间且 URL 被 `replace` 为 `?ws=<首个 id>`；对非法 id 零请求；无 console error

#### Scenario: 无空间空态
- WHEN 账号无任何空间
- THEN 显示 `未选择工作空间`、树区空态文案，`＋` 菜单仍可新建工作空间；`新建文件夹` 提示 `当前工作空间没有可写目录`

### Requirement: 目录树与预览
目录树 SHALL 懒加载：进入空间时请求根一层并默认展开根；点击目录切换展开并在首次展开时请求该层；点击文件请求预览。预览面板 SHALL 显示面包屑（路径、大小、mtime）；按扩展名前端先判定：不在可预览集 → 直接显示 `该类型不支持预览`（不请求）；`md` 默认渲染视图（移植 demo `mdRender`：先 HTML 转义再生成标题/列表/代码块/表格/链接标签，链接不可跳转），按钮 `查看源码`/`渲染视图` 切换；`csv` 渲染表格并注 `共 N 行 · 大文件仅预览前若干行`；其余文本以带行号的代码表显示，`json` 尝试格式化；图片以 `<img>` 显示；`X-Workbuddy-Truncated` 时显示截断横幅。`sandbox_denied`/`preview_*` 错误 SHALL 内联显示信封 message。
经用户明确授权，病态重建格式 SHALL 有界规范化：规范节点输出每条祖先链最多保留 64 层 `strong`；超出部分的冗余粗体包装可省略，但全部文字顺序、链接及其作用范围、不可跳转行为和可见格式 SHALL 保留。普通及浅层输入仍遵循 demo 契约；代码保持字面值。此规则不是文本截断、纯文本降级或危险 HTML 注入，HTML 与 React 投影 SHALL 消费同一规范化节点结构。

#### Scenario: 一次浏览
- WHEN 以 mock fetch 提供根 `out/`、`readme.md`、`notes.csv`、`logo.png`、`归档.zip`：展开 `out`、依次点击四个文件
- THEN 展开 `out` 触发恰一次 `tree?path=out`；`readme.md` 显示渲染后的 `h1` 与 `查看源码` 按钮，点击后显示源码行号表；`notes.csv` 显示表头与 `共 2 行`；`logo.png` 显示 `img`；`归档.zip` 显示 `该类型不支持预览` 且未发起 `file` 请求

#### Scenario: 渲染器安全
- WHEN Markdown 源含 `<script>alert(1)</script>` 与 `[x](javascript:alert(1))`
- THEN 输出中不含 `<script` 标签（被转义为文本），链接渲染为 `href="#"` 且不含 `javascript:`

#### Scenario: 病态格式深度
- WHEN 在同一预览实例依次显示浅层 Markdown、接近 1 MiB 的深层重建格式、普通文档，再切换源码/渲染和卸载
- THEN 全部文字及链接保留，`strong` 祖先深度不超过 64，预览与后续交互完成且无新增控制台/页面错误；开发、生产和 StrictMode 生命周期均满足此契约
