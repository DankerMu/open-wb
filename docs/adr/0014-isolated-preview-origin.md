# 工作空间文件的渲染预览走隔离预览来源；办公文档经 LibreOffice 转换；删除进回收目录

工作空间里的 HTML 由助手写出，是不可信内容；把它以 `text/html` 发在主站来源上，页面脚本就能以登录用户的身份调用 `/api`。
此前的 `srcdoc` 预览加载不了相对资源。change `s1f-files-page` 同时要内嵌预览 PDF 与办公文档，并提供删除。
本 ADR 登记其中三项长期决定（owner，2026-10-06 压测及当日的决定 D-21，2026-10-09 / 10-10 的补充裁决 D-23 至 D-27）及其运维含义；
规格在 `preview-origin`、`office-preview`、`file-operations` 三个能力里，逐条理由在该 change 的 `design.md` D11–D22。

下文每条后果标注证据等级：**实测**（跑过并观察到，注明日期与记录处）、**读代码推出**、**未测**。
「测试主机」指 ADR-0010 所说的 Linux 测试部署；记录处的 `design` 指 `openspec/changes/archive/2026-10-12-s1f-files-page/design.md`（change 归档后的位置）。

## 决定

1. **独立的预览监听器。** 同一进程里的第二个 Fastify 实例（`server/src/preview/app.ts`），监听 `PREVIEW_PORT`，与主监听器绑定同一个 `HOST`。
   它只有两条 `GET`（及派生的 `HEAD`）路由：`/w/<token>/<path>` 原样发文件、`/o/<token>/<path>` 发办公文档转换出的 PDF；
   不注册认证插件、不解析 cookie、自己不拿数据库句柄（经与主实例共用的 store 与 sandbox 读写同一个库：查空间归属、写 `sandbox.reject` 审计）、不托管静态文件、没有 `/api`。入口在主监听器 `listen` 成功之后才让它 `listen`（#1337），关停时先于主监听器关停（`server/src/server.ts`）。
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
6. **办公文档经 LibreOffice 转换。** `docx`、`xlsx`、`pptx` 转成 PDF，浏览器按 PDF 预览。**2026-10-17 起（#1350，change `office-convert-sandbox`）转换在 sidecar 容器里，app 不运行 LibreOffice**：
   长驻的转换容器 `converter`（`converter/compose.yml`：`network_mode: none`、只读根、只挂 spool 卷、与 app 同 uid）在 `<OFFICE_SPOOL_DIR>/jobs/<随机名>/` 里以 `soffice --headless … --convert-to pdf` 转换；
   app 只把输入的字节复制进作业目录、等 sidecar 写回标记、再把它写出的 PDF 复制出来（`server/src/preview/office.ts`；spool 协议、身份与证据见 ADR-0010「2026-10-17 补充」）。
   每次转换一个独立的作业目录（独立的 `UserInstallation`）；转换进程环境只有 `PATH`、`LANG`、`HOME`；`OMP_USER` 不影响转换。
   结果缓存在 `<PREVIEW_CACHE_DIR>/pdf/<键>.pdf`，键为 `sha256(输入绝对路径 NUL mtimeMs NUL size)`；输出是**复制**成应用用户自己的 `0600` 新文件后才进缓存，不是改名。
   输出超过 200 MiB 即失败；排队至多 8 组，再来的判繁忙；同一个键的并发请求共用一次转换。
   `OFFICE_SPOOL_DIR` 未配置、或配置了而启动时的 sidecar 预检未通过，即功能关闭：令牌响应的 `officeAvailable` 为 `false`，直接请求 `/o/` 得 503；运行期 sidecar 宕机时 `officeAvailable` 仍为 `true`（启动快照），未缓存的文档 503、已缓存的照常（见「转换 sidecar 与 `OFFICE_SPOOL_DIR`」）。
   `/o/` 的失败是固定文案的纯文本页（413 / 415 / 502 / 503 / 504），主站的错误码集合不因此增加。
   2026-10-12 的形态已退役：app 以 `<OFFICE_BIN>` 在 `<PREVIEW_CACHE_DIR>/work/<随机名>` 里启动 LibreOffice，配置了 `OMP_USER` 时经 `sudo` 以该用户运行，未配置时与应用同 uid——解析不可信文档、读取文档所引用资源的一方就是应用用户（**读代码推出**；见 ADR-0010 的 #1119 补充与文末「真实转换的验证记录」）。
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
- 回收目录与工作空间同在 `SANDBOX_ROOT` 下，是为了 `rename` 不跨文件系统；代价是 omp 用户对它的父目录可写，见下表 #1286。2026-10-16 起根由启动校正为 `3770`（带粘滞位，ADR-0010「2026-10-16 补充」）：omp 用户在根下仍可新建自己的条目，但不能改名或删除应用建出的 `.trash` 与账号根（读代码推出）。

