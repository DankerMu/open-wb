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
  1. 管理员封顶：`APPROVAL_MAX_MODE` 是档位的上界，缺省 `yolo`（三档都开放）；设为 `write` 即整体关掉这一档，超界的选择在读取时被夹取；新建与 fork 写入会话行的档位也不高于写入当时的上界（见下文「入库夹取」）。
  2. 选择时确认：在界面上选「全部自动」要确认一次，选中后常驻警示色。新会话继承最近一次选择时不再弹确认；继承的档位不高于当前上界（高于时会话行存上界本身），所得有效档位是「全部自动」时警示色与创建审计仍在。
  3. 审计：创建或修改会话的请求使有效档位变化时写一条 `session.permission`（创建时只在所得有效档位不同于当前配置下的缺省档时写）。
     fork 不写；改 `APPROVAL_MAX_MODE` 引起的有效档位变化不写（没有用户动作）。
  4. 独立 uid（ADR-0010）：omp 能触及的范围仍以该 uid 为界，不因档位扩大。
- **入库夹取（2026-10-12，#1282，owner 裁决 A）：change `s1g-composer-capabilities` design D3 的「只在读取时夹取、入库不夹取」在新建与 fork 两处被 change `s1-followups-batch`（design D6）局部推翻。**
  新建会话由账号最近选择继承的档位、fork 从源会话复制的档位，高于写入当时的上界时，会话行存上界本身（不是原始值，也不是 NULL）。
  理由：按 D3 原样抄写，封顶期间建出的会话与 fork 行里存着 `yolo`、当时显示为「只问命令」、没有创建审计；上界放回后它们不经任何用户动作变成「全部自动」，`session.permission` 里查不到。
  存上界而不存 NULL，是因为 NULL 日后跟随缺省档，会丢掉「用户选过不低于这一档」的意思。
  D3 其余不变：读取时照旧夹取；请求显式给出的超界值照旧 400，不夹取；不回填——上界调低之前已写入的会话行与账号最近选择行里的原始值保持原样，上界放回后重新生效
  （其中经创建或 `PATCH` 选出 `yolo` 的会话各自在选择当时已有一条 `session.permission`；由 `yolo` 的源会话 fork 出的会话自身没有——fork 不写审计——只能经库里的 `parent_session_id` 追到源会话；上界放回后由最近选择继承 `yolo` 的新建会话照常写创建审计）。
  仍在的两点：本条生效之前、在封顶期间建出并存了超界档位的会话行同样不回填，上界放回后照旧变宽且没有审计（读代码推出：没有迁移）；
  最近选择或源会话的档位列为 NULL 时新行仍写 NULL（按列判定，不按账号：已选过 `yolo` 的账号 fork 一个档位列为 NULL 的旧会话也是如此），上界为 `always-ask` 期间读作 `always-ask`，放回后读作缺省的 `write`，不写审计，到不了 `yolo`（测试钉住）——owner 2026-10-13 裁决保留这一情形，不存成上界。
- **不因档位改变的行为。** 60 秒超时自动允许按审批条目计时，三档相同，`always-ask` 下写文件的确认卡同样会超时自动允许。
  宿主不因档位自动应答或丢弃 omp 的确认请求：`yolo` 下 omp 若仍因工具自带策略请求确认，照常出确认卡。
  「批准一次 `task` 后子代理以 yolo 运行」这条残余与会话档位无关，三档下都在。
- **升级 omp 时**除了重新验证 overlay 的每个键，还要重跑上面四条对照用例：「argv 压过 overlay」与「项目层绕不过 `always-ask`」都依赖 v18.0.10 的层次次序。

## 补充（2026-10-14，#909）：overlay 钉住会话级重试，关闭模型兜底

overlay 在 `images:` 段之后新增 `retry:` 段（openspec 变更 `fix-upstream-failure-surfacing` design D2、D12）：

```yaml
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: false
```

