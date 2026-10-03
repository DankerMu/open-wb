# Proposal: omp-host-overlay（#708，含 #772；owner 决议「分两类对待」+ 方案 B）

## Why
omp 从会话 cwd 加载项目层设置，而 cwd 是 agent 无需审批即可写的目录。`--approval-mode write` 只钉住档位：项目层的 `tools.approval`、`bash.patterns` 可让 exec 档工具不再产生审批请求；`shellPath`、解释器路径、项目 MCP 配置可让宿主在审批之外执行命令（真实栈实测：`tools.approval.bash: allow` 后 bash 无审批直接 done）。另：未完成 todo 的提醒让助手正文出现两段回复（#772）。

## What Changes
- 启动时在托管 agent 目录写 `host-overlay.yml`（`0640`，omp uid 只读——#706 的布局保证），每次 spawn 的 argv 在 `--no-title` 之后加 `--config <绝对路径>`。
- overlay 内容见 omp-runtime ADDED「宿主 overlay」，每个键都在真实 omp v18.0.10 上验证过（探针记录见 design）。
- 规格：omp-runtime MODIFIED「子进程 spawn 契约」+ ADDED「宿主 overlay」；http-service-skeleton MODIFIED「服务启动与装配」；omp-uid-isolation MODIFIED「Linux 隔离证明」。
- ADR-0012（新）：决定、已接受残余、部署前提。

## 不做（owner 决定）
- 项目层 skills / `AGENTS.md` / `RULES.md` / agent 定义照常加载。
- 项目层 `.omp/tools`（及 `.claude/tools`、`.codex/tools`）与项目插件不拦：登记为已接受残余。
- 不扫描、不拒绝工作目录；不改 omp。
- `<state>/home` 下的第三方配置目录不用 `disabledProviders` 压：它不支持按路径生效，整个 provider 关掉会连项目层的同名目录一起关掉；且 omp 自己的运行期状态本就含可写的可加载代码（ADR-0010 2026-10-03 补充），单堵这一处没有收益。登记为残余。
