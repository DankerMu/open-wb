# Proposal: omp-dotenv-pinning（#802，owner 决议「预建只读 .env」）

## Why
官方 omp v18.0.10 启动时加载 `<cwd>/.env`、`<agent>/.env`、`$HOME/.omp/.env`、`$HOME/.env`，写入宿主环境里没有或为空的变量。实测（官方二进制，最小环境）：
- `$HOME/.env` 含 `PI_CONFIG_FILES=/不存在` → 启动失败 `Config overlay not found`（该文件确被加载）；
- `<cwd>/.env` 含 `OMP_CONFIG_FILES`/`PI_CONFIG_FILES` → 同样失败，`OMP_` 值胜出；宿主已设 `PI_CONFIG_FILES` 时不受影响；
- `<cwd>/.env` 含 `PI_CODING_AGENT_DIR=<cwd>/evil` → omp 的 `agent.db` 落到 `<cwd>/evil`（agent 目录被改走，#706 的只读托管配置对该目录失效）；宿主显式设 `PI_CODING_AGENT_DIR=<HOME>/.omp/agent` 时 `evil` 为空且 XDG 重定向照常。
`<state>/home` 对 omp uid 可写（#706 的 owner 决定），`home/.env` 对所有账号的所有会话生效。

## What Changes
- 托管布局预建并持有 `<state>/home/.env`（`0640`，内容不管）；新 `ensureOwnedFile`。
- spawn 环境显式设置 `PI_CODING_AGENT_DIR`（= 默认 agent 目录）与 `PI_CONFIG_FILES`（= overlay 路径）；sudo `--preserve-env` 同步。argv 不变（`--config` 保留）。
- 规格：omp-runtime MODIFIED「子进程 spawn 契约」「OMP_STATE_DIR 托管布局」+ ADDED「工作目录 dotenv 钉住」；sandbox-core ADDED「托管文件权限位」；omp-uid-isolation MODIFIED 两条；omp-test-harness MODIFIED 一句。ADR-0010/0012 同步。

## 残余
`<cwd>/.env` 里其它 `PI_*`/`OMP_*` 变量仍生效（无法穷举；与 ADR-0012 的项目工具残余同类）。升级时若 `<state>/home/.env` 已被 omp uid 建出，启动失败（归属不符），运维移走后重启。
