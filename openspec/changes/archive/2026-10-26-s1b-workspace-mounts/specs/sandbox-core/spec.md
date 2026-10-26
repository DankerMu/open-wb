# sandbox-core Spec Delta

> s1b-workspace-mounts：以主规格为底（逐字沿用，含全部场景标题）。「resolve 契约与逃逸向量」加可选的挂载名集合：第一段是已登记挂载名时不对其下做任何文件系统调用、返回带 `mount` 的结果，加一个场景；「沙箱 facade 与拒绝审计」加可选端口 `mountNamesOf`，加一个场景（design D21：宿主不同步进入挂载）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: resolve 契约与逃逸向量
`core/sandbox` SHALL 提供纯函数 `resolve(root, relPath, op)`：`relPath` 为 `/` 分隔的相对路径（空串表示根），`op ∈ {read, list, mkdir, write, delete, move}`（`delete` 与 `move` 由 change s1f-files-page 加入）。它 SHALL 在以下任一条件下返回 `{ok:false, reason}`：`relPath` 含 NUL 字节；以 `/` 开头；任一分量为 `..`；规范化后的目标不满足边界匹配 `target === realpath(root) || target.startsWith(realpath(root) + "/")`；从 root 起任一**已存在**分量经 `lstat` 为 symbolic link（不跟随任何 symlink）。否则返回 `{ok:true, absPath}`；`op` 为 `mkdir`、`write`、`delete` 或 `move` 时 SHALL 额外要求最后一段非 `.`/`..`、不含反斜杠、非空——空串（空间根本身）因此对这四种 `op` 被拒绝，根不能被删除、移动或作为移动的目标。`op=write` 表示调用方将在目标位置创建一个文件（本 change 的文件上传）；它的词法与边界规则与 `mkdir` 完全相同，同样不判定目标或其父目录是否存在、是否为目录——那由调用方在授权之后判定。其它 change 需要写文件的解析时 SHALL 复用 `op=write`，不另立同义的 op。`op=delete` 与 `op=move` 表示调用方将把目标条目移走或改名（file-operations；移动的源与目标各解析一次，都用 `move`），它们的词法与边界规则同样与 `mkdir` 完全相同，目标是否存在、是什么类型由调用方在授权之后判定；s1f-files-page 不使用 `op=write`。函数 SHALL 不创建、不读取目标内容。（change s1b-workspace-mounts）`resolve` 另接受可选的第四个参数 `mountNames`（该 root 下已登记挂载的名字集合，缺省为空集）。路径的**第一段**定义为把 `relPath` 按 `/` 分割、去掉空段与 `.` 段之后的第一个分量（`core/sandbox` 导出这个函数，workspace-mounts 的挂载判定用同一个）。第一段属于 `mountNames` 时，`resolve` SHALL NOT 对该段及其下的任何分量做 `lstat` 或其它文件系统调用，NUL、绝对路径、`..`、末段与边界规则照旧，通过时返回 `{ok:true, absPath, mount:<该名字>}`，`absPath` 是 `realpath(root)` 与各分量的词法拼接；其余路径的行为与返回值不变（不带 `mount` 键）。调用方 SHALL 在以这样的 `absPath` 访问文件系统之前经 workspace-mounts「挂载目录内的文件端点」「宿主不同步进入挂载」判定。

#### Scenario: 逃逸向量全拒
- WHEN 对临时 root 分别 resolve `../x`、`a/../../x`、`/etc/passwd`、含 NUL 字节的 `a<NUL>b`、指向 root 外的 symlink 文件、symlink 目录下的子路径、悬空 symlink、以及 root 为 `<tmp>/a` 时的 `../ab/x`
- THEN 每一个都返回 `ok:false` 且 `reason` 非空；文件系统无任何新增条目

#### Scenario: 合法路径与边界
- WHEN resolve 空串、`a`、`a/b/c.md`（各级为普通目录/文件或尚不存在）
- THEN 返回 `ok:true` 且 `absPath` 位于 `realpath(root)` 之下；`op=mkdir` 对 `out`、`a/out` 成功，对 `a/.`、`a/..`、含反斜杠的 `a/b\c`、尾随斜杠的 `a/` 返回 `ok:false`；`op=write` 对 `a.pdf`、`uploads/a.pdf`、`uploads/图 (1).png`（`uploads` 存在或尚不存在）成功，对 `uploads/.`、`uploads/..`、含反斜杠的 `uploads/a\b`、尾随斜杠的 `uploads/` 返回 `ok:false`；`op=delete` 与 `op=move` 对 `a`、`a/b/c.md` 成功，对空串、`a/.`、`a/..`、`a/b\c`、`a/` 同样返回 `ok:false`

路径安全检查 SHALL distinguish structural absence from unsafe/uninspectable metadata: ENOENT and ENOTDIR below an already inspected non-symlink component SHALL allow continued lexical/boundary validation; they do not assert that a target exists or is a directory. Other metadata errors SHALL remain rejection. HTTP callers SHALL decide existence/type separately after authorization.