已知残余（#1350 于 2026-10-17 由 change office-convert-sandbox 缓解——转换移进 `--network none`、只挂 spool 的 sidecar，下表 #1350 的几行按此改写、原文划去留作记录；#1286 于 2026-10-16 由 change sandbox-boundary-closure 有界闭合，划去的两行留作记录，其余是书面残余；#1337 闭合于 change s1-followups-batch，该行留作记录）：

| 残余 | 证据 |
|---|---|
| **#1286**（2026-10-16 有界闭合，owner B1：①、清理与 `moveToTrash` 目标一侧对 `.trash` 的换入（根的粘滞位，读代码推出），以及四条读路由——`file`、`download`、`/w/`、`/o/` 转出 PDF——的末段换入（钩子辅助复现）已闭合，见划去的两行；仍在的是读路由与 `archive` 的**中间目录分量**被换成符号链接（design D4「书面残余」，读代码推出，未测、未防）、删除与移动的中间分量（含 ②）、③④⑤。以下是原文）检查之后按路径操作的替换窗口：删除、移动、回收目录清理、`file` / `download` / `archive`、`/w/`、`/o/`。owner D-23：本 change 不闭合，由部署模型兜底（单一专用 omp 用户、可信账号）；利用者须能以 omp 用户身份运行代码。后果：清理可被引到 `.trash` 之外、删掉一棵形状相符的应用用户 `0700` 目录树（快照目录是这个形状）；删除与移动的 `rename` 可穿过被换成符号链接的中间目录，把条目移出工作空间，或把空间之外、应用用户够得着的条目移进来；读路由可读到链接指向的文件，或被换入的命名管道占住线程池线程 | 原残余：起草时读代码推出；下面五行是 2026-10-10 的实测（#1318，design D22「实测」），那里没提到的仍是读代码推出、未测。闭合与仍在残余的等级见左栏括号 |
| **已闭合**（2026-10-16：根带粘滞位，omp 用户不能把应用的账号根改名成 `.trash`，也不能把 `.trash` 改名挪开；读代码推出）~~① 删除不需要竞态：`.trash` 不存在时 omp 用户把另一个账号的根改名成 `.trash`，下一次删除把它改成 `0700` 并在其中建批次，该账号根对 omp 用户锁死；被挪开的真 `.trash` 里的批次不再被清理~~ | 原残余：实测（ext4 与 overlayfs；驱动的是编译后的 `moveToTrash` 与 `sweep`，两半各自实测、未连成一次；经 `DELETE` 路由的 204 与审计行未测）；闭合：读代码推出（粘滞目录语义，未在 uid 分离的 Linux 上实测） |
| ② 移动的目标一侧可替换工作空间之外、同一文件系统上应用用户可写处的同名文件或空目录；跨文件系统是 `EXDEV` | 纯系统调用实测；经真实处理器只在钩子辅助下复现；自然竞态 20000 轮未复现 |
| ③ 同步的处理器挡不住同进程线程池里的文件系统调用落进检查与改名之间 | 时序未测 |
| ④ `to` 处出现源的硬链接时 `rename` 成功而不动，路由仍答 200 | 纯系统调用实测；钩子辅助下经真实处理器复现 |
| ⑤ `work/` 的条目可被换成符号链接；Node 24.13.1 的 `rmSync` 不跟随。2026-10-17 起 `work/` 退役（#1350）；同一递归删除现用于启动时清空 `<OFFICE_SPOOL_DIR>/jobs/`，能换入的是与 app 同 uid 的 sidecar 里的存活进程（`server/src/preview/office-cache.ts` 头注释） | 预先放好的顶层与嵌套两例经真实 `clearWork` 实测（`jobs/` 上同形的两例在 `office-cache.test.ts`；`work/` 时的用例随 S1b 删除），另有裸 `rmSync` 的 `strace`；边删边换未测；只对该运行时版本成立 |
| ~~`/w/` 与 `/o/` 的读窗口：`lstat` 之后按路径打开，不带 `O_NOFOLLOW` / `O_NONBLOCK`~~ **末段已闭合**（2026-10-16）：`/w/` 与 `/o/` 转出 PDF 以 `O_NOFOLLOW \| O_NONBLOCK` 打开、按描述符读，换入的末段答 404 / 502、零字节；中间分量残余同 #1286 行。`/o/` 的输入 2026-10-17 起由转换器以同一个 `openRegularFile` 打开、把字节复制进 spool（#1350，不再由转换进程按路径打开）：`lstat` 之后末段被换成符号链接 → 转换 `failed`（502），与 `/w/` 同守末段——收窄而不闭合，中间分量仍跟随；排队仍把 `lstat` 到打开之间的窗口拉长到最坏约 `ceil(8 / 并发) × 超时`（缺省约 4 分钟），边界里因此多出的最多是那一个被换入的普通文件的字节；两条路由的成功读取都不写审计 | 末段：钩子辅助复现（包住打开的钩子自己换入，PR #1498；`/o/` 输入侧是转换器单元测试里的钩子例，PR #1511）；其余读代码推出，未测 |
| **#1350 已缓解**（sidecar，`network_mode: none`、只挂 spool）：链接资源不再被取回（测试主机实测，S2b 结果表）；数据类向量未测、按构造覆盖。~~文档内容引用的资源由转换进程去取。链接图片被跟随：docx 的 http 图片、docx / pptx 的 `file://` 图片都进了输出的 PDF；读的一方是转换进程的 uid，两种模式都读到了另一账号工作空间里的图。网络引用从服务器所在的网络位置发出，uid 分离不缓解~~ | 已缓解：实测（测试主机，2026-10-18，两种部署形态与两种 uid 模式各一次：docx 的 http 图片 0 次请求、0 图，docx / pptx 的 `file://` 外部图 0 图；对照与两条变异都命中 / 有图；ADR-0010「2026-10-17 补充」结果表 b1–b5、f1–f2）；实测（CI，`office-sidecar`：0 次请求 0 图，对照 1 次 1 图）。原残余：实测（2026-10-12，design D22；一次性容器里按 `office.ts` 的 argv 与 `sudo … setpriv` 形状复刻，LibreOffice 24.2.7.2，未经 `/o/` 路由） |
| **#1350 已缓解**（sidecar，`network_mode: none`、只挂 spool）：链接资源不再被取回（测试主机实测，S2b 结果表）；数据类向量未测、按构造覆盖——要读的本地文件不在容器里，要走的网络不存在，DDE 的进程间通信在容器自己的 ipc 命名空间里（owner B1：不为验证它们造文档）。~~外部数据类引用（xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、docx `INCLUDETEXT`）是否跟随；https、回环以外的网络目标、关闭链接更新之后的行为、其它版本~~ | 数据类向量：未测、视为跟随，按构造覆盖（读手册推出）；原残余：未测 |
| **sidecar 下未再出现**（2026-10-17 起转换不经 `sudo`，sidecar 里只有同 uid 杀整个进程组一种终止；`work/` 退役）。~~`OMP_USER` 模式下被终止的转换留下 `soffice.bin`；`work/` 在一次运行期间增长~~ | sidecar 下未再出现（测试主机实测：3 列 × (5 次超时 + 1 次断开) + 8 次探针，≈6.6 s 文档；504 / 断开后 0.5–1.5 s 内 converter 内 soffice 为 0；其中 app 取消路径 6 次、sidecar 自身时限路径 20 次）；服务关停一种终止未测。原残余：实测（#1052，2026-10-06，design D18）；数字见「被终止的转换留下的进程」与 ADR-0010 的 #1119 补充 |
| 同一 sidecar 内并发作业共享 fs / ipc / uid，作业间隔离只靠 128 位随机作业 id；LibreOffice 代码执行漏洞下另一在途作业的输入 / 输出可读可伪造（读代码推出，未测） | 读代码推出，未测（change office-convert-sandbox design D2 第 2 条、D12；不缓解）；测试主机没有测并发作业 |
| 取消之后作业目录残留：超时或断开收尾时 app 删作业目录与 sidecar 写 `failed` 标记竞态，目录非空删不掉，留到下一次 app 启动由 `clearWork` 清空；残留的只是输入副本与标记，没有进程 | 实测（测试主机，2026-10-18）：26 次终止里 1 次（A 同 uid c#4，该次 sidecar 日志为 `cancelled`），下次启动被 `clearWork` 清掉；机制读代码推出（未看到残留目录的内容）；接受、不改代码 |
| 被攻破的 sidecar（与 app 同 uid、spool 可写）对 app 的反向面：`O_NOFOLLOW` 只管末段，它可在核对与操作之间把 `<job>/out`、作业目录或 `jobs` 换成符号链接，让 app 代读它够得着的文件并当 PDF 交出、把 `cancel` / `.part` 写进目标目录，或在启动清空时删掉目标目录的子项。缓解：读输出前核对作业目录与 `out/` 是非链接目录，`.part` 用 `wx`、写 `cancel` 与 `.part` 前核对作业目录，清空前以 `O_NOFOLLOW \| O_DIRECTORY` 打开 `jobs` 核对；确定性利用降为一次系统调用间隔的竞态窗口，不是零（Node 没有 `openat` 族） | 读代码推出（change office-convert-sandbox design Risks「app 跟随 spool 中间分量」）；核对本身有单元测试（实测（CI）），竞态窗口未测 |
| 转换缓存没有总量上限 | 读代码推出（只有按 7 天的清理） |
| 移动的「先看再改名」：检查之后、改名之前别的进程在目标位置建出的文件会被覆盖 | 读代码推出，未测（design Risks） |
| **#1337**（已闭合，change s1-followups-batch）缺省 `PREVIEW_PORT=0` 曾先于主端口绑定，系统分配的端口可能恰是 `PORT`。入口改为先绑定主监听器，分配到的端口不可能是 `PORT`。对调留下一段窗口：主监听器已受理请求而预览监听器尚未绑定，其间 `preview-token` 答 typed 404。托管布局建在两次绑定之间（owner 2026-10-13 裁决）：主监听器绑定成功之后到 `ensureOmpStateLayout` 返回是同步代码，窗口里到达的 prompt 建得出快照目录，不留 `session_fault`；布局失败时已绑定的主监听器随失败清理关闭。`models.yml` 与宿主 overlay 仍在两次绑定之后写，它们写出之前到达的请求是对调之前就有的残余（写入本来就是异步的），窗口多了一次预览绑定的时长。在实测的形状下（macOS arm64、无 `OMP_USER`、不经 sudo/setpriv），宿主 overlay（审批钉住值）未写出时 spawn 的 omp v18.0.10 不会不带钉住值运行：它以退出码 1 退出、不发 `ready`，stderr 为 `Config overlay not found: <路径>`（omp 一侧失败关闭）；该 prompt 以 agent 不可用失败（读代码推出，未测）。`models.yml` 未写出而 overlay 已在时 omp 同样不到 `ready`、以退出码 1 退出（`Model "workbuddy/<id>" not found`），退出前在模型发现阶段停了约 10 秒，与宿主 10 秒的握手超时相当 | 原问题：读代码推出，未复现。对调后的次序（先 `PORT`、后预览端口）：实测（编译入口的 order trace，不加钩子，`server/test/server-startup-order.test.ts`）。窗口里的 `preview-token` 404 与 prompt 不留 `session_fault`：钩子辅助复现（预加载推迟预览监听器的原生 `listen` 把窗口拉宽，`server/test/server-startup-preview.test.ts`）。主绑定与布局之间没有让出：读代码推出（`server/src/server.ts` 的 `start`）。overlay 或 `models.yml` 缺失时 omp 的退出：实测（2026-10-13，macOS arm64，官方 v18.0.10；手工按 `spawnOmp` 的 argv 与 env 运行，无 `OMP_USER`、不经 sudo / setpriv、不经入口的 spawn 路径，未发任何 prompt；对照组两个文件都在时发出 `ready`）。Linux 与 `OMP_USER`（sudo/setpriv）形状未测；入口对 omp 在 `ready` 之前退出的处置未测（prompt 路由答什么、是否留 `session_fault`；`models.yml` 缺失时握手超时与退出谁先到）：读代码推出，未测（子进程 stderr 只被排空，不保留、不写日志，`server/src/sessions/omp/process.ts`）。不加钩子时窗口有多长、请求能否落进去：未测 |
| 真实 LibreOffice 经 `/o/` 的端到端（docx / xlsx / pptx）、从另一台机器经固定端口打开 html 预览 | 已测一次（#1123，2026-10-12；浏览器一步是脚本驱动加截图）：三种格式可翻页，html 的相对样式表生效，见文末「真实转换的验证记录」；那里列着没有做的。sidecar 形态：实测（测试主机，2026-10-18，两种部署形态——容器形态以 `docker run` 等参数起 app，非 compose `include`；三种格式含中文正文各 1 页、`pdftotext` 可辨认；经 `/o/` 0.92–1.12 s；ADR-0010「2026-10-17 补充」结果表）；结果表没有记录浏览器查看器一步 |

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
- `PORT` 落在系统临时端口段内而 `PREVIEW_PORT` 未设也可以：入口先绑定主监听器，系统随后为预览监听器分配的端口不可能是 `PORT`（#1337，已闭合；**实测**次序，见上表）。两者显式设成相同的值仍是启动失败，阶段为预览监听器那一步（`{"event":"server_start_failed","reason":"preview_listen"}`，**实测**）。
- 浏览器不自己拼预览地址，用的是令牌响应里的 `base` / `officeBase`。未设 `PREVIEW_ORIGIN` 时前缀取「本次请求的协议 + `Host` 头的主机名 + 预览监听器实际绑定的端口」（`server/src/workspaces/rest-preview-token.ts`）；
  服务端没有开启代理头信任，经 TLS 终结或端口映射时这样拼出的地址不对（**读代码推出**）。所以有反向代理、TLS 终结或端口映射时必须设 `PREVIEW_ORIGIN`。
