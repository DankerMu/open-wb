## MODIFIED Requirements

### Requirement: 工作空间 HTTP 集成边界
registerWorkspaces(app,{store,sandbox,audit}) SHALL consume one canonical preconstructed store, facade and same-db bound synchronous audit emitter. Since change s1f-files-page the dependency object additionally accepts preconstructed `limits` (the preview limits, defaulting to the spec defaults when omitted), `trash` (file-operations) and optional `preview` (preview-origin); the routes those capabilities and「压缩包列表」add under `/api/workspaces/:id/` SHALL obey every rule of this requirement: guard-bound principal, earliest route-local no-store for all matched outcomes, identical 404 for foreign/missing ids before their paths are inspected and without audit or filesystem changes, a required scalar `path` (or body field) with a repeated `path` → 400. It SHALL use guard-bound principal and earliest route-local no-store for all matched outcomes. It SHALL NOT read configuration, duplicate store/domain validation or wire production bootstrap. POST body shapes SHALL reject wrong types/extra fields, nonJSON and >16KiB as canonical400. Tree default path SHALL be empty; file path SHALL be a required scalar string; repeated path SHALL be400. Typed foreign/missing scoped IDs SHALL be404 before inspecting their paths, without audit or filesystem changes. Structurally absent owned roots/targets/parents SHALL be404, not fake sandbox denials. An owned root whose path exists but is not a directory (a regular file or any other non-directory entry that is not a symbolic link) SHALL be treated as absent by every route under `/api/workspaces/:id/` (owner 2026-10-12, #1244): the response is the same 404 `not_found` as for a missing root, decided before the request's path or body is inspected, with no audit row and no filesystem change; the entry occupying the root path is left untouched. The other invalid persisted states of「工作空间 store 与惰性目录事务」— an unsafe owner path segment, an owner or workspace directory that is a symbolic link — still fail generically. Directory creation SHALL check existing immediate parent/absent target before calling the canonical helper, then emit dir.create with detail.path and return201 only after emission. Failed creation/emission SHALL be generic500; filesystem rollback is not promised for dir creation failures.

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

#### Scenario: 新增路由沿用同一边界
- **WHEN** 两个已认证账号对自己的、他人的与不存在的工作空间 id 请求 `archive`、`download`、`DELETE entries`、`move` 与 `preview-token`，其中对他人与不存在的 id 的请求带越界路径；另有未认证请求与重复的 `path` 查询参数
- **THEN** 他人与不存在的 id 一律是相同的 404，没有审计行与文件系统变化（越界路径没有被检查）；未认证为 401；重复 `path` 为 400；所有这些响应都带 `Cache-Control: no-store`

#### Scenario: 空间根被非目录占据
- **WHEN** 自有工作空间 W 的根目录被移走、同一路径上建出一个普通文件；owner 对 W 之下的每一条路由各请求一次（`tree`、新建目录、`file`、`archive`、`download`、`DELETE entries`、`move`、`preview-token`、上传），带路径的请求用越界路径 `../x`
- **THEN** 每一个应答都与 W 的根目录不存在时逐字相同：404 `not_found`、带 `Cache-Control: no-store`；审计没有新增行（越界路径没有被检查，没有 `sandbox.reject`）；占据根路径的那个文件原样未动，没有任何目录被创建，上传没有读取请求体
- **WHEN** 持有 W 的未过期预览令牌的请求访问预览监听器的 `/w/<token>/a.md`
- **THEN** 应答是预览监听器对「空间消失」的同一个 404（preview-origin「预览监听器」），不是 500
- **WHEN** W 的根路径是一个指向目录的符号链接
- **THEN** 同样的请求仍以 sanitized 500 结束（store 条文的通用失败），不返回链接目标之下的任何内容
