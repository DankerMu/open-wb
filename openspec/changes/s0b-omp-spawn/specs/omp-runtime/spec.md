## ADDED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。

#### Scenario: 环境白名单
- WHEN 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- THEN 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- WHEN 对 owner `u1` 首次 spawn 与 resume spawn
- THEN 首次 argv 精确等于契约（无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；四个目录在 spawn 时已存在

#### Scenario: Directory preparation failure
- WHEN a required directory path is obstructed by a file
- THEN preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- WHEN parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- THEN the actual child SHALL observe only the allowlisted keys and supplied token, the four directories SHALL already exist, and parent env SHALL remain unchanged
