# Spec delta: omp-runtime（S1a 修改）

> 基线是 S0b change `s0b-minimal-chat-loop` 新增（尚未 promoted）的 `子进程 spawn 契约`；本 delta 按仓内先例**整段重述**该 Requirement（含其全部 Scenario），归档时以本文整段替换 S0b 归档后的同名 Requirement。归档顺序：S0b 先于本 change。其余 omp-runtime Requirement（二进制供给、RPC 握手与帧层、每会话生命周期）不变。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`OmpProcess.spawn` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。直接 spawn 时子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL 经 `core/sandbox` 的 `ensureSharedDir` 创建 cwd、session-dir、home、agent 四个目录（新建者 `0o2770`）。**`OMP_USER` 设置时**（ADR-0010 补充）：可执行文件 SHALL 为 PATH 上的 `sudo`，argv 精确为 `["-n","-u",<OMP_USER>,"--preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN",...optionalTmpdirAssignment,"--", <OMP_BIN>, <上述 omp 参数>]`，sudo 进程自身 env 精确等于上述白名单（凭证值仅经 env 传递，SHALL 不出现在 argv；非凭证 TMPDIR 是唯一环境赋值例外——`/proc/<pid>/cmdline` 全局可读）；omp 子进程实际环境 SHALL 满足：白名单 ⊆ 键集；键集 ∖ 白名单 只来自 sudo/PAM（`SUDO_COMMAND`、`SUDO_USER`、`SUDO_UID`、`SUDO_GID`、`LOGNAME`、`USER`、`MAIL`、`SHELL`、`TERM` 与 PAM 可能并入的 `LANG`/`LC_*`、`pam_env` 并入的 `/etc/environment` 键——不可枚举，故不以闭集断言），证明方式为 app-server 进程预置的任何非白名单键（含三密钥键与哨兵键 `WORKBUDDY_CANARY_SECRET`）SHALL 不出现在子进程；`HOME`/`PI_CODING_AGENT_DIR` 的值等于传入值（`PATH` 的值不断言——sudoers `secure_path` 会替换它，`<OMP_BIN>` 为绝对路径不受影响）；sudo 立即退出或非零 SHALL 走既有 `agent_unavailable` 路径，不得回退为同 uid 直接 spawn。`OMP_USER` 未设置时 SHALL 与上述直接 spawn 形态逐字相同。 #239 修正：`optionalTmpdirAssignment` / `[TMPDIR=<value>]` 表示白名单 TMPDIR 已定义（含空串）时，在 `--` 前增加一个 `TMPDIR=<精确值>` argv 元素，缺席时零元素；不经 shell 展开或拆分。此非凭证路径例外跨过 glibc setuid 对 TMPDIR 的剥离，不允许 token/上游密钥上命令行。

#### Scenario: 环境白名单
- WHEN 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`WORKBUDDY_CANARY_SECRET` 的进程内 spawn（`OMP_USER` 未设与设为 `omp` 各一次）
- THEN 直接 spawn 时子进程收到的 env 键集合精确等于白名单，四者均不存在；sudo 形态时 sudo 进程 env 键集合精确等于白名单、sudo 前缀仅可增加非凭证 `TMPDIR=<value>` 环境赋值，omp 子进程键集 ⊇ 白名单、四个预置键均不存在、`HOME`/`PI_CODING_AGENT_DIR` 值为传入值；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- WHEN 对 owner `u1` 首次 spawn 与 resume spawn
- THEN 首次 argv 精确等于契约（无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；四个目录在 spawn 时已存在且新建者 mode `0o2770`

#### Scenario: sudo 前缀
- WHEN `OMP_USER=omp` 下对 owner `u1` 首次 spawn（捕获 spawn 参数，不起进程）
- THEN 可执行为 `sudo`；argv 精确为 `-n -u omp --preserve-env=PATH,LANG,TMPDIR,HOME,PI_CODING_AGENT_DIR,WORKBUDDY_MODEL_TOKEN [TMPDIR=<value>] -- <OMP_BIN> --mode rpc …`（完整 omp 参数，仅允许所述非凭证 TMPDIR 环境赋值）；sudo 进程 env 为 `PATH`、（父进程有则）`LANG`、`TMPDIR`、`HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`、`WORKBUDDY_MODEL_TOKEN=<64hex>`

#### Scenario: Directory preparation failure
- WHEN a required directory path is obstructed by a file
- THEN preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- WHEN parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- THEN direct-spawn children SHALL observe only the allowlisted keys and supplied token; with sudo, the child SHALL satisfy the allowlist-subset and forbidden-sentinel rules above; in both modes the four directories SHALL already exist, and parent env SHALL remain unchanged
