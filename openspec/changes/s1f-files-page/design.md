# Design: s1f-files-page

## Context

- **现状（master d7c575c 核对）**
  - 文件页全在旧样式层：`web/src/features/files/`（`tree.tsx` 644 行、`files.css` 628 行、`page.tsx` 442、`dialogs.tsx` 220、`preview.tsx` 204），
    从 `web/src/ui` 取 `Button`、`Dialog`、`Menu`、`Popover`、`EmptyState`，不在 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 里。地址只有 `?ws=<id>`。
  - 预览接口 `GET /api/workspaces/:id/file?path=`（`server/src/workspaces/rest.ts`）：十二个扩展名，文本一律 `text/plain`、1 MiB 截断，
    图片 png/jpg/jpeg、10 MiB 上限；不支持 `Range`；`classifyPreview` 只看扩展名与大小，不读正文。工作空间路由一共五条，没有删除、改名、移动、下载。
  - `core/sandbox` 的 `resolve` 只有 `read` / `list` / `mkdir` 三种 `op`；越界一律 403 `sandbox_denied` 并写 `sandbox.reject` 审计。
  - 会话页：`file-changes-card.tsx` 的 `查看详情` 只带 `?ws=`；`artifact-card.tsx` 的 `PreviewDialog` 用 `sandbox="allow-scripts"` + `srcdoc`
    （相对资源无从加载）；`artifacts-panel.tsx` 是右侧 `Sheet`，列出改动路径，没有文件树，切换会话时关闭。
  - 服务端只有一个监听（`server/src/server.ts` 的 `app.listen`）；没有 CSP / `X-Frame-Options`。会话 cookie `workbuddy_session` 为 `Path=/`、`HttpOnly`、
    `SameSite=Lax`、无 `Domain`——cookie 不按端口隔离，同主机上的另一个端口会收到它。
  - 启动记录 `{"event":"server_started",…}` 被规格钉为「不得有 extra key」；环境变量集合被钉为「共十五项」；归属 content-parser 的路由被钉为「精确十二条」；错误码被钉为「十三码」。
    这三个数是 master 的值：C 之后为十九项、十四条、十五码，S1g 之后为二十三项、十五条、十六码。本 change 在 S1g 之后的值上加十二项、两条、零码（三十五项、十七条、十六码）。
  - 会话删除用的 `<state>/trash` 是「先移入再立刻递归删除」，没有保留期，不能直接当回收站用。
  - `audit_events.kind` 只有格式约束（小写点分），新增审计种类不需要迁移。
  - `web/package.json` 没有任何高亮、PDF、办公文档、Notebook、压缩包相关的库；`hast-util-to-jsx-runtime` 已随 `@assistant-ui/react-markdown` 进了 `node_modules`。
  - 包体 `web/dist` JS 1,086,670 字节（gzip 326,274），`vite.config.ts` 没有 `manualChunks`，全站没有动态 `import()`。
  - `web/src/lib/api.ts` 778 行、`md-render.ts` 797 行，离 800 行上限都很近。
- **约束**：ADR-0013（拷入层六类修改、应用层不引 Radix）；ADR-0010（omp 以专用系统用户运行，凭证不进 omp 可读环境）；ADR-0011（界面只显示逻辑路径）；
  `CONTEXT.md` 不变量 3（一切路径过 `resolve`）；功能验收清单的行由 owner 签。
- **实现与归档次序**：C `s1f-session-list-temp-space` → S1g `s1g-composer-capabilities` → 本 change。上面的「现状」是 master 的代码事实；本 change 的规格 delta 里凡与 C 或 S1g 同名的 MODIFIED，都以「主规格 → C → S1g」叠加后的文本为底再加本 change 的增量（见 D25 的重叠表）。

## Goals / Non-Goals

**Goals:**

- 文件页换到新组件底座并退出旧样式层；首刀（现有功能、旧文件删除）可单独合入。
- #913 的格式清单一次交付；所有文件可下载；预览器按需加载。
- HTML 渲染预览里同空间的相对资源可用，且不可信内容（HTML、PDF、办公文档转出的 PDF）不在主站来源下作为文档渲染。
- 删除（可由管理员恢复）、重命名、同空间移动，全部过 `resolve`、全部入审计。
- 会话页右侧工作空间侧边栏取代产物面板与网页预览弹窗，文件树与预览跟文件页是同一套组件。

**Non-Goals:**

- 文件页上传（上传接口属 S1g，本 change 的文件页不加上传入口）。
- 在目录树里过滤 S1g 上传过程中的临时文件（`uploads/` 下以 `.upload-` 开头、`.part` 结尾的文件）：不做。S1g 的设计把「要隐藏就在文件页重写那边加一条过滤」留作可选项，本 change 不接——
  目录树如实列出目录内容，这类文件只在上传进行中或进程崩溃后存在，与其它点开头的文件同样显示；它们可以像普通文件一样被删除。
- 工作空间的删除与改名；跨工作空间移动；复制文件。
- 会话消息里代码块的语法高亮；在线编辑文件。
- 回收站界面与自助恢复（恢复由管理员在服务器上做）。
- 挂载的远程存储（SFTP / NFS / SMB，属 S1b）上的预览、移动与回收目录差异；跨文件系统的移动。
- 目录打包下载；下载的范围请求（断点续传）。
- 主站自身的完整内容安全策略；每账号独立的预览来源或子域。
- 产物卡可派生的扩展名集合不扩大（仍是 html、png/jpg/jpeg 与原有文本集合）。
- 把 `web/src/ui` 冻结区与 `legacy.css` 整体删除（见 Not yet specified）。
- 给包体设上限（ADR-0013 增补：S1f 全部 change 完成后再定；本 change 只量并记录）。

## Decisions

### 文件页与预览器

**D1 文件页分两刀重写，首刀只换底座。**
首刀把 `preview.tsx`、`dialogs.tsx`、`tree.tsx`、`page.tsx` 改用 `components/ui`（`dialog`、`dropdown-menu`、`popover`、`button`、`input`、`label`）+ Tailwind，
功能与今天完全相同，删除 `files.css` 与 `legacy.css` 里对它的导入，把 `web/src/features/files` 登记进 `MIGRATED_AREAS`。之后的格式、地址定位、文件操作各自成组叠在上面。
理由：首刀没有新行为，评审只需比对「同一行为、新底座」；后续每组只带一种新行为。
首刀内部按文件切成三刀，每刀合入后 `make check` 与 `make ui-walk` 全绿（tasks 组 2、3 逐条点名受波及的既有断言）：`preview.tsx`（2.1）、`dialogs.tsx`（2.2）、其余连同 `files.css` 的删除（组 3）。两处为此而定的做法：
`新建` 的 `CreationMenu` 在 2.2 从 `dialogs.tsx` 原样搬进 `tree.tsx`、到组 3 才迁移（`dialogs.tsx` 登记后不得再导入冻结区的 `Button` / `Menu`，而走查的层序探针在组 3 换掉之前要读 `新建` 这个 `.ui-btn`）；
`legacy.css` 里还原 Markdown 列表符号与标题字重的三条 `.files-md` 规则随 2.1 删除（只有 `preview.tsx` 用这个类），还原改由预览容器上的 Tailwind 类给出，走查既有的「列表符号不为 `none`」断言原样保留作证。
否决：一步到位（单个 PR 同时换底座又加十类预览，无法评审）；在旧文件页上先加格式再重写（做两遍，#913 明确要避免）。
规格上，`files-web` 既有六条的条文标题不变、正文整体改写为行为条款（去掉 `files.css`、类名与像素宽度）。
首刀连带改一条 ui-primitives 条文：「按钮单一实现与旧类退役」的场景「迁移后行为不回归」原先断言文件页的五个按钮与 `新建会话` 的类名是 `ui-btn …`，迁移后正相反——本 change 以 MODIFIED 把它改成迁移后成立的断言（类名不含 `ui-btn`，可访问名与行为不变；`新建会话` 的迁移来自 C，本 change 最后归档，一并收口）。
`files.css` 删除后，原先靠读它的规则体做的静态断言分三类处理（tasks 3.3 逐条列出，记入偏离记录）：像素值与旧类名的断言随条文删除；单行省略、容器内部滚动换成对渲染结果的类名断言；
#420「文件页不自涂底色」换成走查里的计算样式断言（files-web「文件界面与键盘可用性」的场景「文件页不自涂底色」），因为 Tailwind 类在 jsdom 里没有计算样式，只有真实浏览器能证明。

**D2 地址：`/files?ws=<id>&path=<空间内相对路径>`。**
`path` 是 `/` 分隔的相对路径，经 `URLSearchParams` 编码。进入页面时逐级列出它的各级父目录并展开，再选中该文件；`path` 指向目录时展开到它、不选中文件。
选中文件时以 `replace` 写入 `path`（不堆历史）；切换工作空间清掉 `path`。`path` 不存在或越界时树停在已成功展开的最深一级，预览区就地显示服务端文案。
否决：把路径放进 URL 路径段（`/files/<id>/a/b`，要改路由表与服务端的 history fallback 断言）；放 hash（路由库不解析）。

**D3 类别判定：浏览器按扩展名分流，「是不是文本」由服务端说了算。**
浏览器只为下列按扩展名确定的类别各持一张小表：图片（png、jpg、jpeg、gif、webp、bmp、ico）、PDF（pdf）、办公文档（docx、xlsx、pptx）、
音频（mp3、wav）、视频（mp4、webm）、Notebook（ipynb）、压缩包（zip、tar、gz、tgz）。**其余一切**（含 md、csv、代码、未知扩展名、无扩展名）
都发一次 `GET …/file`；唯一的例外是网页（html、htm）的渲染视图——它默认从隔离预览来源加载（D15），切到源码视图时才发这一次 `file` 请求。对 `file` 请求：服务端对已知文本扩展名直接按文本返回；对未知或无扩展名的文件读前 8192 字节嗅探（没有 NUL 字节且是合法 UTF-8）——是文本就返回，
否则 415 `preview_unsupported`，浏览器显示「该类型不支持预览」加下载按钮。
理由：#913 的清单以「等」结尾（`.proto`、`.vue`、`.kt`、`LICENSE`、`.gitignore`……），扩展名白名单永远列不全；嗅探让「看起来是文本的就能看」。
`classifyPreview` 仍只看元数据；嗅探是路由里的一步、只对未知扩展名发生，结果作为参数传给分类器。
否决：只加文件名白名单（Dockerfile、Makefile……）——未知扩展名的文本文件仍然看不了；新增一个 `stat` 端点由服务端返回类别——多一次往返，而按扩展名确定的那几类不需要它。
代价：浏览器与服务端各有一张扩展名表（图片与音视频），两表不一致时的表现是服务端 415，不是安全问题；由一条契约测试对齐（tasks 17.4）。

**D4 SVG 在主站来源下只当文本返回，由浏览器转成 `data:` 图片。**
服务端把 `svg` 归为文本（`text/plain`，1 MiB 截断）；浏览器把取回的文本做成 `data:image/svg+xml` 地址交给 `<img>`，并提供「图片 / 源码」切换；被截断时只显示源码。
理由：`<img>` 里的 SVG 不执行脚本；但若主站以 `image/svg+xml` 返回它，用户「在新标签页打开图片」就是在主站来源下执行 SVG 里的脚本；Blob 地址同理（Blob 继承创建者的来源）。
`data:` 地址是不透明来源，浏览器也不允许顶层导航到它。这与「HTML 永不以 `text/html` 从主站返回」是同一条规则。

