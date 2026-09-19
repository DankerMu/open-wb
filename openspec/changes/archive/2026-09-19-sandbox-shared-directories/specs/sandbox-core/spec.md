## ADDED Requirements

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录 `chmod 0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。`SANDBOX_ROOT/<ownerId>`、每个工作空间根、`OMP_STATE_DIR` 下由 app-server 创建的 `sessions/<ownerId>`、`home`、`agent` SHALL 全部经它创建。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`
