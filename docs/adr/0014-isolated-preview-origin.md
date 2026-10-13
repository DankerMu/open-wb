# 工作空间文件的渲染预览走隔离预览来源；办公文档经 LibreOffice 转换；删除进回收目录

工作空间里的 HTML 由助手写出，是不可信内容；把它以 `text/html` 发在主站来源上，页面脚本就能以登录用户的身份调用 `/api`。
此前的 `srcdoc` 预览加载不了相对资源。change `s1f-files-page` 同时要内嵌预览 PDF 与办公文档，并提供删除。
本 ADR 登记其中三项长期决定（owner，2026-10-06 压测及当日的决定 D-21，2026-10-09 / 10-10 的补充裁决 D-23 至 D-27）及其运维含义；
规格在 `preview-origin`、`office-preview`、`file-operations` 三个能力里，逐条理由在该 change 的 `design.md` D11–D22。

下文每条后果标注证据等级：**实测**（跑过并观察到，注明日期与记录处）、**读代码推出**、**未测**。
「测试主机」指 ADR-0010 所说的 Linux 测试部署；记录处的 `design` 指 `openspec/changes/s1f-files-page/design.md`。

## 决定

1. **独立的预览监听器。** 同一进程里的第二个 Fastify 实例（`server/src/preview/app.ts`），监听 `PREVIEW_PORT`，与主监听器绑定同一个 `HOST`。
   它只有两条 `GET`（及派生的 `HEAD`）路由：`/w/<token>/<path>` 原样发文件、`/o/<token>/<path>` 发办公文档转换出的 PDF；
   不注册认证插件、不解析 cookie、自己不拿数据库句柄（经与主实例共用的 store 与 sandbox 读写同一个库：查空间归属、写 `sandbox.reject` 审计）、不托管静态文件、没有 `/api`。入口先于主监听器 `listen`、先于主监听器关停（`server/src/server.ts`）。
2. **路径令牌。** `POST /api/workspaces/:id/preview-token`（主站、cookie 鉴权、无请求体）签发；令牌是 32 字节随机数的十六进制，
   登记在进程内存里，绑定一个账号、一个工作空间与签发请求的 `Origin` 头（`server/src/preview/tokens.ts`）。
   同一账号同一空间在未过期时重复签发得到同一个令牌并把到期时间设为「现在 + 900 秒」；页面每 300 秒续一次（`web/src/features/files/use-preview-token.ts`）。
   对监听器的请求不续期。登记表只在内存里，进程重启后旧令牌不再有效；退出登录不吊销。令牌放在路径里，页面的相对地址自然落在同一前缀下。
   每次请求重新核对：令牌未过期 → 空间仍在且仍属该账号 → 路径过 `sandbox.resolve(op=read)` → 目标是普通文件（目录不列、不找 `index.html`）。
   不成立是 404，越界与符号链接是 403 并写 `sandbox.reject` 审计；失败体是固定的短纯文本，不含请求内容。
3. **不认 cookie。** 监听器不读 `Cookie` 头：有有效会话 cookie 而没有有效令牌是 404，有令牌没有 cookie 照常返回。
4. **CSP `sandbox` 与 PDF 的例外**（`server/src/preview/headers.ts`）。每个响应带 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`；
   成功响应另带 `Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin` 与 CSP。
   非 PDF 的 CSP 是 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors <embedOrigin>`——不含 `allow-same-origin`，文档是不透明来源；
   按文件名算出的类型是 `application/pdf` 时 CSP 只有 `frame-ancestors <embedOrigin>`。`embedOrigin` 只有恰是一个序列化来源且不含 `*`、`;`、`,`、`'` 时才写进头，否则取 `'none'`。
   内容类型只看扩展名，取自一张固定表，表外一律 `application/octet-stream`。
   主站嵌入时，HTML 的 `iframe` 带 `sandbox="allow-scripts allow-forms allow-modals"`，PDF 与办公文档的 `iframe` 不带 `sandbox` 属性；
   `navigator.pdfViewerEnabled === false` 时不建 `iframe`，显示说明与下载（`web/src/features/files/previewers/frame.tsx`）。
