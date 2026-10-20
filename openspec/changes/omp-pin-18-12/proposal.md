# Proposal: omp-pin-18-12

## Why

#1560：缺省配置（`MODEL_ID=deepseek-v4.1-flash`）下助手看不到图。根因在钉住的 omp v18.0.10：`ai/src/providers/vision-guard.ts` 的 `isTextOnlyDeepSeek` 对任何 id 含 `deepseek` 的模型一律剥掉图片部分、不看 `models.yml` 的 `input`；上游 DMXAPI 对同一模型实测能看图（带图回答颜色正确，prompt_tokens 241 对 57）。这个守卫只存在于 v18.0.10 / v18.0.11，v18.1.0 起删除。owner 2026-10-20 拍板走方向 A：钉住版本升到 18.12.x（#1563），不做代理别名改写。

实跑证明 18.12.3 不是换个二进制就完（`.workplans/1563/prerun-18123.md`，官方二进制用例 9 个文件红 7 个）：审批 select 的 `options` 多出一项、浏览器从 `write xd://browser` 设备改成 `eval` 的 prelude 且 plain `--mode rpc` 下审批没有 UI、`tools.approval: []` 被类型校验丢弃、`models.yml` 不写 `input` 时内置目录把 `deepseek-v4.1-flash` 补成能看图、`SYSTEM.md` 从 cwd 向上读到仓库根。owner 逐分支裁定见 design「owner 的裁定」（grill 2026-10-20，凭证 `.workplans/1563/grill-gate.json`）。

## What Changes

