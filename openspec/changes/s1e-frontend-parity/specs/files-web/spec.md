# Spec delta: files-web（S1e 修改）

> 按仓内先例整段重述 `工作空间页` 与 `文件界面与键盘可用性` 两个 Requirement（含全部 Scenario），归档时整段替换。`API 客户端扩展`、`文件预览纯组件`、`目录树与预览` 不变（`md-render.ts` 物理位置移到 `web/src/lib/`，`文件预览纯组件` 的契约与来源说明不变）。demo 行号指 `resource/workbuddy-live-demo.html`。

## MODIFIED Requirements

### Requirement: 工作空间页
`/files` SHALL 渲染工作空间页（heading `工作空间` 由顶栏承担）：当前空间由查询参数 `?ws=<id>` 表示，缺省取列表首个；`?ws=` 指向不在本账号列表中的 id（他人或不存在）SHALL 回退到列表首个并以 `replace` 纠正 URL（无空间则移除该参数），不向该 id 发起 tree/file 请求、不产生 console error。无空间时 SHALL 显示 `未选择工作空间` 与选择/创建引导，区别于已选空间的空目录，不宣传未交付的挂载能力。

左栏（demo:3838-3878）自上而下为：切换器按钮卡（`Icon layout-grid` + 空间名 + **逻辑路径** `<account>/<dir>`，由 Principal `account` 与 workspace `dir` 拼接；服务器返回的绝对 `root` SHALL 不出现在任何界面文本、title 或 aria 属性中）、`工作空间目录` 标题与 `＋` 按钮（`Menu`：`新建文件夹`、`新建工作空间`）、目录树。树根行 SHALL 显示 `Icon shield` + 空间名（不再显示字面 `root`）与副行逻辑路径；目录条目 `Icon folder`，文件条目按扩展名选图标（`png|jpg|jpeg` → `image`，`zip|tar|gz` → `archive`，`csv` → `table`，`md|txt|log` → `file-text`，`json|js|ts|tsx|html` → `file-code`，其它 `file`）并在行尾显示大小（`< 1024` → `N B`，否则 `KB`/`MB`/`GB` 保留一位小数；文件条目的可访问名恰为文件名）；空目录展开后显示 `空目录`；空间根一层为空时显示 `该工作空间暂无目录 / 点击左上角 ＋ 新建文件夹`（不提挂载）。右栏为预览面板：预览头显示文件图标、路径、大小、mtime；未选文件时显示 `EmptyState`（`未选择文件` / `在左侧目录树中选择一个文件进行预览`）；不支持类型显示 `该类型不支持预览` 与副行 `<文件名> · <大小>　二进制或未识别格式`。