5. **外部资源放行。** CSP 不设任何取源指令（owner 决定）：预览页面可以加载 CDN 脚本、调用外部接口。
6. **办公文档经 LibreOffice 转换。** `docx`、`xlsx`、`pptx` 由服务端以 `<OFFICE_BIN> --headless … --convert-to pdf` 转成 PDF（`server/src/preview/office.ts`），浏览器按 PDF 预览。
   每次转换一个独立的作业目录 `<PREVIEW_CACHE_DIR>/work/<随机名>`（独立的 `UserInstallation`）；子进程环境只有 `PATH`、`LANG`、`HOME`；
   配置了 `OMP_USER` 时以该用户运行（身份、sudoers 与终止见 ADR-0010 的 #1119 补充）。
   未配置时转换进程与应用同 uid，uid 分离的缓解不存在：解析不可信文档、读取文档所引用的本地资源的一方就是持有数据库与上游密钥的应用用户（**读代码推出**；见下表 #1350）。
   结果缓存在 `<PREVIEW_CACHE_DIR>/pdf/<键>.pdf`，键为 `sha256(输入绝对路径 NUL mtimeMs NUL size)`；输出是**复制**成应用用户自己的 `0600` 新文件后才进缓存，不是改名。
   输出超过 200 MiB 即失败；排队至多 8 组，再来的判繁忙；同一个键的并发请求共用一次转换。
   `OFFICE_BIN` 未配置即功能关闭：令牌响应的 `officeAvailable` 为 `false`，直接请求 `/o/` 得 503。
   `/o/` 的失败是固定文案的纯文本页（413 / 415 / 502 / 503 / 504），主站的错误码集合不因此增加。
7. **回收目录。** 删除（`DELETE /api/workspaces/:id/entries`）是一次 `rename`，进 `<SANDBOX_ROOT>/.trash/<ownerId>/<workspaceId>/<批次>/<原文件名>`（`server/src/workspaces/trash.ts`）；
   批次名是 `<删除时刻的毫秒数>-<16 位十六进制>`，四级目录都是 `0700`、属应用用户，每次删除逐级校验。`rename` 失败（含 `EXDEV`）是 500，条目留在原处。
   审计 `file.delete` 的 `detail` 是 `{path, type, trashId}`，`trashId` 即批次名。保留 `TRASH_RETENTION_DAYS` 天，启动后与此后每 6 小时清一轮，只看目录结构与批次名里的时刻。
   界面不提供恢复，由管理员在主机上按 `trashId` 移回（见「运维」）。

## Consequences

- 同主机不同端口仍是同站，隔离靠三层：监听器不认 cookie；不透明来源；`iframe` 属性。
  **实测**（#1093 走查，design D15；仅 Chromium，主站与预览同主机不同端口）：框内来源为 `null`，读 `document.cookie`、`localStorage`、`parent.document`、`top.location` 都抛 `SecurityError`；
  框内带凭据对主站的 `fetch` 不带 cookie、得 401；框内文档自身的导航请求带了主站会话 cookie，监听器不读它。其它引擎、不同主机的部署、框内经表单提交或自我导航去主站：**未测**。
- PDF 响应不带 `sandbox`，它在预览来源下不是不透明来源；依赖的是内置查看器不向页面脚本开放网络能力（design Risks，**未测**）。
  这个例外的原始依据没有被实测支持——**实测**（#1050，2026-10-06，design D16；macOS 上的 Chromium 151 与 Firefox 153（两者是 Playwright 自带构建）、Google Chrome 154）：
  PDF 响应带不带 CSP `sandbox` 查看器都正常；使查看器失效的是 `iframe` 的 `sandbox` 属性，且只在 Chromium 与 Chrome 上。例外作为规格决定保留，是否收回留给 owner。
- 外部资源放行的后果（**读代码推出**）：预览页面的脚本可以把同一工作空间里任何文件的内容发往外网；它的地址里就有令牌，也可以把令牌发出去，持令牌者在令牌失效前（见下一条：该账号持续续期时不失效）可直接读该空间。
  没有出口的内网部署不受前一半影响。
- 令牌在地址里：浏览器历史与代理访问日志会留下它。缓解是 `no-referrer`、`no-store`、作用域只有一个账号的一个空间、每次使用重核归属。
  到期时间是「最近一次签发 + 900 秒」，对监听器的请求不续期；但同一账号对同一空间的每次签发（任何会话、任何设备）都返回**同一个**令牌并续期，令牌不轮换——
  只要该账号还有页面开着这个空间的 HTML、PDF 或办公文档预览（页面每 300 秒签发一次），泄漏的地址就一直有效（**读代码推出**，`tokens.ts`、`use-preview-token.ts`）。
  退出登录不吊销：此后该账号不再签发时旧地址至多再可读 900 秒（接受）。代码里没有吊销入口，要立即失效只有重启服务（登记表在内存里）；按会话吊销须等 S3a 的会话模型。
- 不透明来源下 `localStorage`、`sessionStorage`、cookie、IndexedDB 不可用，依赖它们的页面会报错。
- 回收目录与工作空间同在 `SANDBOX_ROOT` 下，是为了 `rename` 不跨文件系统；代价是 omp 用户对它的父目录可写，见下表 #1286。