- **钉住版本 v18.0.10 → v18.12.3**：`scripts/omp-fetch.sh` 的版本与两份 SHA256（取自官方 `SHA256SUMS.txt`）、官方二进制夹具的版本钉、参考镜像随之；陈述「当前钉住版本」的文档与 CI 合同字面同步。ADR-0001 的 v18.0.10 钉作废（补充一节）。
- **审批 options 形状白名单**（**BREAKING** 对 18.12.3 而言是修复：不改则 write / always-ask 档所有 exec 调用被静默拒绝）：宿主只认两种精确形状——`["Approve","Deny"]` 与 `["Approve","Approve <subject> for this session","Deny"]`，其余仍 cancel；宿主恒回首项 `Approve`，不暴露 session 授权。
- **omp 以 `--mode rpc-ui` 启动**：18.12.3 的浏览器是 `eval` 工具的 prelude，其每次 `browser.*` 宿主调用在 write / always-ask 档要经 prelude 自己的审批，plain `rpc` 下没有 UI、直接 fail-closed。`rpc-ui` 把这类审批作为 `extension_ui_request{select}` 送到协议上；非审批类 UI 请求（`ask` 等）照旧 cancel。
- **浏览器 prelude 的盲卡由宿主自动放行**：`Allow tool: browser` 的 select 只会出现在已批准（或档位自动放行）的 `eval` 执行过程中，卡上没有 URL、动作与 toolCallId；宿主立即回 `Approve`、不出确认卡、不登记审批行。痕迹改由 `eval` 步骤的 `session.browser` 审计承担（见下）。
- **浏览器操作的宿主识别全部删除**：`server/src/sessions/omp/xd-browser.ts` 与它在审批标题改写、步骤改名、截图候选三处的用法一并删除（18.12.3 没有 `xd://browser`，`browser` 不再是工具）。用户看到的是 `eval` 卡（语言 + 代码，omp 截到 2000 字符）与 `eval` 步骤，与 bash 同一呈现；不做 `\bbrowser\.` 启发式改名。
- **`session.browser` 审计改由 `eval` 结束帧派生**：`tool_execution_end.result.details.statusEvents[]` 里 `op:"browser"` 的每一项（`detail` 如 `open main https://…`、`main.screenshot()`，失败项带 `error`）各写一条审计，在步骤结束落库的同一事务里；`statusEventsElided` 为正时另写一条登记被丢弃的条数。
- **截图进「文件变更」改为目录比对**：18.12.3 的结束帧不带截图路径。绑定会话里回合开始时（任何工具运行之前）记下 `<cwd>/screenshots/` 的条目名集合（经目录句柄、最多 4096 条），每个 `eval` 步骤结束时新出现的普通文件各成一个 `write` 候选，再走 turn-artifacts 既有的归属判定（owner Q5「按调用开始时间比对」的起草者细化，见 design D8）。
- **宿主 overlay**：`tools.approval: []` 改为 `tools.approval: null`（数组被 18.12.3 的 record 校验丢弃并回落默认、每次启动一条 warn；`null` 同样整体替换项目值且无 warn，两个版本都接受——本机实测）；删掉已不存在的 `ruby.interpreter` / `julia.interpreter`；新增 `telemetry.otlpExportEnabled: false`、`archive.enabled: false`、`disabledProviders: [ollama, llama.cpp, lm-studio, apple]`、`ask.enabled: false`（`rpc-ui` 下 omp 会把 `ask` 工具交给模型，宿主取消它的提问会中止整个回合——钉掉它使工具集与 `rpc` 下相同）。owner 有意不钉 `browser.tern` / `PI_BROWSER_TERN` 与 `dev.autoqa` / `PI_AUTO_QA`，登记为已知风险。浏览器块与看图块不变（`browser.enabled: false` 在 18.12.3 关掉的是 prelude）。
- **会话工作目录的仓库根标记**：每次 spawn 前（与工作空间创建时）在会话 cwd 下确保存在一个名为 `.git` 的条目——没有时建一个空目录（mode `2770`）；已有任何同名条目不动。18.12.3 的 `SYSTEM.md` / `SYSTEM_TEMPLATE.md`、`AGENTS.md`、`RULES.md`、skills 发现从 cwd 向上走到最近含 `.git` 的目录；沙箱根与 owner 根对单一 omp uid 可写，A 的会话能写 `<沙箱根>/.omp/SYSTEM_TEMPLATE.md` 静默替换 B 的整份系统提示。标记把这条遍历钉死在 cwd（owner Q3 说的是工作空间 cwd；未绑定会话的 owner 根也放是起草者的扩展，待 owner 确认）。**后果**：owner 根与沙箱根上的 `.omp/` skills、`AGENTS.md`、`RULES.md`、`SYSTEM(_TEMPLATE).md` 不再对工作空间会话生效，`GET /api/project-config` 与命令目录的向上遍历随之止于 cwd（ADR-0012 #773 补充里「跨工作空间影响」一条对这几类作废）；每个空间的文件页多出一个空 `.git` 目录。**封不住的**：omp 的 agent 定义（`.omp/agents`）查找走到文件系统根、不认 `.git`，沙箱根 / owner 根下的 agent 定义仍对其它账号可见——登记为 ADR-0012 已接受残余，部署前提「SANDBOX_ROOT 的祖先不得带 `.omp/`」保持必须，是否另找手段待 owner。
- **托管 `models.yml` 每个模型显式写 `reasoning` 与 `input`**：18.12.3 的 `finalizeCustomModel` 对省略的字段取内置目录同 id 条目的值（`deepseek-v4.1-flash` 在目录里标为 `[text, image]`），宿主省略即被目录改写。`reasoning: false` 与 `input: [text]` 不再省略。
- **夹具与 CI 一并改到 18.12.3 的形状**（owner Q6）：假 omp 的审批回合改为 `tool_execution_start` 先于 `select`、被档位抬高的 bash / write 提示带三个选项；假上游的两个浏览器标记改发 `eval` 调用（JS `browser.open` / `browser.tab("main").screenshot()`）；CI `browser-image` 的驱动断言改为 `eval` 卡与步骤、截图经目录比对进文件变更、两条由 statusEvents 派生的 `session.browser`；`MODEL_ID=ci-vision-model` 回退为缺省（18.12.3 对 `deepseek-v4.1-flash` 不剥图已实测，这正是 #1560 的关闭凭据）。只保留一个版本的形状，不做双版本兼容。
- **文档**：system.md 9.8 改写浏览器部分（eval prelude、rpc-ui、盲卡、截图目录比对、仓库根标记）、ADR-0001 与 ADR-0012 各补充一节、验收清单 CH-121 / CH-123 改写（`eval` 卡）、CH-122 不改。规格里纯粹陈述「v18.0.10」的字样在归档 PR 里统一改为 v18.12.3（官方二进制用例与两个 Linux CI job 全绿即重核完成）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `omp-runtime`：MODIFIED「二进制供给」（v18.12.3 与 SHA）、「子进程 spawn 契约」（`--mode rpc-ui`；spawn 前的仓库根标记；真实 omp 场景改用 eval 标记）、「RPC IO and child observation」（两种 options 形状；`Allow tool: browser` 的 prelude 卡自动 `Approve`）、「宿主 overlay」（固定块：`approval: null`、删 ruby/julia、加 telemetry / archive / disabledProviders / `ask.enabled: false`；各键作用改按 18.12.3；新增真实 omp 场景「rpc-ui 下模型拿不到 ask 工具」）；ADDED「会话工作目录的仓库根标记」。
- `tool-approval`：MODIFIED「审批请求识别」（形状白名单；浏览器改写删除；prelude 卡不是审批）、「确认与步骤配对」（18.12.3 的线上次序已知：start 先于 select）。
- `chat-stream`：MODIFIED「纯协议事件归约」（不再改名 `browser`；`eval` 结束帧的 `statusEvents` 派生审计字段随 step.end 交给 supervisor；`files.changed` 的工具名集合回到 `edit`、`write`）。
- `turn-artifacts`：MODIFIED「文件变更推导与归属」（删 `browser` 候选；绑定会话 `eval` 步骤的截图目录比对）。
- `browser-runtime`：REMOVED「浏览器操作的可读描述」；MODIFIED「浏览器调用审计」（由 `eval` 结束帧的 statusEvents 派生）、「参考部署镜像」（v18.12.3）、「CI browser-image job」（`MODEL_ID` 缺省；断言改为 eval 形状）。Purpose 在归档时直接改写。
- `omp-test-harness`：MODIFIED「假 omp 进程契约」（18.12.3 的帧序与 options）、「受控上游浏览器标记」（`eval` 调用）；ADDED「受控上游 ask 标记」（`WORKBUDDY_ASK` 发一轮 `ask` 调用，钉 `ask.enabled: false`）。
- `model-proxy`：MODIFIED「托管 models.yml」（显式 `reasoning` 与 `input`）。
- `thinking-fold`：MODIFIED「reasoning 前提与真运行时取证」（`MODEL_REASONING=off` 时写 `reasoning: false` 而不是省略；取证链路版本随钉住版本）。
- `chat-sessions`：MODIFIED「项目配置文件列表」（遍历止于 cwd 的 `.git` 标记；位置表按 18.12.3 复核：`.omp/SYSTEM.md` 取最近非空 `.omp` 所在层、新增 `.omp/SYSTEM_TEMPLATE.md`、`.agent(s)` 的 `SYSTEM(_TEMPLATE).md` 与 `AGENTS.md` 每层、`.claude` / `.codex` 的 `SYSTEM(_TEMPLATE).md` 只在 cwd（读码，组 6 的行测试定稿）；agents 查找不止于 `.git`，照旧）。
- `session-permission-tier`：MODIFIED「档位与 omp 审批模式」（真实 omp 场景的 options 形状与版本）。
- `model-selection`：MODIFIED「模型与强度从下一条消息起生效」（真实 omp 场景的 `input` 断言与版本）。

