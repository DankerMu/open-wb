# agent 后端：omp 冻结 fork，每活跃会话一个子进程 RPC

需要成熟的 agent 执行内核；omp（MIT）的进程内 SDK 要求 Bun 运行时且 AgentRegistry 单 Main，
单进程承载全部用户会话意味着一崩全站。决定：fork 定死 v18.0.10（`33cc6b9a`），服务端以
`omp --mode rpc`（stdio JSONL）子进程运行，每活跃会话一个，app-server 管生命周期——崩溃隔离、
每用户 cwd、资源限额优于进程内调用的延迟收益；冻结版本换取供应链确定性，高危 CVE 允许例外
cherry-pick 单个安全 commit。分析与减肥策略见 `resource/backend-research.md` §2。

## 2026-09-18 补充：二进制供给（S0b 前置，用户拍板）

S0b 起开发、`make smoke`、CI、测试 VPS 统一使用 **官方 release v18.0.10 二进制**
（`can1357/oh-my-pi` GitHub release 资产 `omp-darwin-arm64` / `omp-linux-x64`，按随附
`SHA256SUMS.txt` 校验）：由 make 目标拉取到 `var/` 下（gitignore），可执行路径经配置注入
app-server，不依赖 PATH 上的任何 omp。理由：与本 ADR 冻结提交及 `resource/oh-my-pi/docs/rpc.md`
协议基准精确一致，且 CI 零构建链。

- 开发机 brew 安装的更高版本（当前 18.2.3）**不是目标**，任何验收不得对其执行。
- 从 `resource/oh-my-pi` 源码自建（bun + natives 构建链）留到 S4a 减肥时引入——届时才需要改源码。
- fork 仓的建立同样是 S4a 的事；S0b 按 IMPLEMENTATION_PLAN 所写"官方全量"执行，不阻塞。
