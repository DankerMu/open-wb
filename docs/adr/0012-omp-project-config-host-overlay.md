# omp 项目层配置：宿主 overlay 钉住审批相关键，其余作为已接受残余

omp 把会话 cwd（及其祖先）下的项目层内容当作配置加载：设置文件（`.omp/config.yml`、`.claude/settings.json` 等）、MCP 配置、
自定义工具（`.omp/tools` 等）、插件、skills、`AGENTS.md`/`RULES.md`。cwd 是 agent 在 `--approval-mode write` 下无需审批即可写的目录（S1g 起档位按会话取值：`write` 与 `yolo` 两档如此，`always-ask` 下写文件也要审批——见文末补充），
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
    #802 起宿主显式设置 `PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`（dotenv 不覆盖已有的非空变量），并预建、持有 `<OMP_STATE_DIR>/home/.env`；
    其它未被宿主设置的 `PI_*`/`OMP_*` 变量仍可被工作目录的 `.env` 注入（无法穷举），与项目工具残余同类。
    omp 自己派生的 worker 子进程继承的是 profile 变量已被 omp 清掉的环境，`<cwd>/.env` 的 `OMP_PROFILE` 可能在 worker 里生效（读源码推断，未实测）；
    `PI_CONFIG_DIR` 仍被钉住，配置根只能落在 app 持有的 `<OMP_STATE_DIR>/home/.omp` 之内，omp uid 建不出，不击穿托管配置的保证。
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

## 补充（2026-10-03，#773）：项目 skill 与项目配置文件的产品面

- **列出范围**：命令目录只列 `.omp/skills`，从会话 cwd 上溯到带 `.git` 的那一级或沙箱根；`GET /api/project-config` 列出 omp 会读取的位置上**存在**的说明文件与 agent 定义（只 `lstat`）。
  两者都在内核 realpath 上进行，解析后的 cwd 不在沙箱根之内时为空；位置表与扫描规则由官方 v18.0.10 的对照用例钉住（uid-isolation job），升级 omp 时必须重跑。
- **不列出但会执行（已接受残余）**：omp 还从 cwd 下的 `.claude`、`.codex`、`.agents`、`.agent`、`.opencode`、`.github`、托管 `HOME` 下的同类目录、以及沙箱根以上的祖先加载 skill；
  这些 skill 的 `/skill:<name>` 被宿主记为文本而 omp 照常执行（omp 的分派先 `trimStart()`，空格前缀挡不住）。被宿主读取规则跳过的项目 skill 同理。
  会话进程启动后才新建的项目 skill 方向相反：宿主记为 skill，omp 当作普通消息，直到进程下次启动。
- **同名**：`.omp` 项目 skill 胜过平台 skill，目录只出项目那一条并标注覆盖；协作者可以用同名项目 skill 替换平台 skill，标注可见但不拦。
- **跨工作空间影响**：沙箱根与 owner 根上的 `.omp` 对其下所有会话生效，而沙箱内目录对单一 omp uid 都可写（ADR-0010）；本决议不改变这一点，只让这些 skill 在目录里可见。
- **项目级 MCP 与项目工具的方向**：长期不支持按工作空间开启。项目级 MCP 继续由 overlay 的 `mcp.enableProjectConfig: false` 关闭；需要 MCP 时由管理员装到平台级配置。
  出现真实的按工作空间需求时另开 issue，以管理员开启加审计为起点。`.omp/tools` 等项目工具仍是上文登记的已接受残余。
- 完整结论、实测事实表与残余清单见已归档的 openspec 变更 `project-config-surface` 的 design。

## 补充（S1g）：审批档位按会话取值

本 ADR 写成时档位钉死 `write`，不在运行期切换。S1g（openspec 变更 `s1g-composer-capabilities`，design D1–D3）改为每个会话有自己的档位：`always-ask`、`write`、`yolo`（界面上的「全部自动」）。上文的两类划分与已接受残余不变，变的只有下面几点。

- **档位由 argv 决定，overlay 不动。** 每次 spawn 的 argv 带 `--approval-mode <该会话的有效档位>`。omp 把 argv 写进运行期覆盖层，这一层高于 overlay，
  所以 `host-overlay.yml` 里的 `tools.approvalMode: write` 只在 argv 缺席时起作用，作为兜底留着。overlay 仍是全局一份、字节不随档位变化，
  `--config` 与 `PI_CONFIG_FILES` 三档下指向同一个文件；没有启用「按档位各写一份 overlay」的退路。
- **实机结论（官方 v18.0.10，2026-10-07；CI uid-isolation job 的对照用例，逐项见该变更 design「实机核对结果」）：**
  - overlay 原样、argv 为 `always-ask`：写文件与 bash 回合各恰一条审批。
  - argv 为 `yolo`：bash 与写文件回合都是 0 条审批，工具都执行。
  - `always-ask` 下项目层写 `tools.approval: {write: allow}`：仍发起写文件审批，项目层绕不过。
  - 换档后以 `--resume` 重启同一会话文件：历史仍在，新档位生效。
- **换档靠重启进程。** omp 的 RPC 没有切换档位的命令。修改档位只写库；下一次派发消息时，若存活进程的启动档位与会话此刻的有效档位不同，先退役它再以 `--resume` 启动。
  在途回合与已弹出的确认卡继续用启动时的档位。
- **overlay 其余键在三档下的作用不变。** `tools.approval: []` 与 `bash.patterns: []` 仍把项目层的逐工具放行与 bash 放行规则整体清掉；
  `shellPath`、三个解释器路径、`bash.direnv`、`mcp.enableProjectConfig`、`todo.reminders`、`images.urls.enabled` 与档位无关。
  `yolo` 下本来就全部放行，项目层无从再放宽；项目层自己写的收紧规则被清掉，仍是上文登记的残余，在 `yolo` 下同样不起作用。
- **`yolo` 是有意的放宽。** 这一档下 exec 档工具（bash、eval 等）不再请求审批，助手不经确认执行命令——上文「被监管的一方改写策略」所防的那种执行，在这一档由用户自己选择放开。约束它的是四件事：
  1. 管理员封顶：`APPROVAL_MAX_MODE` 是档位的上界，缺省 `yolo`（三档都开放）；设为 `write` 即整体关掉这一档，超界的选择在读取时被夹取。
  2. 选择时确认：在界面上选「全部自动」要确认一次，选中后常驻警示色。新会话继承最近一次选择时不再弹确认，警示色与创建审计仍在。
  3. 审计：有效档位每次变化、以及每个以非缺省档创建的会话，都写一条 `session.permission`。
  4. 独立 uid（ADR-0010）：omp 能触及的范围仍以该 uid 为界，不因档位扩大。
- **不因档位改变的行为。** 60 秒超时自动允许按审批条目计时，三档相同，`always-ask` 下写文件的确认卡同样会超时自动允许。
  宿主不因档位自动应答或丢弃 omp 的确认请求：`yolo` 下 omp 若仍因工具自带策略请求确认，照常出确认卡。
  「批准一次 `task` 后子代理以 yolo 运行」这条残余与会话档位无关，三档下都在。
- **升级 omp 时**除了重新验证 overlay 的每个键，还要重跑上面四条对照用例：「argv 压过 overlay」与「项目层绕不过 `always-ask`」都依赖 v18.0.10 的层次次序。
