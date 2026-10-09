# workspaces Specification

## Purpose
定义账号隔离的工作空间持久化 schema、保持Unicode名称身份的同步 store、惰性目录与失败补偿、单层列举/有界原始预览，以及六个带认证、审计、隔离与安全响应头的 REST 端点；另有文件上传端点 `POST /api/workspaces/:id/uploads`（原始字节流、流式写入工作空间根下的 `uploads` 目录、同名自动编号、大小上限）；生产启动装配由后续切片补充。

## Requirements

### Requirement: 工作空间 schema
迁移 `031_workspaces.sql` SHALL 建立 `workspaces(id TEXT PK 32 lowercase hex, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL CHECK 长度 1..64 且不含 U+0000–U+001F 与 U+007F, dir TEXT NOT NULL CHECK 只含 ASCII 字母数字、下划线、连字符与 CJK 统一表意文字且长度 1..64 且 NOT IN ('.','..'), created_at INTEGER NOT NULL)`，`UNIQUE(owner_id, name)`、`UNIQUE(owner_id, dir)`。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 迁移与唯一性
- WHEN 同一 owner 两次插入同 `name` 或同 `dir`，或 `dir` 为 `..`/含 `/`
- THEN 均被约束拒绝；不同 owner 同名允许

### Requirement: 单层目录列举辅助
`listOneLevel(absDir)` SHALL return only direct ordinary file/directory entries `{name,type:'dir'|'file',size,mtime}` from non-following metadata. size SHALL be native byte size and mtime SHALL be epoch milliseconds. Directories SHALL precede files; names within each category SHALL use UTF-8 byte order, not locale or UTF-16 order. Symlinks including dangling links and all special files SHALL be omitted; nested descendants SHALL NOT be traversed. Metadata/read-directory errors SHALL propagate rather than yield a fabricated empty result.

#### Scenario: 真实一层与类型过滤
- WHEN a directory contains out/ with a.md, b.txt, symlinks to a file/directory/missing target and a FIFO
- THEN root listing contains exactly out(dir) and b.txt(file), while explicitly listing out yields a.md; no symlink/FIFO content is opened

#### Scenario: 字节序与元数据单位
- WHEN retained names include numeric lexical strings, CJK, U+E000 and U+10000, with known file byte contents and mtime
- THEN directories remain first and each group follows explicit UTF-8 order, size is bytes and mtime is the expected epoch-ms value without name normalization

### Requirement: 预览分类元数据与有界字节流
`classifyPreview(absPath,ext,size)` SHALL decide from trusted extension/size metadata without filesystem body IO. Allowed bare extensions case-normalized to lowercase SHALL be md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg. It SHALL return kind, contentType, truncated, limit and production-owned headers for the preview route; unsupported names SHALL throw canonical HttpError(preview_unsupported). Text contentType SHALL be text/plain; charset=utf-8 and limit=min(size,1048576), truncated iff size>1048576. Images SHALL be image/png or image/jpeg, untruncated with limit=size, but size>10485760 SHALL throw preview_too_large before content opening. Headers SHALL include Content-Type, nosniff, no-store and original decimal X-Workbuddy-Size; only truncated text SHALL include X-Workbuddy-Truncated:1. `openPreviewStream(absPath,limit)` SHALL yield at most limit raw bytes, zero as empty output, without whole-file buffering/decoding, propagate read errors and release file resources on completion/error/destroy.

#### Scenario: 文本精确阈值与安全元数据
- WHEN classifying and streaming zero-byte text, exact1MiB,1MiB+1 and1.5MiB log or html containing multibyte UTF8 across the cutoff
- THEN bytes equal the original bounded prefix, zero is empty, only sizes above1MiB set truncated header, original X-Workbuddy-Size remains exact, and html is never text/html; all metadata comes from the production classifier

#### Scenario: 图片大小与无正文拒绝
- WHEN a real PNG/JPEG is within10MiB or exactly10MiB, or an image is10MiB+1/11MiB, or extension is zip
- THEN allowed image bytes remain exact with correct image type and security/size metadata; rejected classifications throw preview_too_large or preview_unsupported with no body open/read, not a partial successful response

#### Scenario: 流关闭和错误
- WHEN a permitted stream is consumed, destroyed before completion, or encounters a real filesystem read/open error
- THEN completion/close/error follow native Readable behavior and owned descriptors are released; no silent error-to-empty fallback is introduced