**D5 高亮用 `lowlight`（MIT）+ `highlight.js`（BSD-3-Clause），输出经 `hast-util-to-jsx-runtime` 变成 React 元素。**
只注册需要的语言（按扩展名映射；未映射的扩展名不高亮、仍带行号）。高亮在一个按需加载的块里；高亮完成前先显示不带颜色的带行号源码。配色用主题变量，亮暗两套。
理由：`lowlight` 自身约 60 KB、产出语法树而不是 HTML 字符串，不需要 `dangerouslySetInnerHTML`；`highlight.js` 可按语言引入；树到 JSX 的工具已在依赖树里。
否决：Shiki（MIT，TextMate 语法 + 正则引擎，体积大一个量级）；Prism / refractor（语言包维护较少，同样需要自己接行号）；手写高亮（不现实）。
范围：只用于文件预览（文件页与侧边栏）；会话消息里的代码块不动（owner 划出）。

**D6 Notebook 不引库，自己渲染 nbformat v4 的 JSON。**
Markdown 单元用既有 `md-render`（源 HTML 已按文本转义）；代码单元用 D5 的高亮；输出按类型：`stream` 与 `text/plain` → 等宽文本；
`image/png`、`image/jpeg` → `data:` 图片；`image/svg+xml` → `data:` 图片（同 D4）；`text/html` → `sandbox=""`（不允许脚本）的 `srcdoc` iframe；
`error` → 等宽的 traceback（去掉 ANSI 转义）；其它类型显示「不支持的输出类型 <类型>」。JSON 解析失败或不是 v4 结构时退回源码视图。
理由：nbformat 是公开的简单 JSON；现成的浏览器渲染库（notebookjs 等）把输出里的 HTML 直接注入页面，还得再加一层净化。
否决：服务端用 `jupyter nbconvert`（多一个 Python 依赖与又一条不可信输入的解析路径）。

**D7 压缩包列表在服务端做：zip 用 `yauzl`（MIT），tar 与 tar.gz 用 Node 自带 `zlib` 加一个 512 字节头的遍历器，不引库。**
新端点 `GET /api/workspaces/:id/archive?path=` 返回 `{format, entries:[{path, type, size}], truncated}`；只读目录结构，不解压文件内容、不落盘；
到上限（缺省 1000 项）即停读；tar 与 tar.gz 都另有 5 秒的读取时限，到时返回已读到的部分并标 `truncated`。
为取成员名而读进内存的东西有硬上限：单个扩展记录（GNU `L`、pax 扩展头）至多 65536 字节，按头部**声明**的长度在读之前判定；单个成员名（含 zip 的）至多 4096 字节，超出的成员不计入结果。任一超出即停读并标 `truncated`
（zip 的成员名随中央目录项读入后才判定——名长字段只有 2 字节，读入量有界，不要求在 `yauzl` 交出该项之前拦截）——
这些长度是包里的字段、攻击者可控，一个 1 KiB 的 tar 可以声明 4 GiB 的长文件名记录；有了上限，处理一个压缩包占用的内存与包内声明的任何长度无关。单个 `.gz`（非 tar）列出一项（去掉 `.gz` 的文件名，大小未知）。
理由：浏览器侧列表要先把整个压缩包下载下来再交给一个解压库（JSZip 约 100 KB），大压缩包不可行；zip 的中央目录在文件尾，服务端可以只读那一段；
tar 头是定长块，遍历器只需认 ustar 的 `name`/`prefix`、GNU 长文件名（`L`）与 pax 的 `path` 记录。
否决：`tar-stream`（MIT，但带四个间接依赖，只为读文件头不值）；`node-tar`（BlueOak 许可，体量大）。

**D8 上限按类别、由环境变量配置；超限的呈现分三种。**
`PREVIEW_TEXT_MAX_BYTES`（1048576，超出截断）、`PREVIEW_IMAGE_MAX_BYTES`（20971520，超出 413）、`PREVIEW_NOTEBOOK_MAX_BYTES`（10485760，超出 413——截断的 JSON 没法解析）、
`PREVIEW_DOCUMENT_MAX_BYTES`（104857600，PDF 与办公文档）、`PREVIEW_ARCHIVE_MAX_ENTRIES`（1000）。音视频不设上限（范围请求分段取）。下载不设上限。
文档上限随预览令牌的响应下发（`documentMaxBytes`），浏览器拿树条目的大小先比，超限就不建 iframe。服务端只有办公文档的 `/o/` 执行这个上限（413，不启动转换）；
PDF 的上限**只在浏览器侧判定**，`/w/` 对任何文件都没有大小上限。理由：`/w/` 还要提供 HTML 页面引用的任意相对资源（大的视频、数据文件都可能是页面的一部分），
持有令牌本就可以经它读到该空间的任何文件，按扩展名单独拦 `pdf` 不减少暴露面，只多一条特例；owner 定的「PDF 100 MB」是「多大的 PDF 还尝试内嵌预览」的呈现门槛，由页面执行即可。
超限时预览区显示说明（`文件过大，无法预览` 或截断提示）与下载按钮。

**D9 预览器按需加载，且这是唯一允许的代码分割。**
`web/src/features/files/previewers/` 下每类预览器一个模块，只经同目录的 `index.ts` 以动态 `import()` 引用；`web/src` 其它位置不得出现动态 `import()`，
`vite.config.ts` 不加 `manualChunks`。一条静态守卫测试钉住这两点。加载失败（断网、发布后旧页面取不到新块）在预览区就地显示「预览组件加载失败」与重试、下载。
ADR-0013 增补记录这条例外与本 change 完成后的包体数字。

**D10 下载是一次普通的浏览器导航，不经 `fetch`。**
预览头部的下载按钮是 `<a href="/api/workspaces/<id>/download?path=…" download>`；服务端以 `Content-Disposition: attachment` 与 `application/octet-stream` 流式返回，
发首字节之前写审计 `file.download`。理由：下载不设上限，`fetch` → Blob 会把整个文件放进内存。代价：文件已不存在时浏览器自己报下载失败，页面拿不到错误。
产物卡的图片 `下载` 同样是这个链接（owner D-19）：与预览头同一实现，写 `file.download` 审计、不限大小；原来「经预览接口取回图片、做成 Blob 地址再触发下载」的实现与它的 Blob 生命周期条款一并去掉，
图片卡因此不再发 `file` 请求，也不再有就地失败文案（失败由浏览器报）。产物卡的代码 `复制代码` 维持现状（仍经预览接口取文本、受 1 MiB 截断约束、失败就地显示）。

### 隔离预览来源

**D11 形态：同一进程里的第二个 Fastify 实例，监听 `PREVIEW_PORT`，只注册两条 GET 路由。**
`createPreviewApp({store, sandbox, tokens, converter, limits})` 是独立的 Fastify 实例：不注册认证插件、不解析 cookie、不托管静态文件、不挂 `/api`。
它与主实例共用工作空间 store 与沙箱 facade（同一个 DB 句柄），由 `server.ts` **先于**主监听器 `listen`（主监听器开始受理请求时 `preview-token` 给出的地址已经可用；预览端口绑定失败时主端口从未处于可连接状态）、在主监听器之前关停。
理由：独立实例才能保证「这个端口上没有任何认 cookie 的路由」是结构性的，而不是靠每条路由自觉；也让它有自己的有界关停。
否决：在主实例上按 `Host` 头分流（一个漏判就把 `text/html` 发到了主站来源）；独立进程（多一套部署与凭证传递）；子域（需要 DNS 与证书，owner 已选独立端口）。

**D12 端口与对外地址：`PREVIEW_PORT` 缺省 `0`（由系统分配），`PREVIEW_ORIGIN` 可选。**
浏览器从不自己拼预览地址：它调用 `POST /api/workspaces/:id/preview-token`，响应里的 `base` 是完整前缀。未设 `PREVIEW_ORIGIN` 时，
`base` 的来源取「这次请求的协议与主机名 + 预览监听器实际绑定的端口」；设了就原样用它（反向代理、TLS 终结、端口映射时必须设）。
缺省为 `0` 的理由：仓库里大量测试并行启动编译入口，任何固定缺省端口都会相互抢占；开发机上不需要知道这个端口；部署时本来就要显式指定并放行。
启动记录 `server_started` 不加键（它被规格钉为精确四键，且端口对运维的意义由显式配置承担）。
否决：缺省 `PORT + 1`（相邻端口的测试仍会相撞）；缺省不启用（功能默认缺席，违背「同批上线」）。

**D13 令牌：进程内登记表里的不透明随机串，绑定一个账号、一个工作空间与签发时的嵌入来源，闲置 15 分钟失效，放在路径里。**
- 签发：`POST /api/workspaces/:id/preview-token`（主站、cookie 鉴权、无请求体）。同一账号同一工作空间在未过期时重复调用返回**同一个**令牌并把到期时间推后到「现在 + 15 分钟」——
  浏览器在预览打开期间每 5 分钟调一次即可续期，iframe 的地址不变、不重载。不存在或属他人的工作空间 → 与其它端点相同的 404。
- 形态：32 字节随机数的十六进制（64 个字符），登记表 `token → {ownerId, workspaceId, embedOrigin, expiresAt}`，只在内存；进程重启后全部失效（预览重新取一次即可）。
- 使用：预览监听器上的 `/w/<token>/<相对路径>` 与 `/o/<token>/<相对路径>`。令牌在路径里，页面里的相对地址（`./style.css`、`img/a.png`）自动落在同一前缀下；
  浏览器会把 `..` 规范化掉，越过前缀的地址落不到任何路由上。对监听器的请求**不**续期（泄漏出去的地址不能自己续命）。
- 每次使用都重新核对：令牌未过期 → `rootOf({id: ownerId}, workspaceId)` 仍有值（空间还在、仍属该账号）→ 路径过 `resolve(op=read)`。
- 不认 cookie：监听器不读 `Cookie` 头。带着有效 `workbuddy_session` 而没有有效令牌的请求是 404；有有效令牌而没有 cookie 的请求照常返回。
理由：登记表与既有 `TokenRegistry`（模型代理的会话 bearer）同一做法，不需要密钥管理与迁移；可续期避免了「看一份长 PDF 看到一半令牌到期」。
否决：HMAC 签名的无状态令牌（不能续期，换令牌就要换地址、iframe 重载）；令牌放查询串（相对资源不会带上）；放 cookie（正是要避免的东西）。
退出登录不主动吊销令牌：它最多再活 15 分钟，且只指向该账号自己的一个工作空间（见 Risks）。

**D14 预览监听器的响应头：每个响应（成功与失败）一律 `nosniff`、`no-store`、`no-referrer`；成功响应另带 `Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin` 与 CSP，其中除 PDF 外一律带 `sandbox`。**
- `Content-Security-Policy`：非 PDF 响应为 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors <embedOrigin>`；PDF 响应只有 `frame-ancestors <embedOrigin>`。
  `embedOrigin` 是签发令牌的那次请求的 `Origin` 头；没有该头（非浏览器客户端）时为 `'none'`。
  这个头由客户端任意填写，所以在写头的那一步校验（owner 追认 2026-10-09）：只有它恰是一个序列化的来源（能解析为 URL、解析结果的 `origin` 与它逐字相等）且不含 `*`、`;`、`,`、`'` 时才逐字写进 CSP，否则与没有一样取 `'none'`——
  这四个字符在 CSP 里依次是通配、指令分隔、策略分隔与关键字引号，而 URL 的主机名并不禁止它们（`http://a.test;sandbox` 能解析且原样往返）。令牌登记表不校验，原样保存。
- CSP `sandbox` 不含 `allow-same-origin`：文档拿到的是不透明来源。于是即使用户把预览地址单独在新标签页打开，页面脚本也读不到任何来源的存储，
  它向主站发的子请求是跨站请求、不带 `SameSite=Lax` 的 cookie。这一条是「不认 cookie」之外的第二道防线，针对的是「同主机不同端口仍是同站」。
