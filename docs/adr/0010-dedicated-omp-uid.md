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
  双方 umask `007`（omp 一侧由 sudoers 强制，见文末 2026-10-02 补充）；app-server 自有状态（SQLite、配置、环境）放在沙箱与 omp 状态目录之外且 `0700`/`0600`。
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
  `SANDBOX_ROOT` 一侧仍是 `2770`，不变。sudoers 规则不变。
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
  递归删除部分失败的残余留在 `<state>/trash`，宿主不自动清理，运维可在停服务后清空。
- **dotenv（#802）**：omp 启动时加载 `$HOME/.env`。`<state>/home/.env` 由宿主预建并持有（`0640`，内容不管，运维可在其中为 omp 放环境变量），
  粘滞位使 omp uid 不能替换它。升级时若该文件已被 omp uid 建出，启动因归属不符失败，移走后重启。
  spawn 环境显式设置 `PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR=.omp`、`OMP_PROFILE=default`、`PI_PROFILE=default`，
  使工作目录的 `.env` 不能改动 omp 读托管配置的位置；`OMP_STATE_DIR` 的路径不得含 `:`（`PI_CONFIG_FILES` 的分隔符），否则启动失败。

## 补充（2026-10-08，#1190、#1206）：快照只在工作空间静止时可还原，及其已接受的残余

本节只登记已在主干上成立的部分。快照目录进入托管布局、临时空间目录删除、还原接线后的缓解（任务 20.3 / #976 的其余条目）等 #953 合入后再补。

- **规则**：所有账号共用一个 omp 用户，同空间的其它会话与上一回合尚未退出的进程都可能在快照遍历期间写工作空间。宿主不假设工作空间静止，而是验证它：
  - 遍历每个目录时记下指纹（`dev`、`ino`、`mtime`、`ctime` 与按字节的条目名），全部条目处理完后逐目录复查；不同、取不到，或已列举的条目读不到（`ENOENT` / `ENOTDIR`），这份快照不可还原（`failed`，快照目录清掉）。
  - 经句柄复制的文件在复制后对同一句柄再取一次元数据；长度或时间有变、或复制的字节数与先前的长度不符，同样不可还原。
  - 不可还原的回合，撤回只回退对话、不动文件。代价：回合开始的瞬间恰有同空间并发写入时，该回合失去文件还原。
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

