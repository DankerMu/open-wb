# omp 项目层配置：宿主 overlay 钉住审批相关键，其余作为已接受残余

omp 把会话 cwd（及其祖先）下的项目层内容当作配置加载：设置文件（`.omp/config.yml`、`.claude/settings.json` 等）、MCP 配置、
自定义工具（`.omp/tools` 等）、插件、skills、`AGENTS.md`/`RULES.md`。cwd 是 agent 在 `--approval-mode write` 下无需审批即可写的目录，
所以被监管的一方可以改写监管它的策略（#708）：项目层 `tools.approval` / `bash.patterns` 让 exec 档工具不再请求审批，
`shellPath`、解释器路径与项目 MCP stdio server 让宿主在审批之外执行命令。

决定（owner，2026-10-03）：**分两类对待**。

1. **会绕过审批或在审批之外执行命令的设置键，由宿主 overlay 钉住。** 服务启动时在托管 agent 目录写 `host-overlay.yml`
   （app 持有、omp uid 只读——ADR-0010 2026-10-03 补充的布局），每次 spawn 以 `--config <绝对路径>` 传入；overlay 层高于项目层。
   内容与各键的依据见 omp-runtime 规格「宿主 overlay」。同一 overlay 关闭未完成 todo 的提醒（#772）。
2. **项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义是功能，照常加载。**
3. **项目层自定义工具（`.omp/tools`、`.claude/tools`、`.codex/tools`）与项目插件不拦**，登记为已接受残余：
   部署在受信局域网，omp 以独立 uid 运行（ADR-0010），其所能触及的范围以该 uid 为界。宿主不在 spawn 前扫描或拒绝工作目录。

## Consequences

- 已接受残余：
  - 项目层自定义工具与项目插件在 spawn 时执行，无审批、无步骤行、无审计。
  - 批准一次 `task` 后，子代理以 yolo 运行 bash/eval，不再经宿主审批（omp 默认行为，设置改不了）。
  - 项目自己写的收紧规则（逐工具 `deny`、bash 的 deny/prompt 规则）被 overlay 一并清掉。
  - 项目 `.omp/config.yml` 为非法 YAML 时，该目录下一次 spawn 失败一次（omp 把文件改名隔离后恢复）。
  - 改变数据去向而不执行代码的设置键（记忆后端、远程压缩端点、浏览器 CDP 地址等）未被钉住。
  - 项目层写 `eval: {js: false}` 时，omp 在 spawn 时做 Python 预检并执行 `<cwd>/.venv/bin/python`（overlay 把 `python.interpreter` 清空后走默认发现）；
    需要 cwd 下有带可执行位的该文件，能力不超过上面的项目工具残余，未钉 `eval.js`（钉住会剥夺项目关闭 JS eval 的选择）。
  - 官方 omp 二进制会自动加载 `<cwd>/.env`（实测：其中的 `PI_CONFIG_FILES` 生效）。宿主已设置的环境变量不会被覆盖，
    #802 起宿主显式设置 `PI_CODING_AGENT_DIR` 与 `PI_CONFIG_FILES`（dotenv 不覆盖已有的非空变量），并预建、持有 `<OMP_STATE_DIR>/home/.env`；
    其它未被宿主设置的 `PI_*`/`OMP_*` 变量仍可被工作目录的 `.env` 注入（无法穷举），与项目工具残余同类。
  - omp uid 可写的 `HOME` 下的第三方配置目录（`~/.claude` 等）不用 `disabledProviders` 关：该键不支持按路径生效，
    整个 provider 关掉会连项目层同名目录的功能一起关掉；omp 自己的运行期状态本就含可写的可加载代码（ADR-0010 同日补充）。
- 部署前提：`SANDBOX_ROOT` 的任何祖先目录不得带 `.omp/`（或带 `.omp/plugins` 的 `.git` 根）——omp 的项目插件与 skills 发现会上溯祖先目录。
  默认的仓库内 `var/sandbox` 不满足这一点，只用于开发；部署选独立目录（如 `/srv/workbuddy/sandbox`，同 ADR-0011）。
- overlay 的取值不经 omp 的 schema 校验，依赖 v18.0.10 的消费代码；升级 omp（ADR-0001 的冻结版本变更）时必须重新验证每个键。
- overlay 缺失或不可读时 omp 启动失败，宿主呈现为 502 `agent_unavailable`，不回退为无 overlay 的 spawn。

## Considered Options

- **方案 A：overlay 里用 `disabledProviders` 关掉 native/claude/codex 等发现源**——能拦住项目工具，但同时关掉项目 skills 与说明文件，
  与「skills 是功能」冲突；按路径限定的写法在该层不生效（实测解析为空）。弃。
- **spawn 前扫描工作目录并拒绝带 `.omp/tools` 的目录**——每次 spawn 一次目录遍历，且与 omp 的发现规则（多 provider、上溯祖先、符号链接）
  保持同步的成本高；拒绝 spawn 会把一个被植入的文件变成该空间的拒绝服务。弃。
- **把 cwd 下的 `.omp` 做成 omp uid 不可写**——整个 `.omp` 不可读时 omp 启动失败；只锁 `tools` 子目录拦不住其它 provider 的目录。弃。