- **`maxRetries: 1`（owner 2026-10-13）。** omp v18.0.10 在一轮之内已有硬编码的重试：传输层 6 次、provider 层整轮重放 1 次，一轮是 12 次上游请求。会话层缺省再试 10 轮，一次 5xx 回合要 402.7 s 才失败（design 实测）。封顶一轮后的**实测**（2026-10-14，官方 v18.0.10 经模型代理，本地假上游，`server/test/omp-official-upstream-failure.test.ts`）：上游每次答 503 → 恰一个 `auto_retry_start`（`attempt` 1、`maxAttempts` 1）、随后 `auto_retry_end{success:false}` 与终止 `agent_end`，上游恰收到 24 次请求，回合 65.8–67.9 s 以 failed 结束（三次运行）。上游端口无人监听（连接被拒，代理回 502 `connect.ECONNREFUSED`）→ 编译后的服务上回合 67.9 s 以 failed 结束（含约 4 s 的 omp 冷启动；一次性脚本，单次运行）。design 的「≈ 64 s / 24 次」是推算，以上面的数字为准。最终 `message_end.errorMessage` 不带 omp 的 `Retry budget exhausted after 1 retry: ` 前缀，逐字为 `502 模型服务返回 HTTP 503：<节选>\n模型服务返回 HTTP 503：<节选> (type=wb_upstream param=status.503)`（实测，上述各次运行都如此）。
- **`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 的缺省值。** 写出来是为了让会话 cwd 下的项目层改不动它们（overlay 高于项目层）。v18.0.10 的退避等待是 `baseDelayMs` 乘以 2 的幂、封顶 8 s、再减至多 25% 的抖动（读源码 `retry-fallback-chains.ts:69-77`），所以项目层的 `baseDelayMs` 能把那一次等待从约 0.5 s 拉到至多 8 s，而不是任意长——**实测**：overlay 去掉 `baseDelayMs` 行、项目层写 3600000 时，`auto_retry_start.delayMs` 为 7841、回合 74 s 失败（design D12「改成一小时就挂一小时」对 v18.0.10 不成立）。`maxDelayMs` 约束的是从上游错误里解析出的等待，项目层写 0 即取消上限（读源码 `settings-schema.ts` 该键的说明）。
- **`modelFallback: false`：本 overlay 关闭了 omp 的模型兜底**（缺省 `true`）。不关的话，项目层一条 `retry.fallbackChains` 就能在失败时换到链上的另一个模型、并把重试预算重置，对不可重试的硬错误（含模型代理的 424）也会换模型重放（读源码：`turn-recovery.ts` 的 `isHardErrorFallbackEligible` 与预算用尽分支）。多上游 / 多模型切换不在范围内（owner 2026-10-06），所以关掉。**实测**：项目层写 `retry: {maxRetries: 10, baseDelayMs: 3600000, modelFallback: true, fallbackChains: {default: ["workbuddy/<第二个白名单模型>"]}}` 时，结果与无项目配置相同——一个 `auto_retry_start`、24 次请求、全部请求第一个模型，65.9–67.3 s 失败（三次运行）；同一用例在旧 overlay（无 `retry:` 段）上出现 `model_changed` 与 `retry_fallback_applied` 帧和第二个 `auto_retry_start`。
- **已接受残余**：普通限流 429（非额度）在封顶一轮下的时长未实测（读代码推出约同 5xx）。上面 65.8–67.9 s 的实测里上游正文不带等待提示；≥500 的节选会进 `errorMessage`，正文若带 `retry-after: <秒>` 之类的提示，omp 从文本里解析出这个等待（`resource/oh-my-pi/packages/coding-agent/src/session/turn-recovery.ts:1921-1951`，含 `extractRetryHint`），用它拉长那一次退避，至多到 `maxDelayMs` 的 300 s，超过则不等、直接失败（同文件 `:2137-2138`、`:2220-2221`）——所以 5xx 回合还可能多等至多 300 s（读代码推出，未实测）。
- **重试后成功的回合**（#909 PR 3）：宿主原先只认第一轮 `message_end` 的失败，重试成功的回合也被判为失败（读代码推出）。现在 `auto_retry_start` 之后那一轮的结局替换第一轮的失败，退避中停止（`auto_retry_end{finalError:"Retry cancelled"}`）记为已中断；**实测**（2026-10-14，官方 v18.0.10 经模型代理，`server/test/omp-official-upstream-failure.test.ts` 的 4.4 两例）：前 12 次请求答 503、之后正常 → 恰一个 `auto_retry_start` 与一个 `turn.retry`，上游共 14 次请求，回合约 34 s 以 `done` 收尾（正文为第二轮的工具轮与回复）；每次都答 503、在 `turn.retry` 之后调停止路由 → omp 先发 `auto_retry_end{success:false,finalError:"Retry cancelled"}`、随即发终止 `agent_end`，回合在停止后几十毫秒内以 `stopped` 收尾，没有 `error`，上游恰 12 次请求（第二轮没有发出）——走的是 omp 自己的 `agent_end`，不是 8 s 的有界退回。
- 升级 omp 时与其余各键一样重新验证：这五个键的名字与取值、`auto_retry_*` 帧的形状和一轮内的硬编码次数都依赖 v18.0.10。

## 补充（2026-10-19，#1527）：overlay 钉住浏览器设置，按白名单钉看图角色

openspec 变更 `omp-browser-integration` design D2。overlay 由固定字面量改为部署配置的纯函数：取决于是否配置浏览器（`BROWSER_BIN`）与模型白名单，启动时写出，此后不变；「不随会话、档位变化」照旧。固定块之后恒接浏览器块，白名单有 `vision: true` 的模型时再接看图块。各键见 omp-runtime「宿主 overlay」与 system.md 9.8。

- **浏览器键已钉。** 浏览器块写 `enabled`、`cdpUrl: ""`、`relay: false`、`cmux: false`、`headless: true`、`screenshotDir: screenshots`，所以上文残余里「浏览器 CDP 地址」一项改为已钉：项目层的 `browser.cdpUrl`、`browser.relay`、`browser.cmux`、`browser.headless`、`browser.enabled` 都被 overlay 压住。实测（官方 v18.0.10，`server/test/omp-official-browser.test.ts`）：项目层写 `browser: {enabled: true}`、overlay 为 `enabled: false` 时，写 `xd://browser` 以失败结束（`No such tool: xd://browser`），工作目录里不落出 `xd:` 条目，`<OMP_STATE_DIR>/xdg/cache/omp/puppeteer/chrome` 不存在，日志无 `Downloading Chromium for puppeteer`。同一用例在旧 overlay 上项目层胜出、浏览器工具被挂载，调用 30 s 后以 `Browser open timed out after 30000ms` 失败，即 #912 的症状（这次没有查看下载缓存与日志）。
- **工具参数钉不住（已接受残余）。** `app.path`（及其启动参数 `app.args`）、`app.cdp_url`、`app.relay` 是浏览器工具的调用参数，不是设置，而且优先于设置（`tools/browser.ts:91-130`）：模型可以借它启动任意可执行文件、连接外部浏览器或走中继（走中继这一项已由 spawn env 的 `PI_BROWSER_RELAY=0` 关掉，见下一条，#1529）。宿主不拦，改为显著标出：确认卡与步骤上加 ⚠ 行，每次浏览器调用写一条 `session.browser` 审计并带 `external` 字段（#1526）。`yolo` 档下没有确认卡，审计是唯一痕迹。
- **`browser.relayUrl` 不钉，`.env` 入口已由 spawn 环境堵上（#1529）。** omp 只在中继模式下用 `browser.relayUrl`。设置层的中继已由 `relay: false` 关掉。另一个入口是环境变量：`PI_BROWSER_RELAY` 与 `PI_BROWSER_CMUX` 是中继与 cmux 的最终开关，非空时压过设置（`tools/browser/relay/kind.ts:36`、`tools/browser/cmux/rpc.ts:187`）。宿主原先不设它们，模型写进工作目录 `.env` 的 `PI_BROWSER_RELAY=1` 在下一次 spawn 时生效，项目层的 `browser.relayUrl` 被当作 CDP 地址连接，`cdpUrl: ""` 被绕过，工具参数里没有 `app`，确认卡与审计都看不到。现在宿主在每次 spawn 的环境里恒写 `PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`（sudo 的 `--preserve-env=` 同步保留）；字面量 `0` 非空，dotenv 不覆盖。实测（官方 v18.0.10，`server/test/omp-official-browser.test.ts`）：工作目录 `.env` 写 `PI_BROWSER_RELAY=1`、`PI_BROWSER_CMUX=1` 与 `CMUX_SOCKET_PATH`，项目层把中继指到 `http://192.0.2.1:9`，浏览器块 `enabled: true`。带两个钉时 omp 走本地浏览器，执行了 `BROWSER_BIN`；去掉两个钉时走中继，30 s 后以 `Browser open timed out after` 失败；只去掉其中任一个（本地变异，未入库），本地浏览器也不再被执行。同一个开关也管参数 `app.relay: true`（`tools/browser.ts:102-107`），所以这类调用随之不走中继、退回本地浏览器，上一条「工具参数钉不住」的残余只剩 `app.path`（含 `app.args`）与 `app.cdp_url`。确认卡的 ⚠ 行与审计 `external.relay` 仍按参数写出，多报不漏报。同类入口 `PUPPETEER_PROXY`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS`（omp 由它们拼浏览器的 `--proxy-server` 与 `--ignore-certificate-errors`，`tools/browser/launch.ts:436-458`；PR #1549 安全审查，owner 2026-10-19）同样恒钉为 `direct://` 与 `0` 并进 `--preserve-env=`，实测同一用例 `.env` 再写这两个变量时，`BROWSER_BIN` 收到的参数含 `--proxy-server=direct://`、不含 `.env` 的代理地址与 `--ignore-certificate-errors`。
  （2026-10-21 补充，#1615）同一个 `.env` 入口还能打开 omp 自己的出站代理：模型请求走 Bun 原生 `fetch`，它从环境读 `HTTP_PROXY` / `http_proxy` / `ALL_PROXY`，对回环目标同样走代理（tag `v18.12.3` `packages/ai/src/utils/transport-fetch.ts:25-47`；omp 自己的回环豁免只在设了 `PI_PROXY` 时生效），工作目录 `.env` 一行就能让全部对话与会话令牌以明文转经任意地址，并把代理的回复当作模型输出。代理变量本身钉不住（Bun 把任何非空值当代理地址，空串又被 dotenv 覆盖），所以宿主钉的是豁免：spawn 环境恒带 `no_proxy=*` 与 `NO_PROXY=*`，sudo 的 `--preserve-env=` 同样保留。两个大小写都钉：Bun 先读小写，omp 自己的豁免判断先读大写（`proxy.ts:68`）。官方 v18.12.3 实测（`server/test/omp-official-overlay-pins.test.ts`）：五种 `.env` 情形下代理零请求、回复来自假上游；删掉两个钉的对照里代理收到指向假上游的 `POST` 绝对 URI。副作用与 `OTEL_SDK_DISABLED` 同类：助手经 bash / eval 跑的程序也看到这两个变量，认它们的工具不走环境代理，curl、git 的 http 传输连显式配置的代理（`curl -x`、`.curlrc`、`http.proxy`）也绕过、改为直连。宿主本就不给子进程代理变量，受影响的只是子 shell 里自设或工具配置里的代理；出站必须经代理的部署里，需要代理的命令要自行去掉豁免（`env -u no_proxy -u NO_PROXY …`），接受。
