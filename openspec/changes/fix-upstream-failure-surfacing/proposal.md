# Proposal: fix-upstream-failure-surfacing

## Why

#909：模型上游拒绝请求时，回合可以长时间停在「生成中」，前端看不到任何错误，服务日志也没有一行记录。2026-10-13 的红灯实测（官方 omp v18.0.10 经真实模型代理、本地假上游，12 个用例）给出了原因：

- 上游 ≥500、连接失败与非法密钥都被代理折成同一个本地 502（`server/src/model-proxy/index.ts:308-313`、`:260`），真实状态码与正文丢失；
- omp 对 502 在三层重试：传输层 6 次、provider 层整轮重放 1 次、会话层默认 10 次——一轮约 32 秒 / 12 次请求，默认 11 轮共 402.7 秒才失败（实测）；
- 上游接受连接却不回响应时，代理只有 10 秒的建连期限，回合在 90 秒内没有任何帧（实测；omp 自己的首事件看门狗是 300 秒，读代码推出）；
- 回合真正失败时，错误文本只在一次性的 SSE `error` 事件里，不落库、快照里没有，刷新即消失（实测）；400 的错误文本还带出服务器文件路径 `raw-http-request=<stateDir>/…json`（实测）。

owner 在 2026-10-06 / 10-13 / 10-14 定下了期望与五项裁定（design D1–D5），本 change 把它们落成契约。

## What Changes

- **代理带回上游失败摘要**：上游 ≥500（504、524 除外）与连接被拒 / 重置时，代理仍回 502（omp 照常重试），但错误信封里带一行人读的中文摘要与机器可读的失败种类、上游状态码、去密钥截断后的上游正文节选；非 5xx 照旧原样透传。
- **慢失败不重试**：代理新增 120 秒首字节期限（只限等待响应头；已开始的流不设期限），到期回一个 omp 不会重试的状态（424，design D7），回合约 2 分钟内以「上游超时」失败；同一机制也用于既有 10 秒建连期限到期（「上游不可达」，约 10 秒）与上游自己答 504 / 524（「上游超时」，带该状态码，上游应答后约 2 秒）（owner 2026-10-14 起草后裁决）。
- **omp 会话级重试封顶一轮**：宿主 overlay 新增 `retry:` 段（`maxRetries: 1`，并关掉 omp 的模型兜底 `modelFallback: false`，使项目层的 `fallbackChains` 不能换模型重放），一次可重试的 5xx / 连接被拒回合最坏约 64 秒 / 24 次请求（推算，实现须实测）。
- **非法密钥拒绝启动**：`MODEL_UPSTREAM_API_KEY` 不是合法 HTTP 头取值时启动失败，错误点名该变量、不含取值。
- **回合失败分类**：服务端把每次失败归为十类之一（鉴权失败、模型不存在、额度不足、请求过于频繁、请求被拒、上游出错、上游不可达、上游超时、模型调用失败、Agent 运行失败），各配一句固定中文；原文经同一净化器（去密钥、去上游地址的 userinfo / 路径 / 查询串与完整 base URL、去 OMP 状态目录与沙箱根的绝对路径、去 bearer、去 `raw-http-request` 行、纯文本、≤2000 码点）。
- **重试可见**：omp 的 `auto_retry_start` 映射为新事件 `turn.retry`，前端在该助手消息上显示「上游出错，正在重试…」；重试成功后回合按成功收尾（今天的归约器会把它判成失败，读代码推出）。
- **错误落库、进快照**：迁移 043 给 `chat_messages` 加三个可空列（失败原因、状态码、净化后原文）；快照的每条消息多一个 `error` 键，刷新后看到同一条错误。
- **前端呈现**：失败的助手消息显示一句分类说明与状态码，可展开查看原文（纯文本）；输入框照旧在回合结束时解锁，可重发或重新生成。
- **日志**：每个以上游原因失败的回合在 application stderr 写一行 `upstream_failed`（会话 id、原因、状态码），不含密钥与正文。
- **测试设施**：假上游按 prompt 里的标记返回指定状态 / 正文、延迟后再答、挂起、断流、前 N 次失败；代理的两个期限可由测试注入短值，建连卡住用本地「接受 TCP 但永不说话」的监听模拟；新增「经代理的官方 omp」测试夹具（今天的 `openOfficialWorld` 绕过代理）。
- **不做**：自动重试策略与多上游切换（owner 2026-10-06 划出）；`Retry-After` 透传；重连期间的重试提示恢复；已在流式输出中的响应的期限。

**BREAKING（部署）**：`MODEL_UPSTREAM_API_KEY` 含非法 HTTP 头字符（换行、NUL、非 Latin-1 等）的部署，升级后服务拒绝启动。这样的密钥今天也从未能用（请求在发出前就被 Node 拒绝，回合挂到 omp 重试耗尽），只是失败从「每个回合挂几分钟」变成「启动即失败」。线协议的键集变化（快照 `error`、`error` 事件新键）由服务端与 web 同 PR 改，不跨版本暴露。

