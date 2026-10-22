# files-web Spec Delta

> s1b-workspace-mounts：以主规格为底。「工作空间页」去掉「不宣传未交付的挂载」、`新建` 菜单在挂载启用时多 `挂载目录`、空根空态只在没有挂载时出现（服务端的根一层 `tree` 不列出挂载点）、挂载内文件的隔离来源预览换成固定文案，加两个场景（design D18、D21）。挂载根行与对话框本身见 workspace-mounts「挂载根行」「挂载对话框」。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间`）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人、不存在，或 `s1f-session-list-temp-space` 规定的不列出的临时空间）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数，同时移除 `path`），不向该 id 发起 tree/file 请求、不产生 console error。空间列表恰为 `GET /api/workspaces` 的结果，本页不另行过滤或补充。无空间时 SHALL 显示 `未选择工作空间` 与树区空态选择/创建引导（`先选择或创建工作空间` / `使用左上角 ＋ 新建工作空间`），区别于已选空间的空目录，不宣传未交付的上传能力。左栏为切换器按钮（`Icon layout-grid` + 空间名 + **逻辑路径** `<account>/<dir>`，由 Principal `account` 与 workspace `dir` 拼接；服务器返回的绝对 `root` SHALL 不出现在任何界面文本、`title`、`aria-*` 属性、`placeholder` 或下拉选项中）、`工作空间目录` 标题、`刷新` 按钮与 `＋` 按钮（accessible name `新建`；菜单：`新建文件夹`、`新建工作空间`；挂载启用时两者之间另有 `挂载目录`，见 workspace-mounts「挂载对话框」（change s1b-workspace-mounts））、目录树（目录条目 `Icon folder`，文件条目按 file-previewers 的类别取图标并在行尾显示大小（`< 1024` → `N B`，否则 `KB`/`MB`/`GB` 保留一位小数）；文件条目的可访问名恰为文件名；展开后为空的目录显示 `空目录`；空间根一层为空、且该空间没有挂载时树区显示空态（`该工作空间暂无目录` / `点击左上角 ＋ 新建文件夹`，不提挂载）；空间根一层为空（服务端不列出已登记挂载的挂载点）而该空间有挂载时，空间根之下显示 `空目录`、其后照常是挂载根行（workspace-mounts「挂载根行」））；右栏为预览面板；选中的文件位于该空间的已登记挂载内（第一段规则见 workspace-mounts「挂载目录内的文件端点」）而它的预览器要从隔离预览来源加载（网页的渲染视图、PDF、办公文档，见 file-previewers「隔离来源的嵌入与令牌」「PDF 与办公文档」）时，预览区 SHALL 显示 `挂载目录内的文件暂不支持预览，请下载查看`，不签发预览令牌、不建 `iframe`（预览来源对挂载内路径一律 404，workspace-mounts「宿主不同步进入挂载」），预览头的下载链接照常；网页的 `查看源码` 与经 `file` 端点取数的预览器（文本、Markdown、表格、图片等）照常工作；会话页侧边栏里的 `WorkspaceBrowser` 同样如此（change s1b-workspace-mounts）；未选文件时显示空态（`未选择文件` / `在左侧目录树中选择一个文件进行预览`）。树根行 SHALL 显示 `Icon shield` + 空间名（可访问名 `展开|折叠 <空间名>`）与副行逻辑路径。切换器弹层 SHALL 含搜索框（placeholder `搜索工作空间`，按空间名/逻辑路径的大小写无关子串过滤列表，无匹配显示 `无匹配的工作空间`）、空间列表（每项空间名 + 逻辑路径，当前项打勾）与 `＋ 新建工作空间`；选择即更新 `?ws=`、移除 `path` 并清空展开态与当前文件；选择当前已选中的空间（#1551）SHALL 不导航——地址、历史长度、展开态与当前文件都不变，只关闭切换器。`新建工作空间` 对话框 SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与沙箱目录创建提示（说明恰为 `将在你的沙箱内创建同名目录`），空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录，根项文案 `根目录　<空间名>`），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。本页 SHALL NOT 提供上传、工作空间删除与工作空间改名的入口。整页 SHALL 只用 `web/src/components/ui` 的组件与 Tailwind 类实现，`web/src/features/files` 下不存在 `.css` 文件（ui-foundation「组件分层」）。

#### Scenario: 空间切换与新建
- WHEN 已登录且有两个空间，访问 `/files`、打开切换器选第二个、再新建第三个
- THEN URL 依次为 `?ws=<第一个>`、`?ws=<第二个>`、`?ws=<新建>`；切换器按钮与树根行显示新名与逻辑路径 `zhangsan/<dir>`，页面任何文本不含服务器绝对路径；刷新后仍停留在 `?ws=` 指向的空间

#### Scenario: 重选当前空间
- WHEN 已登录且在 `/files?ws=W&path=y` 上：（a）删除当前文件 y（地址随之去掉 `path`），再点击 x，然后打开切换器选择 W；（b）展开一个目录后打开切换器选择 W；（c）作为对照，打开切换器选择另一空间 V（此前没有后退过）
- THEN （a）地址为 `?ws=W&path=x`、树中选中 x，`history.length` 与选择 W 之前相同；（b）地址仍为 `?ws=W&path=y`，选中与展开态不变，`history.length` 不变，切换器弹层关闭，再打开时 W 项为 `aria-pressed="true"`；（c）地址变为 `?ws=V`（无 `path`），`history.length` 加一

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

#### Scenario: 有挂载时的菜单与空根
- **WHEN** 已选空间根的 `tree` 为空（挂载点 `远端` 不被列出），`GET …/mounts` 为 `enabled` true 且恰含挂载 `远端`；打开 `新建` 菜单
- **THEN** 树区不显示 `该工作空间暂无目录`，空间根之下显示 `空目录`、其后是 `远端` 的挂载根行；菜单依次为 `新建文件夹`、`挂载目录`、`新建工作空间`

#### Scenario: 挂载内文件的预览
- **WHEN** 空间有在线挂载 `远端`，依次选中 `远端/site/index.html`、`远端/doc.pdf`、`远端/plan.docx`、`远端/notes.md` 与 `远端/logo.png`
- **THEN** 前三个的预览区显示 `挂载目录内的文件暂不支持预览，请下载查看`、没有 `iframe`，全程没有 `issuePreviewToken` 请求，预览头有下载链接；`index.html` 点 `查看源码` 后发出一次 `file` 请求并显示源码；`notes.md` 与 `logo.png` 各发出一次 `file` 请求并照常预览
- **WHEN** 选中根下的 `site/index.html`（不在挂载内）
- **THEN** 照 file-previewers「隔离来源的嵌入与令牌」取得 `base` 并建 `iframe`