切换器弹层（`Popover` 锚定于切换器卡，content `role="dialog"` 名 `工作空间切换器`）SHALL 含搜索框（placeholder `搜索工作空间`，按空间名/逻辑路径子串过滤列表，无匹配显示 `无匹配的工作空间`）、空间列表（每项空间名 + 逻辑路径，当前项打勾）与 `＋ 新建工作空间`（`挂载目录到当前空间` 属 S1b，不渲染）；选择即更新 `?ws=` 并清空展开态与当前文件。`新建工作空间` 对话框（`Dialog`）SHALL 有 `工作空间名称`、`目录名`（留空按名称生成）与沙箱目录创建提示，空名 → `请输入名称`，409 → `同名工作空间已存在`。`新建文件夹` 对话框的位置下拉 SHALL 只列已加载的目录（根 + 已展开目录，根项文案 `根目录　<空间名>` 而非 `根目录　root`），空名 → `请填写文件夹名称`，名称含 `/`/`\` → `名称不能包含路径分隔符`，409 → `该目录下已存在同名条目`（对话框层覆盖通用 `conflict` 信封文案）；`sandbox_denied`/其它错误 → 显示信封 message。

#### Scenario: 空间切换与新建
- WHEN 已登录且有两个空间，访问 `/files`、打开切换器选第二个、再新建第三个
- THEN URL 依次为 `?ws=<第一个>`、`?ws=<第二个>`、`?ws=<新建>`；切换器卡与树根行显示新名与逻辑路径 `zhangsan/<dir>`，页面任何文本不含服务器绝对路径；刷新后仍停留在 `?ws=` 指向的空间

#### Scenario: 非法 ?ws= 回退
- WHEN 访问 `/files?ws=<他人或不存在的 id>`
- THEN 页面显示列表首个空间且 URL 被 `replace` 为 `?ws=<首个 id>`；对非法 id 零请求；无 console error

#### Scenario: 无空间空态
- WHEN 账号无任何空间
- THEN 显示 `未选择工作空间`、树区空态文案，`＋` 菜单仍可新建工作空间；`新建文件夹` 提示 `当前工作空间没有可写目录`

#### Scenario: 树条目图标、大小与空目录
- WHEN 空间根含 `out/`（空）、`readme.md`（2 KB）、`notes.csv`、`logo.png`、`归档.zip`（86.3 MB）
- THEN 根行为 `shield` + 空间名；四个文件依次显示 `file-text`/`table`/`image`/`archive` 图标与 `2.0 KB`、`86.3 MB` 等大小文本；展开 `out` 显示 `空目录`；zip 点击后预览显示 `该类型不支持预览` 与 `归档.zip · 86.3 MB　二进制或未识别格式`

#### Scenario: URL 纠正不丢上下文
- WHEN 缺省或非法 ws 需要纠正且 URL 有其它查询参数/hash
- THEN replace 保留其它参数/hash，无空间时移除 ws；列表确定前及纠正期间对非法 id 零 tree/file 请求

#### Scenario: 创建校验和错误
- WHEN 新建空间为空名或返回 409，或新建目录为空名、含任一斜线、返回 409
- THEN 分别显示约定文案；本地无效输入零 mutation；其它 ApiError 显示 message，网络/非法信封使用既有稳定回退

### Requirement: 文件界面与键盘可用性
文件页 SHALL 只经 ui-primitives 取样式与行为（token、`Dialog`、`Menu`（含 `＋` 创建菜单，替换手写 `role="menu"`）、`Popover`、`EmptyState`、`Icon`、`Button`），桌面左右分栏（树栏 `280px`，`≤900px` 时 `210px`），`≤760px` 纵向布局（树在上、预览在下，各自内部滚动）；长路径与文件名不得撑宽页面（树条目 `text-overflow: ellipsis` + `title` 为全名），代码和表格在预览容器内部滚动（容器 `overflow: auto`）。创建对话框 SHALL 为阻止背景交互的模态，打开时聚焦首个表单控件，Tab/Shift+Tab 留在框内，Escape/取消关闭并恢复触发器焦点；请求进行中保持忙碌反馈且不得重复提交，但仍允许取消等待，通过既有 AbortController 与代际守卫防止迟到响应影响新界面。取消等待不承诺撤销服务端已完成操作，界面 SHALL 明示可刷新确认结果。既有账号/请求代际隔离与安全预览语义 SHALL 保持。

#### Scenario: 创建弹窗的键盘闭环
- WHEN 用户以键盘打开创建弹窗、循环 Tab、按 Escape
- THEN 背景控件不接收焦点，弹窗关闭后触发器重新获得焦点；进行中的创建可取消等待，迟到响应不得关闭或覆盖较新的弹窗

#### Scenario: 三档宽度布局
- WHEN 在 1440、1024、880、390 宽度打开已选空间的 `/files`，树中含一个名称 ≥48 字符的目录
- THEN 1440 与 1024 树栏 280px 且并排，880 树栏 210px 且并排，390 纵向堆叠；各宽度 `document.documentElement.scrollWidth <= innerWidth`（1440/880/390 由 `make ui-walk` 断言——880 为 `desktop-light` project 内临时 viewport，1024 由 `make ui-shots` 每格断言）；超长目录名行 `scrollWidth <= clientWidth` 且 `title` 为全名；csv/代码预览容器计算样式 `overflow-x` 为 `auto`
