# Spec: workspaces

## ADDED Requirements

### Requirement: 工作空间 schema 与惰性沙箱根
迁移 `031_workspaces.sql` SHALL 建立 `workspaces(id TEXT PK 32 lowercase hex, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL CHECK 长度 1..64 且不含 U+0000–U+001F 与 U+007F, dir TEXT NOT NULL CHECK 只含 ASCII 字母数字、下划线、连字符与 CJK 统一表意文字且长度 1..64 且 NOT IN ('.','..'), created_at INTEGER NOT NULL)`，`UNIQUE(owner_id, name)`、`UNIQUE(owner_id, dir)`。工作空间根目录 SHALL 为 `<SANDBOX_ROOT>/<owner_id>/<dir>`。账号沙箱根 `<SANDBOX_ROOT>/<owner_id>` SHALL 在首次工作空间创建时经 `ensureSharedDir` 惰性幂等创建，启动期不预建。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 迁移与唯一性
- WHEN 同一 owner 两次插入同 `name` 或同 `dir`，或 `dir` 为 `..`/含 `/`
- THEN 均被约束拒绝；不同 owner 同名允许

### Requirement: 列表与创建
`GET /api/workspaces` SHALL 返回本账号空间按 `created_at, id` 升序 `{workspaces:[{id,name,dir,root,createdAt}]}`（`root` 为绝对路径字符串）。`POST /api/workspaces` SHALL 只接受 `application/json` body `{name:string, dir?:string}`（≤16 KiB，归属 content-parser 集）：`name` trim 后 1..64 且不含 U+0000–U+001F/U+007F；`dir` 缺省由 `name` 把不属于「ASCII 字母数字、下划线、连字符、CJK」的字符逐个替换为 `-` 派生（demo `newWorkspaceModal` 同法；派生结果为空、`.`、`..` 亦 400），显式给出时须满足 schema 规则；违反 → 400 `bad_request`（body 校验层，不触及文件系统、不写审计——design D2 边界判定）；`(owner,name)` 或 `(owner,dir)` 冲突 → 409 `conflict`，不建目录。成功 SHALL 在一个事务内插行并依次 `ensureSharedDir(沙箱根)`、`ensureSharedDir(root)`（目录已存在则直接采用）、`emit(workspace.create, title "创建工作空间 <name>")`，任一步失败回滚；返回 201 `{id,name,dir,root,createdAt}`，`no-store`。

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
