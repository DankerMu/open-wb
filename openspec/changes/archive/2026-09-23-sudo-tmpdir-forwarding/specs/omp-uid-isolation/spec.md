## MODIFIED Requirements

### Requirement: OMP_USER 配置与 sudo spawn 前缀
Canonical server configuration SHALL accept optional OMP_USER as optional ompUser. Absent SHALL preserve same-uid direct spawn. Present SHALL match1..32 ASCII [a-z_][a-z0-9_-]{0,31} in full without trimming; invalid values SHALL fail before startup effects with one generic failure record. User configuration SHALL reach every runtime spawn generation. Present user SHALL select PATH executable sudo with exact argv ['-n','-u',user,'--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN',...optionalTmpdirAssignment,'--',OMP_BIN,...existingOmpArgs]. optionalTmpdirAssignment SHALL be empty when TMPDIR is absent, otherwise exactly one noncredential `TMPDIR=<exact allowlisted value>` argv element before `--`, including an empty value without shell expansion or splitting. Sudo-process env SHALL equal existing allowlist, LANG/TMPDIR optional; no upstream secrets or OMP_USER env key or credential KEY=value argv SHALL be added. Missing user SHALL preserve executable, full args, env, cwd, stdio and shell:false. Immediate sudo failure/exit SHALL use existing agent_unavailable and cleanup, without direct fallback. Directory permissions and actual uid/proc isolation are not claimed by this slice.

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

