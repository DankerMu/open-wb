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
    - trash 路径：移动之前就把工作目录或目录 fd 留在该树内的 omp uid 进程仍可经相对路径替换子目录（与 #706「会话删除」同一条）；删不掉的部分留在 `<state>/trash`，宿主不自动清理。
    - `EXDEV` 路径：递归删除期间整棵树仍可被 omp uid 按路径到达，子目录被换成符号链接时删除会被引向别处；删不掉的部分留在账号根下。两者同一文件系统的部署不走这条路径。
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

change `s1f-files-page`（design D17、D18；owner D-21、D-24、D-25、D-26）落地后的登记。转换器的决定与运维步骤在 ADR-0014；本节只登记与 uid 分离有关的部分。
下文的「实测」除另注外都指 #1052（任务 1.3，2026-10-06，记录在该 change 的 `design.md` D18「实测」）。

- **身份**：办公文档由 LibreOffice 解析，输入是不可信文档。配置了 `OMP_USER` 时转换进程以该用户运行，spawn 行与 omp 同形：
  `sudo -n -u <OMP_USER> --preserve-env=PATH,LANG,HOME -- /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> --headless … --convert-to pdf --outdir <job>/out <输入>`（`server/src/preview/office.ts`）。
  环境只有 `PATH`、`LANG`（有则传）、`HOME=<job>`，不继承 app-server 的其它环境。`PATH` 与 `/usr/bin/setpriv` 的前置检查不过即转换失败，不回退为同 uid 启动。
  未配置 `OMP_USER` 时直接启动 `<OFFICE_BIN>`，与 app-server 同 uid（与 omp 在该形态下的处境相同）。
- **sudoers 新增两行**，都只在同时配置了 `OMP_USER` 与 `OFFICE_BIN` 的部署里用得到；没有第三行，不存在 `kill` / `pkill` 规则：
  1. 转换的 spawn 前缀：`<app-user> ALL=(<OMP_USER>) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <OFFICE_BIN> *`。`<OFFICE_BIN>` 处于参数位，转义规则同上文 #351 一节。
  2. 启动时清空 `work`（owner D-24）：`<app-user> ALL=(<OMP_USER>) NOPASSWD: /usr/bin/find <PREVIEW_CACHE_DIR 的绝对路径>/work -mindepth 1 -delete`。参数逐项固定、没有通配、不带 `SETENV`。
     - 这是**提权面的扩大**：应用用户多了一条能以 omp 用户身份执行的命令。作用范围是 `work` 之下的条目（`-mindepth 1` 不删 `work` 自身；`find` 缺省不跟随符号链接；命令以 omp 用户身份运行，删得掉的是它自己本来就删得掉的东西）。
     - 服务端只在同时配置了两个键时、于启动时执行一次 `sudo -n -u <OMP_USER> -- /usr/bin/find <该路径> -mindepth 1 -delete`（`server/src/preview/office-cache.ts`；工作目录 `/`，环境只有 `PATH` 与 `LANG`，不经 `setpriv`），先于受理第一次转换。
       有固定 10 秒的时限，到期或关停时对自己启动的 `sudo` 先发 `SIGTERM`、2 秒后仍在再发 `SIGKILL`（owner D-26）。
     - 失败（规则漏配、路径不符、非 0 退出、超时、被终止）只记一行 `{"event":"preview_work_clear_failed"}`，**不阻止启动**；其后本进程自己的递归删除照常执行。
     - 规则里的路径必须与服务端算出的 `join(PREVIEW_CACHE_DIR, "work")` 逐字相同（相对值按 repo root 解析；词法规范化，不解析符号链接；特殊字符按 sudoers 语法转义），sudo 按字面比对参数。
     - 单次转换之后对作业目录的删除**不提权**，尽力而为。
     - 证据：这条规则与命令在真实 `sudo` 下**未测**（自动化测试用假 `sudo`）；`sudo` 被终止后它之下的 `find` 是否随之结束**未测**（该命令不经 `--pdeathsig`）。
- **目录的 mode**（app uid 持有，都以 `ensureOwnedDir` 建出并校正到精确值：前三个在监听成功后由入口建，`server/src/server.ts`；`<job>` 在每次转换开始时建，`server/src/preview/office.ts`）：

  | 路径 | mode | omp uid |
  | --- | --- | --- |
  | `<PREVIEW_CACHE_DIR>` | `2750` | 只能进入 |
  | `<PREVIEW_CACHE_DIR>/work`、其下每个作业目录 `<job>` | `2770` | 可写（转换的 `HOME`、配置目录与输出都在 `<job>` 下） |
  | `<PREVIEW_CACHE_DIR>/pdf` | `0700` | 不能进入 |

  `PREVIEW_CACHE_DIR` 缺省是 repo root 下的 `var/preview-cache`，不在 `OMP_STATE_DIR` 里。输出 PDF 是从作业目录**复制**成 app uid 自己的 `0600` 新文件再进 `pdf/`，不是改名：
  改名后的文件仍属 omp uid，留着它的文件描述符的进程可以改写所有账号共用的缓存。