### Requirement: 工作空间 store 与惰性目录事务
`createWorkspaceStore(db,{sandboxRoot,ensureSharedDir,emit})` SHALL expose synchronous list(ownerId), create(principal,{name,dir?}), and rootOf(principal,workspaceId). list SHALL return only the owner's non-temporary (`temporary = 0`, migration 038) workspace objects {id,name,dir,root,createdAt}, ordered created_at then id ascending; rootOf SHALL return an owned absolute root or null for foreign/missing rows, and SHALL NOT distinguish temporary rows from ordinary ones. The store SHALL additionally expose the temporary-workspace operations specified by temporary-workspaces (creation inside the session-create transaction, promotion, and removal together with the last session using it); they SHALL share create's directory-ensure and compensation code rather than duplicate it, and create's own contract below is unchanged. Reads SHALL NOT create directories. Root paths SHALL remain below the trusted pre-provisioned sandboxRoot without accepting unsafe owner path segments or existing owner/workspace symlinks. Those invalid persisted/configuration states SHALL fail generically without filesystem mutation, not become conflict or an unaudited sandbox_denied.

#### Scenario: owner scope 与稳定排序
- WHEN legal rows exist for two owners with differing and tied signed created_at values
- THEN each list contains only its owner's five-field rows in created_at,id order; rootOf returns only owned roots, otherwise null; no account directories are created by reads

#### Scenario: 名称边界和精确派生
- WHEN creating a trimmed name '智能 客服/重构' without dir
- THEN derived dir is '智能-客服-重构'; invalid trimmed name/control characters or explicit empty/unsafe dir yield bad_request before row/filesystem/audit mutation
- WHEN a name contains non-BMP characters or CJK boundary values
- THEN name length follows SQLite code-point count, directory derivation follows the demo's non-u regex exactly, and derived/explicit dir still obeys the schema alphabet and64limit
- WHEN a name contains an isolated high or low UTF-16 surrogate
- THEN create rejects it as bad_request before any row/filesystem/audit mutation, including when a literal U+FFFD name already exists; it does not normalize the input into an existing name or report conflict
- WHEN a valid supplementary character or literal U+FFFD name is accepted
- THEN create, list, the stored name and audit title preserve that same name unchanged

#### Scenario: 创建和采用
- WHEN a valid workspace is created under a pre-provisioned sandbox base
- THEN one owned SQLite transaction inserts a32lowercasehexid row, lazily ensures owner root then workspace root with the canonical helper, emits workspace.create with actor/workspace/title/detail.root on the same db, and commits before returning the five-field workspace
- WHEN the workspace root is already an ordinary directory
- THEN its files and permissions remain unchanged; new owner/workspace directories have mode2770

#### Scenario: 冲突不触及目录
- WHEN the same owner repeats a name or dir
- THEN create throws canonical conflict before any ensureSharedDir or audit action; other owners may use the same name/dir
- WHEN unrelated primary-key, FK, audit constraint or commit failures occur
- THEN they are not mislabeled conflict and no successful result is returned

#### Scenario: 失败补偿与已有数据保护
- WHEN directory creation fails before or after creating a path, or audit/COMMIT fails after directories were created
- THEN the owned workspace/audit transaction rolls back and newly created empty account/workspace directories are removed in reverse order; adopted directories, files and modes remain unchanged; original failure propagates when compensation succeeds
- WHEN rollback or safe empty-directory removal itself fails
- THEN rollback failure is retained while eligible reverse-order empty-directory compensation still runs; one AggregateError has errors [original, rollbackError?, ...cleanupErrors] and cause original. The failed rollback may leave an active transaction and uncommitted rows visible; row absence is not promised in that failure state. Nonempty/adopted/symlink/file paths are never recursively deleted or falsely reported cleaned.

#### Scenario: 调用方事务与路径边界
- WHEN create is called inside a transaction already owned by the caller
- THEN it fails before any mutation and does not commit/rollback the caller's transaction
- WHEN persisted owner id contains a path separator, traversal component or NUL, or an owner/workspace directory is a symlink
- THEN no outside path is returned/adopted/created or removed, and no workspace/create event is committed

#### Scenario: 列表不含临时空间
- **WHEN** an owner has two ordinary rows and one row with `temporary = 1`
- **THEN** list returns exactly the two ordinary five-field objects in created_at,id order, while rootOf returns the owned root for all three ids and null for the same ids under another owner

