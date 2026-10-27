## MODIFIED Requirements

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录设为 `0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。新建分量的权限 SHALL 经不跟随符号链接的句柄设置，绝不按路径 `chmod`：`mkdir` 之后以 `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` 打开该分量，对句柄 `fstat` 确认它是目录且属本进程 euid，再 `fchmod`（句柄确认的是「本进程 euid 所有的真实目录」，而不是「刚建出的那个 inode」），句柄在所有路径上关闭；打开失败（该分量已被换成符号链接时为 `ENOTDIR` 或 `ELOOP`，依平台而定）或校验不符时 SHALL 抛出固定文本的错误（errno 放在 `cause`），不对任何目标改 mode（#1782；`OMP_USER` 模式下 omp uid 可在 `mkdir` 与设权限之间对调父目录里的条目）。`SANDBOX_ROOT/<ownerId>` 与每个工作空间根 SHALL 经它创建；`SANDBOX_ROOT` 自身不由它建立——它在服务启动时经「沙箱根目录」的 `ensureSandboxRoot` 建出并校正为 `0o3770`，惰性路径再经本函数时它已存在、不被改动（只有不经启动入口的直接调用方——测试装配与直接调用 `spawnOmp`——仍可能由本函数以 `0o2770` 建出根）；`OMP_STATE_DIR` 下的目录不经它，而经「托管目录权限位」的 `ensureOwnedDir`（omp-runtime「OMP_STATE_DIR 托管布局」）。父级分量在 `mkdir` 之前被换成链接不在本条范围内（ADR-0012 已接受残余）。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`

#### Scenario: 已建出的沙箱根不被惰性路径改动
- WHEN 根已由 `ensureSandboxRoot` 建为 `0o3770`，随后 `ensureSharedDir("<root>/u1/ws")`
- THEN `u1` 与 `u1/ws` 为 `0o2770`，根仍为 `0o3770`

#### Scenario: 新建分量在设权限前被换成链接
- WHEN 注入的文件系统在 `mkdir("<tmp>/p/x")` 成功之后把 `x` 换成指向 `<tmp>/target`（`0o700`）的符号链接
- THEN `ensureSharedDir("<tmp>/p/x")` 抛出，`cause.code` 为 `ENOTDIR` 或 `ELOOP`；`<tmp>/target` 的 mode 仍为 `0o700`；打开过的句柄均已关闭

#### Scenario: 新建分量不属本进程 uid
- WHEN 注入的 `fstat` 对新建分量报告与 `process.geteuid()` 不同的 uid
- THEN `ensureSharedDir` 抛出，不调用 `fchmod`，句柄已关闭