- **`modelRoles` 只压 `vision`。** 看图块只写 `modelRoles.vision: "workbuddy/<白名单里第一个 vision 模型>"`。`modelRoles` 是对象，overlay 深合并只压住这一键，项目层写的其它角色照常生效，登记为残余。白名单没有 `vision: true` 的模型时不写 `modelRoles`，项目层的 `vision` 角色也照常生效。
- **截图落点。** `screenshotDir: screenshots` 是相对路径，实测落在会话 `--cwd` 下的 `screenshots/`（2026-10-19，官方 v18.0.10 加本机 Chrome，`dest` 为 `screenshots/screenshot-<时间>.png`）。截图进入工作空间，随回合累积。
- 升级 omp 时与其余各键一样重新验证：浏览器键的名字与取值、`PUPPETEER_EXECUTABLE_PATH` 优先与下载逻辑、截图 `dest` 的相对解析都依赖 v18.0.10。

## 补充（2026-10-20，#1563）：迁到 omp v18.12.3

openspec 变更 `omp-pin-18-12`。本节分几部分随各子 issue 写入。

### 一、overlay 固定块（#1564，design D4）

固定块改了两处：`tools.approval` 由 `[]` 改为 `null`，`retry:` 段之后新钉四个键；`ruby` / `julia` 两段保留到翻转（见下），浏览器块与看图块不变。逐键说明见 system.md 9.8「overlay 的固定块」。上文 S1g 补充里「`tools.approval: []`」的写法自此由本节取代。

