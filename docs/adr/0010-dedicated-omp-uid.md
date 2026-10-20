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
- **权限模型**：两用户同属组 `workbuddy`；`SANDBOX_ROOT`、`OMP_STATE_DIR` 及其下目录 `2770`（setgid 继承组；2026-10-16 订正：`SANDBOX_ROOT` 自身由启动建为 `3770`、多一个粘滞位，其下各级仍 `2770`，见文末「2026-10-16 补充」），
  双方 umask `007`（omp 一侧由 sudoers 强制，见文末 2026-10-02 补充）；app-server 自有状态（SQLite、配置、环境）放在沙箱与 omp 状态目录之外且 `0700`/`0600`。
  `core/sandbox` 的目录创建路径负责施加位。否决项：POSIX ACL（依赖 acl 工具与 FUSE 支持，S1b 挂载不保证）、
  app-server 经 sudo 代操作文件（每次列举/预览起进程）。
- **参考镜像**（2026-10-19 补充，#1528）：参考镜像 `deploy/app/` 落实两 uid 与 sudoers——`workbuddy`（10001）与 `omp`（10002）主组都是 `workbuddy`（10001），`/etc/sudoers.d/workbuddy-omp` 恰为下文 2026-09-25 的 launcher 规则与 2026-10-02 的 `Defaults>omp umask=0007` 两行，入口以 umask `007` 启动服务（system.md 9.8「参考部署镜像」）。
- **验证**：CI 新增 ubuntu job `uid-isolation`（useradd、写 sudoers、`OMP_USER` 起编译服务）跑 Linux-only 集成测试：
  子进程 `Uid` 为 omp、omp 用户读 app-server `/proc/<pid>/environ` 得 `EACCES`、沙箱目录可读写；进入 `all-checks-passed`。
  测试 VPS 保留为部署演练。S0b `constraints.yaml downgrades` 的 `/proc` 向量条目于本 job 全绿时删除。

## 补充（2026-09-25，#351）：sudo 模式经 `setpriv --pdeathsig KILL` 启动 omp

- **问题（测试 VPS 实测，Ubuntu 24.04 / sudo 1.9.15p5）**：sudo 父进程 ruid 仍为 app uid，TERM/KILL 的 `kill()` 都成功，
  sudo 会转发 SIGTERM；但 retire 升级的 SIGKILL 只杀死 sudo，omp 被 init 收养、以 ompUser 身份继续运行并持有 stdio，
  app uid 对它 `kill` 得 `EPERM`。retire 本身仍有界（native `'exit'` + held-stdio 回收），泄漏的是 omp 进程。
- **spawn 行（取代上文 spawn 机制一行的 `--` 之后部分）**：
  `sudo -n -u <OMP_USER> --preserve-env=<白名单键列表> [TMPDIR=<value>] -- /usr/bin/setpriv --pdeathsig KILL -- <OMP_BIN> --mode rpc …`。2026-10-20 起为 `--mode rpc-ui`（#1566）。
  `--` 之前的 sudo 选项与 TMPDIR 位置不变；直连模式（未设 `OMP_USER`）argv 不变。`/usr/bin/setpriv`（util-linux）是固定绝对路径，
  不走 PATH、无环境/配置开关；`OMP_USER` 存在时 canonical 配置与 spawn 边界都要求它可执行（`X_OK`），否则以既有 generic
  failure / spawn 拒绝失败，不静默退化为无 pdeathsig 的启动。
- **sudoers 行（取代上文 `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: <OMP_BIN>`）**：
  `<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OMP_BIN> *`。
  `<OMP_BIN>` 此时处于参数位：路径中的空格、`#`、`,`、`:`、`=` 须反斜杠转义，`*`、`?`、`[`、`]` 须转义以免被当作 fnmatch 通配。
  尾部 ` *` 要求至少一个尾参（omp 恒有 `--mode rpc …`；2026-10-20 起为 `--mode rpc-ui`，#1566），旧规则（路径无参数）本就允许任意参数，故不扩大授权；
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
  - 启用任何 sudo I/O 日志（`log_input`/`log_output` 或第三方 I/O log 插件，无 tty 时同样生效）、或有 tty 时的 `use_pty`，都会让 sudo 插入一个 monitor 进程，pdeathsig 绑定到 monitor 而非被杀的 sudo，
    保证失效；部署不得为该规则开启这些选项（服务无 tty 时默认 `use_pty` 不分配 pty，实测无影响）。
  - 只覆盖 omp 进程本身：omp 派生的工具子进程（如 bash）仍可能存活，与直连模式相同（残留，不是回归）。

## 补充（2026-10-02，#760）：omp 侧 umask 由 sudoers 强制

- **问题（部署演练实测，Ubuntu 24.04 / sudo 1.9.15p5）**：app server 以 umask `007` 启动，但它经 sudo 拉起的 omp 实际 umask 为 `0002`
  ——`/etc/pam.d/sudo` 引入的 `pam_umask` 按 `login.defs`（`UMASK 022`、`USERGROUPS_ENAB yes`）与 omp 的私有主组算出该值，
  调用方的 umask 被丢弃。omp 写的会话 `.jsonl` 为 `0664`、目录 `2775`；omp 主组不是同名私有组时为 `0022`，组写位丢失，
  app uid 无法在 omp 建的目录里删除文件。上文「双方 umask `007`」对 omp 一侧不成立，结果随发行版 PAM 默认值漂移。
- **sudoers（在上一节的规则行之外新增一行 runas Defaults）**：`Defaults><OMP_USER> umask=0007`。sudoers(5)：显式设置的 `umask`
  覆盖 PAM；不加 `umask_override`，保留「与调用方 umask 取并集」的语义（调用方 `007` → `007`；调用方误配 `022` → `027`，仍无 other 位，但组写位丢失——app server 一侧必须以 umask `007` 启动，这是部署前提，不由 sudoers 兜底）。
- **否决项**：把 `sh -c 'umask 007; exec setpriv …'` 放进 allowlist（破坏精确的 launcher 规则形态）；只改文档、靠 `2770` 父目录遮蔽
  （`TMPDIR` 等非 `2770` 位置无保护，且主组变体会破坏删除）。
- **验证**：CI `uid-isolation` job 的 sudoers 含该行；Linux 集成测试断言 omp 写出物 other 位为 0 且组写位保留；job 在真实 omp 冒烟后
  检查会话 `.jsonl` 为 `0660`。

## 补充（2026-10-03，#706）：`OMP_STATE_DIR` 分成托管配置与 omp 运行期状态

- **问题**：上文权限模型把 `OMP_STATE_DIR` 整棵设为 `2770`，omp uid 因此能改写宿主托管的 `models.yml`、安装或替换 `skills/`、
  整体改名 `agent`/`home`。托管配置跨账号生效，一次被注入的会话可以持久影响之后所有会话。agent 目录直接只读不可行（omp 要在其中建 `agent.db`）。
- **布局**（`<state>` = `OMP_STATE_DIR`，全部由 app uid 持有，组经 setgid 继承）：

  | 路径 | mode | omp uid |
  | --- | --- | --- |
  | `<state>`、`<state>/sessions`、`<state>/xdg`、`<state>/xdg/{data,state,cache}` | `2750` | 只能进入 |
  | `<state>/home` | `3770` | 可写自己的条目；粘滞位使它不能改名/删除 `.omp` |
  | `<state>/home/.omp`、`<state>/home/.omp/agent`（`models.yml` `0640`、`skills/`） | `2750` | 只读 |
  | `<state>/xdg/{data,state,cache}/omp` | `2770` | 运行期状态（`agent.db`、日志、原生模块缓存） |
  | `<state>/sessions/<ownerId>` | `2770` | 会话文件 |

  spawn 环境里 agent 目录取 omp 的默认值 `$HOME/.omp/agent`（#802 起显式设置 `PI_CODING_AGENT_DIR` 为这同一路径，见文末 dotenv 一条），新增 `XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<state>/xdg/*`；
  `--preserve-env` 列表同步。omp 只在 agent 目录为默认值且 `$XDG_*_HOME/omp` 已存在时才重定向运行期状态，所以三个 `omp` 目录由宿主预建。
  宿主在启动与每次 spawn 时把上表校正到精确值，并拒绝不属于 app uid 的目录、符号链接与非目录条目（启动失败 / 该次 spawn 502）。
  `SANDBOX_ROOT` 一侧仍是 `2770`，不变（2026-10-16 订正：根自身由启动建为 `3770`，其下各级仍 `2770`，见文末「2026-10-16 补充」）。sudoers 规则不变。
- **HOME 为什么可写**（owner 决定）：HOME 只读时 `npm install`（`~/.npm`）、`git config --global` 等工具链直接失败。
- **部署前提（宿主不检查）**：`<state>` 的父目录不得对 omp uid 可写（否则 `<state>` 可被整体改名替换）；
  `skills/` 由运维以 app uid（或 root）安装，目录与文件不对 omp uid 可写；app uid 必须属于共享组（否则 setgid 位设不上，启动失败）。
- **从旧布局升级**：
  1. 停服务。
  2. sudo 模式：移走 omp uid 建的 `<state>/home/.omp`（其中只有 `natives/`、`logs/` 等可再生内容）；留在原处则启动因归属不符失败。
  3. 把 `<state>/agent/skills` 的内容以 app uid 重新安装到 `<state>/home/.omp/agent/skills`（先核对内容——旧目录曾对 omp uid 可写）；
     宿主不自动搬。旧 `<state>/agent` 的其余文件（`agent.db` 等）不再被读写。
  4. 启动。会话文件位置不变，旧会话可继续续接。
  排障：布局校验不通过时启动日志是一行 `{"event":"server_start_failed","reason":"state_layout"}`（`reason` 只标出失败的启动阶段，
  不带原始错误与路径，#1203），运行中则表现为每次发消息 502 `agent_unavailable`。升级后出现这两种症状，先核对上表各目录的属主（必须是 app uid）、是否被符号链接或文件占位、以及 app uid 是否在共享组里。
- **残余**：omp uid 仍可在 `<state>/home` 下建第三方配置目录（`~/.claude` 等）并在 `<state>/xdg/data/omp` 里持久化自己的状态
  （含用户级插件目录）；前者由 #708 的宿主 overlay 处理，后者与 #708 已接受的「项目插件/工具不拦」同类。
  `sessions/<ownerId>` 之内的递归删除竞态由 #706 的后续切片（删除前先移入 app 私有目录）关闭。
