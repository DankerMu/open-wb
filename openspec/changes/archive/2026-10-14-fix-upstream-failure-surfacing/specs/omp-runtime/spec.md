## MODIFIED Requirements

### Requirement: 宿主 overlay
omp 把会话 cwd 下的项目层设置（`.omp/config.yml`、`.claude/settings.json` 等）与全局层深合并，而 cwd 是 agent 在 `write` 与 `yolo` 档下无需审批即可写的目录；argv 的 `--approval-mode` 只决定档位一个键。宿主 SHALL 用 omp 的 `--config` overlay 层（优先级：全局 < 项目 < overlay < CLI runtime override）钉住会绕过审批或在审批之外执行命令的设置键。overlay 文件 SHALL 位于托管 agent 目录、名为 `host-overlay.yml`，路径只有一个来源（与「OMP_STATE_DIR 托管布局」的路径函数同模块导出 `ompHostOverlayPath(stateDir)`）；它 SHALL 在服务启动时、托管布局建立之后与托管 `models.yml` 一起写入，使用与 `models.yml` 相同的替换方式（独占创建的临时文件、mode 精确 `0640`、rename；宿主内只有一份该实现），内容 SHALL 逐字节等于：

```yaml
tools:
  approval: []
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
ruby:
  interpreter: ""
julia:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
images:
  urls:
    enabled: false
    command: null
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: false
```

各键的作用（真实 omp v18.0.10 实测）：`tools.approval: []` 以数组整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与三个 `interpreter: ""` 使项目层不能指定被宿主执行的可执行文件；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）；`images.urls.enabled: false` 关掉图片发布 broker——项目层把它打开后，会话创建时的 prewarm 会按项目给的参数拉起 `ssh`/`cloudflared` 等外部进程（`blob-broker/service.ts:623`、`exposure.ts:488-503`），`images.urls.command` 则被直接执行（`uploaders.ts:100`）；这一组的效果是读源码得出的，omp 接受该取值已实测。`retry:` 段把 omp 的会话级自动重试封顶为一轮（owner 2026-10-13，#909）：v18.0.10 的传输层（6 次）与 provider 层（整轮重放 1 次）重试是硬编码，一轮 502 约 32 秒 / 12 次上游请求（实测），缺省 10 次会话级重试时一次 5xx 回合约 402.7 秒才失败（实测）；`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 缺省值，写出来是为了让项目层改不动重试的时长；`modelFallback: false` 关闭 omp 的模型兜底（缺省 `true`）——否则项目层一条 `retry.fallbackChains` 就能在重试预算用尽时换模型并重置预算，对不可重试的错误（含模型代理的 424）也会换模型重放（读源码得出，#909 design D12）；这与「多上游切换不在范围内」（owner 2026-10-06）一致，即本 overlay 关闭了 omp 的模型兜底。`tools.approvalMode: write` 的优先级低于 argv：omp v18.0.10 在启动段把 `--approval-mode` 的取值经 `settings.override("tools.approvalMode", …)` 写入高于 overlay 的运行期覆盖层，所以会话的有效档位为 `always-ask` 或 `yolo` 时生效的是 argv 的值，overlay 的这一行只在 argv 缺席时才起作用（argv 恒在，见「子进程 spawn 契约」），作为 `write` 的兜底保留。overlay 的内容 SHALL NOT 随会话档位变化：全部会话、全部档位共用上面这一份文件，逐字节不变。其余各键在三个档位下的作用相同——`always-ask` 下项目层的逐工具放行与 bash 放行规则同样被清掉；`yolo` 下工具本来就不因档位请求审批，项目层无从再放宽，而项目层自己写的收紧规则照旧被清掉（ADR-0012 已登记的残余）。「argv 压过 overlay」这一点由 session-permission-tier「档位与 omp 审批模式」的真实 omp 场景钉住。overlay 不做 schema 校验，上述取值依赖 v18.0.10 的消费代码：升级 omp 时 SHALL 重新验证。

overlay 缺失、不可读或不是 YAML mapping 时 omp 以非零退出且不发任何帧——宿主按既有的握手失败处理（`agent_unavailable`），SHALL NOT 回退为不带 `--config` 的 spawn。写入失败 SHALL 走与 `models.yml` 写入失败相同的 partial-start failure 路径。

本要求 SHALL NOT 做的（owner 决定，登记于 ADR-0012）：不拦项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义（它们是功能）；不拦项目层 `.omp/tools`、`.claude/tools`、`.codex/tools` 与项目插件在 spawn 时的执行（受信局域网 + uid 隔离下的已接受残余）；不在 spawn 前扫描或拒绝工作目录。

#### Scenario: overlay 写入
- **WHEN** 编译入口冷启动
- **THEN** `<OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 是 mode `0640` 的普通文件，内容逐字节等于上文；重启后字节不变；agent 目录无残留临时文件

#### Scenario: 项目层放行不再绕过审批（真实 omp）
- **WHEN** 有效档位为 `write` 的会话 cwd 下预置 `.omp/config.yml`，含 `tools.approval: {bash: allow}` 与 `bash.patterns: [{match: "*", approval: allow}]`，随后一个回合里模型调用 bash
- **THEN** 宿主收到该 bash 调用的审批请求（`chat_approvals` 有行），与无项目配置时一致
- **WHEN** 去掉 argv 里的 `--config`（负向对照）
- **THEN** bash 不经审批直接执行

#### Scenario: 项目层 MCP 不在 spawn 时执行（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/mcp.json`，声明一个会写标记文件的 stdio server，然后 spawn 并完成一个回合
- **THEN** 标记文件不存在
- **WHEN** 去掉 `--config`（负向对照）
- **THEN** 标记文件出现

#### Scenario: 默认行为不变
- **WHEN** 有效档位为 `write` 的会话 cwd 下没有任何项目配置
- **THEN** bash 仍请求审批、文件读写不请求，`make smoke` 的全部既有断言通过

#### Scenario: overlay 不随档位变化
- **WHEN** 编译入口冷启动后，先后有 `always-ask`、`write`、`yolo` 三个档位的会话各 spawn 一次
- **THEN** `host-overlay.yml` 的字节在三次 spawn 前后都等于上文（仍含 `approvalMode: write`），托管 agent 目录里没有按档位另写的 overlay 文件；三次 spawn 的 `--config` 与 `PI_CONFIG_FILES` 都指向这同一个路径

#### Scenario: 会话级重试封顶一轮（真实 omp）
- **WHEN** 官方 omp v18.0.10 经模型代理连接一个对每次请求都答 503 的假上游，会话发一个 prompt
- **THEN** omp 恰发一个 `auto_retry_start`（`attempt` 1、`maxAttempts` 1），随后 `auto_retry_end{success:false}` 与终止 `agent_end`；上游恰收到两轮请求（v18.0.10 下为 24 次），回合以 `failed` 结束；实测时长写进实现 PR
- **WHEN** 托管 `models.yml` 在同一 provider 下列出两个白名单模型 A、B，会话以 A 运行，会话 cwd 下预置 `.omp/config.yml`，含 `retry: {maxRetries: 10, baseDelayMs: 3600000, modelFallback: true, fallbackChains: {default: ["<provider>/B"]}}`
- **THEN** 结果与上一例相同（overlay 压过项目层）：恰一个 `auto_retry_start`，上游收到的每个请求体的 `model` 都是 A、没有一个是 B
