## MODIFIED Requirements

### Requirement: OMP_USER 配置与 sudo spawn 前缀
Canonical server configuration SHALL accept optional OMP_USER as optional ompUser. Absent SHALL preserve same-uid direct spawn. Present SHALL match1..32 ASCII [a-z_][a-z0-9_-]{0,31} in full without trimming; invalid values SHALL fail before startup effects with one generic failure record. User configuration SHALL reach every runtime spawn generation. Present user SHALL select PATH executable sudo with exact argv ['-n','-u',user,'--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,WORKBUDDY_MODEL_TOKEN',...optionalTmpdirAssignment,'--','/usr/bin/setpriv','--pdeathsig','KILL','--',OMP_BIN,...existingOmpArgs]. The fixed absolute `/usr/bin/setpriv --pdeathsig KILL --` launcher SHALL make the kernel SIGKILL the omp process when its sudo parent dies. When ompUser is present, canonical configuration and the spawn boundary SHALL require `/usr/bin/setpriv` to be an executable file before their respective side effects, sharing one check; with ompUser absent no such check SHALL apply. optionalTmpdirAssignment SHALL be empty when TMPDIR is absent, otherwise exactly one noncredential `TMPDIR=<exact allowlisted value>` argv element before `--`, including an empty value without shell expansion or splitting. Sudo-process env SHALL equal existing allowlist, LANG/TMPDIR optional; no upstream secrets or OMP_USER env key or credential KEY=value argv SHALL be added. Missing user SHALL preserve executable, full args, env, cwd, stdio and shell:false. Immediate sudo failure/exit SHALL use existing agent_unavailable and cleanup, without direct fallback. Directory permissions and actual uid/proc isolation are not claimed by this slice.

#### Scenario: 双形态完整 spawn
- WHEN identical cold/resume inputs are captured with user absent and user omp, optionalenv present/absent and contaminated parent
- THEN absent retains exact prior call; present changes only command/prefix including the conditional TMPDIR assignment; env keys/values and parentenv remain unchanged, token/upstream values are absent from argv

#### Scenario: 配置实际抵达运行时
- WHEN configured user omp is used to assemble an app and dispatch a real authenticated session prompt through supervisor/runtime
- THEN captured spawn selects sudo with the exact prefix and allowlist; unset selects direct OMP_BIN, without invoking real sudo

#### Scenario: 非法配置在副作用前失败
- WHEN user is empty, Omp, omp user, root;id, finalnewline/nonASCII or overlength
- THEN config rejects it; each of the four named values at real compiled entry yields exit1, empty application stdout, exactly one generic stderr record, no DBparent/sandbox/state/models creation and no listener

#### Scenario: sudo 立即退出无降级
- WHEN an injected sudo-shaped child exits before RPC ready or spawn fails
- THEN existing agent_unavailable/nativecleanup applies, no prompt success or same-uid retry occurs; no uid isolation claim is made

#### Scenario: Native setuid TMPDIR forwarding
- WHEN a nonroot Linux parent uses native sudo with TMPDIR present (including empty and space/colon/metacharacter values)
- THEN the omp child SHALL observe that exact TMPDIR value; only the TMPDIR assignment is added before the command separator, no credential value enters argv, and existing command authorization is sufficient
- WHEN TMPDIR is absent or ompUser is absent
- THEN no assignment SHALL be invented, and absent-user direct launch SHALL retain its prior args and environment

#### Scenario: sudo 模式缺少 setpriv 启动失败
- WHEN ompUser is present and `/usr/bin/setpriv` is missing or not executable
- THEN configuration fails before startup effects with one generic failure record, and a direct low-level sudo spawn rejects before mkdir/spawn; with ompUser absent startup and direct spawn are unaffected

