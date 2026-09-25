# omp-uid-isolation Specification

## Purpose
Define optional omp-user configuration, exact sudo spawn construction including noncredential TMPDIR forwarding, safe PATH preconditions, private SQLite state, shared-directory permissions, and an opt-in real Linux isolation test while preserving direct-spawn compatibility. Formal GitHub job provisioning and deployment downgrade closure remain separate gates.
## Requirements
### Requirement: OMP_USER 配置与 sudo spawn 前缀
Canonical server configuration SHALL accept optional OMP_USER as optional ompUser. Absent SHALL preserve same-uid direct spawn. Present SHALL match1..32 ASCII [a-z_][a-z0-9_-]{0,31} in full without trimming; invalid values SHALL fail before startup effects with one generic failure record. User configuration SHALL reach every runtime spawn generation. Present user SHALL select PATH executable sudo with exact argv ['-n','-u',user,'--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN',...optionalTmpdirAssignment,'--','/usr/bin/setpriv','--pdeathsig','KILL','--',OMP_BIN,...existingOmpArgs]. The fixed absolute `/usr/bin/setpriv --pdeathsig KILL --` launcher SHALL make the kernel SIGKILL the omp process when its sudo parent dies. When ompUser is present, canonical configuration and the spawn boundary SHALL require `/usr/bin/setpriv` to be an executable file before their respective side effects, sharing one check; with ompUser absent no such check SHALL apply. optionalTmpdirAssignment SHALL be empty when TMPDIR is absent, otherwise exactly one noncredential `TMPDIR=<exact allowlisted value>` argv element before `--`, including an empty value without shell expansion or splitting. Sudo-process env SHALL equal existing allowlist, LANG/TMPDIR optional; no upstream secrets or OMP_USER env key or credential KEY=value argv SHALL be added. Missing user SHALL preserve executable, full args, env, cwd, stdio and shell:false. Immediate sudo failure/exit SHALL use existing agent_unavailable and cleanup, without direct fallback. Directory permissions and actual uid/proc isolation are not claimed by this slice.

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

### Requirement: sudo 模式拒绝不安全 PATH
When ompUser is configured, canonical configuration and the spawn boundary SHALL reject missing/empty PATH, empty or relative delimiter-separated entries, and NUL before their respective side effects. They SHALL share one canonical policy, keep valid absolute-only PATH bytes unchanged, and never resolve sudo from a sandbox-relative entry. With ompUser absent, existing direct-spawn PATH behavior SHALL remain unchanged.

#### Scenario: 不得从工作空间执行伪 sudo
- WHEN parent PATH is absent, empty, contains leading/trailing/doubled delimiters or a relative entry, and a harmless executable named sudo exists in the workspace
- THEN configured startup fails with a generic record before effects and direct low-level sudo spawn rejects before mkdir/spawn; the workspace executable never runs
- WHEN the same inputs omit ompUser
- THEN the prior direct executable/args/env behavior is preserved

### Requirement: 自有状态不对组可读
For non-:memory: DB paths, the entry SHALL ensure the SQLite main file mode is0600 before openDb: create a missing file exclusively with wx and0600, close its descriptor, and repair existing main and existing -wal/-shm files to0600 before SQLite opens. Only absent sidecars SHALL be ignored; other preparation failures SHALL fail startup through existing partial-start cleanup. New WAL/SHM SHALL inherit owner-only main permissions from creation. The process SHALL NOT change umask or force DB-parent0700. Existing directory modes SHALL remain unchanged; every missing component created by the app under SANDBOX_ROOT/OMP_STATE_DIR, including roots, sessions/owner, home and agent, SHALL use canonical ensureSharedDir2770. Group ownership SHALL remain deployment-controlled, without application chown. No app configuration, DB or upstream secrets SHALL be written by these paths into shared trees; managed models.yml containing only the WORKBUDDY_MODEL_TOKEN environment variable name remains allowed.

#### Scenario: 冷启动与既有数据库权限
- WHEN real compiled entry starts with absent DB or valid existing main/WAL/SHM initially0644
- THEN all existing files are0600 before SQLite open, live main/WAL/SHM are0600, data is retained and startup publishes normally
- WHEN DB_PATH is :memory:
- THEN no private DB files are created or chmodded

#### Scenario: 权限准备失败关闭
- WHEN main or existing sidecar chmod fails, or private-file creation fails
- THEN entry exits1 with generic failure, no success record/listener/models/child leak, closes owned resources and does not delete existing data

#### Scenario: 共享目录创建与兼容
- WHEN startup publishes managed models and a session subsequently spawns in previously absent shared trees
- THEN all newly created shared path levels including agent are2770 before use; models contain no upstream key, exact prior spawn arguments/environment remain intact
- WHEN shared directories already exist or directory preparation fails
- THEN existing modes are unchanged, process umask is unchanged, and failed preparation prevents spawn/publication through the existing failure path