- `PREVIEW_ORIGIN` 只能是协议加 authority，例如 `https://preview.example.com` 或 `https://app.example.com:8443`：没有路径、没有结尾斜杠，写法不符即启动失败。
  它必须是与主站**不同的来源**；监听器的路由固定在根下的 `/w/`、`/o/`，不能挂在主站来源的某个路径前缀下。
- 代理把该来源的请求原样转给 `<HOST>:<PREVIEW_PORT>`，不改写路径、不加认证（凭据就是路径里的令牌）。令牌会出现在代理的访问日志里，按含凭据的日志对待。
  经反向代理、TLS 终结或端口映射的部署没有演练过（**未测**）；上面三条（地址怎样拼、`PREVIEW_ORIGIN` 的写法与位置、代理怎样转发）是**读代码推出**。
- 启动失败时标准错误只有一行 `{"event":"server_start_failed","reason":…}`：十二个键写法不符是 `config`（已退役的 `OFFICE_BIN` 仍被设置同样是 `config`，这一行不点名它，见下一节），预览端口绑定失败是 `preview_listen`，缓存目录建不出或归属不符是 `preview_cache`。

### 转换 sidecar 与 `OFFICE_SPOOL_DIR`

2026-10-17 起（#1350，change `office-convert-sandbox`）办公文档由 sidecar 容器转换，app 主机不需要 LibreOffice。决定、spool 协议与证据见 ADR-0010「2026-10-17 补充」；部署要知道的另写在 `docs/architecture/system.md` 9.7。