- `Referrer-Policy: no-referrer`：owner 允许预览加载外部资源（CDN 脚本、外部接口），令牌在路径里，不能让它经 `Referer` 漏给第三方。
- `Access-Control-Allow-Origin: *`（只在成功响应上）：不透明来源下页面自己的 `fetch("./data.json")`、`<script type="module">`、字体都是跨来源请求，需要它才能读到同空间的文件。
  持有令牌地址本身就等于有权读，放开不增加暴露面。成功响应同时带 `Cross-Origin-Resource-Policy: cross-origin`；失败响应（404 / 403 / 416）不带这两个头，也不带 CSP。
- 外部资源不加限制：CSP 不设 `default-src` 之类的取源指令（owner 决定）。
- 内容类型按扩展名取一张固定表（html、css、js、json、常见图片与字体、pdf、音视频）；表外一律 `application/octet-stream`。支持单段 `Range`。
- 拒绝：令牌未知或过期、空间已不存在、目标不存在、目标是目录（不列目录、不找 `index.html`）、非 GET/HEAD → 404；越界路径与符号链接 → 403 并写 `sandbox.reject` 审计（actor 为令牌的账号）。
  错误体是固定的短中文纯文本，不是 JSON 信封（信封规格只管 `/api/*`），不含任何请求内容。

**D15 主站怎样嵌入。**
- HTML 渲染视图：`<iframe src="<base><path>" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer" title="<文件名>">`。
  属性与响应头的 `sandbox` 取同一组，谁都不含 `allow-same-origin`、`allow-top-navigation`、`allow-popups`。
- PDF 与办公文档：`<iframe src="…" title="<文件名>">`，**不带** `sandbox` 属性。
- 主站页面自身的响应头不变（不新增 CSP）。预览页面里的脚本拿不到主站的任何东西，依据是 D13/D14，而不是主站的头。
已知限制：不透明来源下 `localStorage`、`sessionStorage`、cookie、IndexedDB 不可用，依赖它们的页面会报错——与现有 `srcdoc` 预览相同，不是回归。

**D16 PDF 交给浏览器自带的查看器，从隔离来源以不带 `sandbox` 的 `iframe` 加载。**
依据：Chromium 的内置 PDF 查看器在带 `sandbox` 的 iframe（或带 CSP `sandbox` 的响应）里不工作，所以 PDF 响应不带 `sandbox`、iframe 不带 `sandbox` 属性；
它仍在隔离来源下（与主站不同来源），`Content-Type: application/pdf` 加 `nosniff` 保证不会被当成 HTML。规格只有这一种嵌入方式（`iframe`）。
`navigator.pdfViewerEnabled === false`（移动端浏览器、禁用了内置查看器）时不建 iframe，显示「此浏览器不支持内嵌 PDF 预览，请下载后查看」加下载按钮——这是规格里的确定行为，不是回退方案。
**前置核对**（tasks 1.1，在组 19 开工之前做完）：在桌面 Chromium 与 Firefox 里，从另一个端口的来源以无 `sandbox` 的 iframe 加载 PDF，带 CSP `frame-ancestors`。两个确定的分支：
- 查看器正常出现、可翻页 → 与本设计一致，组 19 照规格实现，实测记录写在本条下的「实测」小节。
- 任一浏览器不显示 → **停下回 owner**，组 19 中 PDF 与办公文档的部分不开工（其余组不受影响）。本设计不预先批准任何替代方案：`<object>`、`<embed>`、pdf.js 都要改规格（file-previewers「PDF 与办公文档」、preview-origin 的 PDF 例外头），pdf.js 还是一个新的依赖与体积决定。

**实测**（#1050，tasks 1.1；2026-10-06，macOS arm64，均为有界面模式。一次性本地页面不入库：宿主页与 PDF 各在一个回环端口，宿主页的 `iframe` 不带 `sandbox` 属性；PDF 响应带 `Content-Type: application/pdf`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: frame-ancestors <宿主来源>`；PDF 共 4 页，每页一行大字。「可翻页」的判定是点进 iframe 后滚轮与 End 键把页码从 1 带到 4，截图逐张看过。）

| 情况 | 浏览器与版本 | 查看器出现 | 可翻页 | 现象 |
|---|---|---|---|---|
| 无 `sandbox`（本设计的形态） | Chromium 151.0.7922.34（Playwright 1.62.1 自带构建） | 是 | 是 | 内置查看器工具栏 1/4 → 4/4，缩略图栏在 |
| 无 `sandbox` | Google Chrome 154.0.8037.98 | 是 | 是 | 与 Chromium 151 相同 |
| 无 `sandbox` | Firefox 153.0（Playwright 1.62.1 自带构建，`pdfjs.disabled` 改回正式版默认值 `false`） | 是 | 是 | 内置 PDF.js 工具栏「1 of 4」→「4 of 4」 |
| PDF 响应加 CSP `sandbox allow-scripts allow-forms allow-modals; frame-ancestors …` | 上述三个 | 是 | 是 | 与不加时无差别，控制台与网络无报错 |
| PDF 响应加裸 CSP `sandbox; frame-ancestors …` | 上述三个 | 是 | 是 | 同上 |
| `iframe` 加 `sandbox="allow-scripts allow-forms allow-modals"` 属性（响应不带 CSP `sandbox`） | Chromium 151、Chrome 154 | 否 | 否 | 请求被拦（`net::ERR_BLOCKED_BY_CLIENT`），iframe 内是错误页 |
| 同上 | Firefox 153.0 | 是 | 是 | 照常显示 |
| 内置查看器被禁用（`navigator.pdfViewerEnabled === false`） | Firefox 153.0（`pdfjs.disabled=true`） | 否 | 否 | iframe 空白并触发下载 |

对照：同一条 CSP `sandbox` 头放在 HTML 文档上时，文档内 `self.origin` 为 `null`、不带时为 PDF 所在来源——测试用的头确实生效。

- **结论：与设计相符**——无 `sandbox` 时桌面 Chromium 与 Firefox 的内置查看器都出现且可翻页，组 19 照规格实现。`iframe` 不带 `sandbox` 属性对 Chromium 是必需的（加了就被拦）；`pdfViewerEnabled === false` 时浏览器不内嵌而是下载，与本条「不建 iframe、显示下载按钮」的分支一致。
- **与本条依据不一致的一点（不改变上面的结论，留给 owner）**：依据里的「带 CSP `sandbox` 的响应里不工作」在这三个版本上没有复现——PDF 响应带 CSP `sandbox`（两种形式）时查看器照常工作。使查看器失效的是 `iframe` 的 `sandbox` 属性，不是响应头。D14 给 PDF 响应的例外（不带 CSP `sandbox`）因此不是这些版本上的必要条件；是否保留该例外是规格决定，本项只记录现象，规格不改。
- 范围说明：Firefox 测的是 Playwright 的构建，没有测 Mozilla 正式发行版；只测了 macOS 上的这三个版本。


### 办公文档

**D17 办公文档经 LibreOffice 无界面转换成 PDF，由预览监听器的 `/o/<token>/<path>` 返回。**
- 调用：`<OFFICE_BIN> --headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file://<job>/profile --convert-to pdf --outdir <job>/out <输入绝对路径>`，
  每次转换一个独立的 `<job>` 目录（`<PREVIEW_CACHE_DIR>/work/<随机名>`）——LibreOffice 同一个用户配置目录不能并发，独立的 `UserInstallation` 是并发的前提，
  也保证每次都是出厂默认的宏安全级别。环境只有 `PATH`、`LANG`（有则传）、`HOME=<job>`；工作目录为 `<job>`；标准流丢弃。
- 判定成功：进程退出码 0 且 `<job>/out/<输入文件去扩展名>.pdf` 是大小大于 0 的普通文件。其余（非 0 退出、无输出、超时）都是失败。
- 超时 `OFFICE_CONVERT_TIMEOUT_MS`（缺省 60000）：到时按 D18 的做法终止转换（同 uid 模式杀进程组，`OMP_USER` 模式杀 `sudo`），并尽力删除 `<job>`（`OMP_USER` 模式下删不全，见 D18「作业目录的清理」）。
- 并发 `OFFICE_CONVERT_CONCURRENCY`（缺省 2）：同时最多这么多个转换进程；排队最多 8 个，再来的直接判「繁忙」。同一个缓存键的并发请求共用一次转换。
- 缓存：键为 `sha256(<输入绝对路径> NUL <mtimeMs> NUL <size>)`，文件 `<PREVIEW_CACHE_DIR>/pdf/<键>.pdf`（目录 `0700`，只属应用用户）。
  命中时更新它的修改时间并直接返回；转换成功后把输出**复制**成应用用户自己的新文件再尽力删除 `<job>`（不是改名——见 D18）。
  启动时清空 `work/`（同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时先经一条固定参数的 `sudo … find`，见 D18「作业目录的清理」）；启动时与此后每 24 小时删除 `pdf/` 下修改时间早于 7 天的文件。按路径 + 修改时间 + 大小而不是按内容哈希：不必为算键把 100 MiB 的文件读一遍。
- `OFFICE_BIN` 未配置时该功能关闭：令牌响应里 `officeAvailable` 为 `false`，浏览器显示「服务器未启用文档转换，请下载后查看」加下载按钮；直接请求 `/o/` 得 503。
否决：浏览器侧解析库（docx-preview、SheetJS、pptx 渲染各一套，保真度差、体积大，owner 已定服务端转换）；常驻的 `soffice --accept` 服务（要管它的生命周期与崩溃恢复，单实例还得自己排队）。

**D18 转换进程的身份：配置了 `OMP_USER` 时以该用户运行，否则与应用同 uid。**
理由：LibreOffice 解析的是不可信文档，是一块大的攻击面；应用用户持有数据库与上游密钥，ADR-0010 的全部意义就是不让处理不可信输入的进程与它同 uid。
spawn 行沿用 omp 的形态：`sudo -n -u <OMP_USER> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> …`；sudoers 相应多一行
（`<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *`）；启动时清空 `work/` 另需一行（owner D-24，见下「作业目录的清理」）。两行都写进 ADR-0010 增补。
`<PREVIEW_CACHE_DIR>`（`2750`）、`work/`（`2770`，该用户可写）、`pdf/`（`0700`）由应用在监听成功后用 `ensureOwnedDir` 建出并校正；每个 `<job>` 目录 `2770`。
输出要**复制**进 `pdf/` 而不是改名：改名后的文件仍属 omp 用户，一个被攻破的转换进程若留着它的文件描述符就能改写缓存，而所有账号共用这个缓存。
输入文件能被该用户读到：工作空间目录本来就对它组可读写。
**终止在途转换（超时、中止、关停）的做法已定（owner D-21）：不新增提权规则。**
- 同 uid 模式（未配置 `OMP_USER`）：转换进程以新的进程组启动，终止时对进程组发 `SIGKILL`——进程及其全部后代都不存在。
- `OMP_USER` 模式：应用用户无权向该用户的进程发信号（ADR-0010 的实测：`kill` 得 `EPERM`），终止时杀自己启动的 `sudo`；`sudo` 的直接子进程由 `setpriv --pdeathsig KILL` 随之被内核杀掉。
  直接子进程的后代不随之结束：LibreOffice 的包装脚本再派生的 `soffice.bin` **每次都留下**，并把整份转换跑完才自行退出（下面的「实测」：5 次终止 5 次如此，最长在终止之后 128 秒，长于 60 秒的缺省超时）——**登记为已知残余**（owner D-25：D-21 维持，措辞按实测改写），与 ADR-0010 已登记的「omp 派生的工具子进程可能存活」同类，写进 ADR-0010 增补与 ADR-0014 的运维一节；运维一节要写明怎样查到并结束它们。
  残留进程不占并发名额（名额在 `convert` 落定时释放），所以 `OMP_USER` 模式下主机上实际同时运行的 `soffice.bin` 可以多于 `OFFICE_CONVERT_CONCURRENCY`；它用着的 `<job>` 目录删不掉，留到下次启动时对 `work/` 的清空。