### Requirement: Linux 隔离证明
`server/test/linux/uid-isolation.test.ts` SHALL 仅在 `process.platform === "linux"` 且 `WORKBUDDY_UID_TEST=1` 时执行，否则使用 `describe.skipIf` 明示跳过。已 opt-in 的测试 SHALL 以环境 OMP_USER 经真实 SessionRuntime 与既有 `omp-test-harness`「假 omp probe 回报」合同执行 `probe:<本进程 pid>:<沙箱内 writePath>`；缺少运行前提 SHALL 失败而非追加 skip。
测试 SHALL 预置 MODEL_UPSTREAM_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、WORKBUDDY_CANARY_SECRET，断言实际child uid不同于父uid，白名单 ⊆ child键集且四预置键全部缺席。sudo/PAM额外键 SHALL 允许，不以闭集断言；HOME 与三个 XDG 目录的回报 SHALL 等于传入值，不断言PATH值。字段按标签解析，空格和冒号路径 SHALL 原样保留。
测试 SHALL 断言实际 `environ=EACCES` 与 `wrote=ok`，随后父进程经 workspaces tree 列举该文件。运行 SHALL 使用测试自有2770沙箱目录、由宿主按「OMP_STATE_DIR 托管布局」建立的状态目录、真实进程与procfs，不以mock/fake errno代替；所有自有进程、临时文件及env修改 SHALL 在完成或失败后清理/恢复，不吞清理失败。测试 SHALL 另含一个 SIGKILL 回收用例：以 ompUser 经真实 SessionRuntime 启动忽略 SIGTERM 与 stdin EOF 的假 omp（经注入 spawnImpl 在 argv 末尾追加 scenario 选择），shutdown 前先正向观测该 ompUser 进程恰为一个，retire 升级到对 sudo 的 SIGKILL 后，在有界时间内观测该 omp 进程消失；进程观测工具的非“无匹配”失败 SHALL 使测试失败而非视为空。该用例无法由测试自身清理 ompUser 残留，SHALL 由 CI job 的 owned-process reap 兜底并使 job 失败。正式 CI job 的装配由独立 CI uid-isolation job 要求负责。 测试 SHALL 另断言 omp uid 经 `sudo → setpriv` 路径写出的文件与目录不带任何 other 权限位且保留组写位：隔离探针写出的文件 `(mode & 0o007) === 0` 且 `(mode & 0o060) === 0o060`；删除用例里 omp 写的分支 `.jsonl`、其同名目录及嵌套子目录同样 other 位为 0、组写位为 1。假 omp 与真 omp 走同一条 sudo 路径、继承同一 umask，因此是 sudo/PAM 继承的充分 oracle。 测试 SHALL 另含一个托管布局用例：经真实 SessionRuntime 以 ompUser spawn 之后（托管 `models.yml` 已由测试经 `writeManagedModelsYml` 写入），用 omp-test-harness 的 `probe:` 与 `rename:` prompt 让 omp uid 逐一尝试——在 `<state>`、`<state>/sessions`、`<state>/xdg`、`<state>/xdg/data`、`<state>/home/.omp`、`<state>/home/.omp/agent` 下新建文件、覆写 `<state>/home/.omp/agent/models.yml` 与同目录的 `host-overlay.yml`（均 SHALL 回报 `wrote=EACCES`）；改名 `<state>/home`、`<state>/sessions`、`<state>/home/.omp/agent`（SHALL `renamed=EACCES`）与改名 `<state>/home/.omp` 与 `<state>/home/.env`（粘滞位，SHALL `renamed=EPERM`）、覆写 `<state>/home/.env`（SHALL `wrote=EACCES`）；在 `<state>/home` 与三个 `<state>/xdg/*/omp` 下新建文件（SHALL `wrote=ok`）。随后父进程 SHALL 断言 `models.yml` 字节未变、被拒路径下没有新条目、四个改名目标仍在原名。

#### Scenario: 隔离成立
- WHEN CI uid-isolation job 在预置共享组及sudoers的Linux环境中以WORKBUDDY_UID_TEST=1 OMP_USER=omp运行该测试
- THEN uid、白名单subset、四键缺席、home/XDG值、EACCES、wrote和父tree列举全部断言通过；该场景不是普通CI的skipped记录

#### Scenario: 非 opt-in 明示跳过
- WHEN 平台不是Linux或WORKBUDDY_UID_TEST不是1
- THEN suite报告skipped而非隔离通过，测试体不创建目录、不改env、不启动子进程，既有server套件保持可运行

#### Scenario: 真实安全边界失败
- WHEN opt-in下实际运行同uid、传入父sentinel、HOME/XDG值被替换、proc可读或子写入/父列举失败
- THEN 测试非零，不更改期望为成功、不重试同uid、不追加skip；资源清理仍执行

#### Scenario: SIGKILL of sudo reaps omp
- WHEN opt-in 下 retire 一个忽略 SIGTERM 与 stdin EOF 的 sudo 启动 omp，使 retire 升级为对 sudo 进程的 SIGKILL
- THEN retire 在预算内结束，sudo 以 SIGKILL 退出，此前观测到的 ompUser omp 进程在有界时间内消失；不以 stdio close 作为回收证据

#### Scenario: omp 侧 umask 由 sudoers 强制
- **WHEN** CI uid-isolation job 的 sudoers 含 `Defaults>omp umask=0007`，调用方以 umask `007` 启动编译服务并运行隔离测试
- **THEN** omp uid 写出的探针文件、分支 `.jsonl` 与目录的 other 位全为 0 且组写位保留
- **WHEN** 该 `Defaults` 行被去掉（部署机 PAM `pam_umask` 给出 `0002`）
- **THEN** 上述 other 位断言失败

#### Scenario: 托管配置对 omp uid 只读
- **WHEN** opt-in 下 omp uid 经 `probe:`/`rename:` 对托管布局逐一尝试写入与改名
- **THEN** 托管目录下的新建、`models.yml` 覆写与四个改名全部以 `EACCES`（`.omp` 的改名为 `EPERM`）回报，`home` 与 `xdg/*/omp` 下的新建回报 ok；父进程观测到托管目录内容与 `models.yml` 字节未变
- **WHEN** 布局里 `<state>/home/.omp/agent` 被改回 `2770`（负向对照，经变异 `ensureOmpStateLayout` 的表值）
- **THEN** 该目录下新建文件的断言失败
