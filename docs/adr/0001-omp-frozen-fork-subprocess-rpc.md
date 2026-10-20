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

## 2026-10-20 补充：钉住版本改为 v18.12.3（#1563 / #1570）

上文 2026-09-18 补充钉的 **v18.0.10 作废**，自 #1570 合入起钉 **官方 release v18.12.3**（`can1357/oh-my-pi`
资产 `omp-darwin-arm64` / `omp-linux-x64`，SHA256 写在 `scripts/omp-fetch.sh`，取自随附 `SHA256SUMS.txt`）。
冻结原则不变：版本只经 `scripts/omp-fetch.sh` 一处钉住（`server/test/support/omp-official.ts` 的 `OMP_VERSION`、
CI 镜像构建的 `--version` 校验、`scripts/test-ci-harness.sh` 的合同字面随它），升级走 OpenSpec change 与官方二进制用例的
先红后绿，不跟随上游滚动。

- 理由（#1560）：v18.0.10 按模型 id 含 `deepseek` 剥掉图片输入（`isTextOnlyDeepSeek`），缺省单模型部署看不了图；该守卫自
  v18.1.0 删除。owner 2026-10-20 选「直接升级」而不是代理别名改写。
- 升级牵动的面（change `omp-pin-18-12`）：子进程以 `--mode rpc-ui` 启动、审批 options 三项、浏览器改经 `eval` prelude
  驱动、会话 cwd 放空 `.git` 作仓库根标记、overlay 固定块改键、`models.yml` 显式 `input`；残余登记在 ADR-0012
  「2026-10-20 补充（#1563）」。
- 开发机 brew 安装的 omp 仍**不是目标**；`make omp-fetch` 对已有的旧二进制先删后拉（第一次退出非零、第二次装好）。
- 回滚：revert 翻转 PR 并 `make omp-fetch`（旧 SHA 随 revert 回来）。
