## ADDED Requirements

### Requirement: 沙箱根目录
`ensureSandboxRoot(configuredPath, {strict})` SHALL 在服务启动时建立并校正 `SANDBOX_ROOT` 自身（owner 2026-10-16 B2/B3/B4），返回 `{root, outcome}`：
1. `configuredPath` 缺失时以递归 `mkdir` 建出它及缺失的父级，父级的权限位不改（与 omp-runtime「OMP_STATE_DIR 托管布局」对 `<state>` 的做法相同）；
2. 取 `configuredPath` 的内核 realpath 作为 `root`——`SANDBOX_ROOT` 自身可以是运维放置的、指向目录的符号链接，建立、校正与属主检查都作用于真实目录；此后 store、spawn 与 argv 仍使用配置值；
3. `root` 不是目录（普通文件或其它类型占位）时 SHALL 抛出，`strict` 与否都一样；
4. 对 `root` 以「托管目录权限位」的 `ensureOwnedDir(root, 0o3770)` 校正：必须属本进程 uid，`mode & 0o7777` 精确为 `0o3770`（setgid + 粘滞位 + 属主/组 rwx，其他人无权限），chmod 之后复查（内核静默丢掉 setgid 同样算失败）；`strict` 为真时它的任何失败 SHALL 原样抛出；为假时 SHALL 捕获并返回 `outcome: "unchanged"`，根的 mode 与属主原样留下；
5. 成功时 `outcome` 为 `"ok"`。它 SHALL NOT chown、SHALL NOT 改进程 umask、SHALL NOT 触碰 `root` 之下的任何条目。

`strict` 由调用方按「`OMP_USER` 已配置」给出（http-service-skeleton「服务启动与装配」的 `sandbox_root` 阶段）。粘滞位使 omp uid 不能改名、删除或替换 `root` 之下由应用 uid 建出的条目（`.trash`、账号根），只能新建自己的；`.trash` 各级与账号根的既有逐级校验（file-operations）不因此放松。

#### Scenario: 冷建与校正
- **WHEN** 对一个不存在的路径调 `ensureSandboxRoot(path, {strict: true})`；对一个预先为 `0o2770` 的目录与一个预先为 `0o755` 的目录各调一次；对已是 `0o3770` 的目录再调一次
- **THEN** 四次都返回 `outcome: "ok"`，`root` 的 `mode & 0o7777` 都是 `0o3770`、属主为本进程 uid、属组未变；最后一次没有发出 chmod；进程 umask 未变；`root` 之下没有新增条目

#### Scenario: 根是符号链接或被占位
- **WHEN** `path` 是指向既有目录 `D` 的符号链接；另一例 `path` 的位置是一个普通文件
- **THEN** 前者返回的 `root` 等于 `D` 的 realpath、`D` 被校正为 `0o3770`、链接本身不变；后者在 `strict` 为真与为假时都抛出，文件字节与 mode 不变

#### Scenario: 属主不符或 chmod 被拒
- **WHEN** `root` 属别的 uid（测试以 `sandbox-dirs` 既有造法构造），或对 `root` 的 `chmodSync` 被替换为抛 `EPERM`
- **THEN** `strict: true` 时抛出，错误文本不含任何环境变量的值；`strict: false` 时返回 `outcome: "unchanged"`，`root` 的 mode 与属主与调用前相同，没有第二次 chmod

## MODIFIED Requirements

### Requirement: 共享目录权限位
`ensureSharedDir(absPath)` SHALL 递归创建目录，并对本次**新建**的每一级目录 `chmod 0o2770`（setgid + 属主/组 rwx，其他人无权限）；已存在目录的权限 SHALL 不改动；不调用 chown、不改进程 umask。`SANDBOX_ROOT/<ownerId>` 与每个工作空间根 SHALL 经它创建；`SANDBOX_ROOT` 自身不由它建立——它在服务启动时经「沙箱根目录」的 `ensureSandboxRoot` 建出并校正为 `0o3770`，惰性路径再经本函数时它已存在、不被改动（只有不经启动入口的直接调用方——测试装配与直接调用 `spawnOmp`——仍可能由本函数以 `0o2770` 建出根）；`OMP_STATE_DIR` 下的目录不经它，而经「托管目录权限位」的 `ensureOwnedDir`（omp-runtime「OMP_STATE_DIR 托管布局」）。

#### Scenario: 新建目录位精确
- WHEN 在临时目录下 `ensureSharedDir("<tmp>/a/b/c")`（`a` 不存在）
- THEN `a`、`a/b`、`a/b/c` 的 mode 位（`& 0o7777`）均为 `0o2770`；再次调用不改变任何 mode；预先以 `0o755` 存在的 `a` 保持 `0o755`

#### Scenario: 已建出的沙箱根不被惰性路径改动
- WHEN 根已由 `ensureSandboxRoot` 建为 `0o3770`，随后 `ensureSharedDir("<root>/u1/ws")`
- THEN `u1` 与 `u1/ws` 为 `0o2770`，根仍为 `0o3770`