- **不由本布局关闭的持久化面**：omp 运行期状态里有可加载的代码（`xdg/data/omp` 下的原生模块缓存与用户级插件目录）与 omp 自己的设置库，
  它们必须对 omp uid 可写；所有账号共用一个 omp uid，因此一次被注入的会话仍可经这些位置影响之后的会话。受信局域网下接受，
  与 #708 的同类残余一并登记；要关闭需要每会话独立 uid 或一次性的运行期状态目录，不在 S1 范围。
- **会话删除（#706 2b）**：同名产物目录先被移入 app 私有的 `<state>/trash`（`0700`）再递归删除，omp uid 不能再按路径替换其下的目录。
  删除前就把工作目录或目录 fd 留在该目录树内的 omp uid 进程仍可经相对路径替换子目录（Node 无 `*at` 系调用）——受信局域网下接受。
  递归删除部分失败的残余留在 `<state>/trash`，宿主不自动清理，运维可在停服务后清空（2026-10-16 补：残余里有活挂载时，管理员先卸载、再以应用 uid 删除，见文末「2026-10-16 补充」）。
- **dotenv（#802）**：omp 启动时加载 `$HOME/.env`。`<state>/home/.env` 由宿主预建并持有（`0640`，内容不管，运维可在其中为 omp 放环境变量），
  粘滞位使 omp uid 不能替换它。升级时若该文件已被 omp uid 建出，启动因归属不符失败，移走后重启。
  spawn 环境显式设置 `PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR=.omp`、`OMP_PROFILE=default`、`PI_PROFILE=default`，
  使工作目录的 `.env` 不能改动 omp 读托管配置的位置；`OMP_STATE_DIR` 的路径不得含 `:`（`PI_CONFIG_FILES` 的分隔符），否则启动失败。

## 补充（2026-10-08，#1190、#1206）：快照只在工作空间静止时可还原，及其已接受的残余

本节只登记「遍历期间有变动的快照不可还原」及其残余。快照目录进入托管布局、临时空间目录删除、快照遍历读到工作空间之外、还原的残余与缓解、权限位与升级说明见文末同日的 #976 补充。

- **规则**：所有账号共用一个 omp 用户，同空间的其它会话与上一回合尚未退出的进程都可能在快照遍历期间写工作空间。宿主不假设工作空间静止，而是验证它：
  - 遍历每个目录时记下指纹（`dev`、`ino`、`mtime`、`ctime` 与按字节的条目名），全部条目处理完后逐目录复查；不同、取不到，或已列举的条目读不到（`ENOENT` / `ENOTDIR`），这份快照不可还原（`failed`，快照目录清掉）。
  - 经句柄复制的文件在复制后对同一句柄再取一次元数据；长度或时间有变、或复制的字节数与先前的长度不符，同样不可还原。
  - 不可还原的回合，其消息不能撤回（对话与文件都不回退；撤回按钮呈灰并给出原因）。代价：回合开始的瞬间恰有同空间并发写入时，该回合失去撤回。（2026-10-08 更正，#977：此处原写「撤回只回退对话、不动文件」，与实现和 message-undo 规格的前置校验不符。）
- **已接受的残余**（owner 2026-10-08：不加代码）：
  - 时间戳刻度：同一目录里的两次改动落在文件系统的同一个时间戳刻度内、且条目名恰好复原时指纹不变；文件在同一刻度内被等长改写时复核看不到。本地文件系统上刻度是毫秒级（内核 6.13 起的多粒度时间戳把它消除），在 1 秒粒度的挂载上是 1 秒。
  - `mmap`：经内存映射写入而时间戳尚未更新的改动，复核看不到；要发现它只能把每个文件读两遍。
- **FUSE 挂载上的实测**（2026-10-08，内核 6.8、sshfs 3.7.3、rclone 1.60.1；各自挂一个本机目录，同一脚本）：

  | | 本机 ext4 | sshfs | rclone mount |
  |---|---|---|---|
  | 目录时间随新增 / 改名 / 删除更新 | 是 | 是 | **否** |
  | 时间戳粒度 | 纳秒 | 1 秒 | 纳秒（缓存里的值） |
  | 未改动的目录 45 秒内指纹稳定、`ino` 不变 | 是 | 是 | 是 |
  | 文件等长改写后时间更新 | 是 | 是 | 是（需 `--vfs-cache-mode writes`；不开时不能就地改写） |
  | `chmod` 推进文件 `ctime` | 是 | 否 | 否（`chmod` 无效果） |
  | `utimes` 拨回 `mtime` 后 `ctime` 仍不同 | 是 | 是 | 是 |
  | 不经本挂载的写入者改动目录后 | —— | 目录时间立即可见，条目名在目录缓存期内仍是旧的 | 60 秒内时间与条目名都不可见 |

  结论：
  - **sshfs**：指纹与复核照常工作，但刻度残余放宽到 1 秒；只改权限的变动看不到（不影响内容）。
  - **rclone mount**：目录时间不更新，目录指纹退化为只比条目名——条目名不变的变动（同名重建、同一目录里两个条目互换）在这类挂载的目录里**检测不到**；文件内容的复核仍有效。不经本挂载的写入者（同一远端的其它客户端）在目录缓存期内完全不可见。
  - 两者都没有误判：静止的挂载目录指纹稳定，不会让每个回合都失去文件还原。
  - 因此工作空间里含 rclone 挂载时，对挂载内目录的「遍历期间有变动」检测弱于本地目录。owner 于同日裁决（#1212）：**挂载目录整体不参与快照与还原**，sshfs 与 rclone 同样对待。判据是目录的 `dev` 与工作空间根不同（不看文件系统类型，bind mount 与另一个卷同样算）：快照把它记为跳过项（`mount`）、不列举；还原不进入、不删除任何这样的目录，包括快照之后才挂上的。代价：挂载内的文件改动不随撤回还原。残余：判定与随后的操作之间恰好挂上的挂载点；以挂载方式出现的单个文件；挂起的挂载让对挂载点的 `lstat` 卡住；断开的 FUSE 端点使快照失败、使还原报错（不会静默改动）。工作空间根自身位于挂载之上时全树与根同设备，照常快照与还原——S1b 若采用这种形态需另议。

## 补充（2026-10-08，#976）：快照目录、临时空间目录删除与文件还原

change `s1f-session-list-temp-space`（design D8、D9、D10）落地后的登记。遍历期间有变动的快照不可还原、时间戳刻度与 `mmap` 残余、挂载目录不参与快照与还原，见上一节，不重复。
下文的路径替换残余都需要一个被注入、仍在运行的 omp uid 进程（别的会话的 omp 进程，或本会话遗留的工具子进程，见 #351 残留）卡准时机；受信局域网下接受，与 #706 已登记的递归删除残余同类，根因相同——所有账号共用一个 omp 用户，Node 没有 `openat` / `fdopendir`，目录这一级只能按路径操作。

- **布局**（接 #706 的表；`<state>/trash` 当时只在正文里出现，一并列出）：

  | 路径 | mode | omp uid |
  | --- | --- | --- |
  | `<state>/trash`、`<state>/snapshots` | `0700` | 不能进入、不能列举 |

  `snapshots` 与表中其它目录一样由宿主在启动与每次 spawn 时建出并校正到精确值，不属于 app uid、是符号链接或不是目录时同样拒绝。
  其下是 `<workspaceId>/<messageId>/{manifest.json,tree/}`（`messageId` 是被受理的用户消息的行 id），由快照步骤在受理 prompt 后、派发前写出：目录 `0700`、文件 `0600`，都用显式 `chmod` 设定，不靠 umask。
  工作空间的内容因此只在 app 私有目录里留副本，agent 改写不了快照；`tree/` 里未变的文件是与该空间上一份成功快照之间的硬链接，两端 omp uid 都碰不到。
- **清理**：快照目录跟随登记行。四个触发点，都在对应事务提交之后：prompt 受理被补偿、撤回提交（被删掉的各条消息）、会话删除而空间保留（该会话的各条消息）、临时空间行被删（整个 `<workspaceId>` 目录，先于空间目录）。
  结果不是 `ok` 的快照由 `take` 自己删掉已写出的目录；快照成功而登记行写入失败时，快照步骤删掉刚写出的目录。`take` 自己的那次删除失败时不报告，目录留作孤儿；登记行写入失败后的删除与四个触发点的清理失败经服务错误通道报告。
  **启动时不扫描快照根，也没有按时间或容量的淘汰**。孤儿目录的来源：进程在 `take` 开始到登记行写入之间被杀（半份或完整的 `<messageId>` 目录，没有登记行）；在事务提交到清理完成之间被杀；以及失败的清理（含上面不报告的那一种）。
  它们留到所属临时空间被删除（整目录清理），或由运维在停服务后手工删除；普通空间没有删除路径，其下的孤儿只能手工删。消息 id 不复用，残留目录不会被之后的快照读到或当作「上一份快照」。
- **临时空间目录删除**（最后一个引用它的会话被删除时；此时该会话的进程已退役，没有别的会话绑定它）：
  - 账号根必须恰是 `<SANDBOX_ROOT 的 realpath>/<ownerId>`，目录名必须恰是 `tmp-<32 位十六进制>`，`lstat` 必须是真实目录（占位的符号链接或文件不删、只报告）。
    然后 `rename` 进 `<state>/trash/<随机名>`，对到达的条目再 `lstat` 一次（期间被换成符号链接或文件的只 `unlink` 并报告），最后递归删除（不带 `force`）。移进去之后 omp uid 不能再按路径替换其下任何一级。
  - `rename` 以 `EXDEV` 失败（沙箱根与状态目录不在同一文件系统）时退为**原地**递归删除，删除前再 `lstat` 一次。只有临时空间目录有这条退路，会话产物目录没有。
  - 任何失败只经服务错误通道报告，不改变删除会话的响应。
  - 残余：
    - 账号根在 realpath 校验与随后的 `lstat` / `rename` 之间被替换。
    - trash 路径：移动之前就把工作目录或目录 fd 留在该树内的 omp uid 进程仍可经相对路径替换子目录（与 #706「会话删除」同一条）；删不掉的部分留在 `<state>/trash`，宿主不自动清理（2026-10-16 补：其中有活挂载时，管理员先卸载、再以应用 uid 手工删除，见文末「2026-10-16 补充」）。
    - `EXDEV` 路径：递归删除期间整棵树仍可被 omp uid 按路径到达，子目录被换成符号链接时删除会被引向别处；删不掉的部分留在账号根下（2026-10-16 补：有活挂载时同上，先卸载再删）。两者同一文件系统的部署不走这条路径。
