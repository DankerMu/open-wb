## ADDED Requirements

### Requirement: 类别判定与预览器选择
文件预览 SHALL 由纯函数 `previewKind(name)` 按文件名决定用哪个预览器；扩展名取最后一个 `.` 之后、不区分大小写，文件名没有 `.` 或唯一的 `.` 在开头时视为无扩展名：

| `previewKind` | 扩展名 | 数据来源 |
|---|---|---|
| `image` | `png` `jpg` `jpeg` `gif` `webp` `bmp` `ico` | `fetchPreview`（Blob 地址） |
| `pdf` | `pdf` | 隔离预览来源 `base` |
| `office` | `docx` `xlsx` `pptx` | 隔离预览来源 `officeBase` |
| `audio` | `mp3` `wav` | 主站 `file` 路由的直接地址 |
| `video` | `mp4` `webm` | 主站 `file` 路由的直接地址 |
| `notebook` | `ipynb` | `fetchPreview`（文本） |
| `archive` | 以 `.zip`、`.tar`、`.tar.gz`、`.tgz`、`.gz` 结尾 | `listArchive` |
| `text` | 其余一切（含无扩展名与未知扩展名） | `fetchPreview`（文本）；网页（`html`、`htm`）的渲染视图除外——它来自隔离预览来源 `base`，切到源码视图时才 `fetchPreview` |

`text` 之内再由 `textView(name)` 细分呈现：`md` → Markdown（渲染 / 源码）；`csv`、`tsv` → 表格；`html`、`htm` → 网页（渲染 / 源码）；`svg` → 图片 / 源码；其余 → 源码。对 `text` 类，「是不是文本」由服务端决定：`fetchPreview` 返回 415 `preview_unsupported` 时显示不支持态（见「预览头、下载与不可预览的呈现」），浏览器 SHALL NOT 自己维护文本扩展名白名单。`image`、`audio`、`video`、`notebook` 的扩展名集合 SHALL 与 workspaces「预览分类元数据与有界字节流」表中对应类别的集合逐项相同，由一条契约测试钉住。文件图标按类别取（`image` → `image`，`archive` → `archive`，表格 → `table`，Markdown 与纯文本 → `file-text`，其它文本 → `file-code`，其余 → `file`）。

#### Scenario: 判定表
- **WHEN** 对 `a.PNG`、`b.webp`、`c.pdf`、`d.DOCX`、`e.mp3`、`f.webm`、`g.ipynb`、`h.zip`、`i.tar.gz`、`j.tgz`、`k.gz`、`readme.md`、`t.tsv`、`p.htm`、`logo.svg`、`main.py`、`LICENSE`、`.env`、`x.unknown` 调用 `previewKind` 与（对文本类）`textView`
- **THEN** 依次为 `image`、`image`、`pdf`、`office`、`audio`、`video`、`notebook`、`archive`、`archive`、`archive`、`archive`，其余都是 `text`；`textView` 依次为 Markdown、表格、网页、图片 / 源码、源码、源码、源码、源码

#### Scenario: 与服务端的扩展名表一致
- **WHEN** 契约测试读取服务端分类器的图片、音频、视频、Notebook 扩展名集合与浏览器侧 `previewKind` 的对应集合
- **THEN** 四个集合两两相等；向任一侧加一个另一侧没有的扩展名时测试判红

#### Scenario: 未知文件由服务端裁决
- **WHEN** 选中 `schema.proto`（服务端返回 200 文本）与 `blob.bin`（服务端返回 415）
- **THEN** 两者都恰发出一次 `file` 请求；前者显示带行号的源码，后者显示 `该类型不支持预览` 与下载按钮

