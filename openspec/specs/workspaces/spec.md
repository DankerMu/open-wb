# workspaces Specification

## Purpose
定义账号隔离的工作空间持久化 schema、保持Unicode名称身份的同步 store、惰性目录与失败补偿、单层列举/有界原始预览，以及五个带认证、审计、隔离与安全响应头的 REST 端点；生产启动装配由后续切片补充。
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
`classifyPreview(absPath,ext,size)` SHALL decide from trusted extension/size metadata without filesystem body IO. Allowed bare extensions case-normalized to lowercase SHALL be md/txt/log/csv/json/js/ts/tsx/html/png/jpg/jpeg. It SHALL return kind, contentType, truncated, limit and production-owned headers for the future route; unsupported names SHALL throw canonical HttpError(preview_unsupported). Text contentType SHALL be text/plain; charset=utf-8 and limit=min(size,1048576), truncated iff size>1048576. Images SHALL be image/png or image/jpeg, untruncated with limit=size, but size>10485760 SHALL throw preview_too_large before content opening. Headers SHALL include Content-Type, nosniff, no-store and original decimal X-Workbuddy-Size; only truncated text SHALL include X-Workbuddy-Truncated:1. `openPreviewStream(absPath,limit)` SHALL yield at most limit raw bytes, zero as empty output, without whole-file buffering/decoding, propagate read errors and release file resources on completion/error/destroy.

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
`createWorkspaceStore(db,{sandboxRoot,ensureSharedDir,emit})` SHALL expose synchronous list(ownerId), create(principal,{name,dir?}), and rootOf(principal,workspaceId). list SHALL return only owner's workspace objects {id,name,dir,root,createdAt}, ordered created_at then id ascending; rootOf SHALL return an owned absolute root or null for foreign/missing rows. Reads SHALL NOT create directories. Root paths SHALL remain below the trusted pre-provisioned sandboxRoot without accepting unsafe owner path segments or existing owner/workspace symlinks. Those invalid persisted/configuration states SHALL fail generically without filesystem mutation, not become conflict or an unaudited sandbox_denied.

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

### Requirement: 列表与创建
`GET /api/workspaces` SHALL 返回本账号空间按 `created_at, id` 升序 `{workspaces:[{id,name,dir,root,createdAt}]}`（`root` 为绝对路径字符串）。`POST /api/workspaces` SHALL 只接受 `application/json` body `{name:string, dir?:string}`（≤16 KiB，归属 content-parser 集）：`name` trim 后 1..64 Unicode scalar，拒绝孤立 UTF16 surrogate 且不含 U+0000–U+001F/U+007F，保留合法 supplementary 与字面 U+FFFD 不变；`dir` 缺省由 `name` 把不属于「ASCII 字母数字、下划线、连字符、CJK」的字符逐个替换为 `-` 派生（demo `newWorkspaceModal` 同法；派生结果为空、`.`、`..` 亦 400），显式给出时须满足 schema 规则；违反 → 400 `bad_request`（body 校验层，不触及文件系统、不写审计——design D2 边界判定）；`(owner,name)` 或 `(owner,dir)` 冲突 → 409 `conflict`，不建目录。成功 SHALL 在一个事务内插行并依次 `ensureSharedDir(沙箱根)`、`ensureSharedDir(root)`（目录已存在则直接采用）、`emit(workspace.create, title "创建工作空间 <name>")`，任一步失败回滚；返回 201 `{id,name,dir,root,createdAt}`，`no-store`。

#### Scenario: 创建与派生
- WHEN zhangsan `POST {name:"智能 客服/重构"}`
- THEN 201，`dir === "智能-客服-重构"`，磁盘存在 `<SANDBOX_ROOT>/u1/智能-客服-重构` 且 mode `0o2770`，`<SANDBOX_ROOT>/u1` 亦为 `0o2770`；`audit_events` 有 `workspace.create`；再次同名 → 409 `conflict`

#### Scenario: 采用既有目录
- WHEN 磁盘已存在 `<SANDBOX_ROOT>/u1/smoke-fixture` 且表中无记录，`POST {name:"smoke-fixture"}`
- THEN 201 且既有文件保留；既有目录权限不被改动

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