已知残余（均未闭合；#1286、#1350、#1337 截至 2026-10-12 都是打开的 issue）：

| 残余 | 证据 |
|---|---|
| **#1286** 检查之后按路径操作的替换窗口：删除、移动、回收目录清理、`file` / `download` / `archive`、`/w/`、`/o/`。owner D-23：本 change 不闭合，由部署模型兜底（单一专用 omp 用户、可信账号）；利用者须能以 omp 用户身份运行代码。后果：清理可被引到 `.trash` 之外、删掉一棵形状相符的应用用户 `0700` 目录树（快照目录是这个形状）；删除与移动的 `rename` 可穿过被换成符号链接的中间目录，把条目移出工作空间，或把空间之外、应用用户够得着的条目移进来；读路由可读到链接指向的文件，或被换入的命名管道占住线程池线程 | 起草时读代码推出；下面五行是 2026-10-10 的实测（#1318，design D22「实测」），那里没提到的仍是读代码推出、未测 |
| ① 删除不需要竞态：`.trash` 不存在时 omp 用户把另一个账号的根改名成 `.trash`，下一次删除把它改成 `0700` 并在其中建批次，该账号根对 omp 用户锁死；被挪开的真 `.trash` 里的批次不再被清理 | 实测（ext4 与 overlayfs；驱动的是编译后的 `moveToTrash` 与 `sweep`，两半各自实测、未连成一次；经 `DELETE` 路由的 204 与审计行未测） |
| ② 移动的目标一侧可替换工作空间之外、同一文件系统上应用用户可写处的同名文件或空目录；跨文件系统是 `EXDEV` | 纯系统调用实测；经真实处理器只在钩子辅助下复现；自然竞态 20000 轮未复现 |
| ③ 同步的处理器挡不住同进程线程池里的文件系统调用落进检查与改名之间 | 时序未测 |
| ④ `to` 处出现源的硬链接时 `rename` 成功而不动，路由仍答 200 | 纯系统调用实测；钩子辅助下经真实处理器复现 |
| ⑤ `work/` 的条目可被换成符号链接；Node 24.13.1 的 `rmSync` 不跟随 | 预先放好的顶层与嵌套两例经真实 `clearWork` 实测，另有裸 `rmSync` 的 `strace`；边删边换未测；只对该运行时版本成立 |
| `/w/` 与 `/o/` 的读窗口：`lstat` 之后按路径打开，不带 `O_NOFOLLOW` / `O_NONBLOCK`；`/o/` 的排队把窗口拉长到最坏约 `ceil(8 / 并发) × 超时`（缺省约 4 分钟）；两条路由的成功读取都不写审计 | 读代码推出，未测 |
| **#1350** 文档内容引用的资源由转换进程去取。链接图片被跟随：docx 的 http 图片、docx / pptx 的 `file://` 图片都进了输出的 PDF；读的一方是转换进程的 uid，两种模式都读到了另一账号工作空间里的图。网络引用从服务器所在的网络位置发出，uid 分离不缓解 | 实测（2026-10-12，design D22；一次性容器里按 `office.ts` 的 argv 与 `sudo … setpriv` 形状复刻，LibreOffice 24.2.7.2，未经 `/o/` 路由） |
| 外部数据类引用（xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、docx `INCLUDETEXT`）是否跟随；https、回环以外的网络目标、关闭链接更新之后的行为、其它版本 | 未测（#1350 保持打开） |
| `OMP_USER` 模式下被终止的转换留下 `soffice.bin`；`work/` 在一次运行期间增长 | 实测（#1052，2026-10-06，design D18）；数字见「运维」与 ADR-0010 的 #1119 补充 |
| 转换缓存没有总量上限 | 读代码推出（只有按 7 天的清理） |
| 移动的「先看再改名」：检查之后、改名之前别的进程在目标位置建出的文件会被覆盖 | 读代码推出，未测（design Risks） |
| **#1337** 缺省 `PREVIEW_PORT=0` 先于主端口绑定，系统分配的端口可能恰是 `PORT` | 读代码推出，未复现 |
| 真实 LibreOffice 经 `/o/` 的端到端（docx / xlsx / pptx）、从另一台机器经固定端口打开 html 预览 | 已测一次（#1123，2026-10-12；浏览器一步是脚本驱动加截图）：三种格式可翻页，html 的相对样式表生效，见文末「真实转换的验证记录」；那里列着没有做的 |

## Considered Options

