## ADDED Requirements

### Requirement: 文件上传
`POST /api/workspaces/:id/uploads?name=<文件名>` SHALL 把请求体的原始字节作为一个文件写进该工作空间根下的 `uploads` 目录；一次请求恰一个文件，任意文件类型（不按扩展名或内容限制）。路由由 `registerWorkspaces` 注册，受既有 cookie guard 保护（未认证 401，先于读取请求体），全部响应 `Cache-Control: no-store`。请求的 `Content-Type` SHALL 为 `application/octet-stream`；其它媒体类型为 400 `bad_request`（该路由属于 http-service-skeleton「统一错误信封」的 content-parser 归属集）。
请求体 SHALL 以流的方式直接写入磁盘：服务端 SHALL NOT 把整个请求体缓冲在内存里，SHALL NOT 使用 multipart 解析。单个文件的字节上限为 `UPLOAD_MAX_BYTES` 的生效值（http-service-skeleton「服务启动与装配」，缺省 524288000）；0 字节的文件合法。

处理次序（每一步失败即止，不再执行后面的步骤）：

1. 空间归属：经工作空间 store 所有者作用域的 `rootOf(principal, id)` 判定，对临时空间与正式空间不作区分（temporary-workspaces「临时空间的可见性」：所有者自己的临时空间 id 与正式空间行为一致）。`:id` 属他人或不存在（含格式不合法的 id、他人的临时空间）→ 404 `not_found`，与其它工作空间端点逐字相同；不读取请求体、不写审计、不触及文件系统。自有空间的根目录不存在或不是普通目录 → 404。
2. `name`：SHALL 是 query 里恰一个非空字符串（缺失、重复、空串 → 400 `bad_request`）；服务端按 URL 解码后的字符串使用，不做额外规范化。
3. 声明的大小：请求带 `Content-Length` 且其值大于上限 → 413 `upload_too_large`，不读取请求体，并写一条 `upload.reject` 审计（见下）。
4. 沙箱：经 facade `resolve(principal, id, "uploads/" + name, "write")`。被拒绝的（任一分量为 `..`、含 NUL、`uploads` 或目标本身是符号链接、最后一段含反斜杠或为空等，sandbox-core）→ 403 `sandbox_denied`，facade 先写一条 `sandbox.reject` 审计（`detail.op="write"`、`detail.relPath` 为 `uploads/` 加所给名字）。本步 SHALL 先于第 5 步，使越界的名字留下审计而不是被名字规则的 400 抢先；唯一的例外是长度：不含 `/` 且超过 255 个 UTF-8 字节的名字 SHALL 在本步之前即为 400 `bad_request`（不写审计、不触及文件系统）——`uploads` 已存在时对这样的名字 `lstat` 得到 `ENAMETOOLONG`，sandbox-core 对意外的元数据错误一律拒绝，否则一个只是太长的文件名会得到 403 与一条 `sandbox.reject`。
5. 名字规则：解析出的目标 SHALL 直接位于 `uploads` 目录之下（名字含 `/` 而成为嵌套路径 → 400）；名字 SHALL 为 1 到 255 个 UTF-8 字节，不含 U+0000–U+001F 与 U+007F，不以 `.upload-` 开头。违反 → 400 `bad_request`，不写审计、不触及文件系统。
6. 目录：`uploads` 不存在时经 `ensureSharedDir` 创建（mode `0o2770`，不写 `dir.create` 审计）；存在但不是普通目录 → 409 `conflict`。
7. 写入：在 `uploads` 内独占创建（目标路径已存在即失败、不跟随符号链接）一个名字以 `.upload-` 开头、以 `.part` 结尾、中间为随机十六进制串的临时文件，mode 精确为 `0660`（不受进程 umask 影响），把请求体流式写入并累计字节数。累计超过上限的那一刻 SHALL 停止读取请求体、删除临时文件，返回 413 `upload_too_large` 并写一条 `upload.reject` 审计（响应之后服务端可以关闭连接）。客户端中断、请求流出错或磁盘写入失败 SHALL 删除临时文件，不写审计；能响应时为 generic 500。
8. 定名：依次以候选名对临时文件做「目标不存在才创建」的原子链接——先是所给名字，被占用则 `<主名> (1)<扩展名>`、`<主名> (2)<扩展名>` …直到 `(999)`；成功后删除临时文件。全部被占用 → 删除临时文件，409 `conflict`。扩展名是名字里最后一个 `.` 及其之后的部分；名字没有 `.`、或唯一的 `.` 在开头时视为没有扩展名（编号接在末尾）。SHALL NOT 覆盖、截断或替换任何已存在的文件；并发上传同名文件 SHALL 各得不同的最终名。
9. 审计与响应：写一条 `file.upload` 审计，然后返回 201 `{path, name, size}`——`path` 为 `uploads/<最终名>`，`name` 为最终名，`size` 为写入的字节数。审计写入失败 → generic 500，不返回 201；此时文件可能已留在磁盘上（与新建目录的既有规则一致，不承诺文件系统回滚）。