### Requirement: 列表与创建
`GET /api/workspaces` SHALL 返回本账号的**非临时**空间（`temporary = 0`；临时空间见 temporary-workspaces，它们不出现在本列表，文件页因此不列出）按 `created_at, id` 升序 `{workspaces:[{id,name,dir,root,createdAt}]}`（`root` 为绝对路径字符串）；工作空间对象恰为这五键，不含 `temporary`。`POST /api/workspaces` 创建的行 `temporary` 恒为 0。`POST /api/workspaces` SHALL 只接受 `application/json` body `{name:string, dir?:string}`（≤16 KiB，归属 content-parser 集）：`name` trim 后 1..64 Unicode scalar，拒绝孤立 UTF16 surrogate 且不含 U+0000–U+001F/U+007F，保留合法 supplementary 与字面 U+FFFD 不变；`dir` 缺省由 `name` 把不属于「ASCII 字母数字、下划线、连字符、CJK」的字符逐个替换为 `-` 派生（demo `newWorkspaceModal` 同法；派生结果为空、`.`、`..` 亦 400），显式给出时须满足 schema 规则；违反 → 400 `bad_request`（body 校验层，不触及文件系统、不写审计——design D2 边界判定）；`(owner,name)` 或 `(owner,dir)` 冲突 → 409 `conflict`，不建目录。成功 SHALL 在一个事务内插行并依次 `ensureSharedDir(沙箱根)`、`ensureSharedDir(root)`（目录已存在则直接采用）、`emit(workspace.create, title "创建工作空间 <name>")`，任一步失败回滚；返回 201 `{id,name,dir,root,createdAt}`，`no-store`。

#### Scenario: 创建与派生
- WHEN zhangsan `POST {name:"智能 客服/重构"}`
- THEN 201，`dir === "智能-客服-重构"`，磁盘存在 `<SANDBOX_ROOT>/u1/智能-客服-重构` 且 mode `0o2770`，`<SANDBOX_ROOT>/u1` 亦为 `0o2770`；`audit_events` 有 `workspace.create`；再次同名 → 409 `conflict`

#### Scenario: 采用既有目录
- WHEN 磁盘已存在 `<SANDBOX_ROOT>/u1/smoke-fixture` 且表中无记录，`POST {name:"smoke-fixture"}`
- THEN 201 且既有文件保留；既有目录权限不被改动

#### Scenario: 临时空间不在列表里，转正后出现
- **WHEN** zhangsan 有正式空间 `项目A`，并以无 body 的 `POST /api/sessions` 得到一个用临时空间 T 的会话，随后 `GET /api/workspaces`；再对 T 调用 `POST /api/workspaces/<T>/promote {"name":"调研资料"}` 后重新读取
- **THEN** 第一次列表恰含 `项目A`，每个对象恰五键；第二次列表依次含 `项目A` 与 `调研资料`（其 `dir` 为 `tmp-<T>`）

### Requirement: 目录树、新建目录与隔离
`GET /api/workspaces/:id/tree?path=<rel>` SHALL 经 `resolve(op=list)` 后只列举**该一层**：`{path, entries:[{name, type:'dir'|'file', size, mtime}]}`，目录在前、同类按 UTF-8 字节序，跳过 symlink 与非普通文件；`path` 缺省空串，服务端按 URL 解码后的字符串交给 `resolve`（不做额外规范化）；目标不存在或非目录 → 404。`POST /api/workspaces/:id/dirs` body `{path:string}`（≤16 KiB，归属集）经 `resolve(op=mkdir)`：父目录不存在或非目录 → 404，目标已存在 → 409 `conflict`，成功创建（`0o2770`）+ `emit(dir.create, title "新建目录 <path>")` → 201 `{path}`。属他人或不存在的 `:id` SHALL 对全部端点一律 404 `not_found`。越界路径 → 403 `sandbox_denied` + 审计（sandbox-core）。全部响应 `no-store`。

#### Scenario: 懒加载列举
- WHEN 空间根下有 `out/`（含 `a.md`）、`b.txt`、一个 symlink 与一个 FIFO，请求 `tree`
- THEN `entries` 恰为 `out(dir)`、`b.txt(file)`，不含 `a.md`；`tree?path=out` 恰为 `a.md`

#### Scenario: 新建目录
- WHEN `POST dirs {path:"out/新目录"}` 两次，再 `POST dirs {path:"missing/x"}`、`POST dirs {path:"../x"}`
- THEN 依次 201、409 `conflict`、404 `not_found`、403 `sandbox_denied`（后者写审计）；`out/新目录` mode `0o2770`

### Requirement: 文件预览
`GET /api/workspaces/:id/file?path=<rel>` SHALL 经 `resolve(op=read)` 后按扩展名（小写）判定：不在 `{md,txt,log,csv,json,js,ts,tsx,html,png,jpg,jpeg}` → 415 `preview_unsupported`（不读文件）；目标不存在或非普通文件 → 404。文本类 SHALL 以 `Content-Type: text/plain; charset=utf-8`（`html` 亦然）、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`X-Workbuddy-Size: <总字节>` 流式返回，超过 1 MiB 只返回前 1 MiB 并加 `X-Workbuddy-Truncated: 1`。`png`/`jpg`/`jpeg` SHALL 以对应 `image/*` 返回，同样带 `X-Workbuddy-Size`、`nosniff`、`no-store`，总字节 > 10 MiB → 413 `preview_too_large`（不读正文）。空文件（0 字节）SHALL 200 空体且 `X-Workbuddy-Size: 0`。

