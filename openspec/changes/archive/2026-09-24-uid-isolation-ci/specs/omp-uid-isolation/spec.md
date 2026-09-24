## ADDED Requirements

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本、`var/omp/omp` 与 `/usr/bin/env` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: <abs path>`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 四文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含八个 direct job，任一失败/取消/跳过时聚合非零


#### Scenario: 预检与换组不能假绿
- WHEN HOME preservation, effective shared group, required interpreter, selected test or real-omp smoke fails, or child residue remains
- THEN the job SHALL fail nonzero without weakening the test or retrying as same uid/root; only owned processes are reaped and unrelated runner credentials SHALL NOT enter printed preflight environment
