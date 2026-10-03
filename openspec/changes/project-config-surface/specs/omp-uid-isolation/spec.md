## MODIFIED Requirements

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本与 `var/omp/omp` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <abs path> *`，对 `/usr/bin/env` 一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/env`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；由于 runner 预置 `ALL` 规则会掩盖参数匹配，脚本 SHALL 在 preflight 与测试之前，以同一规则生成函数为一个只持有这些规则的检查用户生成等价规则，并经 `sudo -l -U <检查用户> -u omp <command>` 断言带 launcher 与尾参的 OMP_BIN 命令允许、缺 launcher 或零尾参被拒；随后先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，并在同一阶段随后串行运行 `WORKBUDDY_OMP_TEST=1` 的 `server/test/omp-official-skills.test.ts`（官方二进制对照用例，chat-sessions「Slash 命令白名单与命令目录」；未设该开关时文件内用例全部跳过），再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。 job 生成的 sudoers SHALL 含一行 runas Defaults `Defaults>omp umask=0007`（不带 `umask_override`），使 omp 的 umask 不依赖部署机 PAM 与 omp 用户的主组配置；CI harness 的 sudoers 合同 SHALL 校验该行并拒绝去掉它的变异。job 在真实 omp 冒烟成功之后 SHALL 检查真实 omp 写出的会话 `.jsonl` 为 `0660`、其新建的目录不带 other 位，以排除 omp 自行改 umask；找不到任何会话 `.jsonl` SHALL 使 job 失败。 同一检查 SHALL 另断言真实 omp 的运行期状态落在托管布局的 XDG 目录而不在托管配置里：`<OMP_STATE_DIR>/xdg/data/omp/agent.db` 存在，且 `<OMP_STATE_DIR>/home/.omp` 之下没有任何不属于 runner uid 的条目；任一不成立 SHALL 使 job 失败。脚本创建 `OMP_STATE_DIR` 时的 `2770` 由服务启动时校正为 `2750`（「OMP_STATE_DIR 托管布局」），脚本不为此另设权限位。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 五文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含八个 direct job，任一失败/取消/跳过时聚合非零

#### Scenario: 预检与换组不能假绿
- WHEN HOME preservation, effective shared group, required interpreter, selected test or real-omp smoke fails, or child residue remains
- THEN the job SHALL fail nonzero without weakening the test or retrying as same uid/root; only owned processes are reaped and unrelated runner credentials SHALL NOT enter printed preflight environment

#### Scenario: sudoers 参数匹配不能被预置 ALL 掩盖
- WHEN the generated launcher rule is wrong (missing launcher token, missing trailing wildcard, or wrong escaping)
- THEN the rule check fails the job before tests run, even though the runner's preinstalled `ALL` rule would have allowed the command
