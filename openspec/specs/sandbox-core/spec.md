# sandbox-core Specification

## Purpose
Define the app-server sandbox boundary: metadata-only relative-path resolution rejecting traversal and symbolic links, shared-directory creation permissions, and a synchronous owner-root facade that completes rejection audit before denial and propagates port failures without granting access.
## Requirements
### Requirement: resolve 契约与逃逸向量
`core/sandbox` SHALL 提供纯函数 `resolve(root, relPath, op)`：`relPath` 为 `/` 分隔的相对路径（空串表示根），`op ∈ {read, list, mkdir}`。它 SHALL 在以下任一条件下返回 `{ok:false, reason}`：`relPath` 含 NUL 字节；以 `/` 开头；任一分量为 `..`；规范化后的目标不满足边界匹配 `target === realpath(root) || target.startsWith(realpath(root) + "/")`；从 root 起任一**已存在**分量经 `lstat` 为 symbolic link（不跟随任何 symlink）。否则返回 `{ok:true, absPath}`；`op=mkdir` 时 SHALL 额外要求最后一段非 `.`/`..`、不含反斜杠、非空。函数 SHALL 不创建、不读取目标内容。

#### Scenario: 逃逸向量全拒
- WHEN 对临时 root 分别 resolve `../x`、`a/../../x`、`/etc/passwd`、含 NUL 字节的 `a<NUL>b`、指向 root 外的 symlink 文件、symlink 目录下的子路径、悬空 symlink、以及 root 为 `<tmp>/a` 时的 `../ab/x`
- THEN 每一个都返回 `ok:false` 且 `reason` 非空；文件系统无任何新增条目

#### Scenario: 合法路径与边界
- WHEN resolve 空串、`a`、`a/b/c.md`（各级为普通目录/文件或尚不存在）
- THEN 返回 `ok:true` 且 `absPath` 位于 `realpath(root)` 之下；`op=mkdir` 对 `out`、`a/out` 成功，对 `a/.`、`a/..`、含反斜杠的 `a/b\c`、尾随斜杠的 `a/` 返回 `ok:false`

路径安全检查 SHALL distinguish structural absence from unsafe/uninspectable metadata: ENOENT and ENOTDIR below an already inspected non-symlink component SHALL allow continued lexical/boundary validation; they do not assert that a target exists or is a directory. Other metadata errors SHALL remain rejection. HTTP callers SHALL decide existence/type separately after authorization.

#### Scenario: 非目录祖先不是越界
- WHEN an ordinary file exists at regular-file and resolve receives regular-file/child for read/list/mkdir
- THEN it returns a safe absolute path without filesystem mutation; HTTP metadata handling can return404 instead of falsely auditing sandbox.reject
- WHEN such a suffix also includes .., or an actual symlink or unexpected metadata error is encountered
- THEN the original rejection rules still apply and no path access is authorized

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录 `chmod 0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。`SANDBOX_ROOT/<ownerId>`、每个工作空间根、`OMP_STATE_DIR` 下由 app-server 创建的 `sessions/<ownerId>`、`home`、`agent` SHALL 全部经它创建。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`

### Requirement: 沙箱 facade 与拒绝审计
`createSandbox({rootOf,audit})` SHALL expose synchronous `resolve(principal,workspaceId,relPath,op)` returning the permitted absolute path and the existing `ensureSharedDir(absPath)`. The rootOf port SHALL be core-owned and receive the supplied principal unchanged; its synchronous result SHALL be absolute root or null. core/sandbox SHALL NOT import feature modules. A null root SHALL throw canonical HttpError(not_found) before path inspection and SHALL NOT emit audit. A rejected underlying resolve SHALL synchronously complete `audit.emit({kind:"sandbox.reject",actorId:principal.id,workspaceId,title:"越界访问被沙箱拦截",detail:{relPath,op,reason}})` before throwing canonical HttpError(sandbox_denied). The audit port SHALL use the existing synchronous numeric-returning core/audit event contract. Audit/lookup errors SHALL propagate unchanged with no successful path or filesystem mutation; generic HTTP failure mapping belongs to the later route integration.

#### Scenario: 不可见根先于路径检查
- WHEN rootOf returns null and the requested relPath is an escape attempt
- THEN resolve throws canonical not_found, emits no audit and does not inspect or modify a target path; missing and foreign roots have the same result

#### Scenario: 合法路径与原有目录助手
- WHEN rootOf yields a real temporary root and resolve receives a legal nested read/list path
- THEN resolve returns its canonical absolute path, no rejection event is emitted, and no filesystem entry is created
- WHEN ensureSharedDir is called through the facade for new nested directories below an existing parent
- THEN new directories have mode2770 and the existing parent's mode and contents remain unchanged

#### Scenario: 真正拒绝先完成审计
- WHEN a permitted root receives traversal or a real symlink path that the existing resolver rejects
- THEN exactly one sandbox.reject event records the actor, workspace, original relPath/op and nonempty reason before the caller receives sandbox_denied; no target content or directory is created

#### Scenario: 端口失败不放行
- WHEN audit.emit throws a sentinel error during rejection
- THEN the caller receives that same error rather than sandbox_denied or a successful path, and filesystem state remains unchanged
- WHEN rootOf throws a sentinel error
- THEN that same error propagates and no audit event or path side effect occurs