- **快照遍历（`take`）读到工作空间之外**：遍历在等上一回合的进程退出之前执行，同空间的其它会话也可能在运行。
  - 缓解：每个条目先 `lstat` 分类；普通文件以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开，清单里的身份与元数据取自该句柄的 `fstat`，内容从句柄读出。分类之后被换成符号链接的文件打不开（快照 `failed`），被换成 FIFO 或设备的不挂住遍历、按 `special` 跳过。
  - 残余一：路径的**中间分量**在其父目录被列举之后被换成指向外部的符号链接，`lstat` 与打开都会穿过它。
  - 残余二：**目录条目自身**在 `lstat` 判为目录之后、`readdir` 之前被换成符号链接，外部目录被整棵列举、其中的普通文件被复制进 `tree/`。
    工作空间根自身同理：它的父目录 `<SANDBOX_ROOT>/<ownerId>` 是 `2770`，omp uid 可写，没有部署前提兜底。
    这一种随后会被上一节的目录指纹复查发现（同名之下是另一个 inode，快照 `failed`、目录清掉），除非替换在复查前被换回并落进时间戳刻度的残余；复制量受单文件、总量与条目数三个上限封顶。
- **还原**：app uid 在与 omp uid 共享的目录里写与删。
  - 缓解：
    - 撤回先退役本会话自己的进程，改写会话文件的临时进程也已退出，之后才还原；还原时本会话的 omp 进程（自有与临时）均已退出。它们派生的工具子进程可能仍存活（#351 残留），不在此缓解之内。
    - 同一空间有任何其它会话（不论属主）处于 `running` 时拒绝（`session_busy`），不动文件。
    - 每个条目开始前，以及每一次新建、改名和每一次删除的起点之前，从工作空间根起逐级 `lstat` 它的各级父目录：任何一级不是真实目录（符号链接、其它类型、缺失）或 `dev` 与根不同，该条目跳过并记入 `failed`。
    - 绑在句柄上的不受路径替换影响：读工作空间文件（`O_NOFOLLOW | O_NONBLOCK`，对句柄 `fstat` 确认是普通文件）；写回文件的内容、权限位与时间（在临时文件的句柄上设好再 `rename`，之后不再按最终路径做任何操作）；新目录的权限位（`O_DIRECTORY | O_NOFOLLOW` 打开后 `fchmod`）。
    - 删除不跟随符号链接：非目录一律 `unlink`；目录逐级下行，每一级先 `lstat` 再分类，不越过设备边界（挂载规则见上一节）。
    - 快照目录只读：不原地写、不 `chmod`、不从 `tree/` 向工作空间建硬链接。
  - 并发写入者（#1214）：要删的东西已经不在（`ENOENT`）算已删；`rmdir` 得 `ENOTEMPTY` / `EEXIST`（列举之后有新增）时那一级连同新增内容保留并记入 `failed`，不回头重删——一次还原只删它列举时看到的东西，有界终止。列举时已经消失的那一级不再 `rmdir`，免得删掉同名重建的目录。
  - 单个条目的 `EACCES` / `EPERM` 记入 `failed`、其余继续；其它错误使整次还原中止，工作空间停在还原了一部分的状态，撤回不提交、对话不回退，重来即可（已与清单一致的不再动）。
  - 残余：
    - 父目录检查与它守护的调用是两步，其间被换成符号链接的父级会被穿过，写或删落到工作空间之外。
    - 递归删除只在起点做上述检查，起点之下的各次调用不逐次检查：子目录在它的 `lstat` 之后被换成符号链接时，随后的列举会跟随它，列出的条目被删除（自 #1212 改为逐级下行起即如此，#1214 未改变）。
    - 临时文件的名字落在 omp uid 可写的目录里，`rename` 之前可被删掉并换上别的文件，还原照样报告成功。这不给对方新能力（它本来就能直接改最终路径），等价于还原期间有并发写入者。
    - 并发写入者能让还原反复以非权限类错误中止：撤回的拒绝服务面，可重试。
    - 「同空间有会话在运行则拒绝」只在撤回开头查一次：从检查通过到文件还原之间，另一个会话可以受理新 prompt 并开始写，还原与它的写入交错而不报冲突。窗口是一次撤回的时长，不加空间级的锁。
    - 别的空间的 omp 进程，以及同空间内非 `running` 会话仍驻留的进程（空闲会话的 omp 进程不退出），不在上述两条进程缓解之内。
- **还原写出物的权限位**：
  - 写回的文件：`(清单 mode & 0o777) | 0o660`，对句柄显式设定，不靠 umask——属主与属组的读写位一律补上，其它用户位与执行位照清单，setuid / setgid / sticky 不带；`mtime` 取清单值。
    文件由 app uid 持有，属组靠父目录的 setgid 继承；清单里是 `0644` / `0755` 的文件原样还原的话，只在共享组里的 omp uid 就再也改不了它。
    代价：快照时 `0600` / `0644` 的文件还原后是 `0660` / `0664`。沙箱目录本来就对共享组开放，不扩大可达范围。
  - 判定为没变而不动的文件，权限位不改。
  - 新建的目录 `2770`；已存在的目录权限位不动（清单记了目录的 mode，还原不施加它）。
- **验证**：CI `uid-isolation` 在真实 omp 冒烟之后——
  - 冒烟没有在 `snapshots` 下留下任何 `manifest.json`；用编译后的服务取一份快照，omp 用户列举 `snapshots` 得 `EACCES`（探针打印 errno 名，目录不存在或列举成功都不算通过）。
  - 一个 `0644` 的文件被快照、被 omp 用户删除、再由还原写回：结果是 `0664`、属主 app 用户、属组为共享组（只能来自目录的 setgid），omp 用户可以追加写入。
  - 上述各项残余没有 CI 证明。
- **升级**：无需手工步骤。升级后首次启动建出 `<state>/snapshots`（`0700`）；该位置若已有不属于 app uid 的条目、符号链接或文件，启动按 #706 的规则失败。
  升级前已有的消息没有快照登记，读作不可撤回。回滚到旧版本后残留的 `snapshots` 目录可由运维在停服务后删除。

## 补充（2026-10-12，#1119）：办公文档转换进程的身份、两行 sudoers 与终止后的已知残余

> **2026-10-17 起退役（#1350，change `office-convert-sandbox`）：办公文档转换不再以 omp 用户、不再经 sudo；两行 sudoers 规则删除；下文保留为历史。** 现状见本文末「2026-10-17 补充」。

change `s1f-files-page`（design D17、D18；owner D-21、D-24、D-25、D-26）落地后的登记。转换器的决定与运维步骤在 ADR-0014；本节只登记与 uid 分离有关的部分。
下文的「实测」除另注外都指 #1052（任务 1.3，2026-10-06，记录在该 change 的 `design.md` D18「实测」）。

- **身份**：办公文档由 LibreOffice 解析，输入是不可信文档。配置了 `OMP_USER` 时转换进程以该用户运行，spawn 行与 omp 同形：
  `sudo -n -u <OMP_USER> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> --headless … --convert-to pdf --outdir <job>/out <输入>`（`server/src/preview/office.ts`）。
  环境只有 `PATH`、`LANG`（有则传）、`HOME=<job>`，不继承 app-server 的其它环境。`PATH` 与 `/usr/bin/setpriv` 的前置检查不过即转换失败，不回退为同 uid 启动。
  未配置 `OMP_USER` 时直接启动 `<OFFICE_BIN>`，与 app-server 同 uid（与 omp 在该形态下的处境相同）。
- **uid 分离挡不住的（已知残余，#1350；证据见该 change `design.md` D22「已知残余」）**：文档引用的资源由转换进程去取，读的一方就是转换进程的 uid。`OMP_USER` 模式下是 omp 用户，读得到**其它账号的工作空间**；uid 分离只挡住应用用户独有的文件（数据库、密钥）。同 uid 模式下由应用用户读。网络引用从服务器所在的网络位置发出，两种模式相同，没有缓解。
  **实测**（2026-10-12，一次性容器里按 `office.ts` 的 argv、环境与 `sudo … setpriv` 形状复刻，LibreOffice 24.2.7.2，未经 `/o/` 路由）：docx 的 http 链接图片、docx / pptx 的 `file://` 链接图片都被取回并进了输出的 PDF，两种模式都读到了另一账号工作空间里的图，各自读不到对方 `0600` 的文件。
  **未测**：外部数据类引用（xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、docx `INCLUDETEXT`）是否跟随，所以任意本地文本文件能否进 PDF 未知；https 与回环以外的网络目标、DNS 与重定向、xlsx 里的链接图片、关闭链接更新之后的行为、其它版本。未找到命令行层面的禁用手段（未测）。#1350 保持打开。
