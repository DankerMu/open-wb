# Spec delta: omp-runtime（#466 fork 临时进程走同一 spawn 契约）

> 以主 spec「子进程 spawn 契约」为底，把末句「regenerate 取得的会话进程 SHALL 走同一 spawn 契约…」按父文整句替换为「fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约…」（#481/#465 延后的 fork 一半）。整块由此与父 delta 同名块一致。Scenario 原样。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（含 `--approval-mode write`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；四个目录在 spawn 时已存在

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, the four directories SHALL already exist, and parent env SHALL remain unchanged