- 否决：以该用户身份 `pkill` 作业进程——要多一行 sudoers（新的提权面：应用用户可以让 omp 用户执行带通配参数的 `pkill`），为一个可用性残余不值。
- 规格相应分两种模式写可观察结果，「进程及其子进程都不存在」的场景限定在同 uid 模式（假 `soffice` 可证）；`OMP_USER` 模式的场景只断言 `sudo` 已被杀、没有执行 `kill`/`pkill`/第二次 `sudo`。
- 上线前在测试 VPS 上实测一次（tasks 1.3）：sudo 模式下转换能跑通、两个并发转换互不干扰，以及超时杀掉 `sudo` 之后残留进程**是否出现**——只记录现象，写进 ADR-0010 增补，不再决定做法。结果见下面的「实测」；owner 据它于 2026-10-09 作出的两项裁决是 D-24 与 D-25。

`PREVIEW_CACHE_DIR` 单独一个目录（缺省 repo-root `var/preview-cache`），不放进 `OMP_STATE_DIR`：那棵树的目录表被 omp-runtime 规格逐项钉死，往里加目录要改那条规格，没有必要。

**作业目录的清理（owner 裁决 2026-10-09，D-24，#1052 第 1 点）：同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时，启动时经一条固定参数的 `sudo … find` 清空 `work/`。**
「实测」表明该模式下应用用户删不掉 `<job>`：LibreOffice 在其下建的 `profile/`、`.cache/` 属 omp 用户、只有该用户可进入，连正常跑完的作业也一样。裁决如下：
- sudoers 再加**恰一行**，参数逐项固定、没有通配：`<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`。
  它只让应用用户以 omp 用户的身份删除 `work/` 之下的条目（`-mindepth 1` 不删 `work/` 自身）；`find` 缺省不跟随符号链接，而且命令以 omp 用户的身份运行，删得掉的只是 omp 用户自己本来就删得掉的东西。
  规则里的路径必须与服务端解析 `PREVIEW_CACHE_DIR` 得到的绝对路径逐字相同（相对值按 repo root 解析；不带末尾斜杠、不经符号链接换写）：sudo 按字面比对参数，差一个字符就是拒绝。
- 服务端**只在同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时**、**启动时执行一次** `sudo -n -u <OMP_USER> -- /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`，在转换器受理第一次转换之前；随后照旧由自己递归删除 `work/` 下余下的条目（属应用用户的那部分）。子进程的工作目录固定为 `/`（GNU `find` 退出前要回到初始目录，omp 用户进不去时会把已完成的删除报成失败）；路径取 `join(cacheDir, "work")`，sudoers 里写的必须是同一个规范化结果，含空格等特殊字符时按 sudoers 语法转义。上一次运行残留的 `soffice.bin` 若仍在写它的 `<job>`，这一次可能删不净，留到下一次启动。
  配了 `OMP_USER` 而没配 `OFFICE_BIN` 时不执行 `sudo`：没有转换器，`work/` 下不会有属 omp 用户的东西，这样的部署也不需要这一行 sudoers。服务端自己的递归删除在每一种模式下都执行。
  启动前对 `PATH` 做与 spawn 前缀相同的安全检查（`sudo` 经 `PATH` 查找）；不经 `setpriv`（它是一次性的短命令，没有需要随父进程结束的东西）；环境只有 `PATH` 与 `LANG`。
- 该命令失败（规则没配、`find` 不在该路径、非 0 退出）只记一行日志（`preview_work_clear_failed`，不带路径），**不阻止启动**：规则漏配的部署照常提供转换，只是 `work/` 不归零。
- 单次转换之后对 `<job>` 的删除保持已交付的尽力而为，不为它提权。所以 `OMP_USER` 模式下 `work/` 在一次运行期间会增长（实测：小文档每个作业约 650 KB；被终止的作业另加完整的输出 PDF，20–78 MB），重启时归零；写进运维一节。
- 同 uid 模式不变：不执行 `sudo`，自己删得掉。CI 的 `uid-isolation` job 不设 `OFFICE_BIN`，所以 `.github/scripts/ci-uid-isolation.sh` 写出的 sudoers 不需要改。
- 否决：每次转换之后都经 sudo 删除 `<job>`——规则里的路径带随机的作业目录名，只能写成通配，正是 D-21 不要的那种提权面；周期性地执行这条 `find`——会删掉在途转换的作业目录。
这是一项**审批 / 提权策略**的改动：给应用用户多了一条以 omp 用户身份执行的命令。它是 owner 的决定（D-24），不是起草者或实现者可以自定或调整的；实现它的 PR 落在 `AGENTS.md` 的 Critical Path「omp 子进程治理」上，须标注白盒审查，测试通过不豁免。

**实测**（#1052，tasks 1.3；2026-10-06，与 D22「实测」同一套测试 VPS 容器内的 uid 分离部署。LibreOffice 24.2.7.2（只装 writer 组件）；`/usr/bin/soffice` 是包装脚本，它启动 `oosplash`，再由后者派生 `soffice.bin`。本项只记录现象，不决定做法。）

sudoers 只新增本条写明的一行（`<应用用户> ALL=(<omp 用户>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- /usr/bin/soffice *`）。应用用户（umask `007`，工作目录与 `HOME` 为 `<job>`，`<job>` 为 `2770`、属应用用户）执行：

```
sudo -n -u <omp 用户> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL -- /usr/bin/soffice --headless --norestore --nolockcheck --nodefault --nofirststartwizard -env:UserInstallation=file://<job>/profile --convert-to pdf --outdir <job>/out <工作空间里的 docx>
```

- **转换能跑通**：退出码 0，约 1.2 秒，`<job>/out/<名>.pdf` 生成（`0660`、属 omp 用户与共享组），应用用户能把它复制进 `pdf/`。`out/` 不必预建。
- **进程身份**：`oosplash` 与 `soffice.bin` 的 `Uid:` 四个值都是 omp 用户（`sudo` 自身是实际 uid 应用用户、有效 uid root）。
- **并发**：两个转换各用自己的 `UserInstallation` 同时进行——两个小文档、以及两个各约 25 秒的文档全程重叠——都以退出码 0 结束并各自产出 PDF。
- **杀 `sudo` 之后**（应用用户对自己启动的 `sudo` 发 `SIGKILL`，共 5 次：约 25 秒的文档在第 3 秒杀 3 次、在第 0.15 秒杀 1 次，约 133 秒的文档在第 5 秒杀 1 次）：`sudo` 立即消失，它的直接子进程 `oosplash` 随之被杀（`--pdeathsig` 生效）；**`soffice.bin` 每次都残留**——属 omp 用户、被 1 号进程收养、持续占用 CPU，并且**把整份转换跑完才自行退出**（杀后约 20–23 秒；大文档杀后 128 秒，长于 60 秒的缺省超时），在已被放弃的 `<job>/out` 里留下与未中断时字节数相同的完整 PDF，没有半截文件。5 次表现一致，不是偶发。

实测当时与本条及 D17 的文字不一致的两点（owner 已于 2026-10-09 裁决：第 1 点见 D-24，第 2 点见 D-25；本条正文、D17 与规格已按裁决改写，下面两点保留实测时的原文，其中「规格未改」「做不到」说的是裁决之前）：

1. **应用用户删不掉 `<job>`，转换成功的作业也一样。** LibreOffice 把 `<job>/profile` 建成 `0700`、属 omp 用户（不受 umask `007` 影响）；因为 `HOME=<job>`，它还在 `<job>` 下建 `.cache/` 与 `.config/`（`2700`、属 omp 用户）。对一个正常跑完的作业目录做递归删除：只删掉 `out/` 与空的 `.config/`，`profile/` 与 `.cache/` 留下，`EACCES`。于是 D17 的「转换成功后删 `<job>`」「超时清掉 `<job>`」「启动时清空 `work/`」与本条的「留给下次启动时对 `work/` 的清空」在 `OMP_USER` 模式下按现有的一行 sudoers 都做不到，`work/` 只增不减（小文档每个作业约 650 KB；被杀的作业另加完整的输出 PDF，实测 20–78 MB）。同 uid 模式不受影响。
2. **残留进程的代价比本条描述的大。** 它不是很快自行消失，而是占一个核直到整份文档转完；并发名额在 `convert` 落定时已经释放，所以实际同时运行的 `soffice.bin` 可以多于 `OFFICE_CONVERT_CONCURRENCY`。

- 范围说明：全程在容器内（1 号进程是容器的 init，负责收养并回收孤儿进程）；只测了对 `sudo` 发 `SIGKILL`；只测了 docx（xlsx / pptx 与经 `/o/` 的端到端属 tasks 28.6）；每次转换的标准错误里有一行与结果无关的 `javaldx` 警告。

**D19 转换失败的呈现在 iframe 里，不新增错误码。**
`/o/` 的失败是预览监听器上的固定纯文本页：413「文件超过预览上限，请下载后查看」、415「该类型不支持转换」、502「文档转换失败，请下载后查看」、
503「文档转换繁忙，请稍后重试」/「服务器未启用文档转换」、504「文档转换超时，请下载后查看」。主站页面在 iframe 的 `load` 事件之前盖一层「正在转换文档…」，
`load`（成功页与失败页都会触发）之后撤掉。预览头部的下载按钮始终可用。
理由：转换结果本来就只在 iframe 里消费，没有必要让主站 API 认识「转换失败」；主站的错误码集合（http-service-skeleton「统一错误信封」的 definition map）因此不因本 change 增加任何成员。

**D20 测试替身有两层。**
- 端口：`createPreviewApp` 收一个 `converter`（`{available, convert(absInput, signal) → Promise<absPdf>}`），路由测试注入内存替身，覆盖成功、各类失败、并发去重。
- 可执行文件：`server/test/fixtures/fake-soffice.mjs`（可执行的 Node 脚本，认 `--convert-to pdf --outdir`，按输入文件名里的标记决定写出一个最小 PDF、以非 0 退出、睡过超时、或写空文件），
  真实的 spawn / 超时 / 并发 / 缓存实现对着它测。CI 与开发机都不需要 LibreOffice。
- 真实转换（docx、xlsx、pptx 各一份）是测试 VPS 上的人工验证任务（tasks 28.6），不进 CI。
- `OMP_USER` 模式的终止路径用记录型假 `sudo`（记录自己的 pid 后睡眠）测：断言被杀的是它、它恰被启动一次。

### 文件操作

**D21 `resolve` 增加 `delete` 与 `move` 两个 `op`，与 `mkdir` 用同一条末段校验。**
末段必须非空、不是 `.` / `..`、不含反斜杠——因此空路径（空间根本身）对这两个 `op` 是拒绝，根不能被删除或移动。移动的源与目标各 `resolve` 一次（都用 `move`），
两者都在同一个工作空间根内，跨空间移动在接口形状上就不存在（路由只有一个 `:id`）。本 change 不使用 S1g 的 `write`（文件页不做上传，删除与移动也不创建文件）。
S1g 先合入并在 `resolve.ts` 与 facade 的 `op` 联合里加了 `write`；本 change 在 S1g 之后的联合上加 `delete`、`move`，末段校验从 `mkdir`、`write` 扩到四种 `op`，不动 `write` 的任何规则（sandbox-core 的 delta 以 S1g 的文本为底，见 D25）。