### Requirement: 按需加载
每类预览器（Markdown、表格、源码与高亮、网页、图片、PDF 与办公文档、音视频、Notebook、压缩包）SHALL 是 `web/src/features/files/previewers/` 下的独立模块，只经同目录 `index.ts` 的动态 `import()` 在第一次需要该类预览时加载（ui-foundation「预览器按需加载是唯一的代码分割」）；同一类别第二次打开 SHALL 复用已加载的模块，不再发起块请求。加载期间预览区 SHALL 显示 `正在加载预览…`（`role="status"`）；加载失败（块请求失败）SHALL 就地显示 `预览组件加载失败`、一个 `重试` 按钮与下载按钮，`重试` 重新发起加载；失败不影响目录树与其它文件的预览。打开文件页或会话页而不选中任何文件时 SHALL NOT 加载任何预览器模块。

#### Scenario: 第一次才加载
- **WHEN** 打开 `/files`、展开目录但不选文件；随后选中 `main.py`；再选中 `other.ts`
- **THEN** 选中文件之前没有任何预览器模块被加载（以对 `previewers/index.ts` 加载函数的调用次数为证）；选中 `main.py` 时源码预览器的加载函数恰被调用一次，期间显示 `正在加载预览…`；选中 `other.ts` 时不再调用

#### Scenario: 加载失败可重试
- **WHEN** 源码预览器的加载第一次被拒绝，点击 `重试` 后成功
- **THEN** 失败时预览区显示 `预览组件加载失败`、`重试` 与 `下载 main.py`，目录树仍可操作；重试后显示源码，没有未处理的拒绝

### Requirement: 预览头、下载与不可预览的呈现
选中任何文件时，预览头 SHALL 显示文件图标、空间内路径、大小与修改时间（`formatMtime`，查看者本地时区 `YYYY-MM-DD HH:mm`），以及一个下载链接：accessible name `下载 <文件名>`，`href` 为 `/api/workspaces/<id>/download?path=<编码后的路径>`，带 `download` 属性——所有文件都有它，包括不支持预览、超限、预览失败与预览器加载失败的文件。下载由浏览器直接导航完成，页面 SHALL NOT 经 `fetch` 读取下载内容。

不可预览的各种情况 SHALL 在预览区就地显示，并都保留预览头：

| 情况 | 文案 |
|---|---|
| 服务端 415（不是文本的未知类型） | `该类型不支持预览`，副行 `<文件名> · <大小>` |
| 服务端 413（图片、Notebook 超限）或文档大小超过令牌响应的 `documentMaxBytes` | `文件过大，无法预览`，副行 `<文件名> · <大小>` |
| 文本被截断 | 正文照常显示，其上一行 `文件超过预览上限，仅显示开头部分 · 共 <大小>` |
| 其它非 401 的 `ApiError` | 信封 message |
| 网络失败或非法响应 | 既有的 request_failed 安全文案 |

401 交由认证守卫，不显示页面内错误。错误与不支持态 SHALL NOT 使用 Toast。切换文件、切换工作空间、卸载时 SHALL 中止在途的预览请求，迟到的响应不提交状态；`fetchPreview` 分配的图片 Blob 地址在被替换、卸载与迟到结果被丢弃时释放。

#### Scenario: 每个文件都能下载
- **WHEN** 依次选中 `readme.md`、`blob.bin`（415）、21 MiB 的 `huge.png`（413）与 `archive.zip`
- **THEN** 每次预览头里都有名为 `下载 <文件名>` 的链接，`href` 恰为该文件的 download 地址且带 `download` 属性；`blob.bin` 显示 `该类型不支持预览`，`huge.png` 显示 `文件过大，无法预览`；页面没有对 download 地址发起 `fetch`

#### Scenario: 截断提示
- **WHEN** 选中 1.5 MiB 的 `big.log`（响应带截断头与 `X-Workbuddy-Size: 1572864`）
- **THEN** 显示源码与一行 `文件超过预览上限，仅显示开头部分 · 共 1.5 MB`

#### Scenario: 请求归属与资源释放
- **WHEN** 选中一张图片后在响应返回前切到另一个文件；或图片显示后切换工作空间；或页面卸载（含 StrictMode 的二次挂载）
- **THEN** 迟到的图片不显示，其 Blob 地址被释放；每个分配过的 Blob 地址在失去归属时都被释放一次

