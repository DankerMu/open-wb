## MODIFIED Requirements

### Requirement: OMP_USER 配置与 sudo spawn 前缀
Canonical server configuration SHALL accept optional OMP_USER as optional ompUser. Absent SHALL preserve same-uid direct spawn. Present SHALL match1..32 ASCII [a-z_][a-z0-9_-]{0,31} in full without trimming; invalid values SHALL fail before startup effects with one generic failure record. User configuration SHALL reach every runtime spawn generation. Present user SHALL select PATH executable sudo with exact argv ['-n','-u',user,'--preserve-env=PATH,LANG,TMPDIR,HOME,XDG_DATA_HOME,XDG_STATE_HOME,XDG_CACHE_HOME,PI_CODING_AGENT_DIR,PI_CONFIG_FILES,PI_CONFIG_DIR,OMP_PROFILE,PI_PROFILE,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,OTEL_SDK_DISABLED,PUPPETEER_EXECUTABLE_PATH',...optionalTmpdirAssignment,'--','/usr/bin/setpriv','--pdeathsig','KILL','--',OMP_BIN,...existingOmpArgs]. The fixed absolute `/usr/bin/setpriv --pdeathsig KILL --` launcher SHALL make the kernel SIGKILL the omp process when its sudo parent dies. When ompUser is present, canonical configuration and the spawn boundary SHALL require `/usr/bin/setpriv` to be an executable file before their respective side effects, sharing one check; with ompUser absent no such check SHALL apply. optionalTmpdirAssignment SHALL be empty when TMPDIR is absent, otherwise exactly one noncredential `TMPDIR=<exact allowlisted value>` argv element before `--`, including an empty value without shell expansion or splitting. Sudo-process env SHALL equal existing allowlist (which includes `PI_BROWSER_RELAY=0`, `PI_BROWSER_CMUX=0`, `PUPPETEER_PROXY=direct://`, `PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0` and `OTEL_SDK_DISABLED=true`, omp-runtime「子进程 spawn 契约」; preserving them is what keeps the pins effective under sudo), LANG/TMPDIR/PUPPETEER_EXECUTABLE_PATH optional (the `--preserve-env` list is the fixed string above whether or not `BROWSER_BIN` is configured; an absent variable has nothing to preserve); no upstream secrets or OMP_USER env key or credential KEY=value argv SHALL be added. Missing user SHALL preserve executable, full args, env, cwd, stdio and shell:false. Immediate sudo failure/exit SHALL use existing agent_unavailable and cleanup, without direct fallback. Directory permissions and actual uid/proc isolation are not claimed by this slice.

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
- **THEN** both argv carry the identical `--preserve-env=` element ending in `,WORKBUDDY_MODEL_TOKEN,PI_BROWSER_RELAY,PI_BROWSER_CMUX,PUPPETEER_PROXY,PUPPETEER_PROXY_IGNORE_CERT_ERRORS,OTEL_SDK_DISABLED,PUPPETEER_EXECUTABLE_PATH`; both env hold `PI_BROWSER_RELAY=0`, `PI_BROWSER_CMUX=0`, `PUPPETEER_PROXY=direct://`, `PUPPETEER_PROXY_IGNORE_CERT_ERRORS=0` and `OTEL_SDK_DISABLED=true`; the first env holds `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, the second holds no such key; no argv element is `KEY=value` for any of these six keys
