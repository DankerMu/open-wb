# Proposal: managed-omp-state-layout（#706 第二刀 2a，owner 决议「两刀都做」+「HOME 可写 + 粘滞位」）

## Why
`OMP_STATE_DIR` 今天整棵 `2770`：omp uid 能改写宿主托管的 `models.yml`、在 `agent/skills` 里装或换 skill、改名整个 `agent`/`home` 目录。托管配置跨账号、跨会话生效，一次被提示注入的会话就能持久地影响之后所有会话。把 `agent` 目录直接改成只读不可行：omp 要在 agent 目录里写 `agent.db` 等运行期文件（探针：冷启动即 502）。

## What Changes
- 新布局（omp-runtime ADDED「OMP_STATE_DIR 托管布局」）：托管配置在 `<state>/home/.omp/agent`（app 持有 `2750`，omp 只读），omp 运行期状态经 `XDG_{DATA,STATE,CACHE}_HOME=<state>/xdg/*` 落到 `<state>/xdg/*/omp`（`2770`）；`<state>`、`sessions`、`xdg` 根 `2750`；`<state>/home` `3770`（omp 可写自己的条目，粘滞位护住 `.omp`）；`sessions/<ownerId>` 仍 `2770`。
- spawn 环境去掉 `PI_CODING_AGENT_DIR`、加三个 `XDG_*_HOME`；sudo `--preserve-env` 列表同步。sudoers 规则形态不变。argv 不变。
- 新的 `ensureOwnedDir(path, mode)`（sandbox-core ADDED「托管目录权限位」）：要求目录由 app uid 持有、不是符号链接，每次校正到精确 mode；`ensureOmpStateLayout` 在启动写 `models.yml` 之前与每次 spawn 时调用。
- `writeManagedModelsYml` 不再建目录。
- 假 omp：probe 回报 `agent=` 换成三个 `xdg*=`；新增 `rename:<path>` 探针；`fake-omp-proxy` 从 `$HOME/.omp/agent/models.yml` 读。
- Linux uid-isolation 测试新增托管布局用例（omp uid 的写入/改名全部被拒）；CI job 断言真实 omp 的 `agent.db` 在 `xdg/data/omp`、`home/.omp` 下无 omp 持有的条目。
- ADR-0010 补充（权限模型更新、迁移说明、残余）。

## 不在本 change
- `#758` 递归删除竞态：本 change 把 `<state>/sessions` 收成 `2750`，omp uid 不能再整体替换 `sessions/<ownerId>`，但 `sessions/<ownerId>` 之内仍是 omp 可写——同名产物目录内部的替换竞态由随后的 2b（`session-delete-trash`：先 rename 进 app 私有的 trash 再递归删）关闭。**2b 合并前该竞态仍开着。**
- `--config` overlay 与 `disabledProviders`（#708）。overlay 文件将放在本 change 建立的 `<state>/home/.omp/agent/`。
- 不改 omp；不迁移旧布局的数据（见 design「迁移」）。
