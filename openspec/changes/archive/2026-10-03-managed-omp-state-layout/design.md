# Design: managed-omp-state-layout

## 事实依据（真实 omp v18.0.10）
- XDG 重定向条件（`resource/oh-my-pi/packages/utils/src/dirs.ts:315-373`）：仅当 agent 目录是默认的 `$HOME/.omp/agent`（即未设 `PI_CODING_AGENT_DIR`）且 `$XDG_*_HOME/omp` **已存在**时，对应类别才重定向；不存在则回落到 `~/.omp`。所以宿主必须预建三个 `xdg/*/omp`。Linux 与 darwin 都生效。
- 重定向到 XDG 的是运行期状态（同文件 `:583-983`）：`agent.db`、`models.db`、`history.db`、`sessions`、`blobs`、`plugins`、`natives`、`logs`、`run/daemons`、各类 cache。`models.yml`、`config.yml`、`skills/` 仍从 agent 目录读。
- 探针（一次性 Linux 容器，app/omp 两个 uid，sudoers 为 ADR-0010 规则 + `umask=0007`，编译后的服务 + 假上游）：
  - agent 目录直接只读（保留 `PI_CODING_AGENT_DIR`）：prompt → 502，omp 建不了 `agent.db`。
  - 本布局：`/api/commands` 列出托管 skill；冷启动回合（含 bash + 审批）、空闲回收后的 `--resume` 回合、`/skill:` 回合、fork 及其回合、DELETE 全部成功；omp 成功的写入全部落在 `xdg/data/omp/{agent.db*,models.db,natives/}`、`xdg/state/omp/{logs,run}`、`xdg/cache/omp/`；omp uid 对 `models.yml`、`skills/`、`.omp`、`<state>/home` 的写/删/改名全部 `Permission denied`，读 `models.yml` 成功。
  - HOME 只读（`2750`）：`npm install`（`~/.npm`）与 `git config --global` 失败 → owner 选「HOME 可写 + 粘滞位」。HOME `2770` 无粘滞位：omp uid 可 `mv .omp .omp2`。HOME `3770` + app 持有的 `.omp`：工具链可用，`mv .omp` → `Operation not permitted`。
- `<state>` 自身必须对 omp uid 不可写，否则 `home` 可被整体改名替换（探针实测）。
  - 最终布局复测（本 change 的表原样：`<state>`/`sessions`/`xdg` 根 `2750`、`home` `3770`）：同一组回合全部 done，服务日志无权限错误；omp uid 的 `touch <state>/x`、`touch sessions/x`、`mv sessions/u1`、`touch xdg/data/x` → `Permission denied`，`mv home/.omp` → `Operation not permitted`，`home` 与 `xdg/data/omp` 下新建/删除成功。
- XDG 生效后 omp 仍会尝试写 `~/.omp` 的几处都不阻断默认流程：`install-id`（`utils/src/dirs.ts:1061-1108`，失败被吞，每进程换新 id）、`config.yml` 保存（`coding-agent/src/config/settings.ts:2516`，仅告警）、`edit/blackbox.ts:53`（默认关）；`launch/client.ts:485-489` 的 `~/.omp/run/daemons/global` 只在 `browser.relay` 打开时走到（默认 false）。
- `OMP_STATE_DIR` 可以是符号链接（`session-delete` 与其测试用例 (l) 按 realpath 校验）：布局对根取 realpath 后再应用，根以下不允许符号链接。