**D22 删除 = 改名进回收目录；回收目录在 `<SANDBOX_ROOT>/.trash`，保留 30 天。**
- 位置：`<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<批次>/<原文件名>`，批次名 `<删除时刻的毫秒数>-<16 位十六进制随机数>`。`.trash` 及其下各级目录 `0700`、属应用用户，
  每一级都用既有的 `ensureOwnedDir` 建立并在每次删除时重新校验：`SANDBOX_ROOT` 对 omp 用户组可写，它可以抢先放一个 `.trash` 符号链接把被删的文件引到别处——校验不过就 500、什么都不移动。
  放在 `SANDBOX_ROOT` 下是为了与工作空间同一文件系统——`rename` 才是原子的，目录再大也是一次系统调用。`<state>/trash` 不合适：`OMP_STATE_DIR` 可以在另一个文件系统上，
  而且它现有的语义是「移入后立刻删」。账号 id 由服务端生成，不以 `.` 开头，`.trash` 不会与某个账号的目录重名（实现时以一条断言钉住）。
  已交付的保证在 store 一侧（owner 追认 2026-10-09）：`server/src/workspaces/store.ts` 的 `rejectUnsafeOwnerSegment` 拒绝以 `.` 开头的 owner 段，所以没有哪个账号的根目录能落在 `.trash` 这个名字上。
- 流程：`resolve(op=delete)` → 目标必须存在且是普通文件或目录 → 建批次目录 → `rename` → 写审计 `file.delete`（`detail` 含 `path`、`type`、`trashId`=批次名）→ 204。
  `rename` 失败（含跨文件系统的 `EXDEV`）→ 500，目标原样留着，空的批次目录删掉。
- 保留与清理：`TRASH_RETENTION_DAYS`（缺省 30）。监听成功后与此后每 6 小时扫一遍，删除批次名里的时刻早于保留期的批次；名字不合规则的条目不碰；清理出错不报、下次再试。
- 恢复：界面不提供。管理员按审计里的 `trashId` 到服务器上把批次里的条目移回去（写进 ADR-0014 的运维一节）。
- 与临时空间（C）的关系：清理只看目录结构与批次名里的时间戳，不查 `workspaces` 表。临时空间随最后一个会话删除时（C 的 temporary-workspaces「临时空间目录的删除」只删 `tmp-<id>` 目录与快照目录，本 change 不改那条），
  它在 `.trash/<ownerId>/<空间 id>/` 下的批次**不随之立即删除**，与正式空间的批次一样保留到期满再由周期清理删掉；转正不改变空间 id，批次原地保留。
  理由：回收目录的全部意义是「删错了管理员还能找回」，这一点不该因为空间是临时的而不同；让会话删除去清回收目录，等于给 C 的删除流程再加一条跨目录的删除路径。代价：用户在临时空间里删过的文件在会话删除后最多再留 30 天（只有管理员在服务器上可见）。
**已知残余（owner 裁决 2026-10-09，#1286）：检查之后按路径操作的替换窗口，本 change 不闭合。**
`sandbox.resolve` 与回收目录的逐级校验都只证明检查那一刻的状态，交出的是路径字符串；其后的 `rename`、打开与递归删除仍按路径逐级解析（Node 没有 `*at` 系列调用），检查与使用之间 omp 用户可以把其中一级换掉。
`SANDBOX_ROOT` 对 omp 用户组可写且不带 sticky 位，工作空间各级目录同样对它可写。共三处（均为读代码推出，没有实测）：
- **清理（`sweep`，代码已交付、尚无调用方）**：每一级在校验之后都按路径再解析一次，`rm` 内部的递归也按路径，没有一步是原子的。逐级校验（真实目录、属应用用户、没有组与其它权限位）挡住了「把某一级换成 omp 用户可写的目录」，但没有把遍历绑定在真正的 `.trash` 之下：
  `.trash` 通过校验之后可以被换成符号链接，此后的每条路径都穿过它；链接指向任何一棵由应用用户的 `0700` 目录组成的树时，下三级照样通过——快照目录正是这个形状，且它最末一级以工作空间的顶层目录名命名，这个名字由 omp 用户决定。
  赢下这一个窗口，清理就会删掉 `.trash` 之外的一个目录；批次名的格式因此也不是安全边界。另外批次内部不做检查：对被移进批次的目录仍持有句柄（打开的描述符、工作目录）的进程，可以在递归删除期间在里面换入符号链接。
- **删除与移动（8.1 的 `moveToTrash` 半边、8.2、9.1，尚未实现）**：`resolve` 之后、`rename` 之前，路径的中间分量被换成符号链接时 `rename` 会跟随它——`move` 的 `from` 可以把空间之外、应用用户够得着的条目改名进工作空间，`to` 与删除可以把条目移到空间之外。
  `moveToTrash` 对 `.trash` 各级的 `ensureOwnedDir` 会把一个被预先放在那里的、属应用用户而 mode 不符的目录校正为 `0700` 后照常使用（file-operations「回收目录被预先占位」的第三例），目录里已有的内容随之被收进回收目录。
- **`GET …/file` 与 `GET …/download`（已交付）**：`lstat` 判为普通文件之后按路径打开读流，没有 `O_NOFOLLOW` 与 `O_NONBLOCK`。两步之间条目或任一中间目录分量被换成符号链接时，读到的是链接指向的文件；被换成命名管道时 `open` 不返回，占住一个线程池线程，几个这样的请求就能拖住本进程全部的异步文件操作。
界限：要利用其中任何一处，都得能以 omp 用户的身份运行代码并卡准时机，也就是一个已登录的账号驱动自己的助手去做。部署模型是单一专用 omp 用户加可信账号（ADR-0010），所有账号本来就共用这个 uid；owner 据此裁决登记为已知残余（D-23），不在本 change 内闭合。
#1286 保持打开作为跟踪项，闭合方案（给 `SANDBOX_ROOT` 加 sticky 位、以目录描述符为基准操作、把回收目录移出 `SANDBOX_ROOT`）留给后续 change。它不再挡住任何任务：8.1 的 `moveToTrash` 半边、8.2、9.1、9.2 与 13.1 照常开工。验收清单 FL-01 是 owner 对这项残余的确认（待签）。
否决：直接删除（owner 要可恢复）；回收目录放进工作空间里的隐藏目录（助手会看到并可能改它，树里还得过滤）；数据库里记回收条目（没有界面要查它）。

**实测**（#1051，tasks 1.2；2026-10-06，测试 VPS 上的干净容器里按 ADR-0010 起的 uid 分离部署：应用用户与专用 omp 用户分属两个 uid、同在一个共享组，工作空间各级目录 `2770`，双方 umask `007`，sudoers 含 `Defaults>omp 用户 umask=0007` 与 omp 的启动器规则。Ubuntu 24.04，被测目录在 ext4 上；sudo 1.9.15p5、util-linux 2.39.3、官方 omp v18.0.10（linux-x64，SHA256 已校验）、Node 24；服务端是当日主干编译出的 `server/dist`。）

做法：应用用户以 `OMP_USER` 模式经产品的 `SessionRuntime` 启动 omp（实际 spawn 行是 `sudo -n -u <omp 用户> --preserve-env=… -- /usr/bin/setpriv --pdeathsig KILL -- <omp> --mode rpc …`），由一个脚本化的受控上游下发工具调用，omp 以 omp 用户身份真实执行（工具进程自报 uid 为 omp 用户、umask `0007`）。随后应用用户（umask `007`）在 `<SANDBOX_ROOT>/.trash/…/<批次>`（各级 `0700`、属应用用户，与工作空间同一 `st_dev`）与工作空间之间对每个条目做一次 `rename(2)` 移入、一次移回（不带拷贝回退；移动前后 inode 不变）。

| 条目 | 创建方式 | mode | 属主 / 组 | 移入 `0700` 目录 | 移回 | errno |
|---|---|---|---|---|---|---|
| 文件 | 写文件工具 | `0660` | omp 用户 / 共享组 | 成功 | 成功 | — |
| 目录（含子目录与其中的文件） | 写文件工具写嵌套路径 | `2770` | omp 用户 / 共享组 | 成功 | 成功 | — |
| 文件 | `bash` 重定向 | `0660` | omp 用户 / 共享组 | 成功 | 成功 | — |
| 目录（含子目录） | `bash` 的 `mkdir -p` | `2770` | omp 用户 / 共享组 | 成功 | 成功 | — |

子条目：子目录 `2770`、其中的文件 `0660`，都属 omp 用户与共享组，移动前后不变。

- **结论：与设计相符**——按 `2770` 与 umask `007` 建出的条目，应用用户都能 `rename` 进自己的 `0700` 目录并移回。被挡的任务（8.1 的 `moveToTrash` 半边、8.2、8.3 的 `workspaces-delete.test.ts`、9.1、9.2）开工。
- 去掉组写位的分支（规格已定的 500，记入 ADR-0014 运维一节）：助手用 `bash` 对自己建的目录执行 `chmod g-w` 后（`2750`、属 omp 用户），应用用户把它移入 `0700` 目录失败，`EACCES`，条目留在原处。附带一点（D23）：同一个目录在**同一父目录内**改名成功、改回也成功——只有跨父目录的移动被挡（移动目录要改写它自己的 `..`，需要对该目录的写权限）；所以这类目录删除与移动会失败，原地重命名不会。
- 范围说明：全程在容器内（被测目录在容器的数据卷上），用户、组与 sudoers 按 `.github/scripts/ci-uid-isolation.sh` 手工复刻；没有测「去掉组写位的目录里面的文件能否单独移动」。

**D23 重命名与移动是同一个端点：`POST /api/workspaces/:id/move`，`{from, to}`。**
检查次序：空间归属（404）→ 请求体形状（400）→ `resolve(from, move)`、`resolve(to, move)`（403 + 审计）→ 目标是源自身的后代（400）→ 源存在且是普通文件或目录（否则 404）→ 目标的父目录是已存在的普通目录（否则 404）→
目标已存在（409 `conflict`，源与目标相同也落在这里）→ `rename` → 审计 `file.move`（`detail`：`from`、`to`、`type`）→ 200 `{path: to}`。
子树判断是对两个已解析的绝对路径做前缀比较（`<from>/` 是 `to` 的前缀），纯词法、不碰文件系统，所以排在一切存在性检查之前：「把 `d1` 移到 `d1/sub/d1`」不论 `d1/sub` 存在与否都是 400，不会先撞上「父目录不存在」的 404。
「目标同名时拒绝」用「先看再改名」实现，两步之间有一个很小的竞态窗口（见 Risks）；不用硬链接加删除来做原子的不覆盖——那条路在 `fs.protected_hardlinks` 下对别人拥有的只读文件会失败，换来的是另一类更难解释的错误。
界面上重命名走对话框，移动走拖拽（HTML5 原生拖放，不引库）与菜单里的「移动到…」（给键盘与触屏用，目标从已加载的目录里选）。

**D24 助手运行期间的文件操作：不加锁、不提示，以文件系统的结果为准。**
用户在回合进行中删除或移动文件时，服务端照常执行；助手随后对旧路径的读写按它自己的工具结果成功或失败。界面不弹「助手正在运行」的确认——删除本身已有确认框且可由管理员恢复，
移动与重命名可以再移回去；每次操作都多一个提示只是噪音。反过来，助手改了文件之后用户操作一个已经变了的条目，得到的是 404 或 409 的就地文案，随后树刷新。
C 的每回合快照与撤回（#907）在用户动过文件之后怎样还原，由 C 的冲突规则决定，本 change 不为它做特殊处理。

**D25 跨 change 的条文协调：与 C、S1g 重叠的 MODIFIED 一律以叠加后的文本为底。**
OpenSpec 的 MODIFIED 是整条替换，归档次序固定为 C → S1g → 本 change。本 change 每条与它们同名的 MODIFIED，底本是「主规格 → C → S1g」叠加后的文本（S1g 改过的取 S1g 的 delta，只有 C 改过的取 C 的 delta），
前序 change 的句子、场景标题与计数全部原样保留，再加下表「增量」列所列的差异——表里列的就是相对底本的**全部**差异。归档前的对底（tasks 0.1、0.2）只允许 diff 里出现这些。
绝对计数按叠加值写：配置项 23 + 12 = 35；归属身份 15 + 2 = 17（其余 16 条以 POST 归属）；错误码 16 + 0 = 16；`op` 为 `{read, list, mkdir, write}` 加 `delete`、`move`。
场景标题规则：每条 MODIFIED 原样保留主规格与前序 change 该条文现有的全部 `#### Scenario:` 标题，含义变了只改标题下的正文；因此有几处标题与正文的字面不再一致（如 turn-artifacts「空间不可解析」的正文里 `查看详情` 仍可用、「html 预览隔离」的正文是侧边栏的隔离来源预览），以正文为准。

