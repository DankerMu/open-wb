## ADDED Requirements

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