## 决定
1. **布局与权限位**：见 omp-runtime delta 的表。`skills/` 不由宿主建立也不校正——它是运维安装的内容（可以是指向别处的符号链接，第一刀的 realpath 约束仍然生效）；agent 目录 `2750` 已保证 omp uid 不能替换 `skills` 这个条目。
2. **`ensureOwnedDir` 而不是 `ensureSharedDir`**：后者只给新建分量设位、不看归属。托管布局需要「每次都是这个值、且是我的目录」，否则旧部署遗留的 `2770` 或 omp uid 预先放置的目录会被沿用。失败是硬失败：启动走 generic `server_start_failed`（既有合同不带细节），spawn 走既有目录准备失败（502 `agent_unavailable`）；`Error.message` 带路径与期望 mode，供测试与日志使用。
3. **两处调用**：启动（listen 之后、写 `models.yml` 之前，原 `ensureSharedDir(agentDir)` 的位置）与每次 `spawnOmp`。每次 spawn 重跑整套（十来个同步 `mkdir`+`lstat`）换来：单元测试直接调 `spawnOmp` 仍能自建布局；运行中被改宽的位在下一次 spawn 前回正。
4. **路径单一来源**：`server/src/sessions/omp/state-layout.ts`（新）放路径函数与 `ensureOmpStateLayout`；`process.ts` 改为从它导入，并须继续 re-export `ompSessionDir`/`ompAgentDir`（chat-sessions 规格写的是「exported by `sessions/omp/process.ts`」）。`server.ts:301` 的 `join(config.ompStateDir, "agent")` 改用它。
5. **spawn 环境**：键集 `{PATH, LANG?, TMPDIR?, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, WORKBUDDY_MODEL_TOKEN}`；sudo `--preserve-env` 同序。argv 与 sudoers 规则不变（规则只约束命令行）。
6. **`writeManagedModelsYml` 不建目录**：目录由布局建立；写入器只做临时文件 + rename（第一刀）。
7. **CI**：`ci-uid-isolation.sh` 仍 `chmod 2770 "$OMP_STATE_DIR"`（服务启动时回正为 `2750`，正好覆盖「被改宽的目录被校正」）；只在 `check_omp_modes` 加两条断言。CI 的 `job_root` 对 omp uid 可写，不满足「`<state>` 父目录不可写」的部署前提——CI 证明的是布局之内的权限，不是该前提。

## 迁移（记入 ADR-0010 补充，宿主不自动做）
- 旧 `<state>/agent` 不再读写：`skills/` 由运维移到 `<state>/home/.omp/agent/skills`（以 app uid 持有、组只读）；旧 `agent.db` 等可删。会话文件（`sessions/<ownerId>/*.jsonl`）位置不变，旧会话可继续 `--resume`，omp 以新的空 `agent.db` 启动。
- sudo 模式的旧部署里 `<state>/home/.omp` 是 omp uid 建的（`natives/`、`logs/`）：升级前必须删掉，否则 `ensureOwnedDir` 因归属不符使启动失败。同 uid 部署无此问题（全是 app uid 的目录，直接被校正）。
- 不自动搬 `skills`：旧目录对 omp uid 可写，把其中内容搬进受信目录等于把不受信内容升格。

## 残余（如实登记）
- `<state>/home` 对 omp uid 可写：它可以在 HOME 下建 `~/.claude`、`~/.codex` 等第三方配置目录，omp 的第三方 provider 会读。由 #708 的 overlay（`disabledProviders`）处理；本 change 不关。
- omp 运行期状态里有可加载的代码：`<state>/xdg/data/omp` 下的 `natives/`（原生模块解包，探针实测落在 data 目录）、`plugins/`（用户级插件），以及 `agent.db`。它们必须对 omp uid 可写，所以 omp uid 能跨会话、跨账号持久化代码与设置——所有账号共用一个 omp uid（ADR-0010）决定了这一点，本布局关不掉；单把 `plugins/` 做成只读没有意义（`natives/` 同样可写）。与 owner 在 #708 接受的「项目插件/工具不拦」同属受信局域网下的残余，在 ADR-0010 补充登记。
- `install-id` 写不进 `~/.omp`：omp 每个进程用一个新的随机 id（只影响 omp 自己的遥测标识）。
- `sessions/<ownerId>` 之内的删除竞态：2b。
- 部署前提不由宿主检查：`<state>` 的父目录对 omp uid 不可写；`skills/` 内容不对 omp uid 可写。

## 证据计划
- 单元（macOS/Linux 同 uid）：布局 mode、幂等、校正、符号链接/文件占位、遗留 `agent` 被忽略、spawn env/argv 精确值、sudo 前缀、`models.yml` 位置与不建目录。
- Linux 两 uid（CI `uid-isolation`，假 omp）：托管布局用例的全部写入/改名回报。
- 真实 omp：CI `smoke` 与 `uid-isolation` 的 `make smoke`（sudo 下 `chat.hurl`）+ `check_omp_modes` 新断言；本机 `ci-compiled-server.sh smoke`（官方 v18.0.10，同 uid）。
- 旧会话续接：本机用基线构建在一个状态目录里建会话并完成一回合，换成本 change 的构建、同一状态目录，再发一回合 → done（真实 omp + 假上游）。
- 合并后由编排者在演练机容器里补 sudo 两 uid 的真实 omp 走查（含 #758 的 E4b：非空同名产物目录的删除）。
