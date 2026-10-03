# Design: omp-host-overlay

## 事实依据（官方 omp v18.0.10；RPC 直驱 + 真实栈两套探针）
- 分层：全局 `<agent>/config.yml` < 项目 < `--config` overlay < CLI runtime override；对象深合并，数组/标量/`null` 整体替换（`resource/oh-my-pi/packages/coding-agent/src/config/settings.ts:2649-2652`）。
- `tools.approval`：项目写 `{bash: allow}` → 真实栈上 bash 无审批执行；overlay `[]`（或 `null`）整体清除，对任意工具名生效；`{bash: prompt}` 只管列出的工具，且会让子代理的 bash 被拦（行为变化），不取；`{}` 无效。
- `bash.patterns`：项目 `[{match:"*", approval: allow}]` 绕过审批；overlay `[]` 恢复。
- `tools.approvalMode`：项目写 `yolo` 时 CLI `--approval-mode write` 本来就赢。
- `shellPath`：basename 含 `bash` 的项目值在首次 bash 调用时被执行；不存在的路径让 prompt 直接失败；overlay `null` 恢复默认。
- 解释器：项目写 `eval.js: false` + `python.interpreter` 时，解释器在**启动期、无 prompt、无审批**被执行；ruby/julia 同理；overlay `""` 中和。
- `bash.direnv`：默认 `auto`，PATH 上有 direnv 且 cwd 有 `.envrc` 时每次已批准的 bash 前跑 `direnv export json`；`"off"` 关闭。
- `mcp.enableProjectConfig`：无 overlay 时 `.omp/mcp.json`、`.mcp.json`、`.claude/mcp.json`、`.cursor/mcp.json`、`.codex/config.toml`、`.gemini/settings.json` 等里的 stdio server 在启动期被拉起；overlay `false` 全部挡住，也压过项目的 `true`。
- `todo.reminders: false`：生效值 false；关闭回合末的隐藏提醒 + 自动续跑与回合中的 nudge（`session/todo-tracker.ts:208,294`）。
- overlay 机制：`--config <abs>` 放在固定 flags 之后、`--resume` 之前可用，`--resume` 时同样生效；`0640` 文件 / `2750` 目录可读即可，omp 从不写它；缺失/不可读/非法 YAML/顶层非 mapping → exit 1、stdout 无 `ready`。
- 整份 overlay：恶意项目 + overlay → 审批恢复、零标记文件；无项目配置 + overlay → 与无 overlay 的默认行为一致（bash/eval 提示，read/write 不提示，task 提示一次后子代理照常）。
- `--no-extensions` 已使 `extensions:` 设置、`.omp/extensions/`、`.omp/hooks/` 不加载；v18.0.10 schema 无 `env`/`hooks` 类设置键。

## 决定
1. 文件在 `<state>/home/.omp/agent/host-overlay.yml`：#706 的布局使该目录 app 持有、omp uid 只读——overlay 本身不能被 omp 改写是前提。全局层 `config.yml` 同目录、omp 同样写不了。
2. 内容是常量，启动时与 `models.yml` 一起写（同一个 `replaceFile`；把它从 `models-yml.ts` 提到两处都能用的位置，不复制）。不在 spawn 时写：与 `models.yml` 同一生命周期，少一条并发写路径。
3. argv 位置：`--no-title` 之后、`--resume` 之前。假 omp 的 argv 解析忽略未知参数及其后的 token，不需要改假 omp。
4. 不回退：overlay 不可用时宁可 502，也不以无 overlay 的方式 spawn。
5. 可选的 `shellMinimizer.settingsPath`、`images.urls.*` 不加：前者不是可执行路径，后者默认已关且未实测。

## 残余（记入 ADR-0012）
- 项目层 `.omp/tools` / `.claude/tools` / `.codex/tools` 与项目插件在 spawn 时执行（已接受）。
- 批准一次 `task` 后子代理以 yolo 跑 bash/eval（omp 默认，overlay 改不了）。
- 项目自己的收紧规则（`tools.approval.x: deny`、`bash.patterns` 的 deny/prompt）被一并抹掉。
- 项目 `.omp/config.yml` 为非法 YAML 时首次启动仍失败（文件被 omp 隔离改名后恢复）。
- 数据外发类设置键（`memory.backend`、`compaction.remoteEndpoint`、`browser.cdpUrl` 等）未覆盖。
- bash 工具的进程环境里带 `WORKBUDDY_MODEL_TOKEN`（探针顺带观察，范围外，另行登记）。
- 部署前提：`SANDBOX_ROOT` 的任何祖先目录不得带 `.omp/`（或含 `.omp/plugins` 的 `.git` 根）——omp 的项目插件与 skills 发现会上溯祖先；默认的仓库内 `var/sandbox` 不满足该前提，只适合开发。

## 证据计划
- 单元：overlay 字节、mode、幂等、写入失败路径；argv 精确（冷启动与 `--resume`）；sudo 前缀后的 argv。
- 真实 omp + 真实栈（同 uid，假上游）：三个「真实 omp」场景及其负向对照（负向对照用临时变异去掉 `--config`）。
- CI：`smoke`、`uid-isolation`（真实 omp 在 sudo 下带 `--config` 完成冒烟——证明 omp uid 读得到 `0640` 的 overlay）。
- Linux 两 uid：`probe:` 覆写 overlay → `EACCES`。