- 预览监听器的形态（D11）：在主实例上按 `Host` 头分流（一个漏判就把 `text/html` 发到主站来源）；独立进程（多一套部署与凭证传递）；子域（要 DNS 与证书，owner 选了独立端口）。
- 端口缺省值（D12）：`PORT + 1`（相邻端口的并行测试仍会相撞）；缺省不启用（功能默认缺席）。
- 令牌（D13）：HMAC 签名的无状态令牌（不能续期，换令牌就要换地址、`iframe` 重载）；放查询串（相对资源不会带上）；放 cookie（正是要避免的）。
- 办公文档（D17）：浏览器侧解析库（三种格式各一套，保真度差、体积大）；常驻的 `soffice --accept` 服务（要管生命周期与崩溃恢复，单实例还得自己排队）。
- 终止与清理（D18）：以 omp 用户身份 `pkill` 作业进程（多一条带通配参数的提权规则）；每次转换后经 sudo 删作业目录（路径带随机名，只能写成通配）；周期性执行 `find`（会删掉在途转换的作业目录）。
- 删除（D22）：直接删除（owner 要可恢复）；回收目录放进工作空间里的隐藏目录（助手看得到并可能改它）；数据库里记回收条目（没有界面要查它）；放进 `<state>/trash`（可能在另一个文件系统上，且它的语义是移入后立刻删）。

## 运维

### 端口、对外地址与反向代理

- 不做任何配置也能启动：`PREVIEW_PORT` 缺省 `0`，由系统分配端口，只适合本机使用。要让别的机器访问预览，固定 `PREVIEW_PORT` 并在防火墙放行它；
  预览监听器与主监听器绑定同一个 `HOST`（缺省 `127.0.0.1`），所以 `HOST` 也得是外部可达的地址，或者前面有反向代理。
- 固定 `PREVIEW_PORT` 还避开 #1337：`PORT` 落在系统临时端口段内而 `PREVIEW_PORT` 未设时，系统可能把 `PORT` 分给预览监听器，主监听器随即绑定失败（`{"event":"server_start_failed","reason":"listen"}`）。两者显式设成相同的值同样是这个失败（都是**读代码推出**，未复现）。
- 浏览器不自己拼预览地址，用的是令牌响应里的 `base` / `officeBase`。未设 `PREVIEW_ORIGIN` 时前缀取「本次请求的协议 + `Host` 头的主机名 + 预览监听器实际绑定的端口」（`server/src/workspaces/rest-preview-token.ts`）；
  服务端没有开启代理头信任，经 TLS 终结或端口映射时这样拼出的地址不对（**读代码推出**）。所以有反向代理、TLS 终结或端口映射时必须设 `PREVIEW_ORIGIN`。
- `PREVIEW_ORIGIN` 只能是协议加 authority，例如 `https://preview.example.com` 或 `https://app.example.com:8443`：没有路径、没有结尾斜杠，写法不符即启动失败。
  它必须是与主站**不同的来源**；监听器的路由固定在根下的 `/w/`、`/o/`，不能挂在主站来源的某个路径前缀下。
- 代理把该来源的请求原样转给 `<HOST>:<PREVIEW_PORT>`，不改写路径、不加认证（凭据就是路径里的令牌）。令牌会出现在代理的访问日志里，按含凭据的日志对待。
  经反向代理、TLS 终结或端口映射的部署没有演练过（**未测**）；上面三条（地址怎样拼、`PREVIEW_ORIGIN` 的写法与位置、代理怎样转发）是**读代码推出**。
- 启动失败时标准错误只有一行 `{"event":"server_start_failed","reason":…}`：十二个键写法不符是 `config`，预览端口绑定失败是 `preview_listen`，缓存目录建不出或归属不符是 `preview_cache`。

### LibreOffice 与 `OFFICE_BIN`

- 在主机（或部署镜像）上安装 LibreOffice，把 `OFFICE_BIN` 设为其启动程序的绝对路径（相对路径即启动失败；服务端不查它是否存在，路径不对时每次转换以 502 失败——**读代码推出**）。
  仓库里还没有镜像文件，实际安装属 S4b。实测用的是发行版的 LibreOffice 24.2.7.2、只装了 writer 组件、路径 `/usr/bin/soffice`（#1052）；#1123 的验证用的是 7.4.7.2、装了 writer、calc、impress，三种格式各转了一份（见文末「真实转换的验证记录」）；别的版本**未测**。
- 配置了 `OMP_USER` 的部署另需两行 sudoers（作用范围与转义规则见 ADR-0010 的 #1119 补充；第二行的路径要求见下文「磁盘」）：
  - `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *`
  - `<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`
