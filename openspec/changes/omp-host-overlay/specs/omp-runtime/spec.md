## ADDED Requirements

### Requirement: 宿主 overlay
omp 把会话 cwd 下的项目层设置（`.omp/config.yml`、`.claude/settings.json` 等）与全局层深合并，而 cwd 是 agent 无需审批即可写的目录；`--approval-mode write` 只钉住档位一个键。宿主 SHALL 用 omp 的 `--config` overlay 层（优先级：全局 < 项目 < overlay < CLI runtime override）钉住会绕过审批或在审批之外执行命令的设置键。overlay 文件 SHALL 位于托管 agent 目录、名为 `host-overlay.yml`，路径只有一个来源（与「OMP_STATE_DIR 托管布局」的路径函数同模块导出 `ompHostOverlayPath(stateDir)`）；它 SHALL 在服务启动时、托管布局建立之后与托管 `models.yml` 一起写入，使用与 `models.yml` 相同的替换方式（独占创建的临时文件、mode 精确 `0640`、rename；宿主内只有一份该实现），内容 SHALL 逐字节等于：

```yaml
tools:
  approval: []
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
ruby:
  interpreter: ""
julia:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
```

各键的作用（真实 omp v18.0.10 实测）：`tools.approval: []` 以数组整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与三个 `interpreter: ""` 使项目层不能指定被宿主执行的可执行文件；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）。`tools.approvalMode: write` 与 argv 冗余，保留使文件自洽。overlay 不做 schema 校验，上述取值依赖 v18.0.10 的消费代码：升级 omp 时 SHALL 重新验证。

overlay 缺失、不可读或不是 YAML mapping 时 omp 以非零退出且不发任何帧——宿主按既有的握手失败处理（`agent_unavailable`），SHALL NOT 回退为不带 `--config` 的 spawn。写入失败 SHALL 走与 `models.yml` 写入失败相同的 partial-start failure 路径。

本要求 SHALL NOT 做的（owner 决定，登记于 ADR-0012）：不拦项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义（它们是功能）；不拦项目层 `.omp/tools`、`.claude/tools`、`.codex/tools` 与项目插件在 spawn 时的执行（受信局域网 + uid 隔离下的已接受残余）；不在 spawn 前扫描或拒绝工作目录。

#### Scenario: overlay 写入
- **WHEN** 编译入口冷启动
- **THEN** `<OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 是 mode `0640` 的普通文件，内容逐字节等于上文；重启后字节不变；agent 目录无残留临时文件

#### Scenario: 项目层放行不再绕过审批（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/config.yml`，含 `tools.approval: {bash: allow}` 与 `bash.patterns: [{match: "*", approval: allow}]`，随后一个回合里模型调用 bash
- **THEN** 宿主收到该 bash 调用的审批请求（`chat_approvals` 有行），与无项目配置时一致
- **WHEN** 去掉 argv 里的 `--config`（负向对照）
- **THEN** bash 不经审批直接执行

#### Scenario: 项目层 MCP 不在 spawn 时执行（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/mcp.json`，声明一个会写标记文件的 stdio server，然后 spawn 并完成一个回合
- **THEN** 标记文件不存在
- **WHEN** 去掉 `--config`（负向对照）
- **THEN** 标记文件出现

#### Scenario: 默认行为不变
- **WHEN** cwd 下没有任何项目配置
- **THEN** bash 仍请求审批、文件读写不请求，`make smoke` 的全部既有断言通过

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 启动（`--config` 的取值由「宿主 overlay」规定，恒为绝对路径），**仅当** `chat_sessions.omp_session_file` 非 null 时在其后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；SHALL 不设 `PI_CODING_AGENT_DIR`（omp 因此取默认 agent 目录 `$HOME/.omp/agent`，并只在 agent 目录为默认值时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」），SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话）。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd；见 vendored omp v18.0.10 `coding-agent/src/main.ts:728-775,1697-1712`、`session-manager.ts:2846-2871`），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--cwd <SANDBOX_ROOT>/u1`，含 `--approval-mode write` 与紧随 `--no-title` 的 `--config <overlay 路径>`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；session-dir、「OMP_STATE_DIR 托管布局」的全部目录与作为 cwd 的所有者根在 spawn 时已存在（事先不存在的由宿主建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir and every directory of the managed layout SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates), and parent env SHALL remain unchanged

#### Scenario: 绑定空间的会话以空间根为 cwd
- **WHEN** owner `u1` 的会话绑定了 `dir` 为 `proj` 的工作空间（`workspace_id` 非 null），其首个 prompt 触发 spawn，随后 resume spawn，且同一 owner 另有一个未绑定会话 spawn
- **THEN** `<SANDBOX_ROOT>/u1/proj` 在首次 spawn 前已由工作空间创建建出，宿主只校验不创建；绑定会话两次 spawn 的 argv 都含 `--cwd <SANDBOX_ROOT>/u1/proj`，其余参数与未绑定会话逐字相同（`--session-dir <OMP_STATE_DIR>/sessions/u1` 不随空间变化）；真实 fake 子进程经 probe 回报的 `cwd=` 等于 `<SANDBOX_ROOT>/u1/proj`（`process.cwd()` 的真实路径）；未绑定会话的 `--cwd` 与 probe `cwd=` 仍为 `<SANDBOX_ROOT>/u1`

#### Scenario: 绑定空间根缺失时不创建不 spawn
- **WHEN** owner `u1` 绑定 `proj` 的会话在下一次 spawn 前，`<SANDBOX_ROOT>/u1/proj` 被应用之外的操作删除（或被同名文件占据）
- **THEN** 宿主的存在性检查失败，`spawnOmp` 不被调用、没有子进程、不签发可用 token；`<SANDBOX_ROOT>/u1/proj` 仍不存在（未被 `mkdir -p` 重建）；没有以 `<SANDBOX_ROOT>/u1` 或任何其它路径替代 spawn

#### Scenario: resume 以会话文件头的 cwd 为准
- **WHEN** 一个已持久化 `omp_session_file` 的会话被 resume spawn，而 spawn 传入的 `--cwd` 与该文件头记录的 cwd 不同（例如同一 owner 的另一目录）
- **THEN** 这是宿主依赖的 omp 行为而非宿主实现：真实 omp 在该目录可进入时以文件头 cwd 为会话工作目录，后传的 `--cwd` 不迁移已存在的会话；宿主侧可测的约定是对同一会话（及其 regenerate、fork 进程）的每次 spawn 均传入同一按规则取得的 `<CWD>`，host 测试断言同一绑定会话的首次与 resume argv 中 `--cwd` 逐字相等，fake omp 不模拟此 omp 行为，也不以 fake 结果冒充对它的证明
