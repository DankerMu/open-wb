# omp 子进程以单一专用系统用户运行，与 app-server 分离 uid

同 uid 下 omp 的 bash 工具可读 `/proc/<app-server pid>/environ` 与 app-server 的配置文件，
CONTEXT.md 不变量 4（网关/kb 凭证不进 omp 可读环境）在同 uid 下**无法成立**——ADR-0003/0008 的
"凭证不上命令行/不可猜测 token"只挡命令行与猜测，挡不住这个。决定：所有 omp 子进程运行在一个
**专用系统用户**（如 `omp`）下，与 app-server 不同 uid；这是让不变量 4 成真的最小代价——
一个系统用户 + 一个以该用户 spawn 的机制（sudoers 限定到该二进制、或等价手段，S1a Stage 2 定）。

## Consequences

- 工作空间根目录与挂载点必须对 omp uid 可读写、app-server 配置与 rclone 配置文件（ADR-0003）对其不可读——
  沙箱白名单推导（`core/sandbox`）从此同时是权限位的依据。
- macOS 开发机同 uid 运行，不做分离；隔离性质只在测试 VPS（Linux）上验证并纳入 smoke。
- 每账号独立 uid（跨租户进程级隔离）记为 S3b/S4b 的升级路径，不在本决策内。

## Considered Options

- 每账号独立 uid：隔离更强，但需动态建系统用户与配额，重得多；作为升级路径保留。
- 同 uid 接受泄漏：须在 constraints.yaml downgrades 记为对不变量 4 的降级——等于承认不变量不成立，弃。

## 补充（2026-09-18，S1a grill 拍板）：spawn 机制与权限模型

- **spawn 机制**（2026-09-25 #351 起 `--` 之后改为经 setpriv 启动，见文末补充）：Linux 上 app-server 以 `sudo -n -u <OMP_USER> --preserve-env=<白名单键列表> [TMPDIR=<value>] -- <OMP_BIN> --mode rpc …`
  启动 omp。白名单仍构造在 sudo 进程自身的环境里（sudo 为 setuid root，其 `environ` 他人不可读）。凭证（会话 token、上游密钥）**绝不写进命令行**——
  `/proc/<pid>/cmdline` 对任意本机用户可读，会话 token 上命令行等于广播（与 ADR-0003「凭证不上命令行」同理；
  本节首版写的泛化 `VAR=val` 命令行赋值形态因此作废，2026-09-18 S1a Stage 3 审核纠正）。
  窄例外仅限非凭证 `TMPDIR`：glibc ld.so 在 setuid 二进制（sudo）进入 `main` 之前即按 secure-execution 剥离 `TMPDIR`，
  `--preserve-env` 无法恢复已被 loader 删除的值；因此当本次 spawn 的环境白名单含 `TMPDIR`（`!== undefined`，含空串）时，
  在 `--` 之前插入单个 argv 元素 `TMPDIR=<该白名单值>`，缺席不加。赋值必须放在 `--` 之前，才能保持既有命令匹配与二进制授权
  （实测把赋值放到 `--` 之后会破坏该匹配）。`SETENV` 与二进制授权面不变——sudoers 一行仍为
  `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: <OMP_BIN>`（2026-09-25 #351 后由文末补充的 launcher 形态取代）；`SETENV` 允许在该授权下做环境保留与命令行赋值，
  但不能恢复 sudo 启动前已被 loader 剥离的变量。
  S0b 的环境白名单原样传入且不继承 app-server 其它环境；stdio 直通，RPC 帧层不变。`OMP_USER` 未设置时
  直接 spawn（macOS 开发机、单测）。否决项：`systemd-run --uid`（引入 systemd 与 polkit 依赖，容器内不稳）、
  自研 setuid 包装器（多一个需审计的特权二进制）。
- **权限模型**：两用户同属组 `workbuddy`；`SANDBOX_ROOT`、`OMP_STATE_DIR` 及其下目录 `2770`（setgid 继承组），
  双方 umask `007`；app-server 自有状态（SQLite、配置、环境）放在沙箱与 omp 状态目录之外且 `0700`/`0600`。
  `core/sandbox` 的目录创建路径负责施加位。否决项：POSIX ACL（依赖 acl 工具与 FUSE 支持，S1b 挂载不保证）、
  app-server 经 sudo 代操作文件（每次列举/预览起进程）。
