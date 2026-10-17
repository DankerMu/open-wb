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
`classifyPreview(absPath, name, size, options)` SHALL 只凭受信的文件名、大小与调用方传入的 `options` 判定，不做任何文件正文 IO；`options` 为 `{limits:{text,image,notebook}, sniffedText?:boolean}`，`limits` 由装配方给出（缺省 `1048576`、`20971520`、`10485760`，对应 `PREVIEW_TEXT_MAX_BYTES`、`PREVIEW_IMAGE_MAX_BYTES`、`PREVIEW_NOTEBOOK_MAX_BYTES`）。扩展名取文件名最后一个 `.` 之后并转小写；文件名没有 `.`，或唯一的 `.` 在开头（`.env`、`.gitignore`）时视为无扩展名。它 SHALL 返回 `{kind, contentType, truncated, limit, rangeable, headers}`，其中 `kind ∈ {text, image, audio, video, notebook}`，判定如下：

| 类别 | 扩展名（或文件名） | `contentType` | 上限 |
|---|---|---|---|
| `text` | `md` `txt` `log` `csv` `tsv` `json` `js` `mjs` `cjs` `jsx` `ts` `tsx` `html` `htm` `css` `scss` `py` `go` `rs` `java` `c` `h` `cpp` `sh` `sql` `yaml` `yml` `toml` `ini` `xml` `svg` `env`；文件名恰为 `Dockerfile` 或 `Makefile`；以及不在本表任何一行、且 `options.sniffedText === true` 的文件 | `text/plain; charset=utf-8` | `limit = min(size, limits.text)`，`size > limits.text` 时 `truncated` |
| `image` | `png`→`image/png`，`jpg`/`jpeg`→`image/jpeg`，`gif`→`image/gif`，`webp`→`image/webp`，`bmp`→`image/bmp`，`ico`→`image/x-icon` | 如左 | `size > limits.image` → `preview_too_large`；否则 `limit = size` |
| `audio` | `mp3`→`audio/mpeg`，`wav`→`audio/wav` | 如左 | 无；`limit = size`，`rangeable` |
| `video` | `mp4`→`video/mp4`，`webm`→`video/webm` | 如左 | 无；`limit = size`，`rangeable` |
| `notebook` | `ipynb` | `text/plain; charset=utf-8` | `size > limits.notebook` → `preview_too_large`（不截断：截断的 JSON 无法解析）；否则 `limit = size` |

