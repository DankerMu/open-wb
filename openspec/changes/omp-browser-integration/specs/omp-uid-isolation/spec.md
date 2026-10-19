# Spec Delta

## MODIFIED Requirements

### Requirement: OMP_USER 配置与 sudo spawn 前缀
Canonical server configuration SHALL accept optional OMP_USER as optional ompUser. Absent SHALL preserve same-uid direct spawn. Present SHALL match1..32 ASCII [a-z_][a-z0-9_-]{0,31} in full without trimming; invalid values SHALL fail before startup effects with one generic failure record. User configuration SHALL reach every runtime spawn generation. Present user SHALL select PATH executable sudo with exact argv ['-n','-u',user,'--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PUPPETEER_EXECUTABLE_PATH',...optionalTmpdirAssignment,'--','/usr/bin/setpriv','--pdeathsig','KILL','--',OMP_BIN,...existingOmpArgs]. The fixed absolute `/usr/bin/setpriv --pdeathsig KILL --` launcher SHALL make the kernel SIGKILL the omp process when its sudo parent dies. When ompUser is present, canonical configuration and the spawn boundary SHALL require `/usr/bin/setpriv` to be an executable file before their respective side effects, sharing one check; with ompUser absent no such check SHALL apply. optionalTmpdirAssignment SHALL be empty when TMPDIR is absent, otherwise exactly one noncredential `TMPDIR=<exact allowlisted value>` argv element before `--`, including an empty value without shell expansion or splitting. Sudo-process env SHALL equal existing allowlist, LANG/TMPDIR/PUPPETEER_EXECUTABLE_PATH optional (the `--preserve-env` list is the fixed string above whether or not `BROWSER_BIN` is configured; an absent variable has nothing to preserve); no upstream secrets or OMP_USER env key or credential KEY=value argv SHALL be added. Missing user SHALL preserve executable, full args, env, cwd, stdio and shell:false. Immediate sudo failure/exit SHALL use existing agent_unavailable and cleanup, without direct fallback. Directory permissions and actual uid/proc isolation are not claimed by this slice.

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