- **`tools.approval: []` → `approval: null`。** v18.12.3 给设置加了类型校验，`tools.approval` 是 record，数组不合格，被丢弃、回落默认 `{}`，每次启动写一条 `Settings: ignoring invalid value`。项目值没有复活（合并先于校验，项目层的对象已被数组整体替换），但这是靠校验失败兜底。`null` 在深合并里走替换分支，再被当作未设、回落默认，两个版本都不报警告。实测：v18.0.10 上官方用例 (c)「`always-ask` 下项目层 `tools.approval: {write: allow}` 仍弹写文件卡」在 `null` 下照旧通过；v18.12.3 的同一结论由组 6 的翻转 PR 证明。
- **`ruby.interpreter`、`julia.interpreter` 保留到翻转（owner 2026-10-20，改订 Q7 的「删 ruby / julia」）。** v18.12.3 的 eval 只剩 py 与 js 两个后端，这两个键已不存在，overlay 里的未知键被静默忽略（实测无 `Settings:` 警告）。但组 6 翻转之前宿主仍跑 v18.0.10，而 v18.0.10 上两键有效：实测（2026-10-20，#1564，本机官方 v18.0.10，`--mode rpc-ui`），cwd 的 `.omp/config.yml` 写 `eval: {js: false, ruby: true}` 与 `ruby.interpreter: ./x.sh` 时，overlay 去掉这两段则 omp 在 spawn 时的 Ruby 预检执行了 `<cwd>/x.sh`（参数 `-e exit 0`），不经审批；保留 `ruby.interpreter: ""` 时不执行（预检代码见 v18.0.10 `tools/index.ts:554-570`，Julia 走同一路径，读代码推出）。所以两段留在固定块里，由翻转到 v18.12.3 的组 6 随版本一起删。
- **新钉四个键（owner 2026-10-20，grill Q7；`ask` 为起草者补钉）。**
  - `telemetry.otlpExportEnabled: false`：OTLP 导出缺省开，有 `OTEL_*` 端点才真正导出，而工作目录 `.env` 能注入端点。
    （2026-10-21 补充，#1575）这个设置键只是两道关之一。omp 的 OTLP 导出还看进程环境：`OTEL_SDK_DISABLED=true` 时在解析任何端点之前就不导出（tag `v18.12.3` `packages/coding-agent/src/telemetry-export.ts:82`）。宿主自此在每个 omp 子进程的 spawn 环境里恒钉 `OTEL_SDK_DISABLED=true`（sudo 的 `--preserve-env=` 同样保留），非空值不被工作目录 `.env` 覆盖。两道关各自就能挡住导出：官方 v18.12.3 实测四种配置，只有两道都去掉时本地监听器在 `agent_end` 后收到 `/v1/logs` 与 `/v1/traces`（`server/test/omp-official-overlay-pins.test.ts`）。副作用：omp 不从子 shell 剥掉继承的 `OTEL_*`，助手经 bash / eval 跑的程序也看到 `OTEL_SDK_DISABLED=true`，与 `PUPPETEER_PROXY=direct://` 同类，接受（system.md 9.8）。
  - `archive.enabled: false`：关掉 `archive` prelude。它只读、不请求审批，读的是 omp 自己的 `sessions` 目录，与宿主的 `--session-dir` 不重叠，属卫生项。
  - `disabledProviders: [ollama, llama.cpp, lm-studio, apple]`：不让 omp 隐式探测本机的 11434、8080、1234 端口，不启用 macOS 的 `apple` 提供者。托管 `models.yml` 的 `workbuddy` provider 不受影响。
  - `ask.enabled: false`：`ask` 工具只在有 UI 时创建，宿主改用 `--mode rpc-ui`（本变更组 2）后模型就能调它。宿主对它的提问只会 cancel，而 `ask` 被取消时先中止整个回合，用户看到回答无故「已停止」。钉掉后 `rpc-ui` 下的工具集与 `rpc` 相同。