- CI 与单元测试不需要 LibreOffice。
- 不配 `OFFICE_BIN`：界面对办公文档显示「服务器未启用文档转换，请下载后查看」与下载按钮，其余预览不受影响。

### 十二个环境变量

十二个键都由 `server/src/preview-config.ts` 的 `resolvePreviewSettings` 解析（经 `server/src/server.ts` 的 `resolveServerConfig`），都有缺省值。
数值键须是规范的十进制正整数（`PREVIEW_PORT` 另允许 `0`）；`OMP_USER`、`SANDBOX_ROOT`、`HOST`、`PORT` 是既有的键，不在这十二个里。

| 变量 | 缺省 | 取值 | 含义 | 使用处 |
|---|---|---|---|---|
| `PREVIEW_PORT` | `0` | `0..65535` | 预览监听器的端口；`0` 由系统分配 | `server.ts` |
| `PREVIEW_ORIGIN` | 不设 | `http(s)://authority` | 预览对外的来源；设了就原样用于令牌响应 | `workspaces/rest-preview-token.ts` |
| `PREVIEW_CACHE_DIR` | 仓库根下 `var/preview-cache` | 路径；相对值按仓库根解析 | 转换的作业目录 `work/` 与缓存 `pdf/` 所在 | `server.ts`、`preview/office.ts`、`preview/office-cache.ts` |
| `OFFICE_BIN` | 不设（转换关闭） | 绝对路径 | 办公文档转换程序 | `preview/office.ts`、`preview/office-cache.ts` |
| `OFFICE_CONVERT_TIMEOUT_MS` | `60000` | `1..2147483647` | 一次转换的时限，到时终止 | `preview/office.ts` |
| `OFFICE_CONVERT_CONCURRENCY` | `2` | `1..2147483647` | 同时进行的转换数上限（排队上限固定为 8） | `preview/office-queue.ts` |
| `PREVIEW_TEXT_MAX_BYTES` | `1048576` | `1..2147483647` | 文本预览上限，超出截断 | `workspaces/preview.ts` |
| `PREVIEW_IMAGE_MAX_BYTES` | `20971520` | `1..2147483647` | 图片预览上限，超出拒绝 | `workspaces/preview.ts` |
| `PREVIEW_DOCUMENT_MAX_BYTES` | `104857600` | `1..2147483647` | 文档预览上限：`/o/` 超出答 413；随令牌响应下发，PDF 由页面判定（`/w/` 没有大小上限） | `preview/app.ts`、`workspaces/rest-preview-token.ts` |
| `PREVIEW_NOTEBOOK_MAX_BYTES` | `10485760` | `1..2147483647` | Notebook 预览上限，超出拒绝 | `workspaces/preview.ts` |
| `PREVIEW_ARCHIVE_MAX_ENTRIES` | `1000` | `1..10000` | 压缩包预览一次最多列出的成员数（`docs/architecture/system.md` 9.4） | `workspaces/rest-archive.ts` |
| `TRASH_RETENTION_DAYS` | `30` | `1..2147483647` | 回收批次的保留天数 | `workspaces/trash.ts` |

### 从回收目录恢复

1. 找到审计行：`kind` 为 `file.delete`（`GET /api/audit`，或数据库的 `audit_events` 表）。用到四个值：账号 id（表里是 `actor_id`，接口里是 `actorId`）、空间 id（`workspace_id` / `workspaceId`）、`detail.path`（空间内的相对路径）、`detail.trashId`。
   接口对非管理员角色只返回本人的行，替别的账号恢复须用管理员账号或直接查库。
2. 被删的条目是 `<SANDBOX_ROOT>/.trash/<actor_id>/<workspace_id>/<trashId>/<detail.path 的最后一段>`，一个批次里只有这一个条目。
3. 空间的根目录是 `<SANDBOX_ROOT>/<账号 id>/<workspaces 表里该行的 dir>`（也是 `GET /api/workspaces` 返回的 `root`）。临时空间的行与目录随最后一个会话删除，这时没有原位可回，移到别处。
4. 以**应用用户**的身份（回收目录各级 `0700`）把条目 `mv` 回 `detail.path` 所在的目录。先确认目标位置没有同名条目（`mv` 会覆盖）、父目录还在；
   父目录要重建时建成 `2770`（ADR-0010 的权限模型）。同一文件系统内这是一次改名，属主与 mode 不变。
5. 空的批次目录可以 `rmdir`，不删也会在到期后被清掉。不需要停服务（回收目录没有数据库或内存里的登记，**读代码推出**）；恢复不写审计。

