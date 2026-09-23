# omp-uid-isolation Specification

## Purpose
Define optional omp-user configuration, exact sudo spawn construction, safe PATH preconditions, private SQLite state, and shared-directory permissions while preserving direct-spawn compatibility. Real Linux uid isolation remains a separate verification slice.

## Requirements

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