### Requirement: 源码视图与语法高亮
源码预览器 SHALL 以带行号的表格显示文本：每行一个行号单元格与一个内容单元格，保留空白，末尾空行计入，内容在容器内部横向滚动而不撑宽页面；`json` 先尝试格式化，失败保留原文。它 SHALL 按 `highlightLanguage(name)`（扩展名或文件名到语言的固定映射，至少覆盖 `js` `mjs` `cjs` `jsx` `ts` `tsx` `json` `css` `scss` `html` `htm` `xml` `svg` `py` `go` `rs` `java` `c` `h` `cpp` `sh` `sql` `yaml` `yml` `toml` `ini` `md`、`Dockerfile`、`Makefile`）给内容着色；没有映射的文件名不着色、仍带行号。着色 SHALL 经 `lowlight` 产出语法树并映射为 React 元素，SHALL NOT 使用 `dangerouslySetInnerHTML` 或任何把文件内容当作 HTML 解析的途径；颜色取自主题变量，亮暗两种主题下都可读。着色完成之前 SHALL 先显示未着色的带行号源码（文件内容不因高亮库加载或着色而延后出现）；着色抛错时保留未着色的源码、不显示错误。本条只适用于文件预览；会话消息里的代码块不受影响。

#### Scenario: 行号与字面值
- **WHEN** 源码预览器显示含两行与一个末尾空行的文本，其中一行是 `<script>alert(1)</script>`
- **THEN** 表格有三行、行号 1 到 3；那一行的文字内容恰为该字符串，文档里没有因此新增 `script` 元素

#### Scenario: 按语言着色
- **WHEN** 显示内容为 `const a = "x"; // c` 的 `main.ts` 与同样内容的 `notes.unknownext`
- **THEN** 前者的关键字、字符串与注释各自落在带语法类别标记的元素里（`const` 所在元素与 `"x"` 所在元素的类别不同）；后者没有这类元素；两者的纯文本内容与行数相同

#### Scenario: 先内容后颜色
- **WHEN** 高亮模块的加载被挂起时选中 `main.py`
- **THEN** 带行号的源码已经显示且没有着色元素；放行后着色元素出现，行数与文本不变

### Requirement: Markdown、表格、图片与 SVG
- Markdown（`md`）SHALL 沿用既有 `mdRender` 的安全子集（见 files-web「文件预览纯组件」），默认渲染，可在 `查看源码` 与 `渲染视图` 之间切换，切换文件时重置为渲染。
- 表格（`csv`、`tsv`）SHALL 以首行为表头显示，`csv` 以逗号、`tsv` 以制表符分列，并显示 `共 N 行 · 大文件仅预览前若干行`（N 为数据行数）。
- 图片 SHALL 用 `fetchPreview` 给出的 Blob 地址渲染 `img`（`alt` 为文件名），在预览区内等比缩放、不撑宽页面；`img` 触发 `error`（文件损坏或内容不是它的扩展名所称的格式）时预览区 SHALL 改为显示 `无法显示该图片`、移除该 `img` 并保留预览头的下载链接，SVG 的图片视图同样处理（此时仍可切到 `查看源码`）。
- SVG SHALL 默认以图片显示：把取回的文本做成 `data:image/svg+xml;charset=utf-8,<百分号编码>` 地址交给 `img`，并可在 `查看源码` 与 `图片视图` 之间切换；响应被截断时只显示源码并带截断提示。SVG 的文本 SHALL NOT 被插入页面 DOM、SHALL NOT 做成 Blob 地址。

#### Scenario: tsv 与 csv
- **WHEN** 显示内容为 `name\tvalue\nalpha\t1\nbeta\t2` 的 `t.tsv` 与对应逗号分隔的 `t.csv`
- **THEN** 两者都是两列表头 `name`、`value` 与两行数据，注记为 `共 2 行 · 大文件仅预览前若干行`