| 条文（capability / Requirement） | 底本 | 本 change 的增量 |
|---|---|---|
| http-service-skeleton / 服务启动与装配 | S1g 的 MODIFIED | 配置项二十三 → 三十五（键清单末尾加「以及下一段列出的十二个预览与文件键」，「缺省值分别为」改为「前二十三项的缺省值分别为」）；新增一段：十二个键的名称、缺省值与校验规则；成功次序在 `createApp` 与 `listen` 之间加「预览监听器 listen（先于主监听器）」，在写 models.yml 与 success record 之间加「建立预览缓存目录并启动两个周期清理」；失败清单加「预览监听器 listen」「预览缓存目录」；失败记录 `reason` 封闭枚举一句末尾加「本change新增的两步各有自己的取值：`preview_cache`（建预览缓存目录）、`preview_listen`（预览监听器listen）」（#1203 对齐时加入，既有八个取值原样保留）；失败清理的对象加预览监听器。改写场景：「干净启动与一致命令面」（三十五项）、「HOST=localhost 单一 binding」（两个监听器各一个 binding）。新增场景：「预览与文件键的缺省与覆盖」「预览与文件键的非法值」。成功记录（`server_started` 四键）不变，失败记录的键集合不变。C 的四个 `SNAPSHOT_*` 键与 S1g 的四个键、缺省值、解析规则与场景原样保留 |
| http-service-skeleton / 统一错误信封 | S1g 的 MODIFIED | 归属身份十五 → 十七（清单加 `POST /api/workspaces/:id/move`、`POST /api/workspaces/:id/preview-token`；「其余十四条」→「其余十六条」）；新增句三句：`preview-token` 为 bodyless 归属路由、`move` 的 content-parser 错误为 400、`DELETE /api/workspaces/:id/entries` 不属归属集；新增句：definition map 不因本 change 改变、416 不属于 definition map。改写场景：「auth POST 请求 parse/validation 错误稳定映射」（十七条）、「产品路由身份在共享映射器中的归属」（WHEN 的路由清单加两条；seventeen-identity）、「工作空间 parser owner 的真实 HTTP 边界」（seventeen-owner、fifteen other owners）。新增场景：「工作空间新增两条归属路由」。错误码仍为十六码，C 的两码、S1g 的 `upload_too_large` 与各自的场景原样保留 |
| http-service-skeleton / Shared agent module assembly | S1g 的 MODIFIED | 新增句：`registerWorkspaces` 的依赖对象另收预览上限、回收目录服务与可选的预览依赖，不引入第二个 store / facade / audit。改写场景：「Pure source and compiled configuration identity」（twenty-three → thirty-five application keys；缺省值清单末尾加十二个预览与文件键的指引）。无其它差异 |
| sandbox-core / resolve 契约与逃逸向量 | S1g 的 MODIFIED | `op` 集合加 `delete`、`move` 及括注；末段校验从「`mkdir` 与 `write`」扩到四种 `op`，加「空串因此被拒绝，根不能被删除、移动或作为移动的目标」；新增句：`delete` 与 `move` 的含义、与 `mkdir` 同规则、本 change 不使用 `write`。改写场景：「合法路径与边界」（加 `delete`/`move` 的成功与拒绝输入）、「非目录祖先不是越界」（`read/list/mkdir/write/delete/move`）。新增场景：「删除与移动的逃逸向量」。S1g 的 `write` 各句与「写操作的逃逸向量」原样保留 |
| chat-web / 会话页 | S1g 的 MODIFIED（S1g 以 C 的 MODIFIED 为底，只改空白发送一句与欢迎态场景里的控件措辞） | 顶栏一句：「exactly three icon buttons」改为按序的三个槽位、第三个由 `产物面板`（`Icon package`，turn-artifacts）改为只在 `workspaceId` 非 null 时上报的 `工作空间侧边栏`（`Icon folder`，workspace-sidebar，带 `aria-expanded`）；新增句：侧边栏打开时主区按 workspace-sidebar「布局与开合」布局。改写场景：「顶栏入口」（按钮名、绑定了工作空间的前提、未绑定时只有前两个）。C 的归档只读、列表事件等各句与场景原样保留 |
| session-sidebar / 会话条目菜单与重命名 | C 的 MODIFIED | `CHAT_TOPBAR_ACTIONS` 一句：第三项由 `产物面板` 改为 `工作空间侧边栏`，加「前两个槽位都产出按钮，第三个只在 `workspaceId` 非 null 时产出」与归属括注。改写场景：「顶栏重命名入口」（按钮名、绑定了工作空间的前提、未绑定时只有前两个）。C 的菜单项、归档、另存为等各句与场景原样保留 |
| spa-shell / 路由 IA 与侧栏 | C 的 MODIFIED | `/files` 一句加「当前文件以 `&path=<空间内相对路径>` 表示」；顶栏按钮归属一句：`产物面板`/turn-artifacts → `工作空间侧边栏`/workspace-sidebar；响应式一句的括注由「`≤900px` 文件页树栏宽度由 files-web 规定」改为「文件页的分栏与纵排同样以 760 为界，由 files-web 规定」。无场景差异 |
| ui-foundation / 组件分层 | C 的 MODIFIED | 新增句：`resizable` 与 `react-resizable-panels` 随本 change 拷入并登记；已迁移清单一句加「s1f-files-page 起另含整个目录 `web/src/features/files/**`」。新增场景：「文件页整目录已迁移」。C 的会话列表终态（`features/chat` 下无 `.css`、无豁免名单）各句与场景原样保留 |
| chat-harness / UI 走查会话元数据 | C 的 MODIFIED | 第 5 步：`查看详情` 由「导航到 `/files?ws=`、再导航回会话」改为「打开工作空间侧边栏并选中该文件、带改动标记、URL 不变，预览是隔离来源的 iframe（`sandbox` 三令牌）」；`打开网页预览` 由打开 `srcdoc` 对话框改为到达同一状态、不开对话框；顶栏 `产物面板` 打开面板改为 `工作空间侧边栏` 按钮开合并带 `aria-expanded`（`mobile-dark` 下以层内 `关闭` 关、顶栏按钮开）、`只看本会话改动` 恰一个文件；两处顶栏按钮清单的 `产物面板` → `工作空间侧边栏`。改写场景：「会话元数据走查」（对应的一句）。C 的分组侧栏、标题搜索等步骤原样保留 |
| chat-harness / UI 走查临时空间、撤回与归档 | C 的 ADDED | 第 1 步：文件变更卡由「没有 `查看详情`」改为有 `查看详情 workbuddy-report.html`；`打开网页预览` 由打开 `sandbox="allow-scripts"` 的对话框改为打开工作空间侧边栏（头部 `工作空间`、无 `在文件页打开`）并以隔离来源的渲染视图选中该文件。改写场景：「真实栈上的临时空间、撤回与归档」（对应的一句）、「候选实现的反例」（加一个反例）。其余五步原样保留 |
| turn-artifacts / 文件变更卡 | C 的 MODIFIED | `查看详情` 的动作由导航到 `/files?ws=` 改为打开侧边栏并定位；渲染条件由「空间在列表里」改为「`workspaceId` 非 null」（不在列表、列表读取中或失败、临时空间时以相对路径为名照常渲染；`workspaceId` 为 null 时不渲染）；「空间可解析」定义的共用范围去掉 `产物面板`，加一句说明它只决定产物卡与路径显示。改写场景：「卡片内容与跳转」（侧边栏、URL 不变）、「空间不可解析」（非 null 的两种情形仍有 `查看详情`）、「临时空间会话的文件变更卡」（两行各有 `查看详情`）。C 的可解析定义原样保留 |
| turn-artifacts / 产物卡 | C 的 MODIFIED | 首句：正文拉取限定为代码卡，去掉「不新增服务端端点」；html 卡：`打开网页预览` 由拉取文本并打开 `srcdoc` 对话框改为打开侧边栏的渲染视图，去掉截断提示句；图片卡：`下载` 由拉取 Blob 改为指向下载端点的链接（owner D-19），去掉 Blob 条款；新增句：可派生扩展名集合不扩大；失败文案一句限定为 `复制代码`，去掉「不打开对话框」「不触发下载」；卸载一句去掉「撤销已创建的 Blob URL」；临时空间一句的「预览、下载与复制调用同一预览 API」改为「定位、下载与复制调用相同的按 id 端点」。改写场景：「html 预览隔离」「图片下载与代码复制」「拉取中与卸载」「临时空间会话照常渲染产物卡」。「不派生与失败」原样保留；C 的「空间可解析时渲染」判定原样保留（owner D-22） |
| turn-artifacts / 产物面板 | C 的 MODIFIED | 整条 REMOVED（含 C 新增的场景「临时空间会话的面板行」）；Reason / Migration 见 delta |

不在表里、但依赖前序 change 结果的地方：
- 本 change 独自修改的条文（files-web、files-harness、workspaces 的三条、ui-foundation「Tailwind 入口与层叠顺序」、ui-primitives「按钮单一实现与旧类退役」、verification-harness）底本是主规格，C 与 S1g 没有同名 MODIFIED——所以它们不属重叠，不进上表。
  其中 ui-primitives 那条的场景「迁移后行为不回归」提到的 `新建会话` 由 C 迁移（C 没有改这条 ui-primitives 条文，只在 session-sidebar「分组侧栏」与 ui-foundation「组件分层」里规定了结果）；本 change 的正文按 C 的这两条写，0.1 对底时一并核对它们没有变。
- 这些条文与新增条文里凡提到「错误码集合」「归属集」的地方只引用条文名（http-service-skeleton「统一错误信封」的 definition map），不写数字，前序 change 再变也不必跟着改。
- 会话 DTO：本 change 不增加任何键，只读既有的 `workspaceId` 与 C 加的 `temporaryWorkspace`。
- 临时空间的表示以 C 定稿的规格为准（C 的 design D6：带 `temporary` 标记的 `workspaces` 行，所有者作用域的 `rootOf` 不区分临时与正式，`GET /api/workspaces` 不列出，按 id 的端点照常工作）。
  侧边栏、预览令牌与新增的各端点都只经 `rootOf` 解析 `workspaceId`，所以对临时空间不需要任何特殊分支；侧边栏拿不到临时空间的名称与 `dir`，头部只显示 `工作空间`、卡片行只显示相对路径（规格里的确定行为）。
- 归档次序依赖：本 change 必须在 C 与 S1g 都归档之后归档（共改上表的同一批条文）；对 S1g 没有功能依赖（不使用它的 `write`、上传端点与附件）。

### 会话页侧边栏

