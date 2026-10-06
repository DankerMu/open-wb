## MODIFIED Requirements

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