#### Scenario: SVG 以图片方式加载
- **WHEN** 选中内容含 `<script>` 的 `logo.svg`，再点 `查看源码`
- **THEN** 图片视图里是一个 `img`，其 `src` 以 `data:image/svg+xml` 开头，文档里没有内联的 `svg` 与 `script` 元素，没有新的 Blob 地址被创建；源码视图显示带行号的 SVG 文本；按钮文案变为 `图片视图`

#### Scenario: 损坏的图片
- **WHEN** 选中一个扩展名为 `png`、内容不是图片的 `broken.png`（服务端按扩展名返回 200 `image/png`），其 `img` 触发 `error`；另一例内容不是合法 SVG 的 `bad.svg` 的 `img` 触发 `error`
- **THEN** 两例预览区都显示 `无法显示该图片`、没有残留的破图 `img`，`下载 <文件名>` 链接仍在，没有 Toast 与未处理的拒绝；`bad.svg` 仍可点 `查看源码` 看到原文；`broken.png` 的 Blob 地址被释放

#### Scenario: 被截断的 SVG
- **WHEN** `fetchPreview` 对 `big.svg` 返回带截断标记的文本
- **THEN** 只显示源码与截断提示，没有 `img`，没有视图切换按钮

### Requirement: 隔离来源的嵌入与令牌
需要隔离预览来源的预览器（网页的渲染视图、PDF、办公文档）SHALL 经 `issuePreviewToken(workspaceId)` 取得 `{base, officeBase, expiresAt, documentMaxBytes, officeAvailable}`，并把文件路径按段 `encodeURIComponent` 后接在 `base`（或 `officeBase`）之后作为 iframe 的 `src`；页面 SHALL NOT 自己拼接预览来源的主机或端口。同一工作空间在一个页面里 SHALL 共用一次签发的结果；只要有这样的预览处于挂载状态，页面 SHALL 每 5 分钟再调用一次 `issuePreviewToken` 续期（返回同一个 `base` 时 iframe 不重载；返回了不同的 `base` 时以新地址重载），没有这样的预览时不续期。签发失败（非 401）时预览区显示信封 message 或安全文案，网页仍可切到源码视图。令牌与 `base` SHALL NOT 被写入地址栏、`localStorage`、日志或任何持久存储，SHALL NOT 出现在界面可见文本里。

网页渲染视图的 iframe SHALL 带 `sandbox="allow-scripts allow-forms allow-modals"`（恰这三个令牌，没有 `allow-same-origin`）、`referrerpolicy="no-referrer"` 与 `title="<文件名>"`，SHALL NOT 使用 `srcdoc`。网页默认显示渲染视图，可在 `查看源码` 与 `渲染视图` 之间切换，切换文件时重置为渲染；源码视图经 `fetchPreview` 取文本（1 MiB 截断与截断提示照常），渲染视图不受该上限约束。

#### Scenario: 网页渲染视图
- **WHEN** 选中 `site/index.html`，`issuePreviewToken` 返回 `base` 为 `http://127.0.0.1:4100/w/<T>/`
- **THEN** 预览区有一个 `iframe`，`src` 恰为 `http://127.0.0.1:4100/w/<T>/site/index.html`，`sandbox` 属性恰为 `allow-scripts allow-forms allow-modals`，`referrerpolicy` 为 `no-referrer`，`title` 为 `index.html`，没有 `srcdoc`；此时没有发出 `file` 请求；点 `查看源码` 后发出一次 `file` 请求并显示带行号的源码，按钮变为 `渲染视图`

#### Scenario: 路径编码
- **WHEN** 选中 `报告 2026/a b#1.html`
- **THEN** iframe 的 `src` 为 `<base>` 后接 `%E6%8A%A5%E5%91%8A%202026/a%20b%231.html`（各段分别编码，`/` 保留）

#### Scenario: 共用与续期
- **WHEN** 在同一工作空间里先后预览两个 html 与一个 pdf，停留 11 分钟（使用假定时器），随后切到一个 `md` 文件再停留 6 分钟
- **THEN** 前三次预览合计恰一次签发请求；停留期间恰两次续期请求，iframe 的 `src` 未变、没有重载；切到 `md` 之后没有新的签发请求