## Capabilities

### New Capabilities

- `upstream-failure`：回合失败的分类与固定句子、上游原文净化、错误落库（迁移 043）与快照形状、`upstream_failed` 日志、重试提示的事件契约。

### Modified Capabilities

- `model-proxy`：「透传端点与 bearer 鉴权」（5xx 与连接失败带回摘要；120 秒首字节期限、10 秒建连期限与上游 504 / 524 一律回不可重试的 424；生成的错误不再一律丢弃上游细节）；「假上游夹具契约」（按标记的状态 / 正文 / 延迟 / 挂起 / 断流 / 前 N 次失败）。
- `http-service-skeleton`：「服务启动与装配」（`MODEL_UPSTREAM_API_KEY` 的头取值校验；`log` 端口新增 `upstream_failed` 记录）。
- `omp-runtime`：「宿主 overlay」（逐字节内容新增 `retry:` 段，含 `modelFallback: false`）。
- `chat-stream`：「纯协议事件归约」（`error` 负载加 `reason`/`status`/`detail`；`auto_retry_start` → `turn.retry`；重试之后的结局替换规则；重试被取消记为中断）。
- `turn-control`：「中断帧归约与有界退回」（「首个记住的原因为准」在发生过重试时的例外；重试退避中停止的场景）。
- `chat-sessions`：「会话 REST」（消息对象的键集加 `error`）。
- `chat-web`：「API 客户端扩展」（消息 DTO 严格键集加 `error`）；「纯会话视图归约」「事件流消费与续流」（十一类 → 十二类事件、`error` 与 `turn.retry` 的严格解码与归约）；「消息线程」（错误块的内容与重试提示）。
- `chat-harness`：新增「上游失败的冒烟与走查」一条要求。

## Impact

- **服务端代码**：`server/src/model-proxy/index.ts`、新增 `server/src/core/upstream-failure.ts`（净化器与摘要编解码，纯函数）、`server/src/agent-config.ts`、`server/src/sessions/omp/host-overlay.ts`、`server/src/sessions/events.ts`、新增 `server/src/sessions/upstream-classify.ts`、`turn-control.ts`、store 与 REST 序列化、`server/src/app.ts` / `server.ts` 的装配（净化闭包、日志记录类型）。
- **数据**：迁移 `043_chat_message_error.sql`（三列 `ADD COLUMN`，可空，无回填）。
- **线协议**：快照消息对象多 `error` 键；`error` 事件多三键；新事件 `turn.retry`。web 的严格键集解析与服务端同 PR 改（tasks 组 7，design D18）。
- **web 代码**：`web/src/lib/session-contract.ts`、`web/src/features/chat/stream.ts`（已 757 行，新代码放新模块）、`message-thread.tsx`。
- **测试设施**：`server/test/support/fake-upstream.mjs`（+ `.d.mts`）、新增经代理的官方 omp 夹具与 `omp-official-upstream-failure.test.ts`（进入 `ci-uid-isolation.sh` 清单与 `scripts/test-ci-harness.sh` 断言）、`smoke/chat.hurl`、一条 `make ui-walk` 步骤。
- **文档**：`docs/architecture/system.md`、ADR-0008 与 ADR-0012 增补、`CONTEXT.md` 一个术语、`docs/acceptance/functional-checklist.md`（CH-48 期望更新与新行，`待签`）。
- **依赖**：无新增。

## 流程记录

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 每个失败回合的结束时刻、错误文本与快照；omp 子进程的重试行为（Critical Path「omp 子进程治理」）；上游密钥进入错误文本的路径
Selected risk packs: 见 tasks.md「风险包」
Evidence floor: make check、make test-guardrails、make smoke、make ui-walk；WORKBUDDY_OMP_TEST=1 的经代理官方 omp 用例
```

- **owner 裁定**：2026-10-06（issue「期望」）、2026-10-13（重试封顶一轮并显示；错误落库）、2026-10-14（密钥启动校验；120 秒首字节期限）。落点见 design D1–D5。
- **跟踪**：直接在 #909 上实现，不拆子 issue；tasks 的八个组合成五个 PR（组 1｜组 2 + 3｜组 4 + 5｜组 6 + 7｜组 8），依次合入（owner 2026-10-14 裁决，design D18；唯一的 Width 例外是组 7）。
- **起草者自定的事项**（design D6–D19）中会改变规格的几项（启动失败信息的位置、日志粒度、分类与句子）与 fixture review 之后的「慢失败不重试」都已由 owner 裁决，见 design「Owner 裁决」。