#### Scenario: 文本、截断与 html
- WHEN 请求 `readme.md`（2 KB）、`big.log`（1.5 MiB）、`page.html`
- THEN 前者 200 精确字节 + `text/plain; charset=utf-8` + `nosniff`；`big.log` 200 恰 1048576 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 1572864`；`page.html` 的 `content-type` 为 `text/plain; charset=utf-8` 而非 `text/html`

#### Scenario: 图片与拒绝
- WHEN 请求 `logo.png`、11 MiB 的 `huge.png`、`archive.zip`、`out`（目录）
- THEN 依次 200 `image/png` 精确字节、413 `preview_too_large`、415 `preview_unsupported`、404 `not_found`

### Requirement: 工作空间 HTTP 集成边界
registerWorkspaces(app,{store,sandbox,audit}) SHALL consume one canonical preconstructed store, facade and same-db bound synchronous audit emitter. It SHALL use guard-bound principal and earliest route-local no-store for all matched outcomes. It SHALL NOT read configuration, duplicate store/domain validation or wire production bootstrap. POST body shapes SHALL reject wrong types/extra fields, nonJSON and >16KiB as canonical400. Tree default path SHALL be empty; file path SHALL be a required scalar string; repeated path SHALL be400. Typed foreign/missing scoped IDs SHALL be404 before inspecting their paths, without audit or filesystem changes. Structurally absent owned roots/targets/parents SHALL be404, not fake sandbox denials. Directory creation SHALL check existing immediate parent/absent target before calling the canonical helper, then emit dir.create with detail.path and return201 only after emission. Failed creation/emission SHALL be generic500; filesystem rollback is not promised for dir creation failures.

#### Scenario: 完整真实装配与隔离
- WHEN two authenticated accounts use collection GET/POST and the three scoped routes on owned, foreign and missing IDs, including unsafe typed paths
- THEN collection ownership follows the principal, only scoped owned paths can access FS, and foreign/missing scoped responses are identical404 with no audit/FS delta
- WHEN an unauthenticated request or malformed/nonJSON/oversized body reaches one of these routes
- THEN guard/parser/domain precedence returns canonical401/400 and no-store before handler effects

#### Scenario: 原始路径与结构不存在
- WHEN a decoded path contains duplicate slashes/dot components or percent-literal names, or descends below an ordinary file
- THEN the original string reaches resolver once without extra decoding/normalization; safe existing paths return the same path string, while ordinary-file descendants are404 without sandbox.reject
- WHEN an owned workspace root is missing or an immediate mkdir parent is absent/non-directory
- THEN the response is404, no roots/parents are created, and no rejection audit is fabricated

#### Scenario: 审计失败不伪成功
- WHEN genuine SQLite audit insertion fails on a sandbox denial or after successful mkdir
- THEN response is sanitized500/no-store, no false403/201 is returned; rejected access remains denied, while the mkdir directory may remain without an event
- WHEN workspace store ROLLBACK itself fails
- THEN response is sanitized500/no-store, not success; the store's documented active/uncommitted residual state is not silently committed or represented as clean

#### Scenario: 流错误与真实客户端中止
- WHEN a native preview stream fails before sending headers, or a real HTTP client aborts an ongoing preview
- THEN error handling emits sanitized500/no-store before headers where possible, and Fastify destroys the aborted stream and releases its descriptor without a lingering request
- WHEN a stream fails after headers are sent
- THEN the response connection terminates; the server does not send a fabricated second JSON envelope

### Requirement: 绝对 root 不属于对浏览器保密的信息
按 ADR-0011，`GET /api/workspaces` 与 `POST /api/workspaces` 201 响应中工作空间对象的 `root`（`<SANDBOX_ROOT>/<ownerId>/<dir>` 绝对路径）以及 `workspace.create` 审计事件的 `detail.root` SHALL 保持原样返回给已认证的本人（审计对 admin 全量可见），不删除、不改写；它们不属于保密信息。界面呈现 SHALL 仍以逻辑路径 `<account>/<dir>` 为主，files 页、外壳、标题与 aria 属性不渲染 `root`（files-web）。凭证与他人账号的路径和内容不在本条放宽范围内。

#### Scenario: root 原样返回本人
- **WHEN** 已认证用户列出或创建自己的工作空间，并读取本人的审计事件
- **THEN** 响应中的 `root` 与 `workspace.create` 事件的 `detail.root` 为该空间的绝对路径原文，他人的工作空间不出现在列表中

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