## Impact

- server：`scripts/omp-fetch.sh`；`server/src/sessions/omp/{process.ts, ui-requests.ts, host-overlay.ts, state-layout.ts 或新文件}`（argv、形状、prelude 卡、overlay、标记）；`server/src/sessions/{events.ts, file-changes.ts, turn-control.ts, store-segments.ts, supervisor.ts 或新文件}`（删浏览器改名与候选、statusEvents 审计、截图目录比对）；`server/src/sessions/omp/xd-browser.ts` 删除；`server/src/model-proxy/models-yml.ts`；`server/src/workspaces/store.ts`（`create` 与 `createTemporary` 创建时的标记）。
- 测试：`server/test/support/{omp-official.ts, fake-omp.mjs, fake-omp-composer.mjs, fake-upstream.mjs}`；官方二进制用例 9 个文件全部在 18.12.3 上重核，`omp-official-browser.test.ts` 与 `omp-official-project-config.test.ts` 改写；`xd-browser.test.ts`、`session-events-browser.test.ts`、`session-browser-audit.test.ts` 删除或改写；argv、overlay 字节、`models.yml` 字节、审批形状、配对次序的精确钉点随新契约改。
- CI：`.github/scripts/ci-browser-e2e.mjs`、`ci-browser-image.sh`（`MODEL_ID`）；`scripts/test-ci-harness.sh` 里引用 v18.0.10 的合同字面（`AGENTS.md:93`、`Makefile:2,73`、`constraints.yaml:144`）同步。
- 文档：`AGENTS.md:37,93`、`README.md:4`、`CONTEXT.md:9`、`PLAN.md`、`IMPLEMENTATION_PLAN.md`、`docs/architecture/system.md`、`docs/adr/0001`、`docs/adr/0012`、`docs/acceptance/functional-checklist.md`；`ATTRIBUTION.md:29` 的「定死 v18.0.10」改为 v18.12.3。
- 部署：参考镜像经 `omp-fetch.sh` 自动取新版；无新基底、无新 Debian 包、npm 无新依赖。既有部署升级后：omp 子进程多一个 argv 差异（`rpc-ui`），overlay 与 `models.yml` 字节变化，会话 cwd 下出现 `.git` 空目录（用户 `git init` 会直接填入它）。
- 不碰：web 前端（`eval` 步骤与卡按原文显示，`tool-summary.ts` 已把 `eval` 计入「执行命令」）、模型代理、认证、`MODEL_CATALOG` 键集、`BROWSER_BIN` 语义、spawn 环境白名单（键集不变）。
- 范围外（只记录）：`eval` / bash 审批卡 2000 字符截断（18.0.10 同值）；`task` 批准后子代理 yolo（ADR-0012 已登记）；`browser.tern` 与 `dev.autoqa` 两个 `.env` 可触发的通道（owner 有意不钉）。