### Requirement: Linux 隔离证明
`server/test/linux/uid-isolation.test.ts` SHALL 仅在 `process.platform === "linux"` 且 `WORKBUDDY_UID_TEST=1` 时执行，否则使用 `describe.skipIf` 明示跳过。已 opt-in 的测试 SHALL 以环境 OMP_USER 经真实 SessionRuntime 与既有 `omp-test-harness`「假 omp probe 回报」合同执行 `probe:<本进程 pid>:<沙箱内 writePath>`；缺少运行前提 SHALL 失败而非追加 skip。
测试 SHALL 预置 MODEL_UPSTREAM_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、WORKBUDDY_CANARY_SECRET，断言实际child uid不同于父uid，白名单 ⊆ child键集且四预置键全部缺席。sudo/PAM额外键 SHALL 允许，不以闭集断言；HOME/PI_CODING_AGENT_DIR回报 SHALL 等于传入值，不断言PATH值。字段按标签解析，空格和冒号路径 SHALL 原样保留。
测试 SHALL 断言实际 `environ=EACCES` 与 `wrote=ok`，随后父进程经 workspaces tree 列举该文件。运行 SHALL 使用测试自有2770共享目录、真实进程与procfs，不以mock/fake errno代替；所有自有进程、临时文件及env修改 SHALL 在完成或失败后清理/恢复，不吞清理失败。测试 SHALL 另含一个 SIGKILL 回收用例：以 ompUser 经真实 SessionRuntime 启动忽略 SIGTERM 与 stdin EOF 的假 omp（经注入 spawnImpl 在 argv 末尾追加 scenario 选择），shutdown 前先正向观测该 ompUser 进程恰为一个，retire 升级到对 sudo 的 SIGKILL 后，在有界时间内观测该 omp 进程消失；进程观测工具的非“无匹配”失败 SHALL 使测试失败而非视为空。该用例无法由测试自身清理 ompUser 残留，SHALL 由 CI job 的 owned-process reap 兜底并使 job 失败。正式 CI job 的装配由独立 CI uid-isolation job 要求负责。

#### Scenario: 隔离成立
- WHEN CI uid-isolation job 在预置共享组及sudoers的Linux环境中以WORKBUDDY_UID_TEST=1 OMP_USER=omp运行该测试
- THEN uid、白名单subset、四键缺席、home/agent值、EACCES、wrote和父tree列举全部断言通过；该场景不是普通CI的skipped记录

#### Scenario: 非 opt-in 明示跳过
- WHEN 平台不是Linux或WORKBUDDY_UID_TEST不是1
- THEN suite报告skipped而非隔离通过，测试体不创建目录、不改env、不启动子进程，既有server套件保持可运行

#### Scenario: 真实安全边界失败
- WHEN opt-in下实际运行同uid、传入父sentinel、HOME/agent被替换、proc可读或子写入/父列举失败
- THEN 测试非零，不更改期望为成功、不重试同uid、不追加skip；资源清理仍执行

#### Scenario: SIGKILL of sudo reaps omp
- WHEN opt-in 下 retire 一个忽略 SIGTERM 与 stdin EOF 的 sudo 启动 omp，使 retire 升级为对 sudo 进程的 SIGKILL
- THEN retire 在预算内结束，sudo 以 SIGKILL 退出，此前观测到的 ompUser omp 进程在有界时间内消失；不以 stdio close 作为回收证据

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本与 `var/omp/omp` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <abs path> *`，对 `/usr/bin/env` 一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/env`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；由于 runner 预置 `ALL` 规则会掩盖参数匹配，脚本 SHALL 在 preflight 与测试之前，以同一规则生成函数为一个只持有这些规则的检查用户生成等价规则，并经 `sudo -l -U <检查用户> -u omp <command>` 断言带 launcher 与尾参的 OMP_BIN 命令允许、缺 launcher 或零尾参被拒；随后先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 四文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含八个 direct job，任一失败/取消/跳过时聚合非零

#### Scenario: 预检与换组不能假绿
- WHEN HOME preservation, effective shared group, required interpreter, selected test or real-omp smoke fails, or child residue remains
- THEN the job SHALL fail nonzero without weakening the test or retrying as same uid/root; only owned processes are reaped and unrelated runner credentials SHALL NOT enter printed preflight environment

#### Scenario: sudoers 参数匹配不能被预置 ALL 掩盖
- WHEN the generated launcher rule is wrong (missing launcher token, missing trailing wildcard, or wrong escaping)
- THEN the rule check fails the job before tests run, even though the runner's preinstalled `ALL` rule would have allowed the command

### Requirement: 已证明 UID 门禁关闭同 uid 降级
After the official uid-isolation job has passed on merged master and joined all-checks-passed, strictness_profile.downgrades SHALL no longer contain s0b_same_uid_credential_exposure. AGENTS.md Enforcement Index SHALL contain the exact uid 隔离 block row pointing to the existing CI uid-isolation/all-checks-passed jobs, with no invented local target. Known blind spots SHALL not claim the closed proc gap. Other downgrade entries and runtime behavior SHALL remain unchanged. This evidence SHALL NOT be described as certification of any user production deployment or unset-OMP_USER isolation.

#### Scenario: 主分支实证后关闭登记
- **GIVEN** merged-master run35978802687 job107565512880 passed the native1test withoutskip and real-omp four-file smoke, and its aggregate passed
- **WHEN** the registry/docs/oracle closure lands atomically
- **THEN** the active same-UID registration is absent, exact enforcement row is active at block, all other downgrade records remain and guardrails pass

#### Scenario: 关闭合同不可伪造或回退
- **WHEN** a candidate reintroduces the closed active registration, omits/weakens/duplicates the enforcement row, or substitutes a comment/fence/foreign owner for active ownership
- **THEN** the source-derived oracle rejects the invalid control plane, while the valid and restored baseline passes

