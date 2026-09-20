# workspaces Specification

## Purpose
定义账号隔离的工作空间持久化 schema、保持Unicode名称身份的同步 store、惰性目录与失败补偿，以及受信任路径上的单层目录列举、预览安全元数据和有界原始字节流；REST 授权联动和生产装配由后续切片补充。
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