#### Scenario: 非目录祖先不是越界
- WHEN an ordinary file exists at regular-file and resolve receives regular-file/child for read/list/mkdir/write/delete/move
- THEN it returns a safe absolute path without filesystem mutation; HTTP metadata handling can return404 instead of falsely auditing sandbox.reject
- WHEN such a suffix also includes .., or an actual symlink or unexpected metadata error is encountered
- THEN the original rejection rules still apply and no path access is authorized

#### Scenario: 写操作的逃逸向量
- **WHEN** 对临时 root 以 `op=write` 分别 resolve `uploads/../../x`、`../x`、`/etc/passwd`、含 NUL 字节的 `uploads/a<NUL>b`；`uploads` 是指向 root 外目录的 symlink 时的 `uploads/a.pdf`；`uploads/a.pdf` 本身是 symlink（指向 root 内或 root 外）时的 `uploads/a.pdf`
- **THEN** 每一个都返回 `ok:false` 且 `reason` 非空；文件系统无任何新增条目，symlink 的目标未被读取或改动

#### Scenario: 删除与移动的逃逸向量
- **WHEN** 以 `op=delete` 与 `op=move` 分别 resolve `../x`、`a/../../x`、`/etc/passwd`、含 NUL 字节的路径、指向 root 外的 symlink 文件、symlink 目录下的子路径、悬空 symlink，以及空串
- **THEN** 每一个都返回 `ok:false` 且 `reason` 非空；文件系统没有任何条目被新增、改名或删除

#### Scenario: 挂载名分量不被检查
- **WHEN** 临时 root 下 `远端` 是一个指向 root 外目录的符号链接（若被 `lstat` 即被拒），以 `mountNames = {远端}` 分别 resolve `远端`、`远端/a/b.md`、`./远端/a`、`远端//a`（`op=read`）与 `远端/a`（`op=move`），再 resolve `远端/../x`、`远端/a/`（`op=mkdir`）与 `远端备份/a`（`远端备份` 是另一个指向 root 外的符号链接）；另以空的 `mountNames` resolve `远端/a`
- **THEN** 前五个返回 `ok:true`、`mount` 为 `远端`、`absPath` 为 `<realpath(root)>/远端` 之下的词法拼接；`远端/../x`、`远端/a/` 与 `远端备份/a` 返回 `ok:false`；以空集 resolve 的 `远端/a` 照旧因符号链接返回 `ok:false`；文件系统无任何新增条目

### Requirement: 沙箱 facade 与拒绝审计
`createSandbox({rootOf,audit})` SHALL expose synchronous `resolve(principal,workspaceId,relPath,op)` returning the permitted absolute path and the existing `ensureSharedDir(absPath)`. The rootOf port SHALL be core-owned and receive the supplied principal unchanged; its synchronous result SHALL be absolute root or null. core/sandbox SHALL NOT import feature modules. A null root SHALL throw canonical HttpError(not_found) before path inspection and SHALL NOT emit audit. A rejected underlying resolve SHALL synchronously complete `audit.emit({kind:"sandbox.reject",actorId:principal.id,workspaceId,title:"越界访问被沙箱拦截",detail:{relPath,op,reason}})` before throwing canonical HttpError(sandbox_denied). The audit port SHALL use the existing synchronous numeric-returning core/audit event contract. Audit/lookup errors SHALL propagate unchanged with no successful path or filesystem mutation; generic HTTP failure mapping belongs to the later route integration.（change s1b-workspace-mounts）`createSandbox` 另接受可选端口 `mountNamesOf(workspaceId)`：同步返回该空间已登记挂载的名字集合，缺省视为空集；facade 在 rootOf 返回非 null 之后调用它，并把结果作为 `mountNames` 交给 `resolve`；返回值仍只是绝对路径（调用方经同一个第一段函数判定挂载成员）。该端口抛出的错误 SHALL 原样传播，不放行、不写审计。facade 另暴露只读的 `mountNamesOf(workspaceId)`，原样转交该端口的结果（未给端口时为空集），供经 facade 取路径的各入口（根层 `tree`、预览源、会话附件、撤回、文件变更归属）取同一来源的挂载名。

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

#### Scenario: 挂载名端口
- **WHEN** `mountNamesOf` 对该空间返回 `{远端}`、`远端` 是若被 `lstat` 即被拒的符号链接，facade resolve `远端/a.md`；另一例 `mountNamesOf` 抛出哨兵错误；再一例不传该端口而 resolve 同一路径
- **THEN** 第一例返回 `<realpath(root)>/远端/a.md`、不写 `sandbox.reject`；第二例调用方收到同一个哨兵错误，没有审计、没有路径放行；第三例照旧写一条 `sandbox.reject` 并抛 `sandbox_denied`
