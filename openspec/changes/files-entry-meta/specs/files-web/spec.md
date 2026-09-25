## MODIFIED Requirements

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间`）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人或不存在）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数），不向该 id 发起 tree/file 请求、不产生 console error。无空间时 SHALL 显示 `未选择工作空间` 与选择/创建引导，区别于已选空间的空目录，不宣传未交付的挂载能力。左栏为切换器按钮（空间名 + `root` 路径）、`工作空间目录` 标题与 `＋` 按钮（菜单：`新建文件夹`、`新建工作空间`）、目录树（目录条目 `Icon folder`，文件条目按扩展名选图标（`png|jpg|jpeg` → `image`，`zip|tar|gz` → `archive`，`csv` → `table`，`md|txt|log` → `file-text`，`json|js|ts|tsx|html` → `file-code`，其它 `file`）并在行尾显示大小（`< 1024` → `N B`，否则 `KB`/`MB`/`GB` 保留一位小数）；文件条目的可访问名恰为文件名）；右栏为预览面板：预览头显示文件图标、路径、大小、mtime；未选文件时提示选择文件。切换器弹层 SHALL 含搜索框、空间列表（当前项打勾）与 `＋ 新建工作空间`；选择即更新 `?ws=` 并清空展开态与当前文件。`新建工作空间` 对话框 SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与沙箱目录创建提示，空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。

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

#### Scenario: 树条目图标与大小
- WHEN 根一层含目录 `out` 与文件 `readme.md`（2048 B）、`notes.csv`（1536 B）、`logo.png`（90492109 B）、`归档.zip`（12 B），点击 `readme.md`
- THEN 目录行为 `folder` 图标；四个文件依次显示 `file-text`/`table`/`image`/`archive` 图标与 `2.0 KB`、`1.5 KB`、`86.3 MB`、`12 B`；文件按钮可访问名恰为文件名；预览头显示 `file-text` 图标、路径与 `2.0 KB · <mtime>`