**D26 侧边栏是会话页自己的一块，不属于外壳；宽屏并排、窄屏覆盖。**
`ChatPage` 的主区变成横向两栏：对话区与侧边栏，中间一条可拖动的分隔线，用拷入的 shadcn `resizable`（`react-resizable-panels`，MIT）实现；
宽度记在浏览器本地（键 `workbuddy-workspace-sidebar`），下次打开沿用。外壳唯一的断点（`narrow`，视口不超过 760）以下，侧边栏改为盖住整个视口的模态层（拷入的 `sheet`，全宽）。
开合状态是页面内存状态：刷新后是关的、不跨刷新保留（owner D-20；只有宽度记在本地）；切换会话时保持，并换成新会话的空间；切到没有绑定工作空间的会话或欢迎态时不显示（状态仍记着，回到有空间的会话时恢复）。
理由：`resizable` 自带键盘可达的分隔线与尺寸约束，是 shadcn 的现成组件；外壳不需要知道这块面板。
否决：手写拖拽（要自己补键盘与无障碍语义）；放进外壳做全站的右栏（只有会话页用）；沿用 `Sheet` 盖在对话区上（owner 要并排、对话区不被遮住）。
拷入规则：`resizable` 随第一次用到它的改动拷入 `web/src/components/ui/`，`react-resizable-panels` 加入依赖并登记 `ATTRIBUTION.md`；只做 ADR-0013 的六类修改。
文件页自身的树 / 预览分栏不用 `resizable`（固定比例即可，不在需求里）。
并排与覆盖的分界只有外壳这一个断点：761–1100 的中等宽度下仍然并排（对话区与侧边栏各有最小宽度，拖动不能把任何一方收到不可用）。不为侧边栏另设更高的覆盖阈值（起草者定，见 D31）。

**D27 顶栏按钮：`工作空间侧边栏`，取代 `产物面板` 的槽位。**
`CHAT_TOPBAR_ACTIONS` 的第四项从 `{key:"artifacts", label:"产物面板", icon:"package"}` 改为 `{key:"workspace", label:"工作空间侧边栏", icon:"folder"}`，带 `aria-expanded`。
只在选中的会话 `workspaceId` 不为 `null` 时上报——没有绑定工作空间的老会话没有这个按钮（「无后端不渲染」）。图标取冻结区 `Icon` 已有的名字，不改冻结区。

**D28 侧边栏内容 = 文件页的树与预览组件，加会话特有的三样。**
`web/src/features/files/` 对外导出 `WorkspaceBrowser`（树 + 预览 + 文件操作，受控的「当前路径」），文件页与侧边栏各包一层。侧边栏在窄的宽度里把树放在预览上方，树可折叠。
会话特有的：
- **改动标记**：当前会话视图里全部已结束步骤的 `changes` 按路径聚合（与原产物面板同一聚合），这些文件在树上带标记（可访问文本 `本会话已改动`），其各级父目录带同样的标记。
- **只看本会话改动**：一个开关；打开后树只显示由这些路径构成的子树（各级目录展开），不向服务端列目录；没有改动时显示 `本会话暂无文件改动`。
- **在文件页打开**：链接到 `/files?ws=<id>&path=<当前文件>`；该空间不在 `listWorkspaces` 结果里（临时空间、列表读取失败）时不渲染。
侧边栏里的删除、重命名、移动就是 `WorkspaceBrowser` 自带的，与文件页同一份代码。

**D29 树随助手的改动刷新。**
- 视图里出现新的已结束步骤 `changes`（即 `files.changed` 之后的 `step.end`）：重新列出这些路径的、已加载过的各级父目录（300 毫秒内的多次合并成一次）；当前预览的文件在其中时重新取预览，保留渲染 / 源码模式。
- 回合结束（当前会话从生成中变为不在生成中）：把所有已加载的目录重新列一遍——`bash` 等途径改的文件不产生 `files.changed`，靠这一次兜底。
- 侧边栏头部有手动的 `刷新`。文件页没有事件来源，只有手动 `刷新` 与操作后的刷新。
否决：定时轮询（空转请求，且与走查的请求计数相冲突）；服务端监视文件系统并推事件（新的推送通道与跨平台的监视器，超出本 change）。

**D30 卡片动作改为打开侧边栏并定位。**
文件变更卡的 `查看详情`：打开侧边栏（已开则保持），**不改变「只看本会话改动」开关**（卡片上的文件必在改动集合里，开关开着时它本就在子树里），其余状态也不动；展开到该文件并选中、显示预览；不再导航去 `/files`。
只要会话的 `workspaceId` 非 null 就渲染 `查看详情`——含 C 的临时空间会话与空间列表读取失败时（侧边栏只需要 `workspaceId`）；C 留下的「临时空间会话没有 `查看详情`」在这里补上。
产物卡 html 的 `打开网页预览`：同上，并把该文件的视图置为渲染。产物卡的图片 `下载` 改为指向下载端点的链接（D10，owner D-19），代码 `复制代码` 不变。
产物卡是否渲染沿用 C 的规则（空间可解析：在列表里，或会话 `temporaryWorkspace` 为 true；owner D-22），本 change 不改这条判定，turn-artifacts 的 delta 以 C 的文本为底。
窄屏下侧边栏是模态层：从卡片打开时焦点进入层内的 `关闭`，关闭后焦点回到触发的按钮且不滚动线程（沿用原预览对话框的焦点规则）。宽屏下它不是模态，焦点留在触发按钮上。
`artifacts-panel.tsx` 与 `artifact-card.tsx` 里的 `PreviewDialog` 删除；「产物面板」条文移除。

### 起草者自定的事项与 owner 补充决定

**D31 起草者自定的事项（Epic 中列给 owner 知悉，不卡任何任务）。**
下列各项压测没有逐条问过 owner，由起草者定下并已写进规格；owner 若有不同意见，各自都是局部改动：
- 761–1100 的中等宽度下侧边栏仍与对话区并排，只有外壳的 760 一个断点（D26）。
- 退出登录不吊销预览令牌：它最多再活 15 分钟，且只指向该账号自己的一个工作空间（D13）。
- 回收目录保留 30 天（`TRASH_RETENTION_DAYS` 可配），位置在 `<SANDBOX_ROOT>/.trash`；临时空间随会话删除时其回收批次保留到期满（D22）。
- 办公文档转换缓存按「7 天未访问」清理，没有总量上限；排队上限 8、压缩包读取时限 5 秒、文本嗅探 8192 字节、压缩包扩展记录 65536 字节与成员名 4096 字节的上限（D7、D17）。
- 产物卡可派生的扩展名集合不扩大：新格式没有产物卡，经文件变更卡的 `查看详情` 进侧边栏预览（Non-Goals）。
- `OFFICE_BIN` 不配置即办公文档预览关闭（界面给出说明与下载）。压测第 5 条「部署镜像要装 LibreOffice」在本 change 落在 ADR-0014 的运维说明里；仓库里还没有镜像文件，实际安装属 S4b——
  tasks 28.5 在 `IMPLEMENTATION_PLAN.md` 的 S4b 一节留一行。
- 回合进行中删除、重命名、移动文件不另加提示（D24）。
- 上传中的 `.part` 临时文件不在目录树里过滤（Non-Goals）。
- 预览器分刀合入期间的过渡呈现（tasks 17.2 的过渡规则）：从 17.2（去掉扩展名白名单）合入到 20.1（音视频预览器）合入之间，音视频文件显示的是「请求失败」类的安全文案加下载链接，而不是 `该类型不支持预览`——服务端对它们返回 `audio/*` / `video/*`，`fetchPreview` 按「失败不变成预览」处理；
  同一期间 pdf、办公文档、压缩包显示 `该类型不支持预览`，Notebook 显示源码。各自的预览器合入即消失，不为这段过渡另写分支或文案。

**D32 owner 补充决定的落点**（`.workplans/stage/owner-decisions-stage3.md`，2026-10-06，与压测同等效力）。

| # | 决定 | 落点 |
|---|---|---|
| D-19 | 产物卡图片的 `下载` 改走带审计、不限大小的下载端点，与预览头同一实现 | D10、D30；turn-artifacts「产物卡」（图片卡、场景「图片下载与代码复制」「拉取中与卸载」）；tasks 25.2、25.4、25.6 |
| D-20 | 侧边栏开合状态不跨刷新保留，默认关闭；宽度仍记本地 | D26；workspace-sidebar「布局与开合」（「页面加载后为关闭」、场景「宽屏并排与拖动」）；tasks 23.2、23.4 |
| D-21 | 转换超时不新增提权规则；同 uid 杀进程组，`OMP_USER` 杀 `sudo`、后代残留登记为已知残余；VPS 实测只记录 | D18；office-preview「转换器调用契约」（两种模式、场景「超时与中止」「OMP_USER 模式下终止的是 sudo」）、「真实转换的人工验证」；tasks 1.3、14.1、14.5、28.2、28.6 |
| D-22 | 临时空间会话的产物卡照常显示（C 已定）；本 change 以 C 的 turn-artifacts 文本为底 | D25 重叠表、D30；turn-artifacts 两条 MODIFIED 与 REMOVED；chat-harness「UI 走查临时空间、撤回与归档」的 MODIFIED；tasks 25.1、25.2、25.5 |
| D-23 | #1286（检查之后按路径操作的替换窗口：删除、移动、回收目录清理、`file` 与 `download`）本 change 不闭合，登记为已知残余，由部署模型兜底（单一专用 omp 用户、可信账号，ADR-0010）；issue 保持打开，不再挡任何任务 | D22「已知残余」、Risks；验收清单 FL-01（待签）；tasks 依赖前言的 #1286 一条、13.1 的注记、28.1 |
| D-24 | `OMP_USER` 模式下应用用户删不掉 `<job>`（#1052 第 1 点）：sudoers 再加恰一行固定参数、无通配的 `/usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`；服务端只在同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时、启动时执行一次，失败记日志、不阻止启动；单次转换后的删除保持尽力而为；同 uid 模式不变。属审批 / 提权策略，Critical Path | D17、D18「作业目录的清理」、Risks、Migration Plan；office-preview「转换器调用契约」（两行 sudoers）、「转换缓存」（启动时清空 `work` 与场景「OMP_USER 模式下启动时清空 work」）；http-service-skeleton「预览监听器的装配与关停」；tasks 13.1、14.3、14.5、14.6、15.1、28.1、28.2 |
| D-25 | 杀掉 `sudo` 之后 `soffice.bin` 每次都留下并把转换跑完（#1052 第 2 点）：D-21 维持，不加 `kill` 规则；凡写「可能残留」处改为实测事实（实际并发可超过 `OFFICE_CONVERT_CONCURRENCY`）；运维文档写明怎样查与杀 | D18、Risks；office-preview「转换器调用契约」（`OMP_USER` 模式）、「并发上限与排队」、「真实转换的人工验证」；tasks 14.7（源码头注释的更正）、28.1、28.2 |

D-19 至 D-22 是 2026-10-06 的决定；D-23 至 D-25 是 owner 2026-10-09 的裁决。同日另追认四项已交付的行为，不改变做法、不另编号：预览成功响应的七个头与 `embedOrigin` 在写头处的校验（D14；preview-origin「预览响应头与内容类型」）、转换器只接受绝对路径（office-preview「转换器调用契约」）、workspaces 场景「由别处提供与不支持」的现有写法、store 拒绝以 `.` 开头的 owner 段（D22）。

## Risks / Trade-offs

- **同主机不同端口仍是同站** → 预览页面的脚本若能以主站用户身份发请求就是越权。缓解：监听器不认 cookie（D13）；CSP `sandbox` 使文档成为不透明来源，其子请求不带 `SameSite=Lax` cookie（D14）；
  iframe 属性再限一次（D15）。PDF 响应不带 `sandbox`，依赖的是内置查看器不向页面脚本开放网络能力。
- **令牌在地址里** → 浏览器历史、代理日志、`Referer` 都可能留下它。缓解：`no-referrer`、`no-store`；闲置 15 分钟失效；作用域只有一个账号的一个工作空间；每次使用重核归属。
  退出登录后最多 15 分钟内旧地址仍可读——接受（受信局域网；要立即失效需要按会话登记令牌，等 S3a 的会话模型再议；D31）。