- **前提**：主机上有 Docker（含 compose 插件），并跑着 `converter/compose.yml` 的 `converter` 服务。没有它的部署里配了 `OFFICE_SPOOL_DIR` 的服务照常启动、办公文档预览 fail-closed（下文「排障」），其余功能不受影响。
- **镜像由部署方自建**（owner B9）：`docker compose … up -d --build` 按 `converter/Dockerfile` 现场构建（基底 `node:24-bookworm-slim`，Debian 的 `libreoffice-writer-nogui`、`libreoffice-calc-nogui`、`libreoffice-impress-nogui`、`fonts-dejavu-core`、`fonts-noto-cjk`）；仓库不发布镜像、不引用镜像仓库，也不钉基底 digest 与包版本。实测用的构建里是 LibreOffice 7.4.7.2（测试主机，2026-10-18；CI `office-sidecar` 同为 bookworm 的 7.4.7 包）；别的版本**未测**。
- **两种部署形态跑的是同一个容器**：
  1. app 裸机：建 spool 目录（属应用用户、`0700`；spool 根是部署方的卷，app 不建、不校正）；在同一主机上 `WORKBUDDY_UID=$(id -u <应用用户>) WORKBUDDY_GID=$(id -g <应用用户>) OFFICE_SPOOL_DIR=<该路径> docker compose -f converter/compose.yml up -d --build`；app 的环境去掉 `OFFICE_BIN`、加 `OFFICE_SPOOL_DIR=<同一路径>`，重启 app。
  2. app 容器：把 `converter/compose.yml` `include` 进 app 自己的 compose，app 服务加 `depends_on: converter: condition: service_healthy`，两个服务挂同一个 bind mount（不用命名卷：命名卷的根属 root，预检会拒），app 服务的 `user:` 与 `converter` 相同（`include` 写法本身未实测：S2b 的形态 B 以 `docker run --network host` 加同样的卷与 `--user` 代替，见 ADR-0010「2026-10-17 补充」结果表；compose 写法读手册推出）。仓库没有 app 的 Dockerfile 与 compose 服务定义（该 change 的 Non-Goals），app 镜像由部署方自备。
     （2026-10-21 补充，#1559）上一句已过期：#1528 交付了参考镜像与 compose 片段 `deploy/app/`（`docs/architecture/system.md` 9.8「参考部署镜像」），部署方仍可自备 app 镜像。用参考镜像时应用用户固定为 `workbuddy`，uid:gid `10001:10001`（`deploy/app/Dockerfile` 的 `groupadd` / `useradd`），`WORKBUDDY_UID` / `WORKBUDDY_GID` 取 `10001` / `10001`；自备镜像仍按本条让 app 服务的 `user:` 与 `converter` 相同。参考镜像加挂 spool 未实测（同 system.md 9.7 第 2 条）。
