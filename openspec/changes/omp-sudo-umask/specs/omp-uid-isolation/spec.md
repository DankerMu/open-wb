## MODIFIED Requirements

### Requirement: Linux 隔离证明
`server/test/linux/uid-isolation.test.ts` SHALL 仅在 `process.platform === "linux"` 且 `WORKBUDDY_UID_TEST=1` 时执行，否则使用 `describe.skipIf` 明示跳过。已 opt-in 的测试 SHALL 以环境 OMP_USER 经真实 SessionRuntime 与既有 `omp-test-harness`「假 omp probe 回报」合同执行 `probe:<本进程 pid>:<沙箱内 writePath>`；缺少运行前提 SHALL 失败而非追加 skip。
测试 SHALL 预置 MODEL_UPSTREAM_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、WORKBUDDY_CANARY_SECRET，断言实际child uid不同于父uid，白名单 ⊆ child键集且四预置键全部缺席。sudo/PAM额外键 SHALL 允许，不以闭集断言；HOME/PI_CODING_AGENT_DIR回报 SHALL 等于传入值，不断言PATH值。字段按标签解析，空格和冒号路径 SHALL 原样保留。
测试 SHALL 断言实际 `environ=EACCES` 与 `wrote=ok`，随后父进程经 workspaces tree 列举该文件。运行 SHALL 使用测试自有2770共享目录、真实进程与procfs，不以mock/fake errno代替；所有自有进程、临时文件及env修改 SHALL 在完成或失败后清理/恢复，不吞清理失败。测试 SHALL 另含一个 SIGKILL 回收用例：以 ompUser 经真实 SessionRuntime 启动忽略 SIGTERM 与 stdin EOF 的假 omp（经注入 spawnImpl 在 argv 末尾追加 scenario 选择），shutdown 前先正向观测该 ompUser 进程恰为一个，retire 升级到对 sudo 的 SIGKILL 后，在有界时间内观测该 omp 进程消失；进程观测工具的非“无匹配”失败 SHALL 使测试失败而非视为空。该用例无法由测试自身清理 ompUser 残留，SHALL 由 CI job 的 owned-process reap 兜底并使 job 失败。正式 CI job 的装配由独立 CI uid-isolation job 要求负责。 测试 SHALL 另断言 omp uid 经 `sudo → setpriv` 路径写出的文件与目录不带任何 other 权限位且保留组写位：隔离探针写出的文件 `(mode & 0o007) === 0` 且 `(mode & 0o060) === 0o060`；删除用例里 omp 写的分支 `.jsonl` 及 omp 新建的目录同样 other 位为 0、组写位为 1。假 omp 与真 omp 走同一条 sudo 路径、继承同一 umask，因此是 sudo/PAM 继承的充分 oracle。

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

#### Scenario: omp 侧 umask 由 sudoers 强制
- **WHEN** CI uid-isolation job 的 sudoers 含 `Defaults>omp umask=0007`，调用方以 umask `007` 启动编译服务并运行隔离测试
- **THEN** omp uid 写出的探针文件、分支 `.jsonl` 与目录的 other 位全为 0 且组写位保留
- **WHEN** 该 `Defaults` 行被去掉（部署机 PAM `pam_umask` 给出 `0002`）
- **THEN** 上述 other 位断言失败

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本与 `var/omp/omp` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <abs path> *`，对 `/usr/bin/env` 一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/env`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；由于 runner 预置 `ALL` 规则会掩盖参数匹配，脚本 SHALL 在 preflight 与测试之前，以同一规则生成函数为一个只持有这些规则的检查用户生成等价规则，并经 `sudo -l -U <检查用户> -u omp <command>` 断言带 launcher 与尾参的 OMP_BIN 命令允许、缺 launcher 或零尾参被拒；随后先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。 job 生成的 sudoers SHALL 含一行 runas Defaults `Defaults>omp umask=0007`（不带 `umask_override`），使 omp 的 umask 不依赖部署机 PAM 与 omp 用户的主组配置；CI harness 的 sudoers 合同 SHALL 校验该行并拒绝去掉它的变异。job 在真实 omp 冒烟之后 SHALL 检查真实 omp 写出的会话 `.jsonl` 为 `0660`、其新建的目录不带 other 位，以排除 omp 自行改 umask。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 五文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含八个 direct job，任一失败/取消/跳过时聚合非零

#### Scenario: 预检与换组不能假绿
- WHEN HOME preservation, effective shared group, required interpreter, selected test or real-omp smoke fails, or child residue remains
- THEN the job SHALL fail nonzero without weakening the test or retrying as same uid/root; only owned processes are reaped and unrelated runner credentials SHALL NOT enter printed preflight environment

#### Scenario: sudoers 参数匹配不能被预置 ALL 掩盖
- WHEN the generated launcher rule is wrong (missing launcher token, missing trailing wildcard, or wrong escaping)
- THEN the rule check fails the job before tests run, even though the runner's preinstalled `ALL` rule would have allowed the command