审计事件（`core/audit` 既有 `emit`，`actorId` 为请求账号，`workspaceId` 为该空间 id）：成功为 `kind="file.upload"`、`title="上传文件 <path>"`、`detail={path, size}`；超限为 `kind="upload.reject"`、`title="上传被拒绝：文件超过大小上限"`、`detail={name, limit}`（`limit` 为上限字节数；`name` 为所给名字原文）。
成功写入的文件 SHALL 留在最终位置直到被别的操作移除：本端点不提供删除；消息行的删除与受理补偿、绑定正式工作空间的会话的删除都不删除它。它是工作空间里的普通文件，因此随工作空间一起变化的两种情形照常适用：空间是临时空间、且被删除的是最后一个引用它的会话时，文件随整个临时空间目录被删除（temporary-workspaces「共用与随最后一个会话删除」「临时空间目录的删除」）；撤回并连文件一起还原时，被撤回消息受理之后才上传的文件随工作空间回到那一刻的快照而被移除（workspace-snapshots「还原」）。临时文件在任何失败路径上 SHALL 被删除；进程异常终止时可能残留，不在本要求内清理。

#### Scenario: 上传并自动建目录
- **WHEN** zhangsan 对自有空间 W（根下没有 `uploads`）以 `Content-Type: application/octet-stream`、`name=报告.pdf`、3 字节的请求体上传
- **THEN** 201 `{path:"uploads/报告.pdf", name:"报告.pdf", size:3}` 与 no-store；`<W 的根>/uploads` 是 mode `0o2770` 的目录，其下 `报告.pdf` 是内容为那 3 字节、mode `0660` 的普通文件，没有 `.upload-` 开头的文件；`GET /api/audit` 新增一条 `file.upload`（`title="上传文件 uploads/报告.pdf"`、`detail={path:"uploads/报告.pdf", size:3}`、`workspaceId=W.id`），没有 `dir.create`；`GET /api/workspaces/W/tree?path=uploads` 列出该文件

#### Scenario: 临时空间同样可上传，并随最后一个会话删除
- **WHEN** zhangsan 以无 body 创建会话（得到临时空间 T），向 `POST /api/workspaces/<T>/uploads?name=a.txt` 上传 3 字节；第二个账号向同一 URL 上传；随后 zhangsan 删除该会话；另一例 zhangsan 向正式空间 W 上传 `a.txt` 后删除绑定 W 的会话
- **THEN** 第一次 201，文件位于 T 的根下 `uploads/a.txt`，审计 `file.upload` 的 `workspaceId` 为 `<T>`；第二个账号 404、没有文件；会话删除后 T 的目录连同 `uploads/a.txt` 不复存在；另一例 W 的 `uploads/a.txt` 仍在