- **sudoers 新增两行**，都只在同时配置了 `OMP_USER` 与 `OFFICE_BIN` 的部署里用得到；没有第三行，不存在 `kill` / `pkill` 规则：
  1. 转换的 spawn 前缀：`<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *`。`<OFFICE_BIN>` 处于参数位，转义规则同上文 #351 一节。
  2. 启动时清空 `work`（owner D-24）：`<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`。参数逐项固定、没有通配、不带 `SETENV`。
     - 这是**提权面的扩大**：应用用户多了一条能以 omp 用户身份执行的命令。作用范围是 `work` 之下的条目（`-mindepth 1` 不删 `work` 自身；`find` 缺省不跟随符号链接；命令以 omp 用户身份运行，删得掉的是它自己本来就删得掉的东西）。
     - 服务端只在同时配置了两个键时、于启动时执行一次 `sudo -n -u <OMP_USER> -- /usr/bin/find <该路径> -mindepth 1 -delete`（`server/src/preview/office-cache.ts`；工作目录 `/`，环境只有 `PATH` 与 `LANG`，不经 `setpriv`），先于受理第一次转换。
       有固定 10 秒的时限，到期或关停时对自己启动的 `sudo` 先发 `SIGTERM`、2 秒后仍在再发 `SIGKILL`（owner D-26）。
     - 失败（规则漏配、路径不符、非 0 退出、超时、被终止）只记一行 `{"event":"preview_work_clear_failed"}`，**不阻止启动**；其后本进程自己的递归删除照常执行。
     - 规则里的路径必须与服务端算出的 `join(PREVIEW_CACHE_DIR, "work")` 逐字相同（相对值按 repo root 解析；词法规范化，不解析符号链接；特殊字符按 sudoers 语法转义），sudo 按字面比对参数。
     - 单次转换之后对作业目录的删除**不提权**，尽力而为。
     - 本进程自己对 `work`（`2770`、无 sticky）的递归删除按路径进行，omp uid 的存活进程可以把条目换成符号链接；钉定的 Node 24.13.1 上实测不跟随（预先放好的顶层与嵌套链接），边删边换**未测**，换运行时版本须重新核实（#1286，design D22「实测」（#1318）第 3 项）。与上文 #706、#976 登记的递归删除残余同类。
     - 证据：这条规则与命令在真实 `sudo` 下**未测**（自动化测试用假 `sudo`）；`sudo` 被终止后它之下的 `find` 是否随之结束**未测**（该命令不经 `--pdeathsig`）。
- **目录的 mode**（app uid 持有，都以 `ensureOwnedDir` 建出并校正到精确值：前三个在监听成功后由入口建，`server/src/server.ts`；`<job>` 在每次转换开始时建，`server/src/preview/office.ts`）：

  | 路径 | mode | omp uid |
  | --- | --- | --- |
  | `<PREVIEW_CACHE_DIR>` | `2750` | 可进入、可列出，不可写 |
  | `<PREVIEW_CACHE_DIR>/work`、其下每个作业目录 `<job>` | `2770` | 可写（转换的 `HOME`、配置目录与输出都在 `<job>` 下） |
  | `<PREVIEW_CACHE_DIR>/pdf` | `0700` | 不能进入 |

  `PREVIEW_CACHE_DIR` 缺省是 repo root 下的 `var/preview-cache`，不在 `OMP_STATE_DIR` 里。**部署前提（读代码推出；#1123 只看到了满足时的样子，不满足时未测）**：服务端不 `chown`，这三个目录的属组来自父目录的 setgid 或应用用户的主组，
  表中前两行的「omp uid」一列只在该属组是共享组时成立；`PREVIEW_CACHE_DIR` 的各级上级目录还须让 omp 用户可进入。缺省位置的父目录 `var/` 不存在时由服务端以普通 `mkdir` 建出，服务端不给它设 setgid。
  不满足时启动不失败，但 `OMP_USER` 模式下每次转换都失败。输出 PDF 是从作业目录**复制**成 app uid 自己的 `0600` 新文件再进 `pdf/`，不是改名：
  改名后的文件仍属 omp uid，留着它的文件描述符的进程可以改写所有账号共用的缓存。
- **终止在途转换**（超时、请求方断开、关停；owner D-21：不新增提权规则）：
  - 同 uid 模式：转换进程以新的进程组启动，终止时对进程组发 `SIGKILL`。
  - `OMP_USER` 模式：app uid 无权向 omp uid 的进程发信号（#351 实测 `EPERM`），只对自己启动的 `sudo` 发 `SIGKILL`；`sudo` 的直接子进程由 `--pdeathsig KILL` 随之被内核杀掉。不执行 `kill`、`pkill` 或第二次 `sudo`。
- **已知残余**（owner D-25，按实测写）：`OMP_USER` 模式下直接子进程的后代不随之结束。LibreOffice 的启动程序是包装脚本，它启动 `oosplash`，再由后者派生 `soffice.bin`；
  杀掉 `sudo` 之后 `soffice.bin` **每次都留下**（5 次终止 5 次如此），属 omp uid、被 1 号进程收养、占着 CPU **把整份转换跑完才自行退出**——
  约 25 秒的文档在终止后约 20–23 秒，约 133 秒的文档在终止后 128 秒，长于 60 秒的缺省超时；被放弃的 `<job>/out` 里留下与未中断时字节数相同的完整 PDF。
  它不占转换名额（名额在 `sudo` 退出、`convert` 落定时释放，**读代码推出**），所以主机上实际同时运行的 `soffice.bin` 可以多于 `OFFICE_CONVERT_CONCURRENCY`；
  它用着的 `<job>` 删不掉，留到下次启动的清空（那时它若仍在写，可能删不净，再留到下一次）。与 #351「omp 派生的工具子进程仍可能存活」同类。
  - 查：`ps -u <OMP_USER> -ww -o pid,etime,args | grep -F '<PREVIEW_CACHE_DIR 的绝对路径>/work/'`（服务端解析出的绝对路径；转换的 argv 带着作业目录，**读代码推出**；实测记录没有逐字写下 `soffice.bin` 自己的命令行，筛不到时按进程名与属主找）。
  - 杀：以 root 或 omp 用户的身份 `kill`；app uid 做不到，也不为此加规则。不处理它也会自己退出。
- **`work` 在运行期间增长**：`OMP_USER` 模式下 app uid 删不掉 `<job>`，转换成功的作业也一样（实测：LibreOffice 把 `<job>/profile` 建成 `0700`、`<job>/.cache` 与 `.config` 建成 `2700`，都属 omp uid，不受 umask `007` 影响；
  递归删除只删掉 `out/` 与空的 `.config/`，其余 `EACCES`）。小文档每个作业留下约 650 KB，被终止的作业另加 20–78 MB 的输出；只在重启时由上面第 2 行规则归零。
- **实测 1.3 的记录**（测试主机容器内的 uid 分离部署，与 #1051 同一套；LibreOffice 24.2.7.2，只装 writer 组件，启动程序 `/usr/bin/soffice`；sudoers 当时只加了上面第 1 行；
  应用用户 umask `007`、工作目录与 `HOME` 为 `2770` 的 `<job>`，手工执行上面的 spawn 行转换一份 docx）：
  - 观察到：退出码 0，约 1.2 秒，`<job>/out/<名>.pdf` 生成（`0660`、属 omp uid 与共享组），应用用户能把它复制进 `pdf/`；`out/` 不必预建。
    `oosplash` 与 `soffice.bin` 的 `Uid:` 四个值都是 omp uid（`sudo` 自身是实际 uid 应用用户、有效 uid root）。
    两个转换各用自己的 `UserInstallation` 同时进行（两个小文档，以及两个各约 25 秒的文档全程重叠），都以退出码 0 结束并各自产出 PDF。
    对 `sudo` 发 `SIGKILL` 共 5 次（约 25 秒的文档在第 3 秒 3 次、第 0.15 秒 1 次；约 133 秒的文档在第 5 秒 1 次）：`sudo` 立即消失，`oosplash` 随之被杀，`soffice.bin` 的表现如上「已知残余」，5 次一致。
  - 没有观察的：对 `sudo` 发 `SIGKILL` 以外的信号；xlsx、pptx；经 `/o/` 路由与产品代码的端到端（后由任务 28.6 补做，见下一条）；容器之外（1 号进程是容器的 init）；上面第 2 行规则。
    每次转换的标准错误里有一行与结果无关的 `javaldx` 警告。
- **验证**：CI `uid-isolation` job 不设 `OFFICE_BIN`，两行规则在那里都用不到，`.github/scripts/ci-uid-isolation.sh` 写出的 sudoers 不变；转换器的自动化测试用假的转换程序与假 `sudo`，不需要 LibreOffice。
  `OMP_USER` 模式下真实转换的进程 uid、缓存文件属主与经 `/o/` 超时后的残留已由 28.6 的验证补记，见下一条。
- **28.6 的验证补记**（#1123，2026-10-12；测试 VPS 上的一次性容器，uid 分离部署，LibreOffice 7.4.7.2，经文件页与 `/o/` 的整条链路；环境、做法与没有做的见 ADR-0014「真实转换的验证记录」）：
  - （取样自被超时终止的那一次 docx 转换）转换进行中 `sudo` 的 `Uid:` 是「应用用户 / root / root / root」，它之下的 `oosplash`、`soffice.bin` 四个值都是 omp 用户（`soffice` 包装脚本在进程表里属 omp 用户，没有取到它的 `Uid:` 行）；
    docx、xlsx、pptx 各一份都转换成功，后两种没有取样进程，只看到作业目录里的产物属 omp 用户。
  - `pdf/` 里的缓存文件 `0600`、属应用用户；作业目录下的 `profile/`、`.cache/`、`.config/`、`out/` 与输出 PDF 属 omp 用户，转换成功后整个作业目录留在 `work/` 里。
  - 三个缓存目录的属组随父目录的 setgid 成了共享组（上文「部署前提」满足时的样子）。
  - 上面第 2 行规则在真实 `sudo` 下执行了两次（重启时），`work/` 都被清空，没有 `preview_work_clear_failed`。
  - **超时终止一次之后残留出现了**：把超时设成 3 秒请求一份不被打断时要 84.5 秒的 docx，请求在 3.03 秒得到 504；`sudo` 消失，`oosplash` 随之被杀；
    进程名 `soffice.bin`、属 omp 用户、被 1 号进程收养的残留又运行了约 75 秒把整份转完才自行退出，在被放弃的作业目录里留下与不被打断时字节数相同的 PDF（4,682,817 字节），该 PDF 没有进缓存。
    只做了一次，与上面实测 1.3 的 5 次是同一个现象；终止的做法不因此改变（owner D-21、D-25）。

## 2026-10-16 补充：#1286 有界闭合与 #1237 挂载规则

change `sandbox-boundary-closure`（owner 裁定 B1–B9，2026-10-13 / 2026-10-16）落地后的登记：S0 = PR #1496（测试夹具收窄）、S1 = PR #1497（沙箱根）、S2 = PR #1498（读路由按描述符读）、S3a = PR #1499（FUSE 对照用例与测试主机实测）。上文标着「2026-10-16 订正」「2026-10-16 补」的就地订正（权限模型、#706 的布局、两处残骸句）都指向本节；其余历史记录不动。证据等级逐条标注：实测 / 钩子辅助复现 / 读代码推出。

