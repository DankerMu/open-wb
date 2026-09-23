## ADDED Requirements

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

#### Scenario: URL 纠正不丢上下文
- WHEN 缺省或非法 ws 需要纠正且 URL 有其它查询参数/hash
- THEN replace 保留其它参数/hash，无空间时移除 ws；列表确定前及纠正期间对非法 id 零 tree/file 请求

#### Scenario: 创建校验和错误
- WHEN 新建空间为空名或返回 409，或新建目录为空名、含任一斜线、返回 409
- THEN 分别显示约定文案；本地无效输入零 mutation；其它 ApiError 显示 message，网络/非法信封使用既有稳定回退

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