依据：应用用户把 omp 用户建的文件与目录移进 `0700` 的批次目录再移回，四类条目都成功、inode 不变（**实测**，#1051，2026-10-06，design D22）；上面的步骤本身没有在部署上演练过（**未测**）。
批次名里的时刻早于「现在 − `TRASH_RETENTION_DAYS` 天」的批次在下一轮清理时删除，清理在每次启动之后与此后每 6 小时各一轮；过期即不可恢复。
`.trash` 是 omp 用户放的符号链接、普通文件或属 omp 用户的目录，或账号一级是属 omp 用户的目录时，`moveToTrash` 抛出（**实测**，#1318，仅 ext4）；
其余各级、其余两种与属主是别的用户的情形走同一个 `ensureOwnedDir`（**读代码推出**，未逐一测）；条目因此未被移动、路由答 500 是**读代码推出**（校验先于 `rename`，未观察）。
属应用用户而 mode 不符的目录会被校正为 `0700` 后照常使用，所以恢复前先对照上表 #1286 的 ① 核对 `.trash` 确是回收目录。

### 磁盘

- `PREVIEW_CACHE_DIR` **没有总量上限**。`pdf/` 只删修改时间早于 7 天的文件（命中会刷新修改时间），启动时一轮、此后每 24 小时一轮；磁盘吃紧的部署自己盯这个目录。停服务后可以清空 `pdf/` 与 `work/` 的内容（**读代码推出**：缓存只是可再生的副本；`work/` 里属 omp 用户的条目要以该用户或 root 删）。
- `work/` 只在启动时清空。同 uid 模式下每次转换后应用自己删得掉作业目录。同时配置了 `OMP_USER` 与 `OFFICE_BIN` 时删不全：LibreOffice 在作业目录下建的 `profile/`、`.cache/` 属 omp 用户、只有它可进入，
  小文档每个作业留下约 650 KB，被终止的作业另加完整的输出 PDF（20–78 MB）（**实测**，#1052）。所以 `work/` 在一次运行期间只增不减，重启时归零。
- 归零靠启动时的一条 `sudo -n -u <OMP_USER> -- /usr/bin/find <work 的路径> -mindepth 1 -delete`，需要上文「LibreOffice 与 `OFFICE_BIN`」里的第二行 sudoers（同 ADR-0010 的 #1119 补充）。没配 `OFFICE_BIN` 的部署不执行它，也不需要这一行。
  规则里的路径必须与服务端算出的 `join(PREVIEW_CACHE_DIR, "work")` 逐字相同：相对值先按仓库根解析，结果经词法规范化（去掉结尾斜杠、折叠 `.` 与 `..`），不解析符号链接；含空格等特殊字符时按 sudoers 语法转义。
- 规则漏配、路径差一个字符、`find` 不在 `/usr/bin/find`、10 秒内没跑完：启动日志（标准错误）恰有一行 `{"event":"preview_work_clear_failed"}`，不带路径；服务照常启动并提供转换，只是 `work/` 不归零。
  看到这一行先用 `sudo -l -U <app-user>` 核对规则。这条规则在真实 `sudo` 下执行过两次、都清空了（#1123，见文末「真实转换的验证记录」；自动化测试用的是假 `sudo`）；超时杀掉 `sudo` 之后它之下的 `find` 是否随之结束同样**未测**。
- 回收目录没有总量上限，只按天数清理。

### 被终止的转换留下的进程

`OMP_USER` 模式下，转换超时、请求方断开或服务关停时，应用只能杀掉自己启动的 `sudo`。**实测**（#1052，2026-10-06，design D18；容器内，只测了 docx 与 `SIGKILL`）：
5 次终止 5 次都留下一个属 omp 用户的 `soffice.bin`（经 `/o/` 的整条链路上同样出现，#1123 一次，见文末），它占着一个核把整份文档转完才自行退出——约 25 秒的文档在终止后约 20–23 秒，约 133 秒的文档在终止后 128 秒，长于 60 秒的缺省超时。
残留进程不占转换名额（**读代码推出**：名额在 `sudo` 退出时释放），所以主机上同时运行的 `soffice.bin` 可以多于 `OFFICE_CONVERT_CONCURRENCY`。同 uid 模式杀的是整个进程组。

- 查：转换的命令行带着作业目录（`-env:UserInstallation=file://<PREVIEW_CACHE_DIR>/work/<随机名>/profile` 与 `--outdir`），可以
  `ps -u <OMP_USER> -ww -o pid,etime,args | grep -F '<PREVIEW_CACHE_DIR 的绝对路径>/work/'`（服务端解析出的绝对路径，相对值原样代入匹配不上），再对照 `work/` 下还在的目录名。
  命令行的形状是**读代码推出**（`office.ts` 的 argv）；#1123 取样到的 `soffice.bin` 命令行里有这个筛选串（那条 `ps` 命令本身没有在残留期间执行过），筛不到时按进程名 `soffice.bin` 与属主找。