#### Scenario: 签发失败
- **WHEN** `issuePreviewToken` 返回 404（预览未装配）或网络失败时选中 `index.html`
- **THEN** 渲染视图处显示失败文案，没有 `iframe`；`查看源码` 可用并能显示源码；预览头的下载链接仍在

### Requirement: PDF 与办公文档
PDF SHALL 以不带 `sandbox` 属性的 `iframe`（`title` 为文件名）从 `base` 加载，交给浏览器自带的查看器。办公文档（`docx`、`xlsx`、`pptx`）SHALL 以同样的 `iframe` 从 `officeBase` 加载（服务端转成 PDF）；在 iframe 的 `load` 事件之前预览区 SHALL 盖一层 `正在转换文档…`（`role="status"`），`load` 之后撤掉——转换失败时 iframe 里是服务端的失败说明页。建 iframe 之前 SHALL 依次判定：树条目的大小超过 `documentMaxBytes` → 显示 `文件过大，无法预览`，不建 iframe；办公文档且 `officeAvailable` 为 `false` → 显示 `服务器未启用文档转换，请下载后查看`，不建 iframe；`navigator.pdfViewerEnabled === false` → 显示 `此浏览器不支持内嵌 PDF 预览，请下载后查看`，不建 iframe。三种情况都保留预览头的下载链接。

#### Scenario: PDF 的嵌入
- **WHEN** 选中 2 MB 的 `doc.pdf`
- **THEN** 预览区有一个 `iframe`，`src` 为 `<base>doc.pdf`，没有 `sandbox` 属性，`title` 为 `doc.pdf`

#### Scenario: 办公文档的嵌入与转换提示
- **WHEN** 选中 `plan.docx`，`officeAvailable` 为 `true`；随后 iframe 触发 `load`
- **THEN** iframe 的 `src` 为 `<officeBase>plan.docx`、没有 `sandbox` 属性；`load` 之前可见 `正在转换文档…`，之后不可见

#### Scenario: 不建 iframe 的三种情况
- **WHEN** 选中 150 MB 的 `huge.pdf`（`documentMaxBytes` 为 104857600）；`officeAvailable` 为 `false` 时选中 `a.xlsx`；`navigator.pdfViewerEnabled` 为 `false` 时选中 `doc.pdf`
- **THEN** 依次显示 `文件过大，无法预览`、`服务器未启用文档转换，请下载后查看`、`此浏览器不支持内嵌 PDF 预览，请下载后查看`；三者都没有 `iframe`，都有下载链接

### Requirement: 音视频
音频 SHALL 以 `<audio controls>`、视频 SHALL 以 `<video controls>` 播放，`src` 为主站 `/api/workspaces/<id>/file?path=<编码后的路径>`（同源、随 cookie，由浏览器发起范围请求），`preload="metadata"`，不自动播放；视频在预览区内等比缩放。页面 SHALL NOT 经 `fetch` 把媒体读进内存。媒体元素触发 `error` 时预览区显示 `无法播放该文件` 并保留下载链接。切换文件或卸载时媒体元素被移除（播放随之停止）。

#### Scenario: 播放器与地址
- **WHEN** 选中 `clip.mp4` 与 `voice.mp3`
- **THEN** 分别出现带 `controls` 的 `video` 与 `audio`，`src` 恰为对应的 `file` 地址，`preload` 为 `metadata`，没有 `autoplay`；没有经 `fetchPreview` 发出的请求

#### Scenario: 播放失败
- **WHEN** `video` 元素触发 `error` 事件
- **THEN** 预览区显示 `无法播放该文件`，下载链接仍在