- **实测（2026-10-20，本机官方 v18.0.10 与 v18.12.3，`--mode rpc-ui`，overlay 为新固定块加浏览器块）。**
  - 两个版本的 stderr 与 omp 日志都没有 `Settings:` 行。对照：旧固定块在 v18.12.3 的日志里有一条 `tools.approval` 的 `Settings: ignoring invalid value`。
  - `get_state` 的 `dumpTools` 里没有 `ask`，旧固定块下两个版本都有。
  - `get_available_models` 列出 `workbuddy/m1`；去掉 `disabledProviders` 时，两个版本的日志对 `ollama`、`llama.cpp`、`lm-studio` 各有一条 `model discovery failed`，带上则没有。
- **`disabledProviders` 整体替换项目层的同名键（已接受后果，实测）。** cwd 放 `.claude/skills/x/SKILL.md`、`.omp/config.yml` 写 `disabledProviders: [claude]`：带新 overlay 时 `get_available_commands` 列出 `skill:x`；overlay 去掉 `disabledProviders` 的对照不列。两个版本相同。即 overlay 的数组替换掉项目层的数组，项目自己写的 `disabledProviders`（关掉 `claude`、`codex` 等发现源）不再生效；同理，若部署方在全局层写了 `disabledProviders`，也被 overlay 压住。这与上文「项目层写的收紧规则被 overlay 一并清掉」同类，接受。
  上文「第三方配置目录不用 `disabledProviders` 关」与「方案 A」说的是关掉 `claude`、`codex` 等发现源，本节没有改变那个结论：overlay 只列这四个模型提供者，发现源一个都不关。
- **有意不钉（owner 2026-10-20）：** `browser.tern` 与环境变量 `PI_BROWSER_TERN`、`dev.autoqa` 与环境变量 `PI_AUTO_QA`。登记为已知风险。
- **否决 `tools.approval.browser: allow`。** 为让浏览器 prelude 在 plain `rpc` 下可用而在 overlay 里放行 `browser`，会把 `tools.approval` 变成对象；对象与项目层深合并，项目写的 `{bash: allow}` 等逐工具放行随之复活，等于撤掉 #708 的钉子。改走 `--mode rpc-ui` 与宿主审批（本变更组 2）。

### 二、`--mode rpc-ui`、审批形状与浏览器盲卡（#1566，design D2 / D3）

- **启动模式 `--mode rpc-ui`（owner 2026-10-20，grill Q2）。** v18.12.3 的浏览器是 `eval` 工具的 prelude，`write` / `always-ask` 档下 prelude 对每次 `browser.*` 宿主调用另要一次审批；这次审批走工具 UI，只有 `rpc-ui` 把它作为 `extension_ui_request{select}` 送到协议上，plain `rpc` 下调用直接失败。实测（2026-10-20，本机官方 v18.0.10 与 v18.12.3，三档各一个 bash 回合）：两种模式的启动帧、`get_state` 键集合、审批帧、发给模型的工具集与上游请求数逐项相同。`rpc-ui` 下 `ask` 会成为模型可调的工具，由上一部分的 `ask.enabled: false` 钉掉（真实 omp 用例 `omp-official-rpc-ui.test.ts`：钉住时模型得到 `Tool ask not found`、回合正常结束；去掉钉时宿主 cancel 提问、回合「已停止」）。
- **审批形状显式白名单（owner Q1）。** 只有 `options` 恰为 `["Approve","Deny"]`，或恰三项 `Approve` / 匹配 `^Approve .+ for this session$` 的中间项 / `Deny` 的 `Allow tool:` 卡才是审批，其余形状照旧 cancel。中间项是 v18.12.3 对被档位抬高的提示附带的「本会话内放行」，其中的名字是 omp 的策略键、可以不等于工具名，所以按形状匹配、不钉成工具名。宿主只回 `Approve` / `Deny`、永不回中间项：omp 进程内存里的会话授权集合始终为空，每次调用都回到宿主。
- **浏览器盲卡自动放行：上文 S1g 补充「宿主不因档位自动应答或丢弃 omp 的确认请求」的唯一例外。** `Allow tool: browser`（或其后恰一行 `Reason: …`）且两项 options 的卡，传输层立即回 `Approve`，不出卡、不写 `chat_approvals`、不写 `session.approval` 审计。理由：卡上没有动作、URL 与调用 id，弹给用户是零信息的确认；它只出现在用户已批准（或档位放行）的 `eval` 执行过程中，真正执行的代码在 eval 卡上已经给用户看过；浏览器调用的痕迹由 eval 步骤的 `session.browser` 审计逐次留下（本变更组 4）。`yolo` 档下 prelude 本来不问。
- **盲卡按整个标题闭合匹配，不看首行。** 组 6 翻转之前宿主仍跑 v18.0.10，它有真正的 `browser` 工具（`approval: "exec"`），卡是 `Allow tool: browser\nAction: …\nTab: …[\nURL: …][\nCode:\n…]`、同样两项 options；平时它挂在 `xd://` 下、卡题是 `Allow tool: write`，但 overlay 没钉 `tools.xdev`，项目层写 `tools.xdev: false` 就让它成为顶层工具。只看首行会把这类带动作的卡也自动放行，所以 `Action:` 卡、`Reason:` 之后再有行、尾随空格、三项、`confirm` 都落入 cancel。
- **桥调工具照常问（grill 开放项，实测）。** `write` 档下模型调 `eval`，代码为 `await tool.bash({ command: "echo bridge" })`：宿主批准 eval 卡之后，omp 再弹一张 `Allow tool: bash\nCommand: echo bridge`（v18.12.3 为三项 options），经宿主审批后才执行，v18.0.10 与 v18.12.3 相同。所以「eval 批准后桥调工具不再问」不成立，不登记为残余；这张卡没有自己的步骤，按「没有步骤的审批保持未配对」处理。