- **沙箱根在启动时建出并校正（B2、B3、B4）**：启动多一个阶段 `sandbox_root`，在托管布局（`state_layout`）之后、预览监听器绑定之前同步执行 `ensureSandboxRoot`（`server/src/core/sandbox/dirs.ts`）：缺失时递归建出根与缺失的父级，取 realpath（根可以是指向目录的符号链接，作用于目标），不是目录即失败，再以 `ensureOwnedDir` 把根校正为精确 `3770`（属应用 uid、setgid + 粘滞位，chmod 后复查）；不 chown、不改 umask、不碰根之下的条目。`config`、`db`、`app`、`listen`、`state_layout` 任一失败时仍不建根。根之下的账号根与空间根仍由惰性路径建为 `2770`。证据：单元与编译入口用例（PR #1497；实测，本机 Node 24.13.1）。
  - `OMP_USER` 模式：根不属应用 uid、chmod 被拒或复查不通过（例如应用 uid 不在共享组里、setgid 位被内核丢掉）时启动失败，标准错误恰一行 `{"event":"server_start_failed","reason":"sandbox_root"}`，不带路径与原始错误。两种模式共有的失败：根的位置被普通文件占着（递归 `mkdir` 得 `EEXIST`），或 `SANDBOX_ROOT` 是悬空符号链接（递归 `mkdir` 得 `ENOENT`）——两者都在 realpath 之前整体失败（实测，Node 24.13.1，macOS）。
  - 同 uid 模式（未配置 `OMP_USER`）：属主不符或 chmod 被拒时不失败、不纠正、不回滚，标准错误恰一行 `{"event":"sandbox_root_unchanged"}`（只有 `event` 一个键），启动继续，根可能没有粘滞位。该模式下 omp 与应用本就同 uid，粘滞位在两者之间不挡任何东西。
  - **排障与补救**（升级前提，只影响 `OMP_USER` 部署）：`SANDBOX_ROOT`（realpath）必须属应用 uid，应用 uid 必须在共享组里。由 root 建出、`chgrp` 给共享组的既有根，升级后启动失败于 `sandbox_root`。补救：`chown <app-uid> <root>`（不动属组）；或升级前预建 `install -d -m 3770 -o <app-uid> -g <group> <root>`；两者都要求应用 uid 在 `<group>` 里。同 uid 部署无动作（开发机上 `var/sandbox` 由 `2770` / `0755` 变为 `3770`，实测）。沙箱根须在本地文件系统：NFS / SMB 上 chmod 可能被拒或粘滞位被静默丢掉，`OMP_USER` 模式因复查失败而启动失败，同 uid 模式记一行 `sandbox_root_unchanged` 后继续（读代码推出）。缺失的父目录由递归 `mkdir` 以 `0o777 & ~umask` 建出、不带 setgid，umask 严时 omp uid 可能无法穿越——部署方预建父目录（读代码推出）。回滚到旧版本时根上的粘滞位无害，可留着。
  - CI `uid-isolation` 预置 `2770` 的根，在 `make smoke` 起编译服务时被校正为 `3770`；chmod 失败会让该 job 变红，但没有任何一步断言启动后根的 mode——失败可见、取值不断言（design D10，读代码推出）。
- **粘滞位之后（#1286 ①）**：omp uid 在根下只能新建自己的条目，不能改名、删除或替换应用 uid 建出的 `.trash` 与账号根（POSIX 粘滞目录的语义，读代码推出；仓库用例只钉 mode 位，没有在 uid 分离的 Linux 上实测改名被拒）。所以：ADR-0014 #1286 表的 ①（把另一账号的根改名成 `.trash`）不再成立；`sweep` 与 `moveToTrash` 目标一侧「`.trash` 在校验之后被换成符号链接」的窗口关闭；上文 #976 补充里「账号根在 realpath 校验与随后的 `lstat` / `rename` 之间被替换」对应用 uid 建出的账号根不再成立（同为读代码推出）。同 uid 模式下 omp 与应用同 uid，粘滞位不挡任何东西。残余：omp uid 抢先建出的账号根仍属它自己——账号 id 可猜（种子数据 `u1` / `u2`），它可以先在 `3770` 的根下建出 `<root>/<另一账号 id>`；`ensureSharedDir` 遇到已存在的分量只查是不是目录、不查属主，应用照样复用；作为属主它仍能在 realpath 校验之后把这个账号根改名，#976 的替换残余对这样的账号根仍在（读代码推出）。omp uid 抢先建出的 `.trash`（它自己的符号链接、文件或目录）照旧被 `ensureOwnedDir` 拒绝、该次删除失败（拒绝为实测，#1318，仅 ext4）。`.trash` 各级与账号根的逐级校验不因粘滞位放松。
- **读路由的末段换入已闭合，中间分量残余保留（B1、B5）**：`GET …/file`、`GET …/download`、`/w/`、`/o/` 的转出 PDF 在 `lstat` 之后经同一个 `openRegularFile`（`server/src/workspaces/regular-file.ts`）以 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开、对描述符 `fstat` 判普通文件并取大小，此后只从该描述符读。`lstat` 之后末段被换成符号链接、命名管道、目录或套接字，或条目已消失：`file` / `download` 404、`/w/` 404 纯文本、`/o/` 转出 PDF 502，描述符已关闭、零字节读出、`download` 不写 `file.download`（钩子辅助复现：包住打开的钩子自己换入，PR #1498；不是自然竞态）。
  - 书面残余（design D4「书面残余」，owner B1）：`resolve` / `lstat` 之后、`open` 之前，路径的**中间目录分量**被换成符号链接时 `open` 仍跟随它（`O_NOFOLLOW` 只管末段），读到的是空间外同名普通文件；要关它得按目录描述符逐级 `openat`，Node 不提供。利用前提仍在本 ADR 的部署模型之外：以 omp uid 运行代码、卡准 `lstat` 与 `open` 之间的窗口、链接目标是应用 uid 可读的同名文件。读代码推出，未测、未防。移动路由与 `moveToTrash` 源侧的中间分量残余同样保留（ADR-0014 的 #1286 表）。
  - 对外语义变化：打开之后路径被删除或替换，不影响本次响应——响应从已打开的 inode 发出，`Content-Length`、区间与 `download` 审计的 `detail.size` 都是打开时 `fstat` 的值（钩子辅助复现）。用户可见的只有一处：`download` 在审计行写出之后文件被删，以前是净化 500，现在照常完整下载；`file` 的 200 / 206 与 `/w/` 的 206 同理。`download` 先打开、后写审计：被换入的目标没有审计行。416、HEAD、415、413 各多一次打开与关闭；服务 uid 打不开（`EACCES` 等）的文件，以前不经打开即可答出的 415 / 413 / 416 / HEAD，现在答净化 500（读代码推出）。
  - 不在本 change：`/o/` 的转换输入仍由转换进程按路径打开，文档引用的资源由它去取（#1350）。
- **#1237 挂载规则（B6、B7）**：temporary-workspaces「临时空间目录的删除」规定递归删除不跨越挂载点，由 `server/test/linux/temp-dir-remove-fuse.test.ts` 用真实 FUSE 挂载钉住，并在测试主机的一次性容器里实测通过（下表，「绿」分支）。
  - 判据：挂载点以 Linux 对它 `rmdir` 返回 `EBUSY`、且出现在 `/proc/self/mountinfo` 里为准，不按 `dev` 比较——FUSE 挂载带自己的 `st_dev`，同一文件系统内的普通 bind mount 则与宿主同 `st_dev` 却同样 `EBUSY`（快照的「挂载目录」按 `dev` 判，见上文 #1190 补充，两者边界不同）。
  - 行为：递归删除在挂载点以 `EBUSY` 失败，挂载内的文件不被修改或删除（实测，下表）；挂载点之外的同级普通条目仍被并发删除、不恢复（实测，design D7 探针）。残骸连同挂载留在 `<state>/trash/<随机名>/mnt`（同设备 `rename` 成功，挂载点随目录移动）或原地 `tmp-<id>/mnt`（`EXDEV` 路径）；`DELETE` 仍 204，服务错误通道恰报告一次。宿主不检测挂载、不卸载、不重试、不清扫。
  - **残骸处置**：管理员先 `fusermount3 -u <挂载点>`（其它挂载用对应的卸载命令），再手工删除残骸目录：卸载之后递归删除一次成功、目录消失（实测，design D7 探针 (4)；探针容器以 root 运行，没有区分执行删除的 uid）；先以应用 uid 删除——残骸的顶层（`trash/<随机名>` 或 `tmp-<id>`）由应用 uid 建出，omp uid 按默认 mode 写出的条目在双方 umask `007`（omp 一侧由 sudoers 强制，见 2026-10-02 补充）下组可写，应用 uid 在共享组里；umask 只收窄、不放宽，omp uid 以显式 mode 建出的条目（如 `mkdtemp` 的 `0700`；同类现象上文 `:267` 实测）应用 uid 删不掉，遇 `EACCES` 改以 root 删除（读代码推出）。残骸不被任何数据库行引用，删除不影响服务。
  - **纪律**：用户持有的目录树只经 `fs/promises` 的 `rm`（或回调式 `fs.rm`）删除；`fs.rmSync({recursive: true})` 不得用于可能含挂载点的用户目录树——Node 24.13.1 上它是另一套实现（C++ `binding.rmSync`），测试主机实测它穿过 FUSE 挂载点把源数据删掉、再抛 `code === ""`、`errno === -4094` 的错误（不是 `EBUSY`，按 `code` 捕不到）。生产里 `rmSync` 只用于应用持有的转换 `work/`（`server/src/preview/office.ts`、`server/src/preview/office-cache.ts`），不在 `SANDBOX_ROOT` 下。
  - 用例默认跳过：只在 Linux 且 `WORKBUDDY_FUSE_TEST=1` 时运行（另需 `bindfs`、`fusermount3`、`/dev/fuse` 与 `WORKBUDDY_FUSE_ALT_FS_DIR` 指向另一文件系统上的可写目录，缺一即失败而不是跳过）；不进任何 CI job（owner B7）。换 Node 版本须在测试主机重跑。
  - 没有钉住的（读代码推出）：「不重试」——把 `rm` 改成带 `maxRetries` 时两例仍绿；「挂载内文件不被读取」只由「不被修改或删除」间接钉住（`rm` 对挂载点本身做一次 `lstat`）；只测了 bindfs，普通 bind mount、rclone、sshfs 未测。