- **uid 对齐**：`WORKBUDDY_UID` / `WORKBUDDY_GID` 必须是应用用户的 `id -u` / `id -g`——sidecar 以同一数值 uid/gid 运行，spool 里的一切因此属应用用户、app 自己删得掉；两个变量缺席时 compose 拒绝启动。不对齐时 sidecar 要么写不进 `0700` 的 spool、要么写出的 `heartbeat` 属别的 uid，两种情况预检都失败（**读代码推出**）。
- **并发**：`CONVERTER_CONCURRENCY`（compose 里取 `${OFFICE_CONVERT_CONCURRENCY:-2}`）须 ≥ app 的 `OFFICE_CONVERT_CONCURRENCY`。给 compose 与 app 同一个 `OFFICE_CONVERT_CONCURRENCY` 即相等；小于时作业在 spool 里排队等，app 的时限从建作业目录起算，排得久的会以 504 结束（**读代码推出**）。
- **升级**（owner B8）：`OFFICE_BIN` 还留在 app 的环境里时 app 启动失败，标准错误只有 `{"event":"server_start_failed","reason":"config"}`，**不点名**该键（键名只在抛出的错误 message `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR` 里）。升级后启动失败、`reason` 为 `config` 时先查 `OFFICE_BIN` 是否已去掉。旧的 `<PREVIEW_CACHE_DIR>/work` 不再使用，留着无害，可手工删除。
- **`OMP_USER` 部署**：删掉两行办公文档 sudoers（`<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *` 与 `<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`）；留着无害，但不再匹配任何命令。omp 自己的规则与 `Defaults>omp umask=0007` 不动。LibreOffice 可从 app 主机卸载。
- **排障**：启动时（`server_started` 之前）或运行期标准错误出现 `{"event":"office_convert_sidecar_unavailable"}`，依次查——`docker compose -f converter/compose.yml ps` 里 `converter` 是否在跑且 healthy；`<OFFICE_SPOOL_DIR>/heartbeat` 的修改时间是否在 10 秒内、属主是否为应用用户；spool 根是否属应用用户、mode 为 `0700`（带组或其它写位即被拒）；`WORKBUDDY_UID` / `WORKBUDDY_GID` 与 `CONVERTER_*`（`CONVERTER_CONCURRENCY` 等）的取值。启动时那一行意味着这次进程里办公文档预览一直关着（`officeAvailable` 为 `false`，修好 sidecar 之后要重启 app）；运行期那一行在 sidecar 恢复后自愈，不必重启。
- **用户看到的**：预检失败后办公文档一律显示「服务器未启用文档转换，请下载后查看」与下载按钮，已缓存的也一样；运行期 sidecar 宕机时未缓存的显示同一句、已缓存的照常预览；sidecar 死在一次转换中途时这一次是 504「文档转换超时，请下载后查看」，下一次才是 503（**实测**的五步见 ADR-0010「2026-10-17 补充」结果表 d0–d4；中途死亡一条**读代码推出**）。
- **回滚**到旧版本：恢复 `OFFICE_BIN`、去掉 `OFFICE_SPOOL_DIR`（旧代码忽略不认识的键，**读代码推出**）、恢复两行 sudoers；sidecar 容器可停可留。
- CI 与单元测试不需要 LibreOffice 与 Docker；只有 CI job `office-sidecar` 现场构建镜像、以 `--network none` 跑一次真实转换。
- 不配 `OFFICE_SPOOL_DIR`：界面对办公文档显示「服务器未启用文档转换，请下载后查看」与下载按钮，其余预览不受影响。