- 杀：以 root 或 omp 用户的身份 `kill`。应用用户发信号得 `EPERM`，sudoers 里没有、也不加 `kill` / `pkill` 规则（owner D-21、D-25）。
  不处理它也会自己退出；它用着的作业目录留到下次启动。

### 删不掉、移不动的条目

**实测**（#1051，2026-10-06，design D22）：助手用 `bash` 对自己建的目录执行 `chmod g-w` 之后（`2750`、属 omp 用户），应用用户把它移进 `0700` 目录失败，`EACCES`，条目留在原处。
同一个目录在同一父目录内改名成功、改回也成功。所以这类目录的删除与跨目录移动答 500、不丢文件，原地重命名不受影响；
没有测「这种目录里面的文件能否单独移动」。处置：让助手把组写位加回去，或在主机上以 omp 用户或 root 的身份 `chmod g+w`。

### 其它

- 临时空间随最后一个会话删除时，它在 `.trash/<账号 id>/<空间 id>/` 下的批次不随之删除，与正式空间的批次一样留到期满（清理不查数据库）。用户在临时空间里删过的文件因此在会话删除后至多再留 `TRASH_RETENTION_DAYS` 天，只有管理员在主机上看得到。
- 上传中的文件写在目标目录下的 `.upload-<32 位十六进制>.part` 里，目录列举不按名字过滤，所以上传中的与进程被杀后残留的 `.part` 在目录树里可见（`docs/architecture/system.md` 9.3「上传残留」）。
- 回滚到没有这些功能的版本后，`<SANDBOX_ROOT>/.trash` 与 `PREVIEW_CACHE_DIR` 留在磁盘上，可手工删除。

## 真实转换的验证记录（#1123，任务 28.6）

2026-10-12 在测试 VPS 上做了一次，记录现象，不改变任何做法。**浏览器一步是脚本驱动的桌面浏览器加截图，截图由执行验证的代理逐张看过，不是人眼在真实窗口里操作**；owner 如要亲眼看一次，按「运维」各节与下面的环境照做即可。

**环境。** 测试 VPS 上的一次性容器（Debian 12，Node 24.13.1；用完即删），容器直接使用宿主的网络。构建的是 `master` 的 `35cf6c3a`（本 change 的运行时代码已全部合入；其后只有文档提交）：`npm ci`、`npm run build --workspace web`、`npm run build --workspace server`，以 `node server/dist/server.js` 启动。
uid 分离按 ADR-0010：应用用户与 omp 用户各一个，同属一个共享组；sudoers 是 `secure_path`、`Defaults>omp umask=0007`、omp 的 spawn 行与上文「LibreOffice 与 `OFFICE_BIN`」的两行。应用以共享组为当前组、umask `007` 启动，设了 `HOST=0.0.0.0`、固定的 `PORT` 与 `PREVIEW_PORT`、`OMP_USER`、`OFFICE_BIN=/usr/bin/soffice`、绝对路径的 `PREVIEW_CACHE_DIR`（父目录 `2770`、属应用用户与共享组）；没有设 `PREVIEW_ORIGIN`。
LibreOffice 是发行版的 **7.4.7.2**（`LibreOffice 7.4.7.2 40(Build:2)`；装了 writer、calc、impress 三个组件，不带推荐包，另装了 DejaVu 字体），与 #1052 用的 24.2.7.2 不是同一个版本。
没有装 omp 二进制，也没有配模型端点：助手没有参与，样本文件由种子账号经上传接口放进工作空间的 `uploads/`。
浏览器在另一台机器上（macOS 26.6.2，arm64），经 VPS 的公网地址直连两个端口，不经隧道与反向代理：Playwright 1.62.1 的 Chromium 151.0.7922.34，`channel: "chromium"` 的新无头模式，视口 1440×900。

**三种格式经 `/o/`。** 样本是脚本生成的：docx 四页（每页一行大字）、xlsx 一张 200 行的表、pptx 四张幻灯片。在文件页的目录树里依次点开：

| 文件 | `/o/` 的响应 | 查看器里的页数 | 翻页 |
|---|---|---|---|
| `sample.docx` | 200，`application/pdf` | 4 | 点进框内按 End：页码 1 → 4；回到首页后滚轮：页码到 3 |
| `sample.xlsx` | 200，`application/pdf` | 5 | End：页码 1 → 5，末页是第 184–200 行 |
| `sample.pptx` | 200，`application/pdf` | 4 | End：页码 1 → 4 |