`html`、`htm` 与 `svg` SHALL 永不以 `text/html`、`image/svg+xml` 或任何浏览器会当作文档渲染的类型返回。`pdf`、`docx`、`xlsx`、`pptx`、`zip`、`tar`、`gz`、`tgz` 不由本分类器提供正文（它们分别由 preview-origin、office-preview 与本规格「压缩包列表」提供），与其余未命中的名字一样 SHALL 抛出 canonical `HttpError("preview_unsupported")`；超限的图片与 Notebook SHALL 在读出任何正文字节之前抛出 `preview_too_large`（分类器自身不做 IO；路由为取权威大小已打开的描述符在分类抛出时随即关闭，见「文件预览」）。`headers` SHALL 含 `Content-Type`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store` 与十进制原始大小的 `X-Workbuddy-Size`；只有被截断的文本带 `X-Workbuddy-Truncated: 1`；`rangeable` 的类别另带 `Accept-Ranges: bytes`。

`sniffText(bytes)` SHALL 是纯函数：输入不含 `0x00` 字节，且去掉末尾至多 3 个属于一个未完整多字节序列的字节之后是合法 UTF-8 时返回 `true`；空输入返回 `true`；其余返回 `false`。`parseRange(header, size)` SHALL 是纯函数，只认单段 `bytes=<a>-<b>`、`bytes=<a>-` 与 `bytes=-<n>`（十进制、无空白）：返回闭区间 `{start, end}`（`end` 截到 `size-1`）；`a >= size`、`n` 为 0 或 `size` 为 0 时返回 `unsatisfiable`；多段、其它单位、无法解析或 `a > b` 时返回 `ignore`。两个读流 helper 接受的是**已打开的描述符**，不是路径（change sandbox-boundary-closure，owner B1/B5）：调用方先经 `openRegularFile(absPath)`（`server/src/workspaces/regular-file.ts`，所有读路由共用）以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开目标并对描述符 `fstat`——`ENOENT` / `ENOTDIR`（条目已不在）、`ELOOP`（末段是符号链接）、`ENXIO` 与 `EOPNOTSUPP`（末段是套接字；后者按 errno 数值识别）以及打开成功但 `fstat` 不是普通文件（命名管道、目录、设备——命名管道在 `O_NONBLOCK` 下会立即打开成功，靠这一步拒绝）一律关闭描述符并抛 canonical `HttpError("not_found")`，其它 `open` 错误原样抛；返回 `{fd, size}`，`size` 取自同一次 `fstat`。它只守末段：`resolve` / `lstat` 之后路径的中间目录分量被换成符号链接时 `open` 仍跟随它（书面残余，owner B1；见 ADR-0014 的 #1286 表）。`openPreviewStream({fd}, limit)` SHALL 至多产出 `limit` 个原始字节——`limit` 为 0 时 SHALL 关闭 `fd` 并返回空输出而不开流，否则以 `createReadStream(null, {fd, start: 0, end: limit - 1, autoClose: true})` 读；`openRangeStream({fd}, start, end)` SHALL 恰产出该闭区间的字节（`createReadStream(null, {fd, start, end, autoClose: true})`）；二者都不整文件缓冲、不解码、不再按路径打开任何东西，读错误原样传播，并在完成、出错或销毁时关闭该描述符。`sendFileRange(request, reply, {fd, size, headers, unsatisfiableHeaders})` 的 `size` SHALL 是那次 `fstat` 的值：416 时 SHALL 关闭 `fd`、空体；`HEAD` 时 SHALL 关闭 `fd`、给空流；其余把 `fd` 交给流。lstat 的大小 SHALL NOT 再出现在任何响应头里。

#### Scenario: 文本精确阈值与安全元数据
- **WHEN** 以缺省上限分类并流式读取 0 字节文本、恰 1 MiB、1 MiB+1 与 1.5 MiB 的 `log`，以及跨截断点含多字节 UTF-8 的 `html`、`htm` 与 `svg`
- **THEN** 字节等于原文件的有界前缀，0 字节为空；只有大于 1 MiB 的带截断头，`X-Workbuddy-Size` 为精确原始大小；`html`、`htm`、`svg` 的 `contentType` 都是 `text/plain; charset=utf-8`；全部元数据来自分类器

#### Scenario: 新增的文本扩展名与文件名
- **WHEN** 分类 `a.py`、`A.YAML`、`b.tsv`、`c.scss`、`x.env`、`Dockerfile`、`Makefile`，以及 `dockerfile`（小写）、`notes.proto`、`LICENSE`、`.gitignore`，后四个分别以 `sniffedText` 为 `true`、未提供、`false` 各分类一次
- **THEN** 前七个都是 `text`；后四个在 `sniffedText === true` 时是 `text`，未提供或为 `false` 时抛 `preview_unsupported`；全程没有对 `absPath` 的任何读取

#### Scenario: 图片大小与无正文拒绝
- **WHEN** 以缺省上限分类恰 20 MiB 与 20 MiB+1 的 `gif`、一个真实的 PNG 与 JPEG、一个 `webp`、一个 `ico`、一个 `zip`、恰 10 MiB 与 10 MiB+1 的 `ipynb`、一个 5 GiB 的 `mp4`、一个 `wav`；另以 `limits.image = 1024` 分类 2 KiB 的 `png`
- **THEN** 恰 20 MiB 的 `gif` 为 `image/gif`、`limit = size`；20 MiB+1 抛 `preview_too_large`；PNG 与 JPEG 的字节经流读出后与原文件完全一致、类型为 `image/png` 与 `image/jpeg` 并带安全头与大小头；`webp`、`ico` 为 `image/webp`、`image/x-icon`；`zip` 抛 `preview_unsupported`；被拒绝的分类都发生在读出任何正文字节之前，不产生部分成功的响应；恰 10 MiB 的 `ipynb` 为 `notebook`、不截断，10 MiB+1 抛 `preview_too_large`；`mp4` 为 `video/mp4`、`rangeable`、头含 `Accept-Ranges: bytes`、不抛错；`wav` 为 `audio/wav`；改小上限后的 `png` 抛 `preview_too_large`

#### Scenario: 由别处提供与不支持
- **WHEN** 分类 `a.pdf`、`b.docx`、`c.xlsx`、`d.pptx`、`e.zip`、`f.tar`、`g.tar.gz`、`h.tgz`，其中任何一个即使带 `sniffedText: true`；以及分类 `i.exe` 而 `sniffedText` 未提供或为 `false`
- **THEN** 都抛 `preview_unsupported`，没有正文被打开

#### Scenario: 嗅探与范围解析
- **WHEN** 对空输入、纯 ASCII、末尾截在一个三字节汉字第二个字节处的 UTF-8、含一个 `0x00` 的输入、GBK 编码的中文、PNG 文件头调用 `sniffText`；对 `size = 1000` 以 `bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=990-2000`、`bytes=1000-`、`bytes=-0`、`bytes=5-2`、`bytes=0-1,5-6`、`items=0-1`、`bytes= 0-1` 调用 `parseRange`
- **THEN** `sniffText` 依次为 `true`、`true`、`true`、`false`、`false`、`false`；`parseRange` 依次为 `{0,99}`、`{900,999}`、`{900,999}`、`{990,999}`、`unsatisfiable`、`unsatisfiable`、`ignore`、`ignore`、`ignore`、`ignore`

#### Scenario: 流关闭和错误
- **WHEN** 一个被允许的流（有界前缀或闭区间）被读完、在读完之前被销毁、或遇到真实的文件系统读错误（描述符已由调用方打开，helper 自身不再有打开错误；`EISDIR` 由以目录描述符开流造出）
- **THEN** 完成、关闭与错误遵循原生 `Readable` 的行为，传入的描述符被关闭；`openRangeStream({fd}, 10, 19)` 恰产出第 10–19 字节；`openPreviewStream({fd}, 0)` 不开流、返回空输出且描述符已关闭；不存在把错误静默变成空输出的回退

#### Scenario: 打开只认普通文件
- **WHEN** 对一个普通文件、一个命名管道（没有写端）、一个目录、一个指向普通文件的符号链接、一个已不存在的路径、一个 Unix 套接字各调一次 `openRegularFile`
- **THEN** 第一个返回 `{fd, size}` 且 `size` 等于文件大小；命名管道与目录各打开过一次、随即关闭、抛 `not_found`，命名管道一例在 1500ms 内返回；符号链接、不存在、套接字三例没有描述符留下、抛 `not_found`；没有任何字节被读出

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
`GET /api/workspaces/:id/file?path=<rel>` SHALL 经 `resolve(op=read)` 后：目标不存在或不是普通文件（`lstat`，不跟随符号链接）→ 404，不打开任何东西。随后 SHALL 以「预览分类元数据与有界字节流」的 `openRegularFile` 打开目标：`lstat` 之后被换成符号链接、命名管道、目录、套接字或已被删除的目标同样 → 404 `not_found`（不是 `sandbox_denied`、不写审计），描述符已关闭、零字节读出；此后分类、文本上限、截断头、`X-Workbuddy-Size`、`Content-Length` 与 `Range` 区间用的大小 SHALL 全部是打开那一刻 `fstat` 的 `size`，正文从该描述符读出——`lstat` 之后被截短或追加的文件按打开的 inode 应答，声明的长度与发出的字节一致。分类抛出（415 / 413）时 SHALL 关闭该描述符、不发送任何正文：已知扩展名的 415 / 413 零字节读出；嗅探后得到 415 时读出只限那至多 8192 字节。已知扩展名的文件因此每次请求恰被打开一次（为流），未知扩展名的嗅探 SHALL 从同一个描述符读前至多 8192 字节、不再按路径二次打开。打开之后路径被删除或替换，不影响本次响应：正文、`Content-Length` 与 `X-Workbuddy-Size` 仍来自已打开的 inode（change sandbox-boundary-closure）。随后按「预览分类元数据与有界字节流」判定；仅当文件名不在该条文表格的任何一行、也不在「由别处提供」的集合里时，路由 SHALL 先读取文件的前至多 8192 字节交给 `sniffText`，把结果作为 `sniffedText` 传给分类器——这是本路由在分类之前唯一的正文读取，已知扩展名的文件不发生。分类抛出的 `preview_unsupported` → 415，`preview_too_large` → 413，二者都不发送任何正文。

成功响应 SHALL 带分类器给出的全部头。`text` 与 `notebook` 以 `text/plain; charset=utf-8` 流式返回（`text` 超过文本上限时只返回前 `limit` 字节并带 `X-Workbuddy-Truncated: 1`）；`image` 以其 `image/*` 返回完整字节；空文件（0 字节）SHALL 200 空体且 `X-Workbuddy-Size: 0`。`audio` 与 `video` SHALL 支持单段范围请求：请求带 `Range` 且 `parseRange` 得到区间时，响应为 206，带 `Content-Range: bytes <start>-<end>/<size>`、`Content-Length` 为区间长度、`Accept-Ranges: bytes`，正文恰为该区间；得到 `unsatisfiable` 时为 416，带 `Content-Range: bytes */<size>`、空体（416 不属于 http-service-skeleton「统一错误信封」的 definition map，不带 JSON 信封）；得到 `ignore` 或请求不带 `Range` 时为 200 完整正文并带 `Content-Length`。其余类别 SHALL 忽略 `Range`。各上限来自装配方给出的 `limits`，路由自身不读环境变量。

#### Scenario: 文本、截断与 html
- **WHEN** 请求 `readme.md`（2 KB）、`big.log`（1.5 MiB）、`page.html`、`logo.svg`
- **THEN** `readme.md` 为 200 精确字节 + `text/plain; charset=utf-8` + `nosniff`；`big.log` 为 200 恰 1048576 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 1572864`；`page.html` 与 `logo.svg` 的 `content-type` 都是 `text/plain; charset=utf-8`