#### Scenario: 同名自动编号不覆盖
- **WHEN** 依次上传三次 `name=a.pdf`（内容各不相同）、两次 `name=README`、两次 `name=.env`、两次 `name=archive.tar.gz`
- **THEN** 最终名依次为 `a.pdf`、`a (1).pdf`、`a (2).pdf`；`README`、`README (1)`；`.env`、`.env (1)`；`archive.tar.gz`、`archive.tar (1).gz`；每个文件的内容是它自己那次请求的字节，先上传的文件未被改动
- **WHEN** 同时发起两个 `name=b.txt` 的上传
- **THEN** 两者都 201，最终名一个是 `b.txt`、另一个是 `b (1).txt`，内容各自完整

#### Scenario: 超过大小上限
- **WHEN** `UPLOAD_MAX_BYTES=1024` 时，一个请求声明 `Content-Length: 1025`；另一个请求以分块传输编码发送 2000 字节（没有 `Content-Length`）；另一个请求恰发送 1024 字节
- **THEN** 前两者均为 413 `{error:{code:"upload_too_large",message:"文件超过大小上限"}}`（不是 400），`uploads` 下没有新文件也没有 `.part` 文件，各新增一条 `upload.reject` 审计（`detail={name, limit:1024}`）；第一个请求的请求体未被读取；第三个请求 201 且 `size=1024`

#### Scenario: 越界名字被拒绝并入审计
- **WHEN** 以 `name=../../etc/passwd`、`name=..`、含 NUL 字节的名字、`name=a\b.txt` 上传；另一例 `uploads` 是一个指向沙箱外目录的符号链接时以 `name=a.txt` 上传；再一例 `uploads/a.txt` 是符号链接时以 `name=a.txt` 上传
- **THEN** 每一个都是 403 `sandbox_denied`，各恰新增一条 `sandbox.reject`（`detail.op="write"`），没有 `file.upload`；沙箱外没有新文件，符号链接的目标未被改动；`uploads` 下没有 `.part` 文件

#### Scenario: 名字规则与媒体类型
- **WHEN** 以缺失的 `name`、重复两次的 `name`、空串、256 字节的名字（`uploads` 不存在与已存在各一例）、含换行的名字、`name=sub/a.txt`、`name=.upload-x.part` 上传；另以 `Content-Type: application/json` 或 `multipart/form-data` 上传
- **THEN** 均为 400 `bad_request` 与 no-store；没有文件、没有审计新增

#### Scenario: 他人与不存在的空间
- **WHEN** 第二个账号向第一个账号的空间上传（含越界的名字与超限的 `Content-Length`）；任一账号向随机 32 位 hex 的 id 上传；匿名请求上传
- **THEN** 前两者为逐字相同的 404 `not_found`，没有文件、没有审计新增，请求体未被消费；匿名为 401；第一个账号的 `uploads` 目录内容不变

#### Scenario: 中断与残留清理
- **WHEN** 一个真实 HTTP 客户端在发送了一半请求体后断开连接；另一例请求流在写入中途出错
- **THEN** `uploads` 下没有该文件的最终名，也没有 `.part` 文件；没有 `file.upload` 与 `upload.reject` 审计；服务端没有残留未释放的文件描述符或挂起的请求

#### Scenario: 不进内存的流式写入
- **WHEN** 上限设为 64 MiB，上传一个 32 MiB 的文件，测试在写入过程中采样服务进程的内存使用量（`process.memoryUsage()` 的 `heapUsed` 与 `arrayBuffers` 之和；请求体字节是 `Buffer`，不计入 `heapUsed`）
- **THEN** 201 且落盘内容与发送的字节逐字节相同；写入期间该使用量的增量远小于文件大小（测试给出的阈值为 8 MiB）

#### Scenario: 目录被占与审计失败
- **WHEN** 空间根下 `uploads` 是一个普通文件时上传；另一例成功写入后审计插入失败（测试注入）
- **THEN** 前者 409 `conflict`，没有新文件；后者为 generic 500 而不是 201
