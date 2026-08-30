# agent 后端：omp 冻结 fork，每活跃会话一个子进程 RPC

需要成熟的 agent 执行内核；omp（MIT）的进程内 SDK 要求 Bun 运行时且 AgentRegistry 单 Main，
单进程承载全部用户会话意味着一崩全站。决定：fork 定死 v18.0.10（`33cc6b9a`），服务端以
`omp --mode rpc`（stdio JSONL）子进程运行，每活跃会话一个，app-server 管生命周期——崩溃隔离、
每用户 cwd、资源限额优于进程内调用的延迟收益；冻结版本换取供应链确定性，高危 CVE 允许例外
cherry-pick 单个安全 commit。分析与减肥策略见 `resource/backend-research.md` §2。