### 十二个环境变量

十二个键都由 `server/src/preview-config.ts` 的 `resolvePreviewSettings` 解析（经 `server/src/server.ts` 的 `resolveServerConfig`），都有缺省值。
数值键须是规范的十进制正整数（`PREVIEW_PORT` 另允许 `0`）；`OMP_USER`、`SANDBOX_ROOT`、`HOST`、`PORT` 是既有的键，不在这十二个里。sidecar 自己的五个 `CONVERTER_*` 键在容器里读（`converter/sidecar.mjs`），不经这里。

| 变量 | 缺省 | 取值 | 含义 | 使用处 |
|---|---|---|---|---|
| `PREVIEW_PORT` | `0` | `0..65535` | 预览监听器的端口；`0` 由系统分配 | `server.ts` |
| `PREVIEW_ORIGIN` | 不设 | `http(s)://authority` | 预览对外的来源；设了就原样用于令牌响应 | `workspaces/rest-preview-token.ts` |
| `PREVIEW_CACHE_DIR` | 仓库根下 `var/preview-cache` | 路径；相对值按仓库根解析 | 转换缓存 `pdf/` 所在（2026-10-17 起不再有 `work/`） | `server.ts`、`preview/office.ts`、`preview/office-cache.ts` |
| `OFFICE_SPOOL_DIR` | 不设（转换关闭） | 绝对路径（不查存在性；属主与 mode 归启动预检） | 与 sidecar 共享的 spool 目录，作业在其 `jobs/` 下；2026-10-17 起 1:1 替换 `OFFICE_BIN`，后者仍被设置即启动失败 | `server.ts`、`preview/office.ts`、`preview/office-sidecar-health.ts`、`preview/office-cache.ts` |
| `OFFICE_CONVERT_TIMEOUT_MS` | `60000` | `1..2147483647` | 一次转换的时限：app 到时写 `cancel`；同一个数作为 `request.json` 的 `timeoutMs` 交给 sidecar | `preview/office.ts` |
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
属应用用户而 mode 不符的既有目录仍会被校正为 `0700` 后照常使用；2026-10-16 起根带粘滞位，`.trash` 不会再被 omp 用户换走（读代码推出，上表 #1286 的 ① 已闭合）。

### 磁盘

- `PREVIEW_CACHE_DIR` **没有总量上限**。`pdf/` 只删修改时间早于 7 天的文件（命中会刷新修改时间），启动时一轮、此后每 24 小时一轮；磁盘吃紧的部署自己盯这个目录。停服务后可以清空 `pdf/` 的内容（**读代码推出**：缓存只是可再生的副本）。
- 作业目录在 `<OFFICE_SPOOL_DIR>/jobs/` 下（`jobs/` 由 app 在启动预检通过后建出，`0700`；部署方只建 spool 根），每次转换落定前由 app 删除（尽力而为）；启动时（预检通过后）app 以本进程递归删掉 `jobs/` 下的全部遗留条目（`jobs` 自身不删），不提权、不启动子进程——sidecar 与 app 同 uid，作业目录里没有 app 删不掉的东西。已知的遗留只有「取消之后作业目录残留」一种（上表；实测 26 次终止里 1 次），重启即清。
- 2026-10-17 之前的 `<PREVIEW_CACHE_DIR>/work`、启动时以 omp 用户执行的 `sudo … find` 清空与 `{"event":"preview_work_clear_failed"}` 都已退役（ADR-0010「2026-10-17 补充」）；升级后留下的 `work/` 可手工删除，里面属 omp 用户的条目要以该用户或 root 删。
- 回收目录没有总量上限，只按天数清理。

