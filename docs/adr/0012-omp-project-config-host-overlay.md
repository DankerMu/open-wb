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
- **`modelRoles` 只压 `vision`。** 看图块只写 `modelRoles.vision: "workbuddy/<白名单里第一个 vision 模型>"`。`modelRoles` 是对象，overlay 深合并只压住这一键，项目层写的其它角色照常生效，登记为残余。白名单没有 `vision: true` 的模型时不写 `modelRoles`，项目层的 `vision` 角色也照常生效。
- **截图落点。** `screenshotDir: screenshots` 是相对路径，实测落在会话 `--cwd` 下的 `screenshots/`（2026-10-19，官方 v18.0.10 加本机 Chrome，`dest` 为 `screenshots/screenshot-<时间>.png`）。截图进入工作空间，随回合累积。
- 升级 omp 时与其余各键一样重新验证：浏览器键的名字与取值、`PUPPETEER_EXECUTABLE_PATH` 优先与下载逻辑、截图 `dest` 的相对解析都依赖 v18.0.10。
