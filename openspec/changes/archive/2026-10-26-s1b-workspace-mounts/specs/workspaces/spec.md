# workspaces Spec Delta

> s1b-workspace-mounts：以主规格为底。「目录树、新建目录与隔离」加挂载判定（离线 409 `mount_offline`、只读挂载内新建目录 403 `mount_read_only`，判定位于 `resolve` 之后、存在性检查之前；在线挂载内经异步适配器，挂载内的 `dirs` 不经 `ensureSharedDir`、不 `chmod`；根一层不列出已登记挂载的挂载点），加一个场景（design D16、D21）。工作空间对象与「列表与创建」不变（挂载经 workspace-mounts「挂载端点」单独读取）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 目录树、新建目录与隔离
`GET /api/workspaces/:id/tree?path=<rel>` SHALL 经 `resolve(op=list)` 后只列举**该一层**：`{path, entries:[{name, type:'dir'|'file', size, mtime}]}`，目录在前、同类按 UTF-8 字节序，跳过 symlink 与非普通文件；`path` 缺省空串，服务端按 URL 解码后的字符串交给 `resolve`（不做额外规范化）；目标不存在或非目录 → 404。`POST /api/workspaces/:id/dirs` body `{path:string}`（≤16 KiB，归属集）经 `resolve(op=mkdir)`：父目录不存在或非目录 → 404，目标已存在 → 409 `conflict`，成功创建（`0o2770`）+ `emit(dir.create, title "新建目录 <path>")` → 201 `{path}`。属他人或不存在的 `:id` SHALL 对全部端点一律 404 `not_found`。越界路径 → 403 `sandbox_denied` + 审计（sandbox-core）。路径在该空间的已登记挂载内（第一段规则见 workspace-mounts「挂载目录内的文件端点」）时，`tree` 与 `dirs` SHALL 在 `resolve` 之后、存在性检查之前先判定：挂载离线 → 409 `mount_offline`；`dirs` 的路径在只读挂载内 → 403 `mount_read_only`；均不访问文件系统、不写 `dir.create` 审计；通过时在线挂载内的文件系统调用经 workspace-mounts「宿主不同步进入挂载」的异步适配器；挂载内的 `dirs` 只由适配器 `mkdir`、不 `chmod`，新目录的模式由挂载决定，上文的 `0o2770` 只对挂载之外成立。空间根一层的 `tree` SHALL NOT 列出该空间已登记挂载的挂载点（按名字跳过、不对其 `lstat`）（change s1b-workspace-mounts）。全部响应 `no-store`。

#### Scenario: 懒加载列举
- WHEN 空间根下有 `out/`（含 `a.md`）、`b.txt`、一个 symlink 与一个 FIFO，请求 `tree`
- THEN `entries` 恰为 `out(dir)`、`b.txt(file)`，不含 `a.md`；`tree?path=out` 恰为 `a.md`

#### Scenario: 新建目录
- WHEN `POST dirs {path:"out/新目录"}` 两次，再 `POST dirs {path:"missing/x"}`、`POST dirs {path:"../x"}`
- THEN 依次 201、409 `conflict`、404 `not_found`、403 `sandbox_denied`（后者写审计）；`out/新目录` mode `0o2770`

#### Scenario: 离线与只读挂载
- **WHEN** 空间有离线挂载 `远端` 与在线只读挂载 `参考`；请求 `tree`、`tree?path=远端`、`tree?path=远端/sub`、`POST dirs {path:"远端/新"}`、`tree?path=参考`、`POST dirs {path:"参考/新"}`
- **THEN** 根一层的 `entries` 不含 `远端` 与 `参考`；`tree?path=远端` 与 `tree?path=远端/sub` 都是 409 `mount_offline`；`POST dirs` 到 `远端/新` 为 409 `mount_offline`；`tree?path=参考` 为 200 并列出挂载内容；`POST dirs` 到 `参考/新` 为 403 `mount_read_only`；两次被拒的 `dirs` 都没有目录被建出、没有 `dir.create` 审计