### 被终止的转换留下的进程

2026-10-17 起转换在 sidecar 里，终止只有一种：超时、请求方断开或服务关停时 app 写 `cancel` 并删掉作业目录，sidecar 看到 `cancel` 或目录已不在任一即对该作业的进程组发 `SIGKILL`；sidecar 自己的时限到期同样杀组。不经 `sudo`，没有 app 杀不到的进程。
sidecar 下未再出现（测试主机实测：3 列 × (5 次超时 + 1 次断开) + 8 次探针，≈6.6 s 文档；504 / 断开后 0.5–1.5 s 内 converter 内 soffice 为 0；其中 app 取消路径 6 次、sidecar 自身时限路径 20 次）。服务关停一种终止与并发作业的终止没有实测。

- 查：`docker top <converter 容器>` 看容器里的进程；在途作业的命令行带着作业目录（`/spool/jobs/<随机名>/`，sidecar 视角的路径），再对照宿主上 `<OFFICE_SPOOL_DIR>/jobs/` 下还在的目录名（命令行形状**读代码推出**）。
- 杀：一般不需要。要清掉容器里的全部转换进程就 `docker compose -f converter/compose.yml restart converter`——收到 `SIGTERM` 时 sidecar 杀掉全部在途进程组、以 0 退出；重启后仍在的作业会被重新领取（**读代码推出**）。
- 2026-10-12 之前的现象（`OMP_USER` 模式下只杀得到 `sudo`，`soffice.bin` 属 omp 用户、被 1 号进程收养、跑完整份转换才退出：#1052 的 5 次、#1123 的 1 次）是旧转换链的，见 ADR-0010 的 #1119 补充与文末「真实转换的验证记录」。

### 删不掉、移不动的条目

**实测**（#1051，2026-10-06，design D22）：助手用 `bash` 对自己建的目录执行 `chmod g-w` 之后（`2750`、属 omp 用户），应用用户把它移进 `0700` 目录失败，`EACCES`，条目留在原处。
同一个目录在同一父目录内改名成功、改回也成功。所以这类目录的删除与跨目录移动答 500、不丢文件，原地重命名不受影响；
没有测「这种目录里面的文件能否单独移动」。处置：让助手把组写位加回去，或在主机上以 omp 用户或 root 的身份 `chmod g+w`。

### 其它

- 临时空间随最后一个会话删除时，它在 `.trash/<账号 id>/<空间 id>/` 下的批次不随之删除，与正式空间的批次一样留到期满（清理不查数据库）。用户在临时空间里删过的文件因此在会话删除后至多再留 `TRASH_RETENTION_DAYS` 天，只有管理员在主机上看得到。
- 上传中的文件写在目标目录下的 `.upload-<32 位十六进制>.part` 里，目录列举不按名字过滤，所以上传中的与进程被杀后残留的 `.part` 在目录树里可见（`docs/architecture/system.md` 9.3「上传残留」）。
- 回滚到没有这些功能的版本后，`<SANDBOX_ROOT>/.trash` 与 `PREVIEW_CACHE_DIR` 留在磁盘上，可手工删除。

## 真实转换的验证记录（#1123，任务 28.6）

> 2026-10-12 的记录，对应 sidecar 之前的转换链（`OFFICE_BIN`、`work/`、`OMP_USER` 下经 `sudo`）；保留为历史。sidecar 形态的实测（2026-10-18，测试主机）见 ADR-0010「2026-10-17 补充」的结果表。

2026-10-12 在测试 VPS 上做了一次，记录现象，不改变任何做法。**浏览器一步是脚本驱动的桌面浏览器加截图，截图由执行验证的代理逐张看过，不是人眼在真实窗口里操作**；owner 如要亲眼看一次，按「运维」各节与下面的环境照做即可。

**环境。** 测试 VPS 上的一次性容器（Debian 12，Node 24.13.1；用完即删），容器直接使用宿主的网络。构建的是 `master` 的 `35cf6c3a`（本 change 的运行时代码已全部合入；其后只有文档提交）：`npm ci`、`npm run build --workspace web`、`npm run build --workspace server`，以 `node server/dist/server.js` 启动。
uid 分离按 ADR-0010：应用用户与 omp 用户各一个，同属一个共享组；sudoers 是 `secure_path`、`Defaults><OMP_USER> umask=0007`、omp 的 spawn 行与当时的两行办公文档规则（已退役，原文见上文「转换 sidecar 与 `OFFICE_SPOOL_DIR`」的 `OMP_USER` 一条）。应用以共享组为当前组、umask `007` 启动，设了 `HOST=0.0.0.0`、固定的 `PORT` 与 `PREVIEW_PORT`、`OMP_USER`、`OFFICE_BIN=/usr/bin/soffice`、绝对路径的 `PREVIEW_CACHE_DIR`（父目录 `2770`、属应用用户与共享组）；没有设 `PREVIEW_ORIGIN`。
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

