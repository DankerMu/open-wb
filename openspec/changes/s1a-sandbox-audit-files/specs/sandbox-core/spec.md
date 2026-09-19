# Spec: sandbox-core

## ADDED Requirements

### Requirement: resolve 契约与逃逸向量
`core/sandbox` SHALL 提供纯函数 `resolve(root, relPath, op)`：`relPath` 为 `/` 分隔的相对路径（空串表示根），`op ∈ {read, list, mkdir}`。它 SHALL 在以下任一条件下返回 `{ok:false, reason}`：`relPath` 含 NUL 字节；以 `/` 开头；任一分量为 `..`；规范化后的目标不满足边界匹配 `target === realpath(root) || target.startsWith(realpath(root) + "/")`；从 root 起任一**已存在**分量经 `lstat` 为 symbolic link（不跟随任何 symlink）。否则返回 `{ok:true, absPath}`；`op=mkdir` 时 SHALL 额外要求最后一段非 `.`/`..`、不含反斜杠、非空。函数 SHALL 不创建、不读取目标内容。

#### Scenario: 逃逸向量全拒
- WHEN 对临时 root 分别 resolve `../x`、`a/../../x`、`/etc/passwd`、含 NUL 字节的 `a<NUL>b`、指向 root 外的 symlink 文件、symlink 目录下的子路径、悬空 symlink、以及 root 为 `<tmp>/a` 时的 `../ab/x`
- THEN 每一个都返回 `ok:false` 且 `reason` 非空；文件系统无任何新增条目

#### Scenario: 合法路径与边界
- WHEN resolve 空串、`a`、`a/b/c.md`（各级为普通目录/文件或尚不存在）
- THEN 返回 `ok:true` 且 `absPath` 位于 `realpath(root)` 之下；`op=mkdir` 对 `out`、`a/out` 成功，对 `a/.`、`a/..`、含反斜杠的 `a/b\c`、尾随斜杠的 `a/` 返回 `ok:false`

### Requirement: 沙箱 facade 与拒绝审计
`createSandbox({ rootOf, audit })` SHALL 返回 `{ resolve(principal, workspaceId, relPath, op), ensureSharedDir(absPath) }`。`rootOf(principal, workspaceId)` 是沙箱**自有端口**（`(principal, workspaceId) → absRoot | null`），由 `workspaces` 模块实现并在装配时注入；`core/sandbox` SHALL 不 import 任何 feature 模块。`rootOf` 返回 null SHALL 抛 `HttpError("not_found")`（不区分他人与不存在）。底层 `resolve` 拒绝时 facade SHALL 先 `audit.emit({kind:"sandbox.reject", actorId: principal.id, workspaceId, title:"越界访问被沙箱拦截", detail:{relPath, op, reason}})` 再抛 `HttpError("sandbox_denied")`；审计写入失败 SHALL 让请求以 5xx 失败而非放行。

#### Scenario: 拒绝自动入审计
- WHEN 已登录 zhangsan 对自己的空间请求 `tree?path=../..`
- THEN 响应 403 `sandbox_denied`；`audit_events` 新增一行 `kind=sandbox.reject`、`actor_id=u1`、`workspace_id=<id>`、`detail.relPath=../..`、`detail.op=list`

#### Scenario: 审计写入失败不放行
- WHEN 注入的 `audit.emit` 抛错（如审计表不可写），已登录用户请求越界路径
- THEN 响应为 5xx（不是 403 `sandbox_denied`），`audit_events` 无新增行，文件系统无副作用

#### Scenario: 他人空间不泄漏
- WHEN lisi 对 zhangsan 的空间 id 请求任一端点（含越界路径）
- THEN 404 `not_found` 且不写审计（rootOf 为 null 先于 resolve）

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录 `chmod 0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。`SANDBOX_ROOT/<ownerId>`、每个工作空间根、`OMP_STATE_DIR` 下由 app-server 创建的 `sessions/<ownerId>`、`home`、`agent` SHALL 全部经它创建。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`