#### Scenario: 未知与无扩展名文件的嗅探
- **WHEN** 请求内容为 UTF-8 文本的 `LICENSE`、`.gitignore`、`schema.proto`，内容含 `0x00` 的 `blob.bin` 与无扩展名的 `core`，以及 0 字节的 `empty`
- **THEN** 前三个与 `empty` 为 200 `text/plain; charset=utf-8`（`empty` 为空体、`X-Workbuddy-Size: 0`）；`blob.bin` 与 `core` 为 415 `preview_unsupported`，二者读出的只有嗅探的那至多 8192 字节、描述符已关闭；对已知扩展名的 `readme.md` 请求不发生嗅探读取；被嗅探的文件每次请求只被打开一次，嗅探与流读的是同一个描述符，它恰被关闭一次（由流关闭）

#### Scenario: 图片与拒绝
- **WHEN** 请求 `logo.png`、`anim.gif`、`pic.webp`、21 MiB 的 `huge.png`、`doc.pdf`、`deck.pptx`、`archive.zip`、`out`（目录）
- **THEN** 依次为 200 `image/png` 精确字节、200 `image/gif`、200 `image/webp`、413 `preview_too_large`、415、415、415 `preview_unsupported`、404 `not_found`；413 与三个 415 各把文件同步打开过一次又关闭、没有读出任何字节；目录一例没有打开任何东西；每个 200 恰一次同步打开（流的），没有按路径的异步打开

