# Spec delta: omp-runtime（S1c B 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；基线为 change A（`s1c-turn-control-governance`）对同名 Requirement 的重述文本（A 先于 B 归档），归档时以本文整段替换同名 Requirement，未在此重述的 Requirement 不变。B 相对 A 只改 `--cwd` 取值并补齐子进程工作目录与 `--resume` 下 cwd 的约定。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` session-dir、home、agent 三个目录；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并 `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话；fork 新会话继承源会话 `workspace_id`，故其后续进程与源会话同根）。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd；见 vendored omp v18.0.10 `coding-agent/src/main.ts:728-775,1697-1712`、`session-manager.ts:2846-2871`），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--cwd <SANDBOX_ROOT>/u1`，含 `--approval-mode write`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；session-dir、home、agent 与作为 cwd 的所有者根四个目录在 spawn 时已存在（事先不存在的由宿主 `mkdir -p` 建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir, home and agent SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates), and parent env SHALL remain unchanged

#### Scenario: 绑定空间的会话以空间根为 cwd
- **WHEN** owner `u1` 的会话绑定了 `dir` 为 `proj` 的工作空间（`workspace_id` 非 null），其首个 prompt 触发 spawn，随后 resume spawn，且同一 owner 另有一个未绑定会话 spawn
- **THEN** `<SANDBOX_ROOT>/u1/proj` 在首次 spawn 前已由工作空间创建建出，宿主只校验不创建；绑定会话两次 spawn 的 argv 都含 `--cwd <SANDBOX_ROOT>/u1/proj`，其余参数与未绑定会话逐字相同（`--session-dir <OMP_STATE_DIR>/sessions/u1` 不随空间变化）；真实 fake 子进程经 probe 回报的 `cwd=` 等于 `<SANDBOX_ROOT>/u1/proj`（`process.cwd()` 的真实路径）；未绑定会话的 `--cwd` 与 probe `cwd=` 仍为 `<SANDBOX_ROOT>/u1`

#### Scenario: 绑定空间根缺失时不创建不 spawn
- **WHEN** owner `u1` 绑定 `proj` 的会话在下一次 spawn 前，`<SANDBOX_ROOT>/u1/proj` 被应用之外的操作删除（或被同名文件占据）
- **THEN** 宿主的存在性检查失败，`spawnOmp` 不被调用、没有子进程、不签发可用 token；`<SANDBOX_ROOT>/u1/proj` 仍不存在（未被 `mkdir -p` 重建）；没有以 `<SANDBOX_ROOT>/u1` 或任何其它路径替代 spawn

#### Scenario: resume 以会话文件头的 cwd 为准
- **WHEN** 一个已持久化 `omp_session_file` 的会话被 resume spawn，而 spawn 传入的 `--cwd` 与该文件头记录的 cwd 不同（例如同一 owner 的另一目录）
- **THEN** 这是宿主依赖的 omp 行为而非宿主实现：真实 omp 在该目录可进入时以文件头 cwd 为会话工作目录，后传的 `--cwd` 不迁移已存在的会话；宿主侧可测的约定是对同一会话（及其 regenerate、fork 进程）的每次 spawn 均传入同一按规则取得的 `<CWD>`，host 测试断言同一绑定会话的首次与 resume argv 中 `--cwd` 逐字相等，fake omp 不模拟此 omp 行为，也不以 fake 结果冒充对它的证明