**测试主机实测结果（S3a 任务 3.5 / 3.6，2026-10-16）**——以下自 PR #1499 正文「3.5 / 3.6 结果表」逐字转录（省去该节开头只与合并流程有关的提示）；表中 `:行号` 指该 PR 合入时的 `server/test/linux/temp-dir-remove-fuse.test.ts`。

环境（实测）：

| 项 | 值 |
|---|---|
| 容器形态 | 测试主机上的一次性容器：`node:24.13.1-bookworm` 基础镜像，`docker run --rm -i --network host --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor=unconfined --tmpfs /altfs`，容器内 `apt-get install bindfs fuse3 git`、`git clone -b feat/issue-1493-fuse-control`（公开仓库，`d4e2f168`，不挂宿主目录）、`npm ci`、`npm run build --workspace server`；用完即删，宿主无容器、无文件残留（`docker ps -a` 为零）。宿主 `docker0` 网桥缺失故用 `--network host`（owner 事项） |
| Node 版本（`node -v`） | v24.13.1 |
| 内核版本（`uname -r`） | 6.8.0-117-generic |
| 文件系统：账号根所在（`tmpdir()`） | overlayfs（`/tmp` 与 `/` 同 `st_dev` 50） |
| 文件系统：`/altfs`（`WORKBUDDY_FUSE_ALT_FS_DIR`） | tmpfs（`st_dev` 103，与账号根不同） |
| bindfs / fusermount3 版本 | bindfs 1.14.7-1、fuse3 3.14.0-4（Debian bookworm 包）；挂载在 mountinfo 里 fstype 为 `fuse` |
| 默认（未 opt-in）运行 | `Test Files 1 skipped (1)`、`Tests 2 skipped (2)`，exit 0 |
| opt-in 但未装 `bindfs`（另一容器）：失败而非 skip | `Test Files 1 failed (1)`、exit 1；`Error: WORKBUDDY_FUSE_TEST=1 but the FUSE prerequisites are missing: bindfs is not on PATH; fusermount3 is not on PATH`（`requirePrerequisites` `:140`，自 `beforeAll` `:73` 抛出）。vitest 把两个用例显示为 `2 skipped`，判据是「文件 FAIL + 非零退出码」，不是用例状态（评审 P3-2 实测确认） |

逐次结果：

| 运行 | 用例 | `report` errno | 挂载是否仍在（mountinfo 路径） | 源目录校验和 前 / 后 | 残骸清单（trash 下 / 原地） | 结果 |
|---|---|---|---|---|---|---|
| 1 | trash 路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `trash/<随机名>/mnt`（断言恰为该路径，通过） | 绿 |
| 1 | EXDEV 原地路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `tmp-<id>/mnt`（断言恰为该路径，通过） | 绿 |
| 2 | trash 路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `trash/<随机名>/mnt`（断言恰为该路径，通过） | 绿 |
| 2 | EXDEV 原地路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `tmp-<id>/mnt`（断言恰为该路径，通过） | 绿 |
| 3 | trash 路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `trash/<随机名>/mnt`（断言恰为该路径，通过） | 绿 |
| 3 | EXDEV 原地路径 | `EBUSY` ×1（断言 `toEqual(["EBUSY"])` 通过） | 仍在（mountinfo 第 5 字段含挂载点路径，断言通过） | 相等（断言 `source directory bytes` 通过） | `tmp-<id>/mnt`（断言恰为该路径，通过） | 绿 |
| — | 三次是否一致 | 一致 | 一致 | 一致 | 一致 | 3 × `Tests 2 passed (2)`，exit 0；每次 ≈ 30ms |

变异：

| 变异 | 结果（红 / 绿、红在哪条断言、源文件是否被删、200 轮中含 `notes.md` 的红次数） |
|---|---|
| ① `EBUSY` 断言改为零次 | 红：两例都红在 `:217` `AssertionError: expected [ 'EBUSY' ] to deeply equal []`（`sed` 只改一行，跑完还原，`git diff --quiet` 为零） |
| ② 手写递归删除进入挂载 | 红：两例都红在 `:89` / `:111` `source directory bytes: expected 'e3b0c442…' to be 'e2085c5f…'`——后值是空目录的校验和，**源文件被删**（经挂载 `unlink` 到了 bindfs 源）；此断言先于 EBUSY 断言触发。产品代码临时改为 `readdir` 递归 + `unlink` + `rmdir`（+16/−3），跑完还原 |
| ③ B9：去掉 `rmSync(notes.md)`，200 轮 | 200 轮 `session-delete-temp-workspace.test.ts` 全绿：red=0、含 `notes.md` 的红 0 次（overlayfs，容器）；对照组（S0 行在）20 轮 red=0。自然竞态在该文件系统上 200 轮内不可观察；S0 的收窄仍以钩子辅助复现为据（PR #1496） |

定案（绿 / 红，依据）：**绿**——三次两例全绿，变异 ①② 都判红（② 并证明进入挂载会删掉源文件，与 design D7 探针 (2) 一致）；按 D7 继续，temporary-workspaces delta 留在本 change，S3b 关闭 #1286 与 #1237。

附带探针（S2 复审提出的验证缺口，实测同一容器）：bindfs 挂载上的普通文件以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开后 `fstat.isFile()` 为真、`size` 70000，`readSync` 循环读满 70000 字节，`createReadStream(null, {fd, start, end})` 也读满 70000 字节、无 error——`O_NONBLOCK` 在 FUSE 上对普通文件读没有 EAGAIN 之类副作用。

容器内命令（相对形式，`server/` 下）：

```
WORKBUDDY_FUSE_TEST=1 WORKBUDDY_FUSE_ALT_FS_DIR=/altfs ../node_modules/.bin/vitest run test/linux/temp-dir-remove-fuse.test.ts --coverage=false
```

## 2026-10-17 补充：#1350 办公文档转换移入 `--network none` 的 sidecar

change `office-convert-sandbox`（owner 裁定 B1–B10、B12、B13，2026-10-13 至 2026-10-18）落地后的登记：S1a = PR #1510（`converter/`：sidecar 脚本、镜像、compose、守卫接线）、S1b = PR #1511（app 侧 spool 客户端、启动预检与 fail-closed、退役）、S2a = PR #1512（CI job `office-sidecar`）、S2b = #1507（测试主机实测，2026-10-18，结果表见本节末）。上文「补充（2026-10-12，#1119）」整节由此退役。
规格在 office-preview「sidecar 转换契约」「转换缓存与作业目录清理」「转换隔离边界」「转换 sidecar 的健康与 fail-closed」「转换 sidecar 实现与镜像」；部署步骤与排障在 ADR-0014「转换 sidecar 与 `OFFICE_SPOOL_DIR`」与 `docs/architecture/system.md` 9.7。
证据等级：**实测**（注明平台、版本、次数）/ **实测（CI）**（GitHub `ubuntu-24.04` runner 上的 `office-sidecar` job 与单元测试）/ **读代码推出** / **读手册推出**（Docker、LibreOffice 文档，未在本仓库场景下验证）。

- **owner 的裁定**（逐条理由在该 change 的 `design.md`「owner 的裁定」表）：
  - B1（2026-10-13）：外部数据类引用登记为「未测、视为跟随」；不为验证它们造文档；不以「未测」为由推迟缓解。
  - B2（2026-10-13 / 10-16）：缓解 = 没有网络、只看得见输入与作业目录的隔离边界，先在测试主机实测。
  - B3（2026-10-13）：运行时边界不在或起不来 → fail-closed：拒绝办公文档预览，不回退为 app 进程里的 `soffice`。
  - B4（2026-10-13）：一个 change，走完整流水线。
  - B5（2026-10-16）：结果写进该 change 的 design 与 `server/src/preview/app.ts` 头注释，归档件不改；本 ADR 的两行 sudoers 随之改——B7 之下即退役。
  - B6（2026-10-16）：边界在 app 以 Docker 容器部署时也必须可用；「裸机 + AppArmor profile」作为唯一形态被否决。
  - B7（2026-10-17）：**sidecar 单机制**——长驻、`--network none` 的转换容器（compose 服务），经共享卷上的 spool 目录交接作业；不要 docker socket、不要任何容器特权；裸机部署同样跑这个容器（Docker 成为前提）；sidecar 不在或不健康 → fail-closed；bubblewrap 不进本 change；`OMP_USER` 的 `sudo → setpriv → soffice` 链不再用于转换；镜像由本仓库自己做。
  - B8（2026-10-17）：旧键 `OFFICE_BIN` 仍被设置 → 启动失败。**细节**（同日补裁）：stderr **不点名**退役键——只有既有的一行 `{"event":"server_start_failed","reason":"config"}`，不新增 `reason` 取值；键名只出现在 `resolveServerConfig` 抛出的错误 message `OFFICE_BIN is retired; configure OFFICE_SPOOL_DIR` 与升级文档（ADR-0014、system.md 9.7）里。
  - B9（2026-10-17）：仓库给 `converter/Dockerfile` 与 `converter/compose.yml`，镜像由部署方自建；不引入镜像发布流水线、不引用镜像仓库；CI 只在 job 里现场构建一次做实测。
  - B10（2026-10-17）：批准 CI job `office-sidecar`（`runs-on: ubuntu-24.04`，并入 `all-checks-passed`）。B12（同日）：`uid-isolation` 的 `runs-on` 同样固定为 `ubuntu-24.04`（#1502 并入 S2a）。
  - B13（2026-10-18）：S2b 实测到 1 次取消后作业目录残留（26 次终止里 1 次）→ **放宽规格、登记为残余**：office-preview「终止结束作业的全部进程」两个场景的 THEN 加「删不掉的留到下一次启动清空」；不改代码；ADR-0014 残余表登记一行。