#### Scenario: 音视频的范围请求
- **WHEN** 对 1000 字节的 `clip.mp4` 分别不带 `Range`、带 `Range: bytes=0-99`、`bytes=900-`、`bytes=-100`、`bytes=1000-`、`bytes=0-1,5-6` 请求；对 `readme.md` 带 `Range: bytes=0-9` 请求
- **THEN** 依次为 200（1000 字节、`video/mp4`、`Accept-Ranges: bytes`）、206（`Content-Range: bytes 0-99/1000`、100 字节且等于文件前 100 字节）、206（`bytes 900-999/1000`）、206（`bytes 900-999/1000`）、416（`Content-Range: bytes */1000`、空体）、200（完整正文）；`readme.md` 为 200 完整正文、无 `Content-Range`；所有响应都带 `nosniff` 与 `no-store`

#### Scenario: lstat 之后目标被换入
- **WHEN** 在路由对 `readme.md`（文本流路径）与 `clip.mp4`（带 `Range: bytes=0-99` 的范围路径）的 `lstat` 之后、打开之前（测试钩子包裹 `fs.openSync`），目标分别被换成：一个没有写端的命名管道；一个指向沙箱内另一账号文件的符号链接；一个目录
- **THEN** 六次都是 404 `not_found` 信封、`no-store`，正文不含被链接文件的内容；命名管道与目录各被打开一次又关闭，符号链接一次都没有打开成功；没有以这些描述符开流，没有读出任何字节；命名管道一例在 1500ms 内返回；审计表没有新增行

#### Scenario: 大小以打开的 inode 为准
- **WHEN** 在路由对 1000 字节的 `clip.mp4` 的 `lstat` 之后、打开之前，文件被截短为 600 字节；另一例在 `lstat` 之后被追加到 1400 字节；各不带 `Range` 请求一次，再对截短的那个带 `Range: bytes=900-` 请求一次
- **THEN** 前两次都是 200，`Content-Length` 与 `X-Workbuddy-Size` 分别为 600 与 1400、正文恰为对应字节；第三次为 416、`Content-Range: bytes */600`，文件被打开过一次并已关闭、没有读出字节

#### Scenario: Notebook 与可配置上限
- **WHEN** 请求 3 KB 的 `a.ipynb` 与 11 MiB 的 `big.ipynb`；另以 `limits.text = 16` 装配后请求 20 字节的 `t.txt`
- **THEN** `a.ipynb` 为 200 `text/plain; charset=utf-8` 精确字节、无截断头；`big.ipynb` 为 413 `preview_too_large`；`t.txt` 为 200 恰 16 字节 + `X-Workbuddy-Truncated: 1` + `X-Workbuddy-Size: 20`

