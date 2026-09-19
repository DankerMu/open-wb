# Spec: omp-uid-isolation

## ADDED Requirements

### Requirement: OMP_USER 配置与 sudo spawn 前缀
`server.ts` 配置 seam SHALL 新增可缺省的 `OMP_USER`：缺省表示同 uid 直接 spawn（S0b 行为不变）；显式值 SHALL 匹配 `^[a-z_][a-z0-9_-]{0,31}$`，显式空或不匹配 → 启动前配置失败。`OMP_USER` 设置时 `OmpProcess.spawn` SHALL 以 PATH 上的 `sudo` 为可执行文件，argv 精确为 `["-n","-u",<OMP_USER>,"--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN","--", <OMP_BIN>, ...S0b 规定的 omp 参数]`，sudo 进程自身 env 精确等于 S0b 白名单（`LANG`/`TMPDIR` 缺席时不设）；白名单值 SHALL 不出现在任何 argv 中（`/proc/<pid>/cmdline` 全局可读）；S0b 的目录创建 SHALL 改用 `ensureSharedDir`（`0o2770`）。sudo 非零退出/立即退出 SHALL 走 S0b 既有的 `agent_unavailable` 路径，不重试为同 uid。

#### Scenario: argv 前缀
- WHEN `OMP_USER=omp` 下对 owner u1 冷启动 spawn（捕获 spawn 参数，不起进程）
- THEN 可执行为 `sudo`，argv 精确为 `-n -u omp --preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN -- <OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/u1 …`（不含任何 `KEY=value`）；sudo 进程 env 键集精确等于 `{PATH, LANG?, TMPDIR?, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 父进程有则有），`WORKBUDDY_MODEL_TOKEN` 为 64 hex；未设 `OMP_USER` 时可执行与 argv 与 S0b 断言逐字相同

#### Scenario: 非法配置
- WHEN `OMP_USER` 为空串、`Omp`、`omp user`、`root;id`
- THEN 启动在任何副作用前失败并输出 S0b 规定的 generic failure record

### Requirement: 自有状态不对组可读
非 `:memory:` 的 SQLite 主文件 SHALL 在 `openDb` **之前**即为 `0o600`：入口对缺失文件以 `wx` 模式 `0o600` 创建后关闭，对既有主文件及已存在的 `-wal`/`-shm` `chmod 0o600`；因此 WAL 模式在 open 时创建的 `-wal`/`-shm` 自诞生起为 `0o600`。进程 SHALL 不修改 umask。`dirname(DB_PATH)` 不设 `0o700`（默认布局下它是共享 `var/` 的父目录，design 已记录该缺口）。`SANDBOX_ROOT`、`OMP_STATE_DIR` 以及其下 app-server 创建的目录 SHALL 为 `0o2770`；app-server SHALL 不在这两棵树下写入任何配置、DB 或含上游密钥的文件（`models.yml` 只含 `apiKey: WORKBUDDY_MODEL_TOKEN` 环境变量名，允许）。

#### Scenario: 权限位
- WHEN 以临时 `DB_PATH` 与 `SANDBOX_ROOT` 启动并完成一次工作空间创建
- THEN DB 主文件、`-wal`、`-shm` 三者 mode 均为 `0o600`（首次启动与重启各断言一次）；`SANDBOX_ROOT/u1` 与空间根 `0o2770`；`OMP_STATE_DIR/agent` `0o2770` 且 `models.yml` 全文不含 `MODEL_UPSTREAM_API_KEY` 值

### Requirement: Linux 隔离证明
`server/test/linux/uid-isolation.test.ts` SHALL 仅在 `process.platform === "linux"` 且 `WORKBUDDY_UID_TEST=1` 时执行（否则 `describe.skipIf` 明示跳过），以 `OMP_USER`（来自环境）起 S0b `SessionRuntime` + 假 omp `probe` 模式，向其 prompt `probe:<本进程 pid>:<沙箱内 writePath>`，并断言回报：`uid` ≠ 本进程 uid、`env` 满足 S0b 白名单 ⊆ 键集 且不含 `MODEL_UPSTREAM_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`WORKBUDDY_CANARY_SECRET`（测试进程预先注入这四者；键集 ∖ 白名单 只含 sudo/PAM 并入的键——`SUDO_COMMAND`、`SUDO_USER`、`SUDO_UID`、`SUDO_GID`、`LOGNAME`、`USER`、`MAIL`、`SHELL`、`TERM` 与 PAM 可能并入的 `LANG`/`LC_*`、`/etc/environment` 键，不可枚举故不以闭集断言）、`home`/`agent` 回报值等于传入的 `HOME`/`PI_CODING_AGENT_DIR`（不断言 `PATH` 值——sudoers `secure_path` 会替换它）、`environ=EACCES`、`wrote=ok`；随后断言该文件可被本进程经 workspaces `tree` 列举。假 omp `probe` 模式 SHALL 在 prompt 文本以 `probe:` 开头时先以自身 uid 在 `<writePath>` 写入内容 `probe`，再把 `uid=… gid=… env=<sorted keys> home=<$HOME> agent=<$PI_CODING_AGENT_DIR> environ=<EACCES|readable|errno> wrote=<ok|errno>` 作为一段 `text_delta` 回报后正常 `agent_end`。

#### Scenario: 隔离成立
- WHEN CI `uid-isolation` job 以 `OMP_USER=omp` 运行该测试
- THEN 全部断言通过；同一测试在 macOS 或未设 `WORKBUDDY_UID_TEST` 时报告 skipped 而非通过

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本、`var/omp/omp` 与 `/usr/bin/env` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: <abs path>`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 四文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含八个 direct job，任一失败/取消/跳过时聚合非零

#### Scenario: downgrade 关闭
- WHEN 含 `uid-isolation` job 的 PR 合并且该 job 在 master 全绿
- THEN 后续 PR 删除 `constraints.yaml downgrades` 中 S0b 登记的 `/proc` 凭证读取向量条目；AGENTS.md 不再声明该盲区