### Requirement: Notebook
Notebook 预览器 SHALL 把 `fetchPreview` 取回的文本解析为 nbformat 4 的 JSON，按单元格次序只读渲染：Markdown 单元经既有 `mdRender`；代码单元显示执行计数（`[n]`，没有时为 `[ ]`）与经「源码视图与语法高亮」着色的源码（语言取 `metadata.language_info.name` 或 `metadata.kernelspec.language`，缺省 `python`）；raw 单元显示为等宽文本。输出按类型处理，全部视为不可信：`stream` 与 `text/plain` → 等宽文本；`error` → 去掉 ANSI 转义序列的 traceback 文本；`image/png`、`image/jpeg` → `src` 为 `data:` 地址的 `img`；`image/svg+xml` → `src` 为 `data:image/svg+xml` 地址的 `img`；`text/html` → `sandbox=""`（空值，不允许脚本）的 `srcdoc` iframe；同一输出有多种表示时按 图片 > `text/html` > `text/plain` 取一种；其它类型显示 `不支持的输出类型 <类型>`。输出内容 SHALL NOT 以任何方式作为 HTML 插入主页面的 DOM。文本不是合法 JSON、不含 `cells` 数组或 `nbformat` 不为 4 时 SHALL 退回源码视图并显示 `无法按 Notebook 解析，显示源码`。Notebook 不提供执行、编辑与输出的展开交互。

#### Scenario: 单元格与输出
- **WHEN** 显示一个含 Markdown 单元（`# 标题`）、代码单元（`print("hi")`，执行计数 3，`stream` 输出 `hi\n`）、带 `image/png` 输出的代码单元、带 `text/html`（内容含 `<script>` 与 `<table>`）及其 `text/plain` 备选的代码单元、带 `error` 输出（traceback 含 ANSI 颜色码）的代码单元、带 `application/vnd.custom+json` 输出的代码单元的 Notebook
- **THEN** 依次显示一级标题 `标题`；`[3]` 与着色的源码、等宽文本 `hi`；一个 `src` 以 `data:image/png;base64,` 开头的 `img`；一个 `sandbox` 属性为空串、带 `srcdoc` 的 `iframe`（主文档里没有因此新增 `script` 或 `table` 元素，且没有同时显示其 `text/plain`）；不含转义序列的 traceback 文本；`不支持的输出类型 application/vnd.custom+json`

#### Scenario: 解析失败退回源码
- **WHEN** `a.ipynb` 的内容不是 JSON；或是 JSON 但 `nbformat` 为 3；或没有 `cells`
- **THEN** 三例都显示 `无法按 Notebook 解析，显示源码` 与带行号的原文

#### Scenario: 超限
- **WHEN** `fetchPreview` 对 `big.ipynb` 返回 413
- **THEN** 显示 `文件过大，无法预览` 与下载链接，没有单元格

### Requirement: 压缩包列表
压缩包预览器 SHALL 调用 `listArchive(workspaceId, path)` 并以表格显示条目：每行一个路径（目录条目带目录图标）与大小（`formatSize`；`size` 为 `null` 时显示 `—`；目录不显示大小），路径作为纯文本显示、过长时截断并以 `title` 给出全文。表格上方显示 `共 N 项`；`truncated` 为 `true` 时显示 `仅显示前 N 项`。条目为空时显示 `压缩包内没有文件`。条目 SHALL NOT 可点击、SHALL NOT 触发任何解压或下载请求（下载整个压缩包用预览头的下载链接）。服务端 415（损坏或不是压缩包）显示 `无法读取该压缩包`。

#### Scenario: 列表与截断
- **WHEN** `listArchive` 返回三项（`a.txt` 5 字节、`dir/` 目录、`dir/b.md` 7 字节）、`truncated:false`；另一例返回 1000 项、`truncated:true`
- **THEN** 前者显示 `共 3 项` 与三行，大小列依次为 `5 B`、空、`7 B`；后者显示 `仅显示前 1000 项`；表格里没有按钮或链接

#### Scenario: 恶意成员名只是文字
- **WHEN** 条目路径为 `../../etc/passwd` 与 `<img src=x onerror=alert(1)>`
- **THEN** 两者作为纯文本出现在单元格里，文档里没有新增 `img` 元素，点击它们没有任何请求

#### Scenario: 损坏的压缩包
- **WHEN** `listArchive` 返回 415
- **THEN** 显示 `无法读取该压缩包`，下载链接仍在
