## ADDED Requirements

### Requirement: 托管目录权限位
`core/sandbox/dirs.ts` SHALL 导出同步的 `ensureOwnedDir(absPath, mode)`：以非递归 `mkdir` 创建 `absPath`（`EEXIST` 不是错误，父目录缺失是错误），随后 `lstat` 它并要求它是目录（符号链接与其它类型一律拒绝）且 `uid` 等于本进程 effective uid；`mode & 0o7777` 不等于 `mode` 参数时 `chmod` 到该值，再次 `lstat` 并要求精确相等（setgid 被内核静默丢弃——例如本进程不在该目录的组里——同样是失败）。任何一步不满足 SHALL 抛出 `Error`，其 message 含该路径与期望的八进制 mode，不含环境变量值。它 SHALL NOT chown、不改进程 umask、不跟随符号链接、不触碰 `absPath` 以外的路径。与 `ensureSharedDir` 的区别是「每次校正到精确值并校验归属」而不是「只给新建分量设位」。

#### Scenario: 新建、校正与幂等
- **WHEN** 对不存在的 `<tmp>/d` 调 `ensureOwnedDir("<tmp>/d", 0o2750)`，再把它 `chmod 0o2777` 后以同参数调用，再调用一次
- **THEN** 三次之后 `mode & 0o7777` 都是 `0o2750`；第三次不发出 `chmod`

#### Scenario: 拒绝非目录、符号链接与缺失的父目录
- **WHEN** `absPath` 是普通文件、是指向目录的符号链接、或其父目录不存在
- **THEN** 抛错，message 含该路径；符号链接目标的 mode 不变

#### Scenario: 拒绝他人持有的目录
- **WHEN** 非 root 进程对一个 root 持有的既有目录（如 `/usr`）调 `ensureOwnedDir`（进程为 root 时该用例跳过）
- **THEN** 抛错，该目录 mode 不变

## MODIFIED Requirements

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录 `chmod 0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。`SANDBOX_ROOT/<ownerId>` 与每个工作空间根 SHALL 经它创建；`OMP_STATE_DIR` 下的目录不经它，而经「托管目录权限位」的 `ensureOwnedDir`（omp-runtime「OMP_STATE_DIR 托管布局」）。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`