- **外部资源放行（owner 决定）** → 预览页面可以把同空间的文件内容发到外网。这是「允许加载外部接口」的直接后果，记入 ADR-0014；内网无出口的部署不受影响。
- **LibreOffice 解析不可信文档** → 以 omp 用户运行、独立配置目录、超时、并发上限、输出复制后才进缓存（D17/D18）。`OMP_USER` 模式下被终止的转换每次都留下 `soffice.bin`（已知残余，D18、owner D-25）：它占一个核把整份文档转完才退出（实测最长在终止之后 128 秒，长于 60 秒的缺省超时），不占转换名额，所以实际同时运行的转换进程可以多于 `OFFICE_CONVERT_CONCURRENCY`；运维文档写明如何查与杀。文档里的外部链接（链接的图片等）可能在转换时被取回，无法在命令行层面禁止——登记为残余。
  未配置 `OMP_USER` 的部署里它与应用同 uid（与 omp 本身在该形态下的处境相同）。
- **`OMP_USER` 模式下多一条提权规则，且 `work/` 在运行期间增长（owner D-24）** → 只涉及同时配置了 `OFFICE_BIN` 的部署（没配时不执行 `sudo`，也不需要这条规则）。应用用户可以让 omp 用户执行一条参数固定的 `find … -delete`，作用范围只有 `work/` 之下、且都是 omp 用户自己本来就能删的条目；规则写错路径的后果是启动时那一步失败、记一行日志、`work/` 不归零，不影响转换。
  单次转换删不全 `<job>`，`work/` 每个作业留下约 650 KB（被终止的作业另加 20–78 MB 的输出），只在重启时清空——长时间不重启、磁盘吃紧的部署要自己盯这个目录；写进 ADR-0014 的运维一节。
- **转换耗时与资源** → 大表格转换可能几十秒、占满一个核。缓解：超时、并发 2、排队 8、缓存。xlsx 转出的 PDF 按纸张分页，宽表会被切开——这是 owner 选定方案的已知观感。
- **缓存没有总量上限** → 只按 7 天未访问清理。磁盘吃紧的部署需要自己盯 `PREVIEW_CACHE_DIR`；写进 ADR-0014。
- **移动的「先看再改名」竞态** → 检查之后、改名之前若有别的进程（助手）恰好在目标位置建了文件，它会被覆盖。窗口在微秒级；目标是非空目录时 `rename` 自己会失败。接受并写明。
- **回收目录在 `SANDBOX_ROOT` 下** → omp 用户对 `SANDBOX_ROOT` 有组写权限：它能抢先占住 `.trash` 这个名字（符号链接或自己的目录）——由逐级 `ensureOwnedDir` 校验挡住，结果是删除功能报 500 而不是文件被引走；
  它也能把已有的 `.trash` 整个改名（进不去、删不掉里面的东西），此后的删除会新建一个 `.trash`，旧批次不再被清理。两者都是可用性问题，与「所有账号共用一个 omp uid」的既有残余同类。
- **检查之后按路径操作的替换窗口（#1286；owner 裁决 2026-10-09：已知残余，不在本 change 内闭合，D-23）** → 上一条的「挡住」只对不需要竞态的占位成立。omp 用户卡准时机时：回收目录清理可以被引到 `.trash` 之外、删掉一棵形状相符的应用用户目录树（快照目录是这个形状）；
  删除与移动的 `rename` 可以穿过被换成符号链接的中间目录，把条目移出或移进工作空间；`file` 与 `download` 可以读到链接指向的文件，或被换入的命名管道拖住线程池。完整陈述在 D22「已知残余」。
  界限是部署模型（单一专用 omp 用户、可信账号，ADR-0010）：利用者必须是一个已登录账号驱动的助手。接受并登记；#1286 保持打开，闭合方案留给后续 change。
- **应用用户能否移动 omp 用户建的条目** → 依赖 `2770` + 双方 umask `007`（ADR-0010 已规定）。助手 `chmod` 掉组写位的目录会移动失败——规格已把 `rename` 失败定为 500 且条目留在原处，所以这类失败不丢文件。tasks 1.2 在测试 VPS 上核对「正常条目能移动」这一前提，结果不符即停下回 owner。
- **整条替换的规格冲突** → 本 change 的十三条重叠条文以 C、S1g 当前的 delta 为底（D25 的表）。它们在实现期若再改这些条文，本 change 的同名条文要跟着改——由 tasks 0.1（开工前）与 0.2（归档前）的对底发现：diff 里出现表外的差异就先改本 change 的 delta 与表。
- **走查的请求 oracle** → 现有「零非 `baseURL` 源请求」会被预览来源打破；本 change 把例外限定为「预览令牌响应给出的那个来源」，其余仍为零。
- **包体** → 主包多出 `react-resizable-panels` 与侧边栏、文件操作的代码；高亮、Notebook 等在按需块里。数字在收尾时量并写进 ADR-0013 增补。
- **800 行上限** → `api.ts`（778）不再加方法，新方法进 `api-files.ts`；`md-render.ts`（797）不改；`ui-walk-sessions.spec.ts`（681）与 `ui-walk-layout.ts`（793）不加行，新走查步骤进新 helper 文件。

## Migration Plan

- **数据库迁移**：无。043–045 未使用。
- **合入次序**（每组一个小 PR，合入后主干可运行、`make check` / `make test-guardrails` / `make ui-walk` 全绿）：
  规格对底与前置实测 → 文件页首刀（换底座）→ 服务端：沙箱 `op`、配置键、预览分类与范围请求、压缩包、文件操作、预览令牌与监听器、入口接线、办公文档 →
  前端：API 客户端、预览器、地址定位、文件操作界面 → 会话页侧边栏（外壳、内容、卡片动作，产物面板在这里移除）→ 冒烟与走查 → 文档 → VPS 实测。
  服务端各组先于消费它们的前端组；侧边栏组依赖预览器组。
- **部署**：升级后不做任何配置也能启动（十二个新键都有缺省值；`PREVIEW_PORT` 缺省由系统分配）。要让别的机器访问预览，需固定并放行 `PREVIEW_PORT`；
  经反向代理时设 `PREVIEW_ORIGIN`。要预览办公文档：装 LibreOffice、设 `OFFICE_BIN`；uid 分离部署加两行 sudoers（只在配了 `OFFICE_BIN` 时需要；D18：转换的 spawn 前缀一行，启动时清空 `work/` 的固定参数 `find` 一行）。
- **回滚**：按 PR 回退。服务端的新端点与新监听器没有持久状态；回退后 `<SANDBOX_ROOT>/.trash` 与 `PREVIEW_CACHE_DIR` 留在磁盘上，可手工删除。
  产物面板的移除与侧边栏的引入在同一组 PR 里，回退那一组即恢复产物面板。

## Open Questions

无。起草时的五条都已落定：临时空间的表示以 C 定稿为准（D25）；临时空间会话的产物卡由 C 定为照常显示（owner D-22，D30）；PDF 内置查看器是一项有确定分支的前置核对（D16、tasks 1.1）；
`OMP_USER` 模式下的转换终止做法由 owner 定（D-21，D18）；侧边栏开合不跨刷新保留（owner D-20，D26）；中等宽度仍并排（D26、D31）。

## Not yet specified

- **旧样式层的整体移除**：`ui-foundation` 的一个场景曾写「`legacy` 层整体移除时（change `s1f-files-page` 收尾）」。本 change 之后 `web/src/ui` 里还有谁在用、`legacy.css` 里还剩什么，
  取决于 C 与本 change 都合入之后的终态：按 C 的定稿，`web/src/features/chat` 下不再有 `.css`（`chat.css` 删除、`legacy.css` 不再导入它）；本 change 再删掉 `files.css`。
  此后那一层剩下的是冻结区 `web/src/ui` 的样式（`Icon`、`BrandMark` 仍被已迁移文件使用，其余基元是否还有调用方要到时清点）、`motion.css` 与全局 reset。哪些文件可以删、哪些规则要搬进 `theme.css`，要对着那时的代码清点才说得准，
  所以不切成任务；本 change 只删 `files.css` 及其导入，并把那条层序探针的对象从旧文件页的 `ui-btn` 换成 `ui-icon`（场景标题保留）。C 与本 change 都合入后另开一个清理 issue（tasks 28.7）。
- **预览令牌与 S3a 登录会话的关系**：接入 OIDC 之后令牌是否要绑定登录会话、随退出登录立即吊销。问题要等 S3a 的会话模型出来才问得清。
- **包体上限与进一步的分割**：ADR-0013 增补已定「S1f 全部 change 完成后再定」。本 change 提供数字，不提供阈值。

## Sketch seams under test

- **主站 HTTP（`createApp` + `app.inject`）**：`/api/workspaces/:id/{file,archive,download,entries,move,preview-token}` 的状态码、响应头、字节、审计行与文件系统结果。既有 seam，工作空间路由的测试都在这一层。
- **预览监听器 HTTP（`createPreviewApp` + `inject`，范围请求用真实监听）**：令牌校验、不认 cookie、响应头、拒绝项、`/o/` 经注入的 `converter` 的各种结果。它是新的公共边界，安全性质都在这一层可观察。
- **编译入口子进程（既有 `server-startup-helpers`）**：两个监听器的启动、配置键的校验、关停次序与端口释放。只有真实入口能证明「先停预览监听器、最后关 DB」。
- **转换器对假 `soffice`**：`createOfficeConverter` 对 `fake-soffice.mjs` 的真实 spawn——超时、并发上限、排队、缓存命中、输出复制。证明进程管理而不依赖 LibreOffice。
- **整页渲染（既有 `render-app-router` + 假 fetch）**：`FilesPage` 与 `ChatPage`。预览器的选择、地址定位、文件操作的请求与就地文案、侧边栏的开合与定位，都以用户可见的角色与文本断言。
- **`make smoke`（`files.hurl`）与 `make ui-walk`**：真实服务上的端到端——重命名 / 删除 / 下载 / 范围请求 / 令牌换来的 HTML；真实浏览器里隔离来源的 iframe 与相对资源。
  隔离来源的 iframe 行为在 jsdom 里不存在，只能在这一层证明。

## Traceability

压测凭证 `.workplans/stage/grill-D.md` 的每一行与每个开放项的落点：

| 分支与结论 | 落点 | | 开放项 | 落点 |
|---|---|---|---|---|
| 1 文件页重写 | D1 | | 隔离来源的令牌、CSP、嵌入、监听配置与部署 | D11–D15，ADR-0014 任务 |
| 2 定位到文件 | D2、D30 | | 回收目录的位置、保留期与清理 | D22 |
| 3 格式范围 | D3–D7、D16、D17 | | 预览库选型与许可；SVG | D4–D7 |
| 4 语法高亮 | D5 | | LibreOffice 调用、超时、并发、缓存、用户、失败、替身 | D17–D20 |
| 5 办公文档与 PDF | D16–D20（转换终止做法 owner D-21；镜像安装属 S4b，D31） | | 预览接口扩展（类型、nosniff、no-store、Range、下载名） | D3、D8、D10、D14，`workspaces` 规格 |
| 6 按需加载 | D9 | | 无扩展名文本的判定 | D3 |
| 7 大小上限 | D8（PDF 的上限只在浏览器侧判定） | | 无空间的老会话；临时空间 | D27、D25、D30 |
| 8 下载 | D10、D30（预览头与产物卡图片卡同一个带审计的下载端点，owner D-19） | | 助手运行时的并发语义 | D24、D31 |
| 9 HTML 相对资源 | D13、D14 | | PDF 查看器在 iframe 里的可用性 | D16（前置核对 tasks 1.1，不符即回 owner） |
| 10 独立端口 | D11、D12 | | 文件树刷新 | D29 |
| 11 预览联网 | D14、Risks | | | |
| 12 文件管理操作 | D21–D23，Non-Goals | | | |
| 13 移动与删除的边界 | D22、D23 | | | |
| 14 侧边栏取代产物面板 | D26、D27、D30 | | | |
| 15 本会话改动 | D28 | | | |
| 16 侧边栏布局 | D26（开合不跨刷新，owner D-20） | | | |
| 17 侧边栏里的操作 | D28 | | | |
| 18 不做 | Non-Goals | | | |