- **终止在途转换**（超时、请求方断开、关停；owner D-21：不新增提权规则）：
  - 同 uid 模式：转换进程以新的进程组启动，终止时对进程组发 `SIGKILL`。
  - `OMP_USER` 模式：app uid 无权向 omp uid 的进程发信号（#351 实测 `EPERM`），只对自己启动的 `sudo` 发 `SIGKILL`；`sudo` 的直接子进程由 `--pdeathsig KILL` 随之被内核杀掉。不执行 `kill`、`pkill` 或第二次 `sudo`。
- **已知残余**（owner D-25，按实测写）：`OMP_USER` 模式下直接子进程的后代不随之结束。LibreOffice 的启动程序是包装脚本，它启动 `oosplash`，再由后者派生 `soffice.bin`；
  杀掉 `sudo` 之后 `soffice.bin` **每次都留下**（5 次终止 5 次如此），属 omp uid、被 1 号进程收养、占着 CPU **把整份转换跑完才自行退出**——
  约 25 秒的文档在终止后约 20–23 秒，约 133 秒的文档在终止后 128 秒，长于 60 秒的缺省超时；被放弃的 `<job>/out` 里留下与未中断时字节数相同的完整 PDF。
  它不占转换名额（名额在 `sudo` 退出、`convert` 落定时释放，**读代码推出**），所以主机上实际同时运行的 `soffice.bin` 可以多于 `OFFICE_CONVERT_CONCURRENCY`；
  它用着的 `<job>` 删不掉，留到下次启动的清空（那时它若仍在写，可能删不净，再留到下一次）。与 #351「omp 派生的工具子进程仍可能存活」同类。
  - 查：`ps -u <OMP_USER> -o pid,etime,args | grep -F '<PREVIEW_CACHE_DIR>/work/'`（转换的 argv 带着作业目录，**读代码推出**；实测记录没有逐字写下 `soffice.bin` 自己的命令行，筛不到时按进程名与属主找）。
  - 杀：以 root 或 omp 用户的身份 `kill`；app uid 做不到，也不为此加规则。不处理它也会自己退出。
- **`work` 在运行期间增长**：`OMP_USER` 模式下 app uid 删不掉 `<job>`，转换成功的作业也一样（实测：LibreOffice 把 `<job>/profile` 建成 `0700`、`<job>/.cache` 与 `.config` 建成 `2700`，都属 omp uid，不受 umask `007` 影响；
  递归删除只删掉 `out/` 与空的 `.config/`，其余 `EACCES`）。小文档每个作业留下约 650 KB，被终止的作业另加 20–78 MB 的输出；只在重启时由上面第 2 行规则归零。
- **实测 1.3 的记录**（测试主机容器内的 uid 分离部署，与 #1051 同一套；LibreOffice 24.2.7.2，只装 writer 组件，启动程序 `/usr/bin/soffice`；sudoers 当时只加了上面第 1 行；
  应用用户 umask `007`、工作目录与 `HOME` 为 `2770` 的 `<job>`，手工执行上面的 spawn 行转换一份 docx）：
  - 观察到：退出码 0，约 1.2 秒，`<job>/out/<名>.pdf` 生成（`0660`、属 omp uid 与共享组），应用用户能把它复制进 `pdf/`；`out/` 不必预建。
    `oosplash` 与 `soffice.bin` 的 `Uid:` 四个值都是 omp uid（`sudo` 自身是实际 uid 应用用户、有效 uid root）。
    两个转换各用自己的 `UserInstallation` 同时进行（两个小文档，以及两个各约 25 秒的文档全程重叠），都以退出码 0 结束并各自产出 PDF。
    对 `sudo` 发 `SIGKILL` 共 5 次（约 25 秒的文档在第 3 秒 3 次、第 0.15 秒 1 次；约 133 秒的文档在第 5 秒 1 次）：`sudo` 立即消失，`oosplash` 随之被杀，`soffice.bin` 的表现如上「已知残余」，5 次一致。
  - 没有观察的：对 `sudo` 发 `SIGKILL` 以外的信号；xlsx、pptx；经 `/o/` 路由与产品代码的端到端（属任务 28.6，#1123，尚未进行）；容器之外（1 号进程是容器的 init）；上面第 2 行规则。
    每次转换的标准错误里有一行与结果无关的 `javaldx` 警告。
- **验证**：CI `uid-isolation` job 不设 `OFFICE_BIN`，两行规则在那里都用不到，`.github/scripts/ci-uid-isolation.sh` 写出的 sudoers 不变；转换器的自动化测试用假的转换程序与假 `sudo`，不需要 LibreOffice。
  `OMP_USER` 模式下真实转换的进程 uid、缓存文件属主与经 `/o/` 超时后的残留，待 28.6 的人工验证补记。