### 三、会话工作目录的仓库根标记（#1567，design D5）

- **决定（owner 2026-10-20，grill Q3 / Q8）。** 每个工作空间的会话工作目录放一个空的 `.git` 目录作仓库根标记，宿主每次 spawn 前重新断言，已有的 `.git`（真仓库等）不动；用目录不用文件（名为 `.git` 的文件会被 git 当作 gitfile 解析，`git init` 报错）。起草者把它扩到未绑定会话的 owner 根（不放则这类会话仍从沙箱根读项目层），**待 owner 确认**。时机、权限与失败语义见 system.md 9.8「会话工作目录的仓库根标记」。
- **#773 补充「跨工作空间影响」一条，对下列几类作废。** omp 的 `repoRoot` 恒为会话工作目录，沙箱根与 owner 根上的 `.omp/` skills、`AGENTS.md`、`RULES.md`、`SYSTEM.md` / `SYSTEM_TEMPLATE.md`（及 `.agent(s)/` 的同类文件）不再对工作空间会话生效，一个账号也就不能借它们改写其它账号会话的系统提示（v18.12.3 的 `SYSTEM_TEMPLATE.md` 是整份替换）；宿主的命令目录与 `GET /api/project-config` 的上溯同样止于工作目录。需要平台级 skill 时装到托管 `HOME`。
- **agents 一类保留，新增已接受残余：沙箱根 / owner 根 `.omp/agents` 下的 agent 定义对其它账号可见。** omp 的 agent 定义查找（`findAllNearestProjectConfigDirs("agents")`，v18.0.10 与 v18.12.3 相同）从工作目录一直走到文件系统根，不认 `.git`；沙箱根与 owner 根对单一 omp uid 可写，一个账号写进 `<SANDBOX_ROOT>/.omp/agents/` 或别的 owner 根 `.omp/agents/` 的定义，会被工作目录里没有自己 `.omp/agents` 的其它账号的 `task` 工具加载（批准后子代理按定义运行）。宿主的 agent 文件列表照旧扫到沙箱根，与 omp 一致。是否另找手段（例如每个工作目录再放一个空的 `.omp/agents`——它会同时改变「最近一个非空 `.omp`」的判定）待 owner 决定，本变更不自行处理。
- **`.clinerules` 同样封不住，新增已接受残余（PR #1579 round 1 安全座席 P1，本机官方 v18.0.10 实测）。** omp 的 `cline` provider（缺省启用，固定块的 `disabledProviders` 未列）从工作目录逐级到文件系统根取最近一个 `.clinerules`，不认 `.git`，v18.0.10 与 v18.12.3 相同；文件带 frontmatter `alwaysApply: true` 时整段进入系统提示（`<generic-rules>` 段），不带 frontmatter 不进（归档变更 `project-config-surface` 记的「未观察到进入系统提示」即此）。实测：owner 根放 `---\nalwaysApply: true\n---\n<sentinel>`，工作目录带宿主标记，`systemPrompt` 含 sentinel；官方用例 `omp-official-project-config.test.ts` 以一行带宿主标记的用例钉住这条残余。宿主的 `GET /api/project-config` 不列 `.clinerules`。固定块是否加 `- cline`（工作目录自己的 `.clinerules` 随之失效）待 owner 决定（Epic (g)），要则随 #1570 翻转加入。
- **部署前提「`SANDBOX_ROOT` 的任何祖先目录不得带 `.omp/`」保持必须**（上文 Consequences）：`.omp/agents` 的查找仍上溯到文件系统根，`.clinerules` 的查找同样（同一前提扩到「不得带 `.clinerules`」）。
- **新增部署前提：`SANDBOX_ROOT` 不得位于 `OMP_STATE_DIR/home` 之下。** `AGENTS.md` 发现在工作目录位于 omp 的 `HOME`（生产为 `<OMP_STATE_DIR>/home`）之下时一路扫到 `HOME`（v18.0.10 `discovery/agents-md.ts` 的 `scanToHome`；v18.12.3 `discovery/helpers.ts` 的 `loadStandaloneContextFiles` 同样），不以 `.git` 为界，标记失效——两版本都要这条前提。
- **已接受残余（PR #1579 round 1 安全座席 P2，读码）：父目录被换成链接时标记的建立与设权限仍按路径解析。** `O_NOFOLLOW` 只管路径的最后一个分量；owner 根 `2770` 无粘滞位，omp uid 可以把空间根本身换成指向别处的链接（runtime 只在创建时校验一次 cwd），下一次 spawn 的 `mkdir` 就在链接目标里新建一个应用 uid 所有、属组 `workbuddy` 可写的空 `.git`（omp 填成仓库后 git 的 ownership 检查会信任它）；若再卡在 `mkdir` 与 `open` 之间把链接改指向一个已有应用 uid 所有 `.git` 的目录，`fchmod` 会把那个 `.git` 改成 `2770`。可利用需要三件事同时成立：竞态成功、非参考镜像部署（镜像里 `/app` 属 root）、应用 uid 拥有某个 `.git`（例如以应用用户 clone 的仓库且 `SANDBOX_ROOT` 在其下）；宿主自身不调 git。加固（Linux 上以工作目录的 fd 经 `/proc/self/fd/<n>/.git` 做 mkdir / open，等效 `mkdirat` / `openat`）待 owner 决定（Epic (h)）；`ensureSharedDir` 的按路径 `chmod` 是同类既有代码。
- **实测（2026-10-20，本机官方 v18.0.10）。** 工作目录下空 `.git` 时三档各一回合：无报错帧，stderr 与 omp 日志无 git 相关行，`systemPrompt` 与没有 `.git` 时逐字相同。官方用例 `omp-official-project-config.test.ts` 与 `omp-official-skills.test.ts` 的「with the host marker」行：一层之上的 `AGENTS.md`、`.agents/AGENTS.md`、`.omp/AGENTS.md`、`.omp/RULES.md` 与 owner 根的 skill 不再被读，`.omp/agents` 仍被读；同一批行经测试专用包装去掉标记后照旧被读（omp 自己的上溯规则未变）。v18.12.3 上 `SYSTEM(_TEMPLATE).md` 的同一结论由组 6 的翻转 PR 证明。