#### Scenario: sudo 保留浏览器路径
- **WHEN** ompUser is `omp` and spawn is captured with `BROWSER_BIN` configured as `/usr/bin/chromium`, and again with it unset
- **THEN** both argv carry the identical `--preserve-env=` element ending in `,WORKBUDDY_MODEL_TOKEN,PUPPETEER_EXECUTABLE_PATH`; the first env holds `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, the second holds no such key; no argv element is `PUPPETEER_EXECUTABLE_PATH=…`

### Requirement: CI uid-isolation job
`.github/workflows/ci.yml` SHALL 新增 ubuntu job `uid-isolation`（`timeout-minutes: 15`）：checkout → setup-node（与其它 node job 相同 `with`）→ `npm ci` → build web/server → `make omp-fetch` → `bash .github/scripts/ci-install-hurl.sh`（与 smoke job 同一固定 8.0.1）→ `bash .github/scripts/ci-uid-isolation.sh`。脚本 SHALL：把 tracked `smoke/fixtures/sandbox/u1/` 复制到 job-owned `SANDBOX_ROOT/u1/`；`groupadd workbuddy`、`useradd -m -G workbuddy omp`、把 runner 用户加入 `workbuddy`、写 `/etc/sudoers.d/workbuddy-omp`（对假 omp 脚本与 `var/omp/omp` 各一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/setpriv --pdeathsig KILL -- <abs path> *`，对 `/usr/bin/env` 一条 `<runner> ALL=(omp) NOPASSWD: SETENV: /usr/bin/env`，`visudo -c` 校验；preflight 不依赖 runner 预置的 `ALL` 规则）、在 `RUNNER_TEMP` 下创建 `SANDBOX_ROOT`/`OMP_STATE_DIR` 并 `chgrp workbuddy && chmod 2770`；由于 runner 预置 `ALL` 规则会掩盖参数匹配，脚本 SHALL 在 preflight 与测试之前，以同一规则生成函数为一个只持有这些规则的检查用户生成等价规则，并经 `sudo -l -U <检查用户> -u omp <command>` 断言带 launcher 与尾参的 OMP_BIN 命令允许、缺 launcher 或零尾参被拒；随后先执行 preflight `sudo -n -u omp --preserve-env=HOME,PATH -- /usr/bin/env`：断言输出含 `HOME=<传入值>` 行（否则脚本非零退出）并打印全部输出（`secure_path` 替换 PATH 与 sudo 注入键的实证），再以 `sg workbuddy -c` 运行 `WORKBUDDY_UID_TEST=1 OMP_USER=omp` 的 Linux 测试文件，并在同一阶段随后串行运行 `WORKBUDDY_OMP_TEST=1` 的 `.github/scripts/ci-uid-isolation.sh` 清单内的全部 `server/test/omp-official-*.test.ts`（官方二进制对照用例；清单是该脚本里同一条 vitest 命令行上列出的文件，其逐字内容由 `scripts/test-ci-harness.sh` 断言，往清单加文件时两处同步；未设该开关时这些文件内的用例全部跳过），再起假上游、以 `OMP_USER=omp` 经 `ci-compiled-server.sh smoke` 运行 `make smoke`（真实 omp 在 sudo 下完成 `chat.hurl`）。job SHALL 进入 `all-checks-passed.needs`；任何一步失败 job 非零且不泄漏 token。`ci-compiled-server.sh` SHALL 透传 `OMP_USER`（未设则不传），该透传行进入 `scripts/test-ci-harness.sh` `contract()` 的 helper 期望行。 job 生成的 sudoers SHALL 含一行 runas Defaults `Defaults>omp umask=0007`（不带 `umask_override`），使 omp 的 umask 不依赖部署机 PAM 与 omp 用户的主组配置；CI harness 的 sudoers 合同 SHALL 校验该行并拒绝去掉它的变异。job 在真实 omp 冒烟成功之后 SHALL 检查真实 omp 写出的会话 `.jsonl` 为 `0660`、其新建的目录不带 other 位，以排除 omp 自行改 umask；找不到任何会话 `.jsonl` SHALL 使 job 失败。 同一检查 SHALL 另断言真实 omp 的运行期状态落在托管布局的 XDG 目录而不在托管配置里：`<OMP_STATE_DIR>/xdg/data/omp/agent.db` 存在，且 `<OMP_STATE_DIR>/home/.omp` 之下没有任何不属于 runner uid 的条目；任一不成立 SHALL 使 job 失败。脚本创建 `OMP_STATE_DIR` 时的 `2770` 由服务启动时校正为 `2750`（「OMP_STATE_DIR 托管布局」），脚本不为此另设权限位。

#### Scenario: job 全绿并入聚合
- WHEN PR CI 运行 `uid-isolation`
- THEN Linux 测试非 skipped 且通过、`make smoke` 五文件全绿、cleanup 后无残留 omp/假上游进程；`all-checks-passed.needs` 含十一个 direct job（change office-convert-sandbox 加入 `office-sidecar`，见 office-preview「转换 sidecar 实现与镜像」；change omp-browser-integration 加入 `browser-image`，见 browser-runtime「CI browser-image job」），任一失败/取消/跳过时聚合非零

#### Scenario: 预检与换组不能假绿
- WHEN HOME preservation, effective shared group, required interpreter, selected test or real-omp smoke fails, or child residue remains
- THEN the job SHALL fail nonzero without weakening the test or retrying as same uid/root; only owned processes are reaped and unrelated runner credentials SHALL NOT enter printed preflight environment

#### Scenario: sudoers 参数匹配不能被预置 ALL 掩盖
- WHEN the generated launcher rule is wrong (missing launcher token, missing trailing wildcard, or wrong escaping)
- THEN the rule check fails the job before tests run, even though the runner's preinstalled `ALL` rule would have allowed the command