- **验证**：CI 新增 ubuntu job `uid-isolation`（useradd、写 sudoers、`OMP_USER` 起编译服务）跑 Linux-only 集成测试：
  子进程 `Uid` 为 omp、omp 用户读 app-server `/proc/<pid>/environ` 得 `EACCES`、沙箱目录可读写；进入 `all-checks-passed`。
  测试 VPS 保留为部署演练。S0b `constraints.yaml downgrades` 的 `/proc` 向量条目于本 job 全绿时删除。

## 补充（2026-09-25，#351）：sudo 模式经 `setpriv --pdeathsig KILL` 启动 omp

- **问题（测试 VPS 实测，Ubuntu 24.04 / sudo 1.9.15p5）**：sudo 父进程 ruid 仍为 app uid，TERM/KILL 的 `kill()` 都成功，
  sudo 会转发 SIGTERM；但 retire 升级的 SIGKILL 只杀死 sudo，omp 被 init 收养、以 ompUser 身份继续运行并持有 stdio，
  app uid 对它 `kill` 得 `EPERM`。retire 本身仍有界（native `'exit'` + held-stdio 回收），泄漏的是 omp 进程。
- **spawn 行（取代上文 spawn 机制一行的 `--` 之后部分）**：
  `sudo -n -u <OMP_USER> --preserve-env=<白名单键列表> [TMPDIR=<value>] -- /usr/bin/setpriv --pdeathsig KILL -- <OMP_BIN> --mode rpc …`。
  `--` 之前的 sudo 选项与 TMPDIR 位置不变；直连模式（未设 `OMP_USER`）argv 不变。`/usr/bin/setpriv`（util-linux）是固定绝对路径，
  不走 PATH、无环境/配置开关；`OMP_USER` 存在时 canonical 配置与 spawn 边界都要求它可执行（`X_OK`），否则以既有 generic
  failure / spawn 拒绝失败，不静默退化为无 pdeathsig 的启动。
- **sudoers 行（取代上文 `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: <OMP_BIN>`）**：
  `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OMP_BIN> *`。
  `<OMP_BIN>` 此时处于参数位：路径中的空格、`#`、`,`、`:`、`=` 须反斜杠转义，`*`、`?`、`[`、`]` 须转义以免被当作 fnmatch 通配。
  尾部 ` *` 要求至少一个尾参（omp 恒有 `--mode rpc …`），旧规则（路径无参数）本就允许任意参数，故不扩大授权；
  固定的 launcher 前缀不可改写，setpriv 在自己的 `--` 处停止解析选项。该前缀是卫生约束而非安全边界
  （app 本就能经 omp 的工具以 ompUser 执行任意代码），omp→app 边界不受影响。
  **已部署的 sudo 模式必须把 sudoers 行更新为此形态**，否则每个会话 spawn 都会被 sudo 拒绝（`agent_unavailable`）。
- **为什么成立**：setpriv 在 sudo 完成降权之后以非特权 ompUser 身份运行，设置 `PR_SET_PDEATHSIG=SIGKILL` 后原地 exec omp
  （同一 pid，sudo 的 SIGTERM 转发照常到达）。这不是上文否决的「自研 setuid 包装器」：它不带 setuid 位、不需要审计的特权。
  pdeathsig 在 exec 非 setuid、无 file capability 的二进制后保留（VPS 实测：sudo 被 SIGKILL 后约 2 ms 内 `'close'` 到达、无残留）。
- **验证**：CI `uid-isolation` 为 runner 与一个仅持有同一生成规则的检查用户写 sudoers（runner 预置的 `ALL` 规则会掩盖参数匹配），
  在 preflight 与测试之前经 `sudo -l -U <检查用户> -u omp` 断言带 launcher 与尾参允许、缺 launcher 或零尾参拒绝；
  Linux 测试含「retire 升级为 SIGKILL sudo 后 ompUser 的 omp 进程在有界时间内消失」用例。
- **残留风险**：
  - `sudo -l` 无法在 runner 上证明 `SETENV` 与 `TMPDIR=` 命令行赋值（同被预置 `ALL` 规则掩盖），由 Linux 测试与 `make smoke` 实跑覆盖。
  - sudo 在 fork 之后、setpriv 执行 `prctl` 之前被 SIGKILL（例如关停与 spawn 竞速）时 omp 仍会成为孤儿；窗口极小。
  - 启用 `log_output`、或有 tty 时的 `use_pty` 会让 sudo 插入一个 monitor 进程，pdeathsig 绑定到 monitor 而非被杀的 sudo，
    保证失效；部署不得为该规则开启这些选项（服务无 tty 时默认 `use_pty` 不分配 pty，实测无影响）。
  - 只覆盖 omp 进程本身：omp 派生的工具子进程（如 bash）仍可能存活，与直连模式相同（残留，不是回归）。