- **为什么不是 bubblewrap**（背景，不是选项；实测，2026-10-16，测试主机，两轮，记录在该 change `design.md` Context）：
  - 一次性 `ubuntu:24.04` 容器（docker 缺省 flags，宿主 `apparmor_restrict_unprivileged_userns=1`）里非特权用户 `bwrap --unshare-all` 得 `No permissions to create new namespace`；容器 root 加 `SYS_ADMIN`、seccomp / AppArmor unconfined 得 `Can't mount proc on /newroot/proc`；setuid-root 的 bwrap 在五个特权档全部 `bwrap: capset failed: Operation not permitted`。
  - 裸机上只有装 `apparmor-profiles` 并载入 `bwrap-userns-restrict` 之后非特权 bwrap 才可用（三个 HTML 输入 0 命中 0 图，终止后无存活，一次）——B6 否决了只支持裸机。
  - 对照：不加任何边界、按旧 `office.ts` 的 argv 与环境转换带 http 图片的文档，监听器 3 次命中、PDF 1 图（每档的无 bwrap 对照同样取回）。同一轮里 `--network none`、只读根、只挂作业目录的容器：http 图 0 命中 0 图，宿主上存在、未挂载的 `file://` 外部图 0 图；不需要 bwrap、userns、宿主 AppArmor 前提或任何容器特权——这是 B7 的依据。
- **spool 协议**（单一真相在 `converter/sidecar.mjs` 头注释，app 一侧在 `server/src/preview/office.ts`；读代码）：
  - `OFFICE_SPOOL_DIR`（sidecar 视角恒为 `/spool`）根下只有 `heartbeat` 与 `jobs/`。sidecar 每 2 s touch `heartbeat`；新鲜 = 年龄 < 10 s。
  - app 每次转换建 `jobs/<id>/`（`id` 为 32 个小写十六进制随机字符，`0700`）与 `in/`；以 `openRegularFile`（末段 `O_NOFOLLOW`、`fstat` 判普通文件）打开输入，从该描述符恰复制 `size` 字节为 `in/<basename>`（`wx`、`0600`）；先写 `request.json.part` 再 `rename` 出 `request.json`——内容恰为 `version`、`input`、`timeoutMs` 三个键，没有路径、用户名或时间戳，它的出现就是就绪标记；随后每 100 ms 看 `done` / `failed`。
  - sidecar 每 200 ms 列 `jobs/`（只看目录条目），按 `request.json` 的 mtime 升序领取，转换后经 `.part` + `rename` 写出 `done`（空）或 `failed`（一行原因码，app 不区分原因码，都落为 `failed`）。
  - 超时、客户端断开与 `close()` 时 app 写 `cancel`（`wx`）并随即删掉作业目录；sidecar 每轮看到「`cancel` 出现，**或**作业目录 / `request.json` 已不在」任一即对该作业的进程组 `SIGKILL`；sidecar 自己的时限（`request.json` 的 `timeoutMs`，与 app 的 `OFFICE_CONVERT_TIMEOUT_MS` 同值）到期同样杀组。
  - app 一侧的任何路径都不进 spool：输入只以 basename 出现，`request.json` 里没有路径字段；app 侧单元测试把 `SANDBOX_ROOT`、`PREVIEW_CACHE_DIR`、`OMP_STATE_DIR` 与输入目录都造成含哨兵段，一次转换后 spool 树里没有一个文件含任一哨兵（实测（CI））。sidecar 的日志行不含输入名与路径（实测（CI），sidecar 子进程测试）。
- **身份**：sidecar 以与 app 进程**相同的数值 uid/gid** 运行（compose `user: "${WORKBUDDY_UID}:${WORKBUDDY_GID}"`，两个变量缺席时 compose 拒绝启动；镜像的 `USER node` 只是忘了传 `user:` 时不以 root 运行的地板），**不经 `sudo`、不经 `setpriv`**。`OMP_USER` 与办公文档转换无关：两种 uid 模式下 app 对 spool 做完全相同的事（读代码推出），转换链相同（实测，测试主机，2026-10-18：两种模式 7 份 PDF 的页数、`pdftotext` 输出与图片计数相同；作业目录与 `pdf/` 属应用用户；app 进程树没有 `sudo`；`OMP_USER` 模式下 omp 用户没有 `soffice`——结果表 b′1–b′4）。sidecar 以一个不在镜像 `/etc/passwd` 里的 uid 运行 LibreOffice：实测（CI，runner 的 uid）。
- **退役**（S1b，PR #1511）：
  - 转换的 `sudo -n -u <OMP_USER> … /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> …` 前缀与同 uid 直接启动 `soffice`——app 不再启动任何转换进程。
  - 上文两行 sudoers：`… /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *` 与 `… /usr/bin/find <PREVIEW_CACHE_DIR>/work -mindepth 1 -delete`。`OMP_USER` 部署删掉它们（留着无害，不再匹配任何命令）；omp 的规则与 `Defaults>omp umask=0007` 不动。
  - 配置键 `OFFICE_BIN`（1:1 换成 `OFFICE_SPOOL_DIR`，十二个预览键仍是十二个；B8）。
  - `<PREVIEW_CACHE_DIR>/work`：不再建、不再清空；启动时以 omp 用户执行的 `sudo … find` 清空、它的 10 秒时限与终止句柄，以及事件 `preview_work_clear_failed`。升级后留下的 `work/` 无害，可手工删除。
  - 测试夹具 `fake-sudo-find.mjs` 与 `office-work-clear.test.ts`。
- **预检、fail-closed 与排障**（office-preview「转换 sidecar 的健康与 fail-closed」；读代码推出，另注实测的除外）：
  - 配置了 `OFFICE_SPOOL_DIR` 时，入口在打开数据库之后、构造转换器之前预检一次：spool 根是目录、属本进程 uid、不带组与其它写位；`heartbeat` 至多等 5 s（每 100 ms 看一次，覆盖与 sidecar 同时启动的冷启动）变新鲜；`heartbeat` 存在时须属本进程 uid。预检永不使启动失败；等待期间收到的 SIGINT / SIGTERM 在等待结束后被核对，进程以 0 退出、不写任何记录。
  - 预检失败 → 转换器以「未配置」的形态构造：令牌响应 `officeAvailable` 为 `false`，`/o/` 答 503 固定页「服务器未启用文档转换，请下载后查看」——已缓存的文档同样 503（路由在调用转换器之前拒绝）；stderr 在 `server_started` 之前恰一行 `{"event":"office_convert_sidecar_unavailable"}`（只有 `event` 一个键）。绝不回退为 app 进程里的 LibreOffice。
  - 运行期每次转换前看一次心跳：不新鲜 → 503 固定页、不写 spool；已缓存的文档不经转换器，照常 200。日志边沿触发：一次宕机无论多少请求至多一行同名记录，恢复后再宕再一行。`officeAvailable` 是启动时的快照，运行期 sidecar 宕机时仍为 `true`、不翻转，直到重启。sidecar 死在作业中途 → app 看到的是自己的超时，504；下一次请求才 503。以上 503 / 200 / 行数 / 令牌五步：实测（测试主机，2026-10-18，三列各一次，结果表 d0–d4）。
  - 排障：见到 `office_convert_sidecar_unavailable` 时依次查 `docker compose -f converter/compose.yml ps`（`converter` 是否 healthy）、`<OFFICE_SPOOL_DIR>/heartbeat` 的年龄与属主、spool 根的属主与 mode（应用用户、`0700`）、`WORKBUDDY_UID` / `WORKBUDDY_GID` 是否等于应用用户的 `id -u` / `id -g`、`CONVERTER_CONCURRENCY` 不小于 `OFFICE_CONVERT_CONCURRENCY`；细节在 system.md 9.7。
- **数据类向量（B1）**：xlsx 外部工作簿、`WEBSERVICE()`、DDE、链接 OLE、`INCLUDETEXT` / `INCLUDEPICTURE`、odt 链接节、ods 外部引用——**未测、视为跟随，按构造覆盖（读手册推出）**：要读的本地文件不在容器里（只有镜像的只读根、tmpfs 的 `/tmp` 与 spool），要走的网络不存在（`network_mode: none`），DDE 的进程间通信在容器自己的 ipc 命名空间里——那里只有 sidecar 与其它在途作业的 `soffice`，没有 app、没有 omp。不为验证它们造文档。
- **已知残余：同一 sidecar 内并发作业互相可见**：同一 sidecar 内并发作业共享 fs / ipc / uid，作业间隔离只靠 128 位随机作业 id；LibreOffice 代码执行漏洞下另一在途作业的输入 / 输出可读可伪造（读代码推出，未测）。本 change 不缓解（每作业一个容器、或 sidecar 内按作业切换 uid / 命名空间都不在范围内）。S2b 没有测并发作业。
- **已知残余：被攻破的 sidecar 对 app 的反向面**（读代码推出，未测）：sidecar 与 app 同 uid、spool 可写；`O_NOFOLLOW` 只管末段，被攻破的 sidecar 可在核对与操作之间把 `<job>/out`、作业目录或 `jobs` 换成符号链接，让 app 代读它够得着的文件或删掉目标目录的子项。app 在读输出、写 `cancel` 与 `.part`、启动清空之前都先核对这些目录不是链接，把确定性利用降为一次系统调用间隔的竞态窗口，不是零；Node 没有 `openat` 族，根治不在本 change。条目同 ADR-0014 已知残余表。
- **上文 D-25 残余（`OMP_USER` 模式下 `soffice.bin` 在终止后存活）**：sidecar 下未再出现（测试主机实测：3 列 × (5 次超时 + 1 次断开) + 8 次探针，≈6.6 s 文档；504 / 断开后 0.5–1.5 s 内 converter 内 soffice 为 0；其中 app 取消路径 6 次、sidecar 自身时限路径 20 次）。
  - 时限竞争（读 sidecar 日志）：app 的 3 s 时限与 `request.json` 的 `timeoutMs` 同值，c1–c5 的 15 次里 13 次是 sidecar 自身时限先到（日志 `timeout`），2 次是 app 的 `cancel` 先到（A 同 uid c#4、c#5）；探针 8 次里 1 次 `cancelled`；c6 的 3 次全部 `cancelled`、约 2002 ms（断开即杀，早于任何时限）。两条路径观察到的结果相同。
  - 没有测的：归档 D17 的约 25 s / 133 s 真实文档（以 12000 段纯文本 docx 代替，直接 `soffice` 约 6.6 s；504 后 +1.5 s 的检查因此仍有判别力，+5 s / +30 s 只证明无存活）；`close()`（服务关停）一种终止；并发作业的终止。旧链的「`soffice.bin` 被 1 号进程收养、跑完整份转换」在 sidecar 下预期不出现的理由是读代码推出：sidecar 里只有同 uid 杀整个进程组一种终止，`soffice.bin` 与 `oosplash` 在同一进程组里。