### 四、翻转到 v18.12.3 与 eval 代码层残余（#1570，design D1 / D7 / D9 / D10）

- **翻转（owner 2026-10-20，Epic #1563「直接上 A」）。** `scripts/omp-fetch.sh` 钉 v18.12.3 与两份 SHA（ADR-0001 2026-10-20 补充）；`omp-official.ts` 的 `OMP_VERSION`、CI 镜像构建的 `/opt/workbuddy/omp --version` 校验、harness 合同字面随它。翻转前在 v18.0.10 上保持绿的组 1–5 全部在 v18.12.3 上重跑：官方用例 10 个文件全绿，`make smoke` 本机绿，`browser-image` job 首跑即本 PR 的 CI。首跑冻结值的变化：`thinkingLevel` 在非 reasoning 模型上为 `null`（翻转前就近取低）、`get_state` 不再带 `thinkingLevel` 键、resume 后 `level: null`；审批配对的帧序变为 `tool_execution_start` 先于 `select`；`UPSTREAM_REQUESTS` 仍为 24（一轮 12 = 传输层 6 次 × provider 层重放 1 次）；maxTokens 的线上字段是 `max_completion_tokens`；未配置浏览器的失败文本从 `No such tool: xd://browser` 变为 `ReferenceError: browser is not defined`。
- **固定块删 `ruby` / `julia`、加 `advisor` 与 `ida`（design D9）。** 上文第一部分「保留到翻转」的两段随翻转删除。`ida.enabled: false` 是 Epic (f) 的缺省方案（owner 未否决）：缺省 `true`，项目层可设 `ida.installDir` 与 `ida.python`，之后 `read` 读到带可执行头的文件就以项目层指定的解释器起进程、不经审批（PR #1573 安全座席 P1）。`advisor.enabled: false` 是起草者在 fixture review 里补的钉（owner 可否决）：源码缺省 `false`，但任何一层配置都压过缺省，项目层一行就能开启；开启后 `WATCHDOG.md` / `.yml` 的上溯以 git 仓库根为界，原生发现要求 `.git/HEAD`、宿主的空 `.git` 标记被跳过，会走到文件系统根（PR #1579 安全座席预警）。实测（2026-10-20，本机官方 v18.12.3）：两键在固定块里都不触发 `Settings:` 警告；`ida` 是 discoverable 工具、不进 `dumpTools`，带钉时系统提示的 `xd://` 设备列表没有 `ida`，去掉 `ida:` 块且项目层给出 `installDir` 时有；`advisor` 没有 RPC 读回，带钉时项目层的 `advisor.enabled: true` 无效（一个 bash 回合 2 次上游请求），去掉钉时 5 次并出现 `advisor_yielded`。`dev.autoqa` 缺省开（系统提示有 `xd://report_issue`），owner 已决定不钉，只记一笔。 PR #1582 安全座席另记一条残余：`task.agentAdvisor`（record）能给单个子代理开 advisor、绕过主会话的 `advisor.enabled: false`（`task/executor.ts:4160-4170`；WATCHDOG 发现在 `sdk.ts:1877` 无条件执行），能力不超过上文已登记的「`.omp/agents` 越过标记 + 子代理 yolo」残余，是否一并钉 `task.agentAdvisor: null` 待 owner。
- **eval 代码层残余：工具参数钉不住的 18.12.3 形态。** 上文「工具参数钉不住（已接受残余）」说的是 `app.path` / `app.cdp_url` 一类调用参数；v18.12.3 没有独立的浏览器工具，这些参数由模型写在 `eval` 的 JS 里（`browser.open({ url, app: { path, cdp_url, relay } })`），确认卡把代码原样给用户看（前 2000 字符）、宿主不解析也不改写——#1526 的「浏览器审批改写为浏览器操作」与 `xd://browser` 设备识别随翻转删除。钉子落在 overlay 浏览器块（`cdpUrl: ""`、`relay: false`、`cmux: false`、`headless: true`）与 spawn 环境（`PI_BROWSER_RELAY=0`、`PI_BROWSER_CMUX=0`），不落在参数上；浏览器调用的痕迹由 eval 结果的 `statusEvents` 逐条写 `session.browser` 审计，截图由回合开始时 `screenshots/` 名字集合的比对进文件变更卡（第三、四组）。实测（2026-10-20，v18.12.3，本机 Chrome，三档）见 system.md 9.8「浏览器经 `eval` 驱动」。
- **`GET /api/project-config` 位置表补 v18.12.3 的系统提示文件。** `.omp/SYSTEM.md` 与 `.omp/SYSTEM_TEMPLATE.md` 取自最近非空 `.omp`（不再只看 cwd），`.agent(s)/` 的两份系统文件逐级读，`.claude` / `.codex` 的两份只在 cwd 读；实跑另发现读码漏了 `.gemini/system.md` 与 `.gemini/SYSTEM_TEMPLATE.md`（cwd only，文件名是小写 `system.md`），起草者补进位置表（owner 可否决）；每一行都有官方用例在 depth 0 / depth 1 实测，位置表与实测一致。
- **升级 omp 时重验（以 v18.12.3 为基线）。** 审批 `select` 的 options（两项或恰三项、中间项 `Approve <名字> for this session`）；盲卡标题恰为 `Allow tool: browser`（本次没见到 `Reason:` 行）、两项 options；eval 卡标题 `Allow tool: eval\nLanguage: javascript\nCode:\n…`；`statusEvents` 的 detail 文本（`open main <url>`、`main.screenshot()`）与 `statusEventsElided`；eval 结果 `details` 的键（`language, languages, cells, statusEvents`，没有 `images`）；截图落点 `<cwd>/screenshots/screenshot-<时间>.png`；`SYSTEM(_TEMPLATE).md` 的遍历范围与 `.git` 边界；`UPSTREAM_REQUESTS` 与 `max_completion_tokens`；`thinkingLevel` / `input` 的缺省；固定块每个键的 `Settings:` 读数；`ida` 的观测面是 `xd://` 设备列表而不是 `dumpTools`；`ask` 不在 `dumpTools`。其中 `advisor` / `ida` 两段由 `server/test/omp-official-overlay-pins.test.ts` 的四条用例（两条回归 + 两条去掉对应段的负对照，#1583）自动重验，不必再手工探针；该文件读到的设备段是 `ast_edit, debug`（`report_issue` 出现在系统提示的 Tool Policy 段，#1570 探针用全文正则把它也算进了设备列表）。 prompt 回执与 `agent_start` 的次序、派发后极早停止（宿主回执 = stdin 写完，窗口按构造可达；v18.12.3 实测 `prompt response → agent_start → abort response → prompt_result(aborted)`、stop 后约 40 ms 收尾、未走 8 s 兜底；去掉推迟逻辑的变异跑里 omp 不发 `agent_start`、只能靠兜底收尾）由 `server/test/omp-official-stop-early.test.ts` 重验（#1594）。
- **翻转 PR 未触的源码注释留给归档 PR。** `server/src/server.ts:28`、`sessions/approval-pairing.ts:7`、`sessions/omp/commands.ts:265`、`sessions/omp/state-layout.ts:5`、`sessions/session-todo.ts:3`、`sessions/slash-commands.ts:10,130`、`sessions/upstream-classify.ts:11` 以及各 `fake-omp-*` / `omp-rpc*` / `omp-runtime-*` / `session-events-*` 测试头的「v18.0.10 实测」都是带版本的测量记录，行为在 v18.12.3 上由官方用例与全量测试证明不变，归档 PR 统一清扫（design D1 / D10）。
