## MODIFIED Requirements

### Requirement: OMP_STATE_DIR 托管布局
宿主 SHALL 把 `OMP_STATE_DIR`（下称 `<state>`）分成「托管配置」（app 持有、omp uid 只读）与「omp 运行期状态」（omp uid 可写）两部分，目录与权限位（`mode & 0o7777`）精确如下，全部由 app uid 持有：

| 路径 | mode | 用途 |
| --- | --- | --- |
| `<state>` | `2750` | 根；omp uid 只能进入，不能在其下创建/改名/删除条目 |
| `<state>/home` | `3770` | omp 的 `HOME`；omp uid 可创建自己的条目（工具链缓存等），粘滞位使它不能改名或删除 app 持有的 `.omp` |
| `<state>/home/.env` | `0640`（普通文件） | omp 启动时加载 `$HOME/.env`；由宿主预建（空文件）并持有，粘滞位使 omp uid 不能替换它，见「工作目录 dotenv 钉住」 |
| `<state>/home/.omp`、`<state>/home/.omp/agent` | `2750` | 托管配置：`models.yml`（`0640`）与运维安装的 `skills/` 位于 agent 目录 |
| `<state>/xdg`、`<state>/xdg/data`、`<state>/xdg/state`、`<state>/xdg/cache` | `2750` | XDG 根 |
| `<state>/xdg/data/omp`、`<state>/xdg/state/omp`、`<state>/xdg/cache/omp` | `2770` | omp 运行期状态（`agent.db`、日志、原生模块缓存等）；omp 只在该目录已存在时才启用对应的 XDG 重定向，因此三者 SHALL 由宿主预先建出 |
| `<state>/sessions` | `2750` | 会话目录的父目录 |
| `<state>/sessions/<ownerId>` | `2770` | `--session-dir`，spawn 时按需建立 |
| `<state>/trash` | `0700` | app 私有：会话删除先把产物目录移到这里再递归删除（session-metadata「会话删除」），临时空间目录的删除同样经它中转（temporary-workspaces「临时空间目录的删除」）；omp uid 不能进入 |
| `<state>/snapshots` | `0700` | app 私有：每个回合开始前的工作空间快照（workspace-snapshots「快照的存放位置」）；omp uid 不能进入、列举或改写 |

这些路径 SHALL 只有一个来源：`server/src/sessions/omp/` 下的一个模块导出 `ompTrashDir(stateDir)`、`ompSnapshotsDir(stateDir)`（= `<state>/snapshots`）、`ompHome(stateDir)`、`ompAgentDir(stateDir)`（= `<state>/home/.omp/agent`）、`ompXdgHome(stateDir, "data"|"state"|"cache")`、`ompSessionDir(stateDir, ownerId)` 与 `ensureOmpStateLayout(stateDir)`；`server.ts`、`createApp`、spawn 与会话删除 SHALL 经它们取路径，不得再拼 `join(stateDir, "agent")` 一类的字面量。旧布局的 `<state>/agent` SHALL 不再被读写（遗留目录原样留在磁盘，宿主不迁移也不删除）。

`ensureOmpStateLayout(stateDir)` SHALL 先在 `<state>` 缺失时以递归 `mkdir` 建出它及缺失的父级（不改父级权限位），再取 `<state>` 的内核 realpath（`OMP_STATE_DIR` 自身可以是运维放置的、指向目录的符号链接——既有部署形态，会话删除按同一 realpath 校验），然后对表中除 `sessions/<ownerId>` 之外的每个目录、以解析后的根为基、按父先于子的顺序调用 sandbox-core「托管目录权限位」的 `ensureOwnedDir(path, mode)`；根以下的各级不得是符号链接。`<state>/home` 缺失时 SHALL 先以不对组开放的权限位建出，待 `home/.omp` 与 `home/.omp/agent` 建好之后才校正为 `3770`——否则冷建期间一个残留的 omp uid 进程可以抢先建出 `home/.omp`，使布局因归属不符而失败；`ensureOwnedDir` 新建目录时 SHALL 直接以目标 mode 的权限位创建（不经过一个更宽的中间状态）。argv 与环境里的路径仍用配置值（未解析）拼出，与此前一致。它 SHALL 在两处被调用：服务启动时写托管 `models.yml` 之前，以及每次 `spawnOmp` 准备目录时（随后对 `sessions/<ownerId>` 以 `2770` 调同一 `ensureOwnedDir`）；因此被外部改宽的权限位在下一次 spawn 前被校正，而不属于 app uid 的目录、符号链接或非目录条目使启动失败（既有 generic `server_start_failed` 路径）或使该次 spawn 以「Directory preparation failure」失败，绝不被跟随或沿用。宿主 SHALL NOT chown、不改进程 umask；组归属由部署经 setgid 继承（ADR-0010）。同 uid 部署（`OMP_USER` 缺席）使用同一布局与同一权限位。

部署前提（ADR-0010，宿主不检查）：`<state>` 的父目录不得对 omp uid 可写（否则 `<state>` 可被整体改名替换）；`skills/` 及其内容由运维以 app uid（或 root）安装且不对 omp uid 可写。

#### Scenario: 冷布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout` 后再对 owner `u1` spawn
- **THEN** 表中每个目录存在、由本进程 uid 持有且 `mode & 0o7777` 精确等于表值；再次调用不改变任何 mode、不抛错

#### Scenario: 被改宽的目录被校正
- **WHEN** `<state>`、`<state>/home/.omp/agent` 与 `<state>/sessions` 被预先 `chmod 2770`、`<state>/home` 被 `chmod 2770`（无粘滞位）后调 `ensureOmpStateLayout`
- **THEN** 四者回到表值

#### Scenario: 被占位的路径不被跟随
- **WHEN** 根以下的 `<state>/home/.omp` 是指向别处目录的符号链接，或 `<state>/xdg` 是普通文件，或 `<state>/sessions/u1` 是符号链接
- **THEN** `ensureOmpStateLayout`（前两者）/ spawn 的目录准备（第三者）抛错，链接目标的 mode 与内容不变，不 spawn 任何子进程

#### Scenario: 状态根是符号链接
- **WHEN** `OMP_STATE_DIR` 是指向一个既有目录 `D` 的符号链接，服务启动并 spawn
- **THEN** 布局建立在 `D` 之下且 `D` 的 mode 为 `2750`，启动与 spawn 成功，`HOME` 与 `--session-dir` 仍以配置路径（经链接）给出

#### Scenario: 遗留 agent 目录被忽略
- **WHEN** `<state>/agent/models.yml` 与 `<state>/agent/skills/x/SKILL.md` 存在（旧布局），服务启动并 spawn
- **THEN** 托管 `models.yml` 写在 `<state>/home/.omp/agent/`，命令目录不含 `skill:x`，`<state>/agent` 下的文件字节与 mode 不变

#### Scenario: 冷建时 home 在 .omp 就位前不对组开放
- **WHEN** 对不存在的 `<state>` 调 `ensureOmpStateLayout`，并在 `home/.omp` 被创建的那一刻观测 `<state>/home` 的 mode
- **THEN** 此刻 `home` 的组与 other 权限位全为 0；调用返回后 `home` 为 `3770`、`trash` 为 `0700`

#### Scenario: 快照目录属于布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout`；另一次 `<state>/snapshots` 被预先 `chmod 0770`；再一次它是指向别处目录的符号链接
- **THEN** 第一种 `<state>/snapshots` 存在、由本进程 uid 持有且 `mode & 0o7777` 为 `0o700`；第二种被校正回 `0o700`；第三种 `ensureOmpStateLayout` 抛错且链接目标的 mode 与内容不变