- **观察到的残余：取消之后作业目录残留**：实测（测试主机，2026-10-18）：26 次终止里 1 次——A 同 uid c#4 之后 `jobs/` 多出 1 个目录，一直留到下一次 app 启动被 `clearWork` 清掉；该次 sidecar 日志为 `cancelled`；其余 25 次（含 8 次探针）之后 `jobs/` 为空。机制（读代码推出，未看到残留目录的内容）：app 收尾时 `removeJob` 的 `rmSync` 与 sidecar 写 `failed.part` / `failed` 竞态，目录非空删不掉——`office.ts` 的 `removeJob` 注释已写明「删不掉的留给下一次启动对 `jobs/` 的清空」。残留的应只是输入副本与标记，没有进程（c 与探针每次 0 个 `soffice`）。接受，不改代码（owner B13，2026-10-18）：office-preview「终止结束作业的全部进程」两个场景的 THEN 由「`jobs/` 下该作业目录已不存在」放宽为「已不存在；app 删目录与 sidecar 写标记恰好同时而删不掉的，留到下一次启动清空」，本次观察登记为残余（见 ADR-0014 残余表）。
- **验证**：
  - 实测（CI）：`office-sidecar` job（`ubuntu-24.04`，job 内 `docker build converter/`，标志与 `compose.yml` 逐项相同）以产品代码的 `createOfficeConverter` 转换 runner 上生成的、带 http 外链图片的 docx：监听器 0 次请求、PDF 0 图、`jobs/` 为空；对照（同一镜像 `--network host --entrypoint /usr/bin/soffice -e HOME=/job`）1 次请求、1 图（master `a22039f8` 的一次运行）。
  - 单元与编译入口测试不需要 LibreOffice 与 Docker：app 侧对着进程内的假 sidecar，sidecar 脚本对着假 `soffice`；测试里启动过的可执行文件 basename 没有 `soffice`、`libreoffice`、`docker`（实测（CI））。
  - 测试主机实测见下表。

**测试主机实测结果（S2b，#1507，2026-10-18）**——以下自 #1507 的结果表转录，数字逐字保留；只把「✅」写成「绿」，与上一节的表一致。

环境（实测）：内核 6.8.0-117-generic；Docker 29.1.3 / compose 2.40.3；sidecar 镜像 = 仓库 `converter/Dockerfile`（基底 `node:24-bookworm-slim`，LibreOffice 7.4.7.2，镜像内 Node 24.22.0），因测试主机 apt 极慢而在开发机 `docker buildx --platform linux/amd64` 构建后 `docker save | load` 过去，Dockerfile 相同；宿主 Node 24.13.1；app 构建 `39e2d74d`（S1a + S1b 合入后的 master；之后 master 只多了 #1513 的纯测试提交，运行时代码相同）。宿主不留被跟踪文件。

部署形态：A = app 裸机 + sidecar 容器（`converter/compose.yml`，`WORKBUDDY_UID/GID` 对齐应用用户；容器实测 `net=none ro=true capdrop=[ALL] no-new-privileges user=<app uid:gid> mounts=/spool`）；B = app 临时容器 + 同一 sidecar 容器——仓库没有 app Dockerfile，临时镜像直接复用 sidecar 镜像并 `--entrypoint node`，以 `docker run --network host --user <app uid:gid>` 起（**不是**该 change design D11 写的「临时 compose `include`」：同一容器参数，少一层 compose 文件），只读挂 repo、挂 state 与 spool。uid 模式：同 uid / `OMP_USER`（仅形态 A；临时 omp 用户 + 共享组 + 与仓库 CI 同形的 sudoers，状态目录 `2770`）。

偏离 design D11 的参数：(c) 的「约 25 s 文档」换成 12000 段纯文本 docx（直接 `soffice` 实测约 6.6 s；300 → 12000 段耗时线性 1.8 → 6.6 s）配 `OFFICE_CONVERT_TIMEOUT_MS=3000`：504 后 +1.5 s 的检查有判别力（未被杀的 `soffice` 本会跑到约 6.6 s），+5 s / +30 s 只证明无存活。断开例（c6）在**缺省超时**下做：同一文档、`curl --max-time 2`，+1.5 s（约请求后 3.5 s）同样有判别力。

| # | 项 | 形态 A 同 uid | 形态 A OMP_USER | 形态 B 同 uid | 期望 | 结果 |
|---|---|---|---|---|---|---|
| b1 | docx http 图片 → 监听器命中 / PDF 图数 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 绿 |
| b2 | docx `file://` 外部图 → PDF 图数 | 0 | 0 | 0 | 0 | 绿 |
| b3 | pptx `file://` 外部图 → PDF 图数 | 0 | 0 | 0 | 0 | 绿 |
| b4 | docx / xlsx / pptx 中文 → 页数 / `pdftotext` 可辨认 | 1/1/1 / 是（「中文正文：工作伙伴办公文档」「中文单元格 42」「中文幻灯片标题」） | 同 | 同 | ≥1 / 是 | 绿 |
| b5 | 对照：同镜像 `--network host` 直接 soffice → 命中 / 图数 | 2 / 1 | 2 / 1 | 2 / 1 | ≥1 / ≥1 | 绿 |
| b′1 | 三列 PDF 等价（`pdfinfo` 页数 / `pdftotext -layout` diff / 图数），7 份文档 | 基准 | 1=1 / 空 / 0=0 ×7 | 1=1 / 空 / 0=0 ×7 | 相同 / 空 / 相同 | 绿 |
| b′2 | `jobs/<id>/` 转换中属主与模式 / `pdf/<key>.pdf` 属主与模式 | 应用用户 700（8 次抓取）/ 应用用户 600 | pdf：应用用户 600 | pdf：应用用户 600 | 应用用户 | 绿 |
| b′3 | app 进程树（`pstree -p`）无 `sudo` | 0 | 0 | 0 | 0 | 绿 |
| b′4 | `OMP_USER` 下 omp 用户无 soffice | — | 0 | — | 0 | 绿 |
| c1–c5 | 超时 3 s 请求重文档 → 504（3.01 s）后 1.5 / 5 / 30 s converter 内 soffice 数；`jobs/` | 0/0/0 ×5；c#4 后残留 1 目录（见上文残余） | 0/0/0 ×5；空 | 0/0/0 ×5；空 | 0 / 0 / 0；空 | 绿（残留见上文） |
| c6 | 缺省超时，客户端 2 s 断开 → +1.5 / 5 / 30 s soffice 数；`jobs/`；sidecar 日志 | 0/0/0；空；`cancelled` 2002 ms | 0/0/0；空；`cancelled` 2003 ms | 0/0/0；空；`cancelled` 2004 ms | 0 / 0 / 0；空 | 绿 |
| c′ | 补充探针 ×8（同 uid，3 s 时限；504 前 +1.0 s 与 504 后 +0.5 / 2.5 s） | 转换中 soffice=1、jobs=1（属主应用用户 700）；504 后 soffice=0、jobs=0 ×8 | — | — | — | 实测 |
| d0 | 可用形态起步：令牌 `officeAvailable`、stderr 行数 | true / 0 | true / 0 | true / 0 | true / 0 | 绿 |
| d1 | 运行期 stop ≥10 s：已缓存 / 新 1 / 新 2 / 行数 / 令牌 | 200 / 503 / 503 / 1 / true | 同 | 同 | 200 / 503 / 503 / 1 / true | 绿 |
| d2 | start → 新 3 / 行数；再 stop ≥10 s → 新 4 / 行数 / 已缓存 | 200 / 1；503 / 2 / 200 | 同 | 同 | 200 / 1；503 / 2 / 200 | 绿 |
| d3 | sidecar 停着重启 app：启动行数 / 令牌 / 已缓存 / 新 5 / 行数 | 1（在 `server_started` 前）/ false / 503 / 503 / 1 | 同 | 同 | 1 / false / 503 / 503 / 1 | 绿 |
| d4 | start 后重启 app：行数 / 令牌 / 已缓存 / 新 6 | 0 / true / 200 / 200 | 同 | 同 | 0 / true / 200 / 200 | 绿 |
| e | 三小文档 ×3 经 `/o/`（s） vs 对照直接 soffice（冷容器） | 0.92–1.12 vs 1.15–1.23 | 0.92–1.12 vs 1.19–1.20 | 0.92–1.12 vs 1.17–1.20 | 同量级 | 绿 |
| f1 | 变异：`network_mode: host` 重跑 b1 → 命中 / 图数（已撤销） | 2 / 1 | — | — | ≥1 / ≥1 | 绿 |
| f2 | 变异：挂入外部图目录重跑 b2 → 图数（已撤销） | 1 | — | — | ≥1 | 绿 |

证据等级：表中每格为实测（测试主机，2026-10-18，各列一次；c1–c5 ×3 列、c6 ×3 列、探针 ×8）。(e) 没有「热 profile」一栏：sidecar 每作业独立 `UserInstallation`，经 `/o/` 的每次都是冷 profile（设计如此），对照同为冷容器。终止路径的区分见上文 D-25 一条；sidecar stderr 对这 26 次终止每次恰一行（实测核对；`done` 行数未逐一与命中 / 未命中缓存的请求数对账）。

定案：**全绿**——(b) 无命中无图、三种格式中文可辨认，(d) 五步每项符合，两种 uid 模式四项核对相同，两种部署形态相同。其余观察：形态 B 的 app 镜像是实测用的临时拼装（复用 sidecar 镜像），不是部署配方，app 容器里虽然带着 LibreOffice，进程树里没有 `soffice` / `sudo`（b′3）；首次 6000 段文档直接 `soffice` 运行超过 10 分钟未完成（被终止；未复现，之后同一文档 3.6 s），登记为观察。未测：并发作业；归档 D17 的 25 s / 133 s 真实文档；B1 数据类向量（owner B1：不造）；`setfacl`（测试主机没有 acl 包，以给家目录加其它用户的执行位代替，不影响转换链）。