三个 `iframe` 的地址都是 `<预览来源>/o/<令牌>/uploads/<文件名>`，响应的 CSP 只有 `frame-ancestors <主站来源>`（没有 `sandbox`），内置查看器带缩略图栏与页码框出现在预览区里。从点击到 `/o/` 响应返回各约 1.1 秒（都是首次转换）。把同一地址再取一次得到的 PDF 用 PDF 库数页，是 4、5、4 页，与查看器显示的一致。

**进程身份与缓存属主。** 转换进行中在容器里每 0.5 秒取一次进程表与 `/proc/<pid>/status`：`sudo` 的 `Uid:` 是「应用用户 / root / root / root」；它之下的 `soffice`（包装脚本）、`oosplash`、`soffice.bin` 的 `Uid:` 四个值都是 omp 用户。
`<PREVIEW_CACHE_DIR>/pdf/` 里的缓存文件是 `0600`、属应用用户（属组是共享组）。作业目录 `work/<job>` 属应用用户（`2770`），其下的 `profile/`（`0700`）、`.cache/` 与 `.config/`（`2700`）、`out/`（`2770`）及 `out/<名>.pdf`（`0660`）都属 omp 用户。
转换成功之后作业目录整个留在 `work/` 里，连 `out/<名>.pdf` 也在（三个小文档共 2.0 MB）。三个缓存目录由服务端建出，mode 是 `2750`、`2770`、`0700`，属组随父目录的 setgid 成了共享组——ADR-0010 的 #1119 补充里「属组须是共享组」的前提在满足时的样子；不满足时会怎样**没有测**。

**启动时清空 `work`（第 2 行 sudoers）。** 带着上面三个作业目录重启服务：`work/` 变空，标准错误里没有 `preview_work_clear_failed`。之后带着一个被终止的作业目录（5.2 MB）又重启一次，结果相同。这是这条规则在真实 `sudo` 下第一次被执行；`sudo` 中途被杀时它之下的 `find` 是否随之结束仍**没有测**。

**超时终止一次。** 把 `OFFICE_CONVERT_TIMEOUT_MS` 设成 3000 重启，请求一份 3000 页的 docx（188,779 字节；不被打断时经 `/o/` 要 84.5 秒，得到 4,682,817 字节的 PDF）：

- 请求在 3.03 秒得到 504 与「文档转换超时，请下载后查看」。
- `sudo` 随即消失，`oosplash` 同时被杀（`--pdeathsig` 生效）。
- **残留出现了**：进程名 `soffice.bin`，属 omp 用户，被 1 号进程收养，又运行了约 75 秒把整份文档转完才自行退出，在已被放弃的 `work/<job>/out/` 里留下 4,682,817 字节的完整 PDF——与不被打断时字节数相同。这份 PDF 没有进 `pdf/` 缓存。
- 它的命令行是 `/usr/lib/libreoffice/program/soffice.bin -env:UserInstallation=file://<PREVIEW_CACHE_DIR 的绝对路径>/work/<job>/profile --headless …`，上文「被终止的转换留下的进程」里那条 `ps … | grep -F` 的筛选串在其中（那条命令本身没有在残留期间执行过，这是对照取样到的命令行得出的）。
- 只做了这一次。与 #1052 直接执行转换时的 5 次是同一个现象，这一次经的是 `/o/` 与产品代码的整条链路。
- 容器的 1 号进程不回收孤儿：被杀的 `oosplash` 与退出后的 `soffice.bin` 都以僵尸状态留在进程表里直到容器删除。这是这种容器的现象，有正常 init 的主机上是否如此**没有测**。

**从另一台机器打开 html 预览。** 同一个浏览器点开 `uploads/index.html`（它以 `./style.css` 引同目录的样式表，样式把标题设成绿色）：`iframe`（`sandbox="allow-scripts allow-forms allow-modals"`）的地址是 `<预览来源>/w/<令牌>/uploads/index.html`，其中主机来自请求的 `Host`、端口是固定的 `PREVIEW_PORT`；
`index.html` 与 `style.css` 两个响应都是 200，CSP 为 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors <主站来源>`；框内标题的计算颜色是 `rgb(0, 128, 0)`，截图里是绿色。相对资源可用。

**没有做的。** 人眼在有界面的浏览器窗口里看；Firefox 与其它引擎；由助手生成的文档（没有装 omp）；经反向代理、`PREVIEW_ORIGIN` 或 https 的部署；容器之外的主机；LibreOffice 的其它版本；含中文字体、图片、公式的真实文档的版面；第二次及以后的超时终止；请求方断开与服务关停两种终止。