### Requirement: 工作空间 HTTP 集成边界
registerWorkspaces(app,{store,sandbox,audit}) SHALL consume one canonical preconstructed store, facade and same-db bound synchronous audit emitter. Since change s1f-files-page the dependency object additionally accepts preconstructed `limits` (the preview limits, defaulting to the spec defaults when omitted), `trash` (file-operations) and optional `preview` (preview-origin); the routes those capabilities and「压缩包列表」add under `/api/workspaces/:id/` SHALL obey every rule of this requirement: guard-bound principal, earliest route-local no-store for all matched outcomes, identical 404 for foreign/missing ids before their paths are inspected and without audit or filesystem changes, a required scalar `path` (or body field) with a repeated `path` → 400. It SHALL use guard-bound principal and earliest route-local no-store for all matched outcomes. It SHALL NOT read configuration, duplicate store/domain validation or wire production bootstrap. POST body shapes SHALL reject wrong types/extra fields, nonJSON and >16KiB as canonical400. Tree default path SHALL be empty; file path SHALL be a required scalar string; repeated path SHALL be400. Typed foreign/missing scoped IDs SHALL be404 before inspecting their paths, without audit or filesystem changes. Structurally absent owned roots/targets/parents SHALL be404, not fake sandbox denials. An owned root whose path exists but is not a directory (a regular file or any other non-directory entry that is not a symbolic link) SHALL be answered 404 `not_found` by every route under `/api/workspaces/:id/`, `promote` included (a missing root does not block `promote`; an occupied one does) — for the other routes this is the same response as for a missing root (owner 2026-10-12, #1244) — decided before the request's path or body is inspected, with no audit row and no filesystem change; the entry occupying the root path is left untouched. For `POST /api/workspaces/:id/promote` (temporary-workspaces「转正」) this means no `workspace.promote` audit row is written and the workspace row keeps `temporary = 1` and its name (owner 2026-10-13). `GET /api/workspaces` SHALL list a workspace whose root path is occupied by such an entry exactly as it lists one whose root is missing — the same five keys, `root` being the same absolute path string — and SHALL NOT fail the listing (owner 2026-10-13). The other invalid persisted states of「工作空间 store 与惰性目录事务」— an unsafe owner path segment, an owner or workspace directory that is a symbolic link — still fail generically. Directory creation SHALL check existing immediate parent/absent target before calling the canonical helper, then emit dir.create with detail.path and return201 only after emission. Failed creation/emission SHALL be generic500; filesystem rollback is not promised for dir creation failures.

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
- WHEN a native preview stream fails before sending headers（change sandbox-boundary-closure 之后读流读的是处理器已打开的描述符，触发条件是对该描述符的读失败——测试在打开之后让对它的第一次 `fs.read` 以 `EIO` 回调；`lstat` 之后、打开之前条目消失走「文件预览」的 404，打开之后路径被删除或替换则照常从已打开的 inode 应答，都不再触发本例）, or a real HTTP client aborts an ongoing preview
- THEN error handling emits sanitized500/no-store before headers where possible（无 `Content-Range` 等范围头、不回显路径）, and Fastify destroys the aborted stream and releases its descriptor without a lingering request
- WHEN a stream fails after headers are sent
- THEN the response connection terminates; the server does not send a fabricated second JSON envelope

#### Scenario: 新增路由沿用同一边界
- **WHEN** 两个已认证账号对自己的、他人的与不存在的工作空间 id 请求 `archive`、`download`、`DELETE entries`、`move` 与 `preview-token`，其中对他人与不存在的 id 的请求带越界路径；另有未认证请求与重复的 `path` 查询参数
- **THEN** 他人与不存在的 id 一律是相同的 404，没有审计行与文件系统变化（越界路径没有被检查）；未认证为 401；重复 `path` 为 400；所有这些响应都带 `Cache-Control: no-store`

#### Scenario: 空间根被非目录占据
- **WHEN** 自有工作空间 W 的根目录被移走、同一路径上建出一个普通文件；owner 对 W 之下的每一条路由各请求一次（`tree`、新建目录、`file`、`archive`、`download`、`DELETE entries`、`move`、`preview-token`、上传），带路径的请求用越界路径 `../x`
- **THEN** 每一个应答都与 W 的根目录不存在时逐字相同：404 `not_found`、带 `Cache-Control: no-store`；审计没有新增行（越界路径没有被检查，没有 `sandbox.reject`）；占据根路径的那个文件原样未动，没有任何目录被创建，上传没有读取请求体
- **WHEN** 临时空间 T 的根路径被同样占据，owner `POST /api/workspaces/<T>/promote {"name":"调研资料"}`；对照例临时空间 T2 的根目录只是不存在，同样 promote
- **THEN** 前者 404 `not_found`、带 `Cache-Control: no-store`，审计没有新增 `workspace.promote`，T 的行仍是 `temporary = 1`、名字未变，`GET /api/workspaces` 不含它，占位文件原样未动；后者 200（根不存在不阻止转正，temporary-workspaces「转正」）
- **WHEN** 正式空间 W 的根路径被占据时 owner `GET /api/workspaces`；对照例 W 的根目录只是不存在
- **THEN** 两例都是 200，应答体逐字相同：列表含 W，其对象恰五键、`root` 为同一个绝对路径字符串；账号的其它空间照常列出
- **WHEN** 持有 W 的未过期预览令牌的请求访问预览监听器的 `/w/<token>/a.md`
- **THEN** 应答是预览监听器对「空间消失」的同一个 404（preview-origin「预览监听器」），不是 500
- **WHEN** W 的根路径是一个指向目录的符号链接
- **THEN** 同样的请求仍以 sanitized 500 结束（store 条文的通用失败），不返回链接目标之下的任何内容

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
5. 名字规则：解析出的目标 SHALL 直接位于 `uploads` 目录之下（名字含 `/` 而成为嵌套路径 → 400）；名字 SHALL 为 1 到 255 个 UTF-8 字节，不含 U+0000–U+001F 与 U+007F，也不含 U+0085、U+2028、U+2029 与双向控制字符 U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069（owner 2026-10-13，#1257：与 message-attachments「prompt 携带附件」第 1 条拒绝的是同一组码点，否则这样的文件传得上去、却不能作为附件发出），不以 `.upload-` 开头。违反 → 400 `bad_request`，不写审计、不触及文件系统。这条只管经本端点新上传的名字：磁盘上已有的、名字含这些码点的文件（此前上传的、助手写出的）仍照常可列举、可预览、可下载，SHALL NOT 因此被改名、隐藏或拒绝。
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
- **WHEN** 以缺失的 `name`、重复两次的 `name`、空串、256 字节的名字（`uploads` 不存在与已存在各一例）、含换行的名字、分别含 U+0085、U+2028、U+2029、U+061C、U+200E、U+202E、U+2066 的名字、`name=sub/a.txt`、`name=.upload-x.part` 上传；另以 `Content-Type: application/json` 或 `multipart/form-data` 上传
- **THEN** 均为 400 `bad_request` 与 no-store；没有文件、没有审计新增
- **WHEN** `uploads` 下已有一个名字含 U+202E 的文件（测试直接写盘），owner 请求 `tree?path=uploads`，并以该名字请求 `file` 与 `download`；另以一个含普通非 ASCII 字符的名字 `报告 v2.pdf` 上传
- **THEN** `tree` 列出该文件、名字逐码点原样，`file` 与 `download` 都是 200 且字节与磁盘上相同；`报告 v2.pdf` 的上传照常 201

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

### Requirement: 压缩包列表
`GET /api/workspaces/:id/archive?path=<rel>` SHALL 经 `resolve(op=read)` 后只读取压缩包的目录结构并返回 200 `{format, entries:[{path, type:'file'|'dir', size}], truncated}`，`no-store`；它 SHALL NOT 解压任何成员的内容、SHALL NOT 向文件系统写入任何东西。目标不存在或不是普通文件 → 404。按文件名（小写）判定格式：以 `.zip` 结尾 → `zip`；以 `.tar` 结尾 → `tar`；以 `.tar.gz` 或 `.tgz` 结尾 → `tar.gz`；其它以 `.gz` 结尾 → `gz`；都不是 → 415 `preview_unsupported`。

- `zip`：只读中央目录；`size` 为成员的未压缩大小；名字以 `/` 结尾的成员为 `dir`。未压缩大小（含 zip64 扩展字段给出的）大于 2^53−1（不是安全整数）的成员 SHALL NOT 计入结果，并按「读出若干项之后才损坏」处理——立即停止读取，返回已读到的项并置 `truncated:true`，此前一项都没读出时为 415 `preview_unsupported`；响应里的 `size` 因此只会是 `null` 或 0 到 2^53−1 之间的整数。
- `tar` 与 `tar.gz`（后者经流式 gunzip）：按 512 字节的头逐块读取，SHALL 认 ustar 的 `name` 与 `prefix`、GNU 长文件名记录（类型 `L`）与 pax 扩展头里的 `path` 记录；成员的正文一律跳过不读（未压缩的 `tar` 以定位跳过，`tar.gz` 以丢弃解压出的字节跳过）；类型为目录的成员为 `dir`，其它（含符号链接、设备等）为 `file`；`size` 取头里的大小。类型标志为 `1`–`6` 的成员（硬链接、符号链接、字符设备、块设备、目录、FIFO）没有正文：SHALL NOT 按其头里的大小跳过任何字节，下一个头紧随其后，条目的 `size` 仍取头里的值。`tar.gz` 的 gzip 容器由服务端自己解析：每个 gzip 流的头 SHALL 在一次至多 65536 字节的读取之内结束，否则按损坏处理。一个完整的 gzip 流结束之后：紧随其后的字节构成一个合法的 gzip 头时 SHALL 接着读下一个流，其解压输出接在前一个流之后（多成员 gzip，与解压工具一致）；否则这些字节 SHALL 被忽略——列表与去掉它们后的列表相同，`truncated` 不因此为 `true`。`gz`（恰一项）不读流的内容，流之后的字节与它无关。gzip 流自身损坏或未结束时的行为不变；条目上限、读取时限与各项读入上限对全部流合计适用。
- `gz`：恰一项，`path` 为去掉结尾 `.gz` 的文件名，`type:'file'`，`size:null`。

`entries` 按包内出现的次序，至多 `PREVIEW_ARCHIVE_MAX_ENTRIES`（缺省 1000，可配范围 `1..10000`，见 http-service-skeleton「服务启动与装配」）项：读到上限即停止读取并置 `truncated:true`；`zip`、`tar` 与 `tar.gz` 都另有同一个 5 秒的读取时限（时钟可注入），自开始读该压缩包起算（`zip` 含查找结束记录的读取），到时返回已读到的项并置 `truncated:true`——一项都没读到时是 200 与空的 `entries`，不是 415。时钟在读每个 tar 头之前、读每个 zip 中央目录项之前各读一次（`tar.gz` 另在每一步解压之前）；时限不打断一次已经发出的读取，一次请求的读取时长以「5 秒加一步」为界。`zip` 在结束记录或目录项上的损坏与时钟无关：一项都没读出时仍是 415。为取得成员名而读入内存的内容 SHALL 有硬上限（凡长度由头部字段**声明**的，按声明的长度在读取之前判定，见下）：单个扩展记录（GNU 类型 `L` 的长文件名记录、pax 扩展头）的声明长度至多 65536 字节，单个成员名（`zip` 中央目录里的成员名、ustar `prefix` 与 `name` 的拼接、`L` 记录或 pax `path` 给出的名字）至多 4096 字节；任一超出时，该记录或该成员 SHALL NOT 计入结果，并按「读出若干项之后才损坏」处理——立即停止读取，返回已读到的项并置 `truncated:true`，此前一项都没读出时为 415 `preview_unsupported`。凡长度由头部字段声明的（`L` 记录与 pax 扩展头的 `size` 字段），SHALL 在读入其内容之前按声明长度判定，超出即不读；成员名随所在记录一起读入的（`zip` 中央目录的成员名——中央目录项的各变长字段长度都是 2 字节，读入量以此为界；未超 65536 字节的 pax 记录里的 `path`；ustar `prefix` 与 `name` 的拼接）可在读入后判定，4096 字节的上限同样适用。`tar` 与 `tar.gz` 里为成员名与扩展记录做的单次读取因此都不超过 65536 字节；处理一个压缩包占用的内存有固定上界，与包内 4 字节或更宽的长度字段声明的任何长度无关。成员名 SHALL 原样作为 JSON 字符串返回（不合法的 UTF-8 序列替换为 U+FFFD），不做路径规范化、不与文件系统交互——含 `..` 或以 `/` 开头的成员名只是数据。包损坏到一项都读不出时 → 415 `preview_unsupported`；读出若干项之后才损坏时返回已读到的项并置 `truncated:true`。属他人或不存在的 `:id` → 404；越界路径 → 403 `sandbox_denied` + 审计。

#### Scenario: 三种格式的列表
- **WHEN** 请求一个含 `a.txt`（5 字节）、`dir/`、`dir/b.md`（7 字节）的 `x.zip`，同样内容的 `x.tar`、`x.tar.gz`、`x.tgz`，以及 `notes.txt.gz`
- **THEN** 前四个的 `entries` 都恰为 `[{path:"a.txt",type:"file",size:5},{path:"dir/",type:"dir",size:0},{path:"dir/b.md",type:"file",size:7}]`、`truncated:false`，`format` 依次为 `zip`、`tar`、`tar.gz`、`tar.gz`；`notes.txt.gz` 为 `{format:"gz",entries:[{path:"notes.txt",type:"file",size:null}],truncated:false}`；请求前后工作空间与临时目录里没有新增文件

#### Scenario: 上限与长文件名
- **WHEN** 请求含 1500 个成员的 `big.zip` 与 `big.tar.gz`；另以上限 3 装配后请求含 5 个成员的 `x.tar`；一个 tar 含一个 200 字符路径的成员（GNU 长文件名记录）与一个经 pax `path` 记录给出中文路径的成员
- **THEN** 前两个各恰 1000 项、`truncated:true`；第三个恰 3 项、`truncated:true`；长路径与中文路径完整出现在 `path` 里

#### Scenario: 声明超大的长文件名记录
- **WHEN** 请求 `evil.tar`（整个文件 1 KiB，第一个头是类型 `L` 的记录、其 `size` 字段声明 4 GiB）；`evil2.tar`（两个正常成员之后是一个声明 1 GiB 的 pax 扩展头）；`long.zip`（两个正常成员之后是一个成员名 5000 字节的成员）；`long2.tar`（一个正常成员之后是一个 `L` 记录给出 5000 字节名字的成员）；另以注入的时钟请求一个未压缩的 `slow.tar`，时钟在读出第 3 项之后越过 5 秒
- **THEN** 依次为 415 `preview_unsupported`、200 恰两项 + `truncated:true`、200 恰两项 + `truncated:true`、200 恰一项 + `truncated:true`、200 恰三项 + `truncated:true`；五例都在有界时间内返回；四个 tar 用例里为成员名与扩展记录做的单次读取都不超过 65536 字节（以注入的读取函数记录的最大读取长度为证），`entries` 里没有超过 4096 字节的 `path`

#### Scenario: zip 的读取时限
- **WHEN** 以注入的时钟请求含 5 个成员的 `slow.zip`，时钟在读第 3 个中央目录项的那次读取时越过 5 秒；同一文件，时钟在查找结束记录的那次读取时就越过 5 秒；同一文件，时钟停在 4999 毫秒
- **THEN** 依次为：恰三项 + `truncated:true`，第 4 个目录项所在的位置没有被读取；200、`entries` 为空 + `truncated:true`，没有读任何目录项；五项 + `truncated:false`

#### Scenario: zip64 声明的大小
- **WHEN** 请求 `safe.zip`（两个成员经 zip64 扩展字段给出大小 5368709120 与 9007199254740991）；`over.zip`（一个正常成员，其后是 zip64 大小为 9007199254740992 的成员，再后还有一个正常成员）；`over-first.zip`（第一个成员的 zip64 大小为 18446744073709551615）
- **THEN** 依次为：两项，`size` 恰为这两个数，`truncated:false`；恰一项 + `truncated:true`；415 `preview_unsupported`

#### Scenario: gzip 流之后的字节与没有正文的成员
- **WHEN** 请求 `tail.tgz`（三个成员与结束块压成的完整 gzip 流，后面跟 10 个非零字节）、同一内容后跟 300000 个非零字节的 `tail2.tgz`、含 3000 个成员后跟非零字节的 `bigtail.tgz`（上限放宽到不截断）；一个 `links.tar`，其成员依次为头里大小 1024 的目录（类型 `5`）、头里大小 2048 的硬链接（类型 `1`）、普通文件 `after.txt`，三个头彼此紧邻
- **THEN** 前两个都恰三项、`truncated:false`，与不带尾部字节时的结果相同；`bigtail.tgz` 恰 3000 项、`truncated:false`；`links.tar` 恰三项，前两项的 `size` 为 1024 与 2048，第三项为 `after.txt`，`truncated:false`

#### Scenario: 多成员 gzip
- **WHEN** 请求 `multi.tgz`（第一个 gzip 流是 `a.txt` 的头与正文、没有 tar 结束块，第二个 gzip 流是 `b.txt` 与结束块）、同一文件后跟 10 个非零字节的 `multi-tail.tgz`、一个 tar 按每 512 字节一个 gzip 流压成的 `blocks.tgz`（含三个成员与结束块），以及第二个流的头不合法（魔数对、压缩方法不是 8）的 `multi-bad.tgz`
- **THEN** 前三个依次恰为 `[a.txt, b.txt]`、`[a.txt, b.txt]`、三个成员，都是 `truncated:false`；`multi-bad.tgz` 恰为 `[a.txt]`、`truncated:true`（第二个流不被读取，tar 没有到结束块）

#### Scenario: 恶意成员名只是数据
- **WHEN** 压缩包的成员名为 `../../etc/passwd`、`/abs/x` 与含 `<script>` 的字符串
- **THEN** 它们原样出现在 `entries[].path` 里；服务端没有访问这些路径，工作空间外没有任何读写

#### Scenario: 拒绝与损坏
- **WHEN** 请求 `readme.md`、`out`（目录）、不存在的 `gone.zip`、内容不是 zip 的 `fake.zip`、头部完好但中途被截断的 `cut.tar`、`path=../x.zip`，以及他人工作空间里的 `x.zip`
- **THEN** 依次为 415、404、404、415、200（已读到的项 + `truncated:true`）、403 `sandbox_denied`（写一条 `sandbox.reject` 审计）、404
