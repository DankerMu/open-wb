## MODIFIED Requirements

### Requirement: resolve 契约与逃逸向量
`core/sandbox` SHALL 提供纯函数 `resolve(root, relPath, op)`：`relPath` 为 `/` 分隔的相对路径（空串表示根），`op ∈ {read, list, mkdir, write, delete, move}`（`delete` 与 `move` 由 change s1f-files-page 加入）。它 SHALL 在以下任一条件下返回 `{ok:false, reason}`：`relPath` 含 NUL 字节；以 `/` 开头；任一分量为 `..`；规范化后的目标不满足边界匹配 `target === realpath(root) || target.startsWith(realpath(root) + "/")`；从 root 起任一**已存在**分量经 `lstat` 为 symbolic link（不跟随任何 symlink）。否则返回 `{ok:true, absPath}`；`op` 为 `mkdir`、`write`、`delete` 或 `move` 时 SHALL 额外要求最后一段非 `.`/`..`、不含反斜杠、非空——空串（空间根本身）因此对这四种 `op` 被拒绝，根不能被删除、移动或作为移动的目标。`op=write` 表示调用方将在目标位置创建一个文件（本 change 的文件上传）；它的词法与边界规则与 `mkdir` 完全相同，同样不判定目标或其父目录是否存在、是否为目录——那由调用方在授权之后判定。其它 change 需要写文件的解析时 SHALL 复用 `op=write`，不另立同义的 op。`op=delete` 与 `op=move` 表示调用方将把目标条目移走或改名（file-operations；移动的源与目标各解析一次，都用 `move`），它们的词法与边界规则同样与 `mkdir` 完全相同，目标是否存在、是什么类型由调用方在授权之后判定；s1f-files-page 不使用 `op=write`。函数 SHALL 不创建、不读取目标内容。

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