**进程身份与缓存属主。** 进程取样只在下文超时终止的那一次 docx 转换里做了（容器里每 0.5 秒取一次进程表与 `/proc/<pid>/status`）；三个小文档各约 1 秒转完，没有取样，它们的转换身份只有作业目录里的文件属 omp 用户这一间接证据：`sudo` 的 `Uid:` 是「应用用户 / root / root / root」；它之下的 `oosplash`、`soffice.bin` 的 `Uid:` 四个值都是 omp 用户。`soffice`（包装脚本）在进程表里只取到一拍，属 omp 用户，随即在同一个 pid 里 exec 成 `oosplash`，没有取到它自己的 `/proc/<pid>/status`。
`<PREVIEW_CACHE_DIR>/pdf/` 里的缓存文件是 `0600`、属应用用户（属组是共享组）。作业目录 `work/<job>` 属应用用户（`2770`），其下的 `profile/`（`0700`）、`.cache/` 与 `.config/`（`2700`）、`out/`（`2770`）及 `out/<名>.pdf`（`0660`）都属 omp 用户。
转换成功之后作业目录整个留在 `work/` 里，连 `out/<名>.pdf` 也在（三个小文档共 2.0 MB）。三个缓存目录由服务端建出，mode 是 `2750`、`2770`、`0700`，属组随父目录的 setgid 成了共享组——ADR-0010 的 #1119 补充里「属组须是共享组」的前提在满足时的样子；不满足时会怎样**没有测**。

**启动时清空 `work`（第 2 行 sudoers）。** 带着上面三个作业目录重启服务：`work/` 变空，标准错误里没有 `preview_work_clear_failed`。之后带着一个被终止的作业目录（5.2 MB）又重启一次，结果相同。这是这条规则在真实 `sudo` 下第一次被执行；`sudo` 中途被杀时它之下的 `find` 是否随之结束仍**没有测**。

**超时终止一次。** 把 `OFFICE_CONVERT_TIMEOUT_MS` 设成 3000 重启，请求一份 3000 页的 docx（188,779 字节；不被打断时经 `/o/` 要 84.5 秒，得到 4,682,817 字节的 PDF——那一次是事后把超时调到 200000 另跑的）：

- 请求在 3.03 秒得到 504 与「文档转换超时，请下载后查看」。
- `sudo` 随即消失，`oosplash` 同时被杀（`--pdeathsig` 生效）。
- **残留出现了**：进程名 `soffice.bin`，属 omp 用户，被 1 号进程收养，又运行了约 75 秒把整份文档转完才自行退出，在已被放弃的 `work/<job>/out/` 里留下 4,682,817 字节的完整 PDF——与不被打断时字节数相同。这份 PDF 没有进 `pdf/` 缓存。
- 它的命令行是 `/usr/lib/libreoffice/program/soffice.bin -env:UserInstallation=file://<PREVIEW_CACHE_DIR 的绝对路径>/work/<job>/profile --headless …`，当时「被终止的转换留下的进程」里那条 `ps … | grep -F`（2026-10-17 改写时删去，原文同 ADR-0010 的 #1119 补充「查」一条）的筛选串在其中（那条命令本身没有在残留期间执行过，这是对照取样到的命令行得出的）。
- 只做了这一次。与 #1052 直接执行转换时的 5 次是同一个现象，这一次经的是 `/o/` 与产品代码的整条链路。
- 容器的 1 号进程不回收孤儿：被杀的 `oosplash` 与退出后的 `soffice.bin` 都以僵尸状态留在进程表里直到容器删除。这是这种容器的现象，有正常 init 的主机上是否如此**没有测**。

**从另一台机器打开 html 预览。** 同一个浏览器点开 `uploads/index.html`（它以 `./style.css` 引同目录的样式表，样式把标题设成绿色）：`iframe`（`sandbox="allow-scripts allow-forms allow-modals"`）的地址是 `<预览来源>/w/<令牌>/uploads/index.html`，其中主机来自请求的 `Host`、端口是固定的 `PREVIEW_PORT`；
`index.html` 与 `style.css` 两个响应都是 200，CSP 为 `sandbox allow-scripts allow-forms allow-modals; frame-ancestors <主站来源>`；框内标题的计算颜色是 `rgb(0, 128, 0)`，截图里是绿色。相对资源可用。

**没有做的。** 人眼在有界面的浏览器窗口里看；Firefox 与其它引擎；由助手生成的文档（没有装 omp）；经反向代理、`PREVIEW_ORIGIN` 或 https 的部署；容器之外的主机；LibreOffice 的其它版本；含中文字体、图片、公式的真实文档的版面；第二次及以后的超时终止；xlsx、pptx 转换进行中的进程取样；请求方断开与服务关停两种终止。
